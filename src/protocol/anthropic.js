/**
 * Anthropic Messages 适配层（Claude Code → OpenAI chat completions shim）。
 *
 * 输入：POST /v1/messages（Anthropic Messages 格式）
 *   { model, max_tokens, system (string|blocks), messages: [{role, content}],
 *     tools, stream, temperature, ... }
 * 输出：非流式 Anthropic Messages 响应，或 Anthropic SSE 事件流
 *   （message_start / content_block_* / message_delta / message_stop / ping）。
 *
 * 设计要点（依据 Claude Code 网关兼容指南）：
 *   - 逐事件转发，绝不缓冲整个响应（Claude Code 会 stall）
 *   - 每个事件按序直达 message_stop；缺尾巴会被当断连
 *   - 长思考期间靠 ping 事件保活（Claude Code 有流空闲看门狗）
 *   - 错误体原样转发（保留 capability-rejection 修复路径）
 *
 * @module qwenwork-gateway/protocol/anthropic
 */

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Anthropic content blocks → OpenAI messages 数组。 */
function toOpenAiMessages(body) {
  const messages = [];

  // system：字符串或 blocks → 首条 system message
  if (body.system) {
    const text =
      typeof body.system === 'string'
        ? body.system
        : (Array.isArray(body.system) ? body.system : [])
            .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
            .join('\n');
    if (text !== '') messages.push({ role: 'system', content: text });
  }

  for (const msg of body.messages ?? []) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : [];

    const parts = [];
    const toolUses = [];
    let pendingToolResults = [];
    for (const block of blocks) {
      if (block?.type === 'text') {
        parts.push({ type: 'text', text: block.text ?? '' });
      } else if (block?.type === 'image' || block?.type === 'image_url') {
        const source =
          block.type === 'image' ? block.source : block.image_url ?? block.source;
        // Anthropic source {type:'base64',media_type,data} → OpenAI data URL
        if (source?.type === 'base64' && source.data) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${source.media_type ?? 'image/png'};base64,${source.data}` },
          });
        } else if (typeof source === 'string') {
          parts.push({ type: 'image_url', image_url: { url: source } });
        }
      } else if (block?.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block?.type === 'tool_result') {
        pendingToolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content:
            typeof block.content === 'string'
              ? block.content
              : (Array.isArray(block.content) ? block.content : [])
                  .map((c) => c?.text ?? '')
                  .join('\n'),
        });
      }
    }

    // tool_result 块必须是独立 user 轮（OpenAI role:tool）
    if (pendingToolResults.length > 0) {
      messages.push(...pendingToolResults);
      pendingToolResults = [];
    }
    if (parts.length > 0) {
      messages.push({
        role,
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
      });
    }
    if (toolUses.length > 0) {
      messages.push({ role: 'assistant', content: null, tool_calls: toolUses });
    }
  }
  return messages;
}

/** Anthropic tools → OpenAI tools。 */
function toOpenAiTools(body) {
  const tools = body.tools ?? [];
  return tools
    .filter((t) => t?.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
}

export async function anthropicRoute(req, res, shim) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return anthropicError(res, 400, 'invalid_request_error', e.message);
  }

  const openaiBody = {
    model: normalizeModel(body.model),
    messages: toOpenAiMessages(body),
    max_tokens: body.max_tokens ?? 8192,
    stream: body.stream === true,
  };
  const tools = toOpenAiTools(body);
  if (tools.length > 0) openaiBody.tools = tools;
  if (typeof body.temperature === 'number') openaiBody.temperature = body.temperature;

  // ⚠️ 上游 QwenWork 恒以 SSE 返回（即使 stream:false）——与 vendored shim
  // 行为一致。非流式请求也在适配层按流收集后聚合。
  openaiBody.stream = true;

  const upstream = await fetchShim(shim, openaiBody);

  if (!body.stream) {
    return aggregatedResponse(res, upstream);
  }
  return streamResponse(res, upstream, body.model);
}

async function fetchShim(shim, openaiBody) {
  const target = new URL(shim.baseUrl);
  return fetch(target.origin + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + shim.sharedSecret,
    },
    body: JSON.stringify(openaiBody),
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
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
        reject(new Error('invalid JSON: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function anthropicError(res, status, type, message) {
  json(res, status, { type: 'error', error: { type, message } });
}

function json(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

/** 把 Anthropic 模型名映射回 QwenWork key；未知名原样透传（上游裁决）。 */
function normalizeModel(model) {
  if (typeof model !== 'string') return 'pro';
  const lower = model.toLowerCase();
  if (lower.includes('opus') || lower.includes('sonnet')) return 'pro';
  if (lower.includes('haiku')) return 'flash';
  return model;
}

/** 上游恒为 SSE：非流式请求在适配层聚合出最终 Anthropic Messages 响应。 */
async function aggregatedResponse(res, upstream) {
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return anthropicError(
      res,
      upstream.status,
      mapErrorType(upstream.status),
      `upstream error (HTTP ${upstream.status}): ${text.slice(0, 500)}`,
    );
  }

  let reasoning = '';
  let content = '';
  const toolCalls = new Map(); // tool index → {id, name, args}
  let finish = null;
  let usage = null;

  const parser = createOpenAiSseParser(async (chunk) => {
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (typeof delta.content === 'string') content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const slot = tc.index ?? 0;
      const prev = toolCalls.get(slot) ?? { id: null, name: '', args: '' };
      if (tc.id) prev.id = tc.id;
      if (tc.function?.name) prev.name = tc.function.name;
      if (tc.function?.arguments) prev.args += tc.function.arguments;
      toolCalls.set(slot, prev);
    }
    const f = chunk.choices?.[0]?.finish_reason;
    if (f) finish = f;
    if (chunk.usage) usage = chunk.usage;
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) await parser.push(decoder.decode(value, { stream: true }));
    }
    await parser.flush();
  } catch (e) {
    return anthropicError(res, 502, 'api_error', 'upstream stream interrupted: ' + (e?.message ?? e));
  }

  const contentBlocks = [];
  if (reasoning !== '') contentBlocks.push({ type: 'thinking', thinking: reasoning });
  if (content !== '') contentBlocks.push({ type: 'text', text: content });
  for (const [, tc] of toolCalls) {
    contentBlocks.push({
      type: 'tool_use',
      id: tc.id ?? 'toolu_' + Math.random().toString(36).slice(2),
      name: tc.name,
      input: safeParseJson(tc.args),
    });
  }

  return json(res, 200, {
    id: 'msg_' + Math.random().toString(36).slice(2),
    type: 'message',
    role: 'assistant',
    model: 'qwenwork',
    content: contentBlocks,
    stop_reason: mapStopReason(finish),
    stop_sequence: null,
    usage: mapUsage(usage),
  });
}

/** 上游 OpenAI SSE → Anthropic SSE 事件流。 */
async function streamResponse(res, upstream, requestedModel) {
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return anthropicError(
      res,
      upstream.status,
      mapErrorType(upstream.status),
      `upstream error (HTTP ${upstream.status}): ${text.slice(0, 500)}`,
    );
  }

  res.writeHead(200, SSE_HEADERS);

  const model = requestedModel ?? 'qwenwork';
  const msgId = 'msg_' + Math.random().toString(36).slice(2);

  // message_start：usage 计数从 0 开始，message_delta 里累计
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // 解析上游 OpenAI SSE
  let blockIndex = 0;
  let openBlock = null; // 'text' | 'thinking' | 'tool_use:{id}:{name}'
  let usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = null;
  let toolUses = [];

  const closeBlock = () => {
    if (openBlock !== null) {
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex += 1;
      openBlock = null;
    }
  };

  const parser = createOpenAiSseParser(async (chunk) => {
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      if (openBlock !== 'thinking') {
        closeBlock();
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        });
        openBlock = 'thinking';
      }
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      });
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (openBlock !== 'text') {
        closeBlock();
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' },
        });
        openBlock = 'text';
      }
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }
    for (const tc of delta.tool_calls ?? []) {
      const key = `tool_use:${tc.index ?? 0}`;
      if (openBlock !== key) {
        closeBlock();
        const name = tc.function?.name ?? '';
        const id = tc.id ?? 'toolu_' + Math.random().toString(36).slice(2);
        toolUses.push({ index: blockIndex, id });
        sse(res, 'content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id, name, input: {} },
        });
        openBlock = key;
      }
      if (tc.function?.arguments) {
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
        });
      }
    }
    if (chunk.usage) {
      usage = mergeUsage(usage, chunk.usage);
    }
    const finish = chunk.choices?.[0]?.finish_reason;
    if (finish) stopReason = mapStopReason(finish);
  });

  // 逐块读上游并解析；期间发 ping 保活（Claude Code 空闲看门狗）
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let lastPing = Date.now();
  try {
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) await parser.push(decoder.decode(value, { stream: true }));
      if (Date.now() - lastPing > 15_000) {
        sse(res, 'ping', { type: 'ping' });
        lastPing = Date.now();
      }
    }
    await parser.flush();
  } catch (e) {
    closeBlock();
    sse(res, 'error', {
      type: 'error',
      error: { type: 'api_error', message: 'stream interrupted: ' + (e?.message ?? e) },
    });
    res.end();
    return;
  }

  closeBlock();
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function mapStopReason(finish) {
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  if (finish === 'stop') return 'end_turn';
  return 'end_turn';
}

function mapUsage(u) {
  return {
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? 0,
    ...(u?.prompt_tokens_details?.cached_tokens
      ? { cache_read_input_tokens: u.prompt_tokens_details.cached_tokens }
      : {}),
  };
}

function mergeUsage(a, b) {
  return {
    input_tokens: Math.max(a.input_tokens, b.prompt_tokens ?? 0),
    output_tokens: Math.max(a.output_tokens, b.completion_tokens ?? 0),
  };
}

function mapErrorType(status) {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

function safeParseJson(s) {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/** 轻量 OpenAI SSE 解析（shim 输出是标准 OpenAI 流）。 */
export function createOpenAiSseParser(onChunk) {
  let buffer = '';
  return {
    async push(text) {
      buffer += text;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        try {
          await onChunk(JSON.parse(payload));
        } catch {
          /* 忽略非法帧 */
        }
      }
    },
    async flush() {
      buffer = '';
    },
  };
}
