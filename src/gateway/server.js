/**
 * 团队网关主服务：
 *   - 对外监听 QWENWORK_GATEWAY_BIND（默认 127.0.0.1:8787），建议放反代后。
 *   - API key 鉴权（Bearer qwg_...，SHA-256 常量比较查用户）。
 *   - 端点：
 *       GET  /v1/models                     —— 模型目录（Claude Code/Codex 发现）
 *       POST /v1/chat/completions           —— OpenAI Chat（透明代理到该用户 shim）
 *       POST /v1/messages                   —— Anthropic Messages（Claude Code）
 *       POST /v1/responses                  —— OpenAI Responses（Codex）
 *       GET  /healthz
 *   - 每用户一个上游 shim（127.0.0.1 随机端口）与一套凭据，互不串号。
 *
 * @module qwenwork-gateway/gateway/server
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { findUserByApiKey } from '../users/store.js';
import { createUserUpstream } from '../users/session.js';
import { FALLBACK_QWENWORK_MODELS, formatRate } from '../vendor/models.js';
import { createCatalogStore } from '../vendor/catalog.js';
import { getValidToken } from '../vendor/auth.js';
import { loadCredentials } from '../vendor/credentials.js';

const BIND_HOST = process.env.QWENWORK_GATEWAY_BIND_HOST ?? '127.0.0.1';
const BIND_PORT = Number(process.env.QWENWORK_GATEWAY_BIND_PORT ?? 8787);

/** 每用户的上游会话（{ shim, close }），按 user.id 缓存。 */
const upstreamByUser = new Map();

const catalogStore = createCatalogStore();
/** 目录的定时惰性刷新沿用上游策略：5min TTL，但只有有用户时才拉。 */
setInterval(() => {
  if (upstreamByUser.size > 0) void catalogStore.refresh({ force: true }).catch(() => {});
}, 5 * 60 * 1000).unref?.();

function modelLookup(modelKey) {
  const all = catalogStore.models();
  const hit = all.find((m) => m.id === modelKey || m.displayNameId === modelKey);
  return hit ?? null;
}

async function getUpstreamForUser(user, logger) {
  let entry = upstreamByUser.get(user.id);
  if (!entry) {
    const upstream = createUserUpstream(user, { logger, modelLookup });
    const shim = await upstream.start();
    entry = { shim, upstream, close: shim.close };
    upstreamByUser.set(user.id, entry);
  }
  return entry;
}

function bearerKey(req) {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m) return m[1].trim();
  const xkey = req.headers['x-api-key'];
  return typeof xkey === 'string' ? xkey.trim() : null;
}

function readJsonBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('invalid JSON body: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function anthropicError(res, status, type, message) {
  json(res, status, { type: 'error', error: { type, message } });
}

function openaiError(res, status, message, code = 'api_error') {
  json(res, status, { error: { message, type: code, code } });
}

/** 把模型目录转成 OpenAI /v1/models 形状。 */
function openaiModelsPayload() {
  const models = catalogStore.models();
  return {
    object: 'list',
    data: models.map((m) => ({
      id: m.displayNameId ?? m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'qwenwork',
      display_name: m.shortName,
      billing_rate: m.billingRate,
    })),
  };
}

async function handleModels(res, user, logger) {
  // 确保目录对该用户的凭据可用；失败退回内置目录
  await ensureCatalogForUser(user, logger);
  json(res, 200, openaiModelsPayload());
}

/** 用首个用户的凭据拉一次目录（team 共享同目录）。 */
async function ensureCatalogForUser(user, logger) {
  try {
    if (catalogStore.shouldRefresh()) {
      const entry = await getUpstreamForUser(user, logger);
      const credential = await entry.upstream.getCredential();
      await catalogStore.refresh({ credential });
    }
  } catch (e) {
    logger?.warn?.('catalog refresh failed: ' + (e?.message ?? e));
  }
}

/** 把请求转发到该用户的 OpenAI 兼容 shim。 */
async function proxyToShim(req, res, shim, { rewritePath } = {}) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  const target = new URL(shim.baseUrl);
  const path = rewritePath ?? req.url;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  headers.authorization = 'Bearer ' + shim.sharedSecret;

  const upstreamRes = await fetch(target.origin + path, {
    method: req.method,
    headers,
    body: req.method === 'POST' ? body : undefined,
  });

  res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers));
  if (upstreamRes.body) {
    for await (const chunk of upstreamRes.body) res.write(chunk);
  }
  res.end();
}

export function createGatewayServer({ logger = console } = {}) {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      logger.error?.('gateway unhandled: ' + (e?.stack ?? e));
      if (!res.headersSent) openaiError(res, 500, 'internal gateway error');
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/healthz') {
      return json(res, 200, { ok: true, users: upstreamByUser.size });
    }

    // 兼容 Claude Code 启动时的连接探测
    if (req.method === 'HEAD' && pathname === '/api/hello') {
      res.writeHead(200, { 'content-length': '0' });
      return res.end();
    }

    const apiKey = bearerKey(req);
    const user = apiKey ? findUserByApiKey(apiKey) : null;
    if (!user) {
      return openaiError(res, 401, 'missing or invalid API key (Bearer qwg_...)', 'invalid_api_key');
    }

    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      return handleModels(res, user, logger);
    }

    // 路由到对应协议适配层或直通代理
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      const { shim } = await getUpstreamForUser(user, logger);
      return proxyToShim(req, res, shim);
    }

    if (req.method === 'POST' && pathname === '/v1/messages') {
      const { anthropicRoute } = await import('../protocol/anthropic.js');
      const { shim } = await getUpstreamForUser(user, logger);
      return anthropicRoute(req, res, shim);
    }

    if (req.method === 'POST' && (pathname === '/v1/responses' || pathname === '/responses')) {
      const { responsesRoute } = await import('../protocol/openai-responses.js');
      const { shim } = await getUpstreamForUser(user, logger);
      return responsesRoute(req, res, shim);
    }

    return openaiError(res, 404, `no route: ${req.method} ${pathname}`, 'not_found');
  }

  server.on('clientError', (err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    server,
    /** 优雅停机：关掉所有 per-user shim。 */
    close: async () => {
      await new Promise((done) => server.close(() => done()));
      for (const [, entry] of upstreamByUser) {
        try {
          await entry.close();
        } catch {}
      }
      upstreamByUser.clear();
    },
  };
}

export async function serveCommand() {
  const { createGatewayServer } = await import('./server.js');
  const gw = createGatewayServer();
  await new Promise((resolve) => {
    gw.server.listen(BIND_PORT, BIND_HOST, resolve);
  });
  console.log(`qwenwork-gateway listening on http://${BIND_HOST}:${BIND_PORT}`);
  console.log(`  users home: ${process.env.QWENWORK_GATEWAY_HOME ?? '~/.qwenwork-gateway'}`);
  console.log('  endpoints: /v1/models /v1/chat/completions /v1/messages (Anthropic) /v1/responses (Codex)');
  return gw;
}
