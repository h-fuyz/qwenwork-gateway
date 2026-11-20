// 冒烟测试：不起真实上游（那需要真实凭据），而是把 per-user shim
// 替换为一个返回固定 OpenAI 响应的 stub，验证网关路由/鉴权/协议翻译。
import http from 'node:http';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

const HOME = '/tmp/qwg-test-' + Date.now();
process.env.QWENWORK_GATEWAY_HOME = HOME;
process.env.QWENWORK_GATEWAY_BIND_PORT = '18787';

// ---- stub shim：模拟 vendored chat-shim 的 OpenAI 兼容面 ----
const NON_STREAM_REPLY = JSON.stringify({
  id: 'chatcmpl-test',
  model: 'pro',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      reasoning_content: '思考片段',
      content: '你好，这是回复',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
});

const SSE_REPLY = [
  'data: {"id":"chatcmpl-test","model":"pro","choices":[{"index":0,"delta":{"reasoning_content":"思考中"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-test","model":"pro","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-test","model":"pro","choices":[{"index":0,"delta":{"content":"世界"},"finish_reason":null}]}',
  '',
  'data: ' + JSON.stringify({ id: 'chatcmpl-test', model: 'pro', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) } }] }, finish_reason: null }] }),
  '',
  'data: {"id":"chatcmpl-test","model":"pro","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":50,"completion_tokens":5}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const stubServer = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(SSE_REPLY);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(NON_STREAM_REPLY);
      }
    });
  } else { res.writeHead(404); res.end(); }
});
await new Promise(r => stubServer.listen(0, '127.0.0.1', r));
const stubPort = stubServer.address().port;

// ---- monkey-patch: 让 createUserUpstream 起的 shim 变成 stub ----
// 直接在 server.js 的 getUpstreamForUser 里调用 startChatShim；我们改测法：
// 手工构造 shim 对象注入 upstreamByUser 是私有 Map……改用 stub 网络面：
// 把 store 注册的用户凭据文件指向 stub？不行，凭据要真 JWT。
// 最简可行：直接测协议适配层（不经过 server），再单测 server 的鉴权路由。

const { anthropicRoute, responsesRoute } = await import('../src/protocol/anthropic.js').then(m => ({ anthropicRoute: m.anthropicRoute, responsesRoute: null }));
const { responsesRoute: rr } = await import('../src/protocol/openai-responses.js');
const shim = { baseUrl: `http://127.0.0.1:${stubPort}/v1/chat/completions`, sharedSecret: 'stub-secret' };


function fakeRes() {
  return {
    headersSent: false, statusCode: 0, headers: {},
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; this.headersSent = true; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); },
    end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.finished = true; this.onFinish?.(); },
    chunks: [], finished: false,
    bodyText() { return this.chunks.map(c => c.toString()).join(''); },
  };
}

// ============ 测 1：Anthropic 非流式 ============
{
  const req = (await import('node:stream')).Readable.from([Buffer.from(JSON.stringify({
    model: 'claude-sonnet-4.6', max_tokens: 1024,
    system: [{ type: 'text', text: '你是助手' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '读文件' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '文件内容' }] },
    ],
    tools: [{ name: 'read_file', description: '读', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  }))]);
  // 校验发给 stub 的 OpenAI 请求
  let capturedBody = null;
  stubServer.removeAllListeners('request');
  stubServer.on('request', (req, res) => {
    if (req.url.startsWith('/v1/chat/completions')) {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => { capturedBody = JSON.parse(b);
        if (capturedBody.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE_REPLY); }
        else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(NON_STREAM_REPLY); } });
    } else { res.writeHead(404); res.end(); }
  });
  const res = fakeRes();
  await anthropicRoute(req, res, shim);
  const out = JSON.parse(res.bodyText());
  assert.equal(res.statusCode, 200);
  assert.ok(capturedBody.max_tokens === 1024, 'max_tokens 透传: ' + capturedBody.max_tokens);
  assert.ok(capturedBody.messages.some(m => m.role === 'system' && m.content.includes('你是助手')), 'system 转换');
  assert.ok(capturedBody.messages.some(m => m.role === 'tool' && m.tool_call_id === 'tu_1'), 'tool_result 转换');
  assert.ok(capturedBody.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(tc => tc.function.name === 'read_file')), 'tool_use 转换');
  assert.ok(JSON.stringify(capturedBody.messages).includes('image_url'), 'image 转换');
  assert.equal(capturedBody.model, 'pro', 'claude 模型映射 pro');
  assert.ok(out.content.some(b => b.type === 'thinking'), 'thinking block');
  assert.ok(out.content.some(b => b.type === 'tool_use' && b.name === 'read_file'), 'tool_use 输出');
  assert.equal(out.stop_reason, 'tool_use');
  assert.equal(out.usage.input_tokens, 50);
  assert.equal(out.usage.output_tokens, 5);
  console.log('✓ test1 anthropic non-stream(聚合): 请求翻译+响应翻译 OK');
}

// ============ 测 2：Anthropic 流式 ============
{
  stubServer.removeAllListeners('request');
  stubServer.on('request', (req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { const p = JSON.parse(b);
      if (p.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE_REPLY); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(NON_STREAM_REPLY); } });
  });
  const req = (await import('node:stream')).Readable.from([Buffer.from(JSON.stringify({
    model: 'claude-sonnet-4.6', max_tokens: 512, stream: true,
    messages: [{ role: 'user', content: '你好' }],
  }))]);
  const res = fakeRes();
  await anthropicRoute(req, res, shim);
  const text = res.bodyText();
  assert.ok(text.includes('event: message_start'), 'message_start');
  assert.ok(text.includes('event: content_block_start'), 'content_block_start');
  assert.ok(text.includes('thinking_delta'), 'thinking delta');
  assert.ok((text.match(/"type":"text_delta"/g) || []).length === 2, 'text_delta x2: ' + (text.match(/"type":"text_delta"/g) || []).length);
  assert.ok(text.includes('event: content_block_stop'), 'content_block_stop');
  assert.ok(text.includes('event: message_delta'), 'message_delta');
  assert.ok(text.includes('"stop_reason":"tool_use"'), 'stop_reason tool_use');
  assert.ok(text.trimEnd().endsWith('event: message_stop') || text.includes('event: message_stop'), 'message_stop 收尾');
  // 事件顺序：message_start 必须最先
  const first = text.indexOf('event: message_start');
  const last = text.lastIndexOf('event: message_stop');
  assert.ok(first < text.indexOf('event: content_block_delta') && last > text.lastIndexOf('event: content_block_delta'), '事件顺序');
  console.log('✓ test2 anthropic stream: SSE 事件序 OK');
}

// ============ 测 3：Responses (Codex) 非流式 ============
{
  const req = (await import('node:stream')).Readable.from([Buffer.from(JSON.stringify({
    model: 'pro', instructions: '系统指令', max_output_tokens: 2048,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跑测试' }] },
      { type: 'function_call', call_id: 'call_9', name: 'bash', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_9', output: 'file1 file2' },
    ],
    tools: [{ type: 'function', name: 'bash', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
  }))]);
  let captured = null;
  stubServer.removeAllListeners('request');
  stubServer.on('request', (req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { captured = JSON.parse(b);
      if (captured.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE_REPLY); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(NON_STREAM_REPLY); } });
  });
  const res = fakeRes();
  await rr(req, res, shim);
  const out = JSON.parse(res.bodyText());
  assert.equal(res.statusCode, 200);
  assert.equal(captured.max_tokens, 2048, 'max_output_tokens→max_tokens');
  assert.ok(captured.messages.some(m => m.role === 'system' && m.content === '系统指令'), 'instructions→system');
  assert.ok(captured.messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_9'), 'function_call_output→tool');
  assert.ok(captured.messages.some(m => m.role === 'assistant' && m.tool_calls), 'function_call→tool_calls');
  assert.ok(out.output.some(i => i.type === 'reasoning'), 'reasoning item');
  assert.ok(out.output.some(i => i.type === 'message'), 'message item');
  assert.ok(out.output.some(i => i.type === 'function_call' && i.name === 'read_file'), 'function_call item');
  assert.equal(out.usage.input_tokens, 50);
  assert.equal(out.usage.output_tokens, 5);
  console.log('✓ test3 responses non-stream(聚合) OK');
}

// ============ 测 4：Responses (Codex) 流式 ============
{
  stubServer.removeAllListeners('request');
  stubServer.on('request', (req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { const p = JSON.parse(b);
      if (p.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE_REPLY); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(NON_STREAM_REPLY); } });
  });
  const req = (await import('node:stream')).Readable.from([Buffer.from(JSON.stringify({
    model: 'pro', stream: true, input: '你好',
  }))]);
  const res = fakeRes();
  await rr(req, res, shim);
  const text = res.bodyText();
  assert.ok(text.includes('event: response.created'), 'response.created');
  assert.ok(text.includes('event: response.output_text.delta'), 'output_text.delta');
  assert.ok(text.includes('event: response.function_call_arguments.delta'), 'function_call args delta');
  assert.ok(text.includes('event: response.output_item.done'), 'output_item.done');
  assert.ok(text.includes('event: response.completed'), 'response.completed 收尾');
  const createdIdx = text.indexOf('event: response.created');
  const completedIdx = text.indexOf('event: response.completed');
  assert.ok(createdIdx < completedIdx, 'created 在 completed 前');
  assert.ok(text.includes('"input_tokens":50'), 'usage 透传');
  console.log('✓ test4 responses stream: 事件序 OK');
}

// ============ 测 5：server 鉴权与路由（不真实上游，仅 401/404/healthz） ============
{
  const { createGatewayServer } = await import('../src/gateway/server.js');
  const gw = createGatewayServer({ logger: { info(){}, warn(){}, error(){} } });
  await new Promise(r => gw.server.listen(18787, '127.0.0.1', r));
  const base = 'http://127.0.0.1:18787';
  const noKey = await fetch(base + '/v1/models');
  assert.equal(noKey.status, 401, 'no key → 401');
  const badKey = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer qwg_wrong' } });
  assert.equal(badKey.status, 401, 'bad key → 401');
  const healthz = await fetch(base + '/healthz');
  assert.equal(healthz.status, 200);
  const hello = await fetch(base + '/api/hello', { method: 'HEAD' });
  assert.equal(hello.status, 200, 'HEAD /api/hello (Claude Code 探测)');
  const notFound = await fetch(base + '/v1/xxx', { headers: { authorization: 'Bearer x' } });
  assert.equal(notFound.status, 401, '先鉴权后路由');
  await gw.close();
  console.log('✓ test5 server auth/routes OK');
}

// ============ 测 6：用户 store ============
{
  const { registerUser, findUserByApiKey, listUsers, removeUser, rotateApiKey } = await import('../src/users/store.js');
  const cred = { token: 'fake.jwt.token', refreshToken: 'rt', expiresAt: new Date(Date.now()+3600e3).toISOString(), user: { id: 'u1', name: '张三', email: 'z@corp.cn', organization_id: 'org_123' } };
  const { user, apiKey } = registerUser({ name: '张三', email: 'z@corp.cn', credential: cred });
  assert.ok(apiKey.startsWith('qwg_'));
  assert.equal(findUserByApiKey(apiKey)?.id, user.id);
  assert.equal(findUserByApiKey('qwg_' + 'x'.repeat(40)), null);
  assert.ok(listUsers()[0].name === '张三' && !('apiKeyHash' in listUsers()[0]), 'list 不泄哈希');
  const newKey = rotateApiKey(user.id);
  assert.equal(findUserByApiKey(apiKey), null, '旧 key 失效');
  assert.equal(findUserByApiKey(newKey)?.id, user.id);
  assert.ok(removeUser(user.id));
  assert.equal(listUsers().length, 0);
  console.log('✓ test6 user store: 注册/鉴权/轮换/删除 OK');
}

stubServer.close();
console.log('\n全部冒烟测试通过 ✅');
process.exit(0);
