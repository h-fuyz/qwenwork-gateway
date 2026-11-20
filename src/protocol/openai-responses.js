/**
 * OpenAI Responses API 适配层（Codex → OpenAI chat completions shim）。
 *
 * 输入：POST /v1/responses（Codex wire_api="responses" 唯一协议）
 *   { model, input: string|items[], instructions, tools, stream,
 *     max_output_tokens, temperature, reasoning: {effort}, ... }
 * 输出：非流式 Response 对象，或 Responses SSE 事件流
 *   （response.created → output_item/message 部分 delta → response.completed）。
 *
 * 请求翻译：
 *   instructions → system message
 *   input items: message(含 content parts) → user/assistant；
 *                function_call → assistant.tool_calls；function_call_output → role:tool
 *   tools: {type:'function',name,parameters} → OpenAI function tool
 *   reasoning.effort 映射忽略（上游强制思考，无法开关）
 *
 * @module qwenwork-gateway/protocol/openai-responses
 */
import { createOpenAiSseParser } from './anthropic.js';

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

function json(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function apiError(res, status, message, code = 'api_error') {
  json(res, status, { error: { message, type: code, code } });
}

/** Responses input items → OpenAI messages。 */
function toOpenAiMessages(body) {
  const messages = [];
  if (typeof body.instructions === 'string' && body.instructions !== '') {
    messages.push({ role: 'system', content: body.instructions });
  }

  const items = Array.isArray(body.input)
    ? body.input
    : typeof body.input === 'string'
      ? [{ type: 'message', role: 'user', content: body.input }]
      : [];

  for (const item of items) {
    if (item?.type === 'message' || (item?.role && !item.type)) {
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user';
      const content = Array.isArray(item.content)
        ? item.content.map((part) => {
            if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') {
              return { type: 'text', text: part.text ?? '' };
            }
            if (part?.type === 'input_image' || part?.type === 'image_url') {
              const url = part.image_url ?? part.url;
              return { type: 'image_url', image_url: { url } };
            }
            return { type: 'text', text: '' };
          })
        : item.content;
      if (content !== undefined && content !== null && content !== '') {
        messages.push({ role, content });
      }
    } else if (item?.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id ?? 'call_' + Math.random().toString(36).slice(2),
            type: 'function',
            function: { name: item.name, arguments: item.arguments ?? '{}' },
          },
        ],
      });
    } else if (item?.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content:
          typeof item.output === 'string'
            ? item.output
            : JSON.stringify(item.output ?? ''),
      });
    }
  }
  return messages;
}

function toOpenAiTools(body) {
  return (body.tools ?? [])
    .filter((t) => t?.type === 'function' && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    }));
}

export async function responsesRoute(req, res, shim) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return apiError(res, 400, e.message, 'invalid_request_error');
  }

  const openaiBody = {
    model: typeof body.model === 'string' ? body.model : 'pro',
    messages: toOpenAiMessages(body),
    stream: body.stream === true,
  };
  if (typeof body.max_output_tokens === 'number' && body.max_output_tokens > 0) {
    openaiBody.max_tokens = body.max_output_tokens;
  }
  if (typeof body.temperature === 'number') openaiBody.temperature = body.temperature;
  const tools = toOpenAiTools(body);
  if (tools.length > 0) openaiBody.tools = tools;

  // ⚠️ 上游 QwenWork 恒以 SSE 返回（即使 stream:false）——非流式也在适配层聚合。
  openaiBody.stream = true;

  const target = new URL(shim.baseUrl);
  const upstream = await fetch(target.origin + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + shim.sharedSecret,
    },
    body: JSON.stringify(openaiBody),
  });

  if (!body.stream) return nonStream(res, upstream);
  return stream(res, upstream, body);
}

/** 上游恒为 SSE：非流式请求聚合出 Response 对象。 */
async function nonStream(res, upstream) {
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return apiError(res, upstream.status, `upstream error (HTTP ${upstream.status}): ${text.slice(0, 500)}`);
  }

  let reasoning = '';
  let content = '';
  const toolCalls = new Map();
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
    return apiError(res, 502, 'upstream stream interrupted: ' + (e?.message ?? e));
  }

  const output = [];
  if (reasoning !== '') {
    output.push({
      type: 'reasoning',
      id: 'rs_' + Math.random().toString(36).slice(2),
      summary: [],
      content: [{ type: 'reasoning_text', text: reasoning }],
    });
  }
  if (content !== '') {
    output.push({
      type: 'message',
      id: 'msg_' + Math.random().toString(36).slice(2),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    });
  }
  for (const [, tc] of toolCalls) {
    output.push({
      type: 'function_call',
      id: tc.id ?? 'fc_' + Math.random().toString(36).slice(2),
      call_id: tc.id ?? 'call_' + Math.random().toString(36).slice(2),
      name: tc.name,
      arguments: tc.args || '{}',
      status: 'completed',
    });
  }

  return json(res, 200, {
    object: 'response',
    id: 'resp_' + Math.random().toString(36).slice(2),
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: 'qwenwork',
    output,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      input_tokens_details: { cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens: usage?.completion_tokens ?? 0,
      total_tokens: (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
    },
  });
}

/** chat completion SSE → Responses SSE。 */
async function stream(res, upstream, reqBody) {
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return apiError(res, upstream.status, `upstream error (HTTP ${upstream.status}): ${text.slice(0, 500)}`);
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const respId = 'resp_' + Math.random().toString(36).slice(2);
  const sequence = (() => {
    let n = 0;
    return () => (n += 1);
  })();

  const responseTemplate = {
    id: respId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model: reqBody?.model ?? 'qwenwork',
    output: [],
  };

  send('response.created', { type: 'response.created', sequence_number: sequence(), response: { ...responseTemplate } });

  let msgItemId = null;
  let reasoningItemId = null;
  let callItems = new Map(); // tool index → {item_id, name, args}
  let usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
  let finish = null;

  const parser = createOpenAiSseParser(async (chunk) => {
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      if (!reasoningItemId) {
        reasoningItemId = 'rs_' + Math.random().toString(36).slice(2);
        send('response.output_item.added', {
          type: 'response.output_item.added',
          sequence_number: sequence(),
          output_index: 0,
          item: { type: 'reasoning', id: reasoningItemId, summary: [] },
        });
      }
      send('response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        sequence_number: sequence(),
        item_id: reasoningItemId,
        output_index: 0,
        summary_index: 0,
        delta: delta.reasoning_content,
      });
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (!msgItemId) {
        msgItemId = 'msg_' + Math.random().toString(36).slice(2);
        send('response.output_item.added', {
          type: 'response.output_item.added',
          sequence_number: sequence(),
          output_index: 1,
          item: { type: 'message', id: msgItemId, role: 'assistant', status: 'in_progress', content: [] },
        });
        send('response.content_part.added', {
          type: 'response.content_part.added',
          sequence_number: sequence(),
          item_id: msgItemId,
          output_index: 1,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      }
      send('response.output_text.delta', {
        type: 'response.output_text.delta',
        sequence_number: sequence(),
        item_id: msgItemId,
        output_index: 1,
        content_index: 0,
        delta: delta.content,
      });
    }
    for (const tc of delta.tool_calls ?? []) {
      const slot = tc.index ?? 0;
      let item = callItems.get(slot);
      if (!item) {
        item = {
          item_id: 'fc_' + Math.random().toString(36).slice(2),
          call_id: tc.id ?? 'call_' + Math.random().toString(36).slice(2),
          name: tc.function?.name ?? '',
          output_index: 2 + slot,
        };
        callItems.set(slot, item);
        send('response.output_item.added', {
          type: 'response.output_item.added',
          sequence_number: sequence(),
          output_index: item.output_index,
          item: {
            type: 'function_call',
            id: item.item_id,
            call_id: item.call_id,
            name: item.name,
            arguments: '',
            status: 'in_progress',
          },
        });
      }
      if (tc.function?.arguments) {
        send('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          sequence_number: sequence(),
          item_id: item.item_id,
          output_index: item.output_index,
          delta: tc.function.arguments,
        });
      }
    }
    if (chunk.usage) {
      usage = {
        input_tokens: Math.max(usage.input_tokens, chunk.usage.prompt_tokens ?? 0),
        output_tokens: Math.max(usage.output_tokens, chunk.usage.completion_tokens ?? 0),
        cached_tokens: Math.max(
          usage.cached_tokens,
          chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        ),
      };
    }
    const f = chunk.choices?.[0]?.finish_reason;
    if (f) finish = f;
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
    send('response.failed', {
      type: 'response.failed',
      sequence_number: sequence(),
      response: {
        ...responseTemplate,
        status: 'failed',
        error: { code: 'stream_interrupted', message: String(e?.message ?? e) },
      },
    });
    res.end();
    return;
  }

  // 收尾
  if (reasoningItemId) {
    send('response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: sequence(),
      output_index: 0,
      item: { type: 'reasoning', id: reasoningItemId, summary: [] },
    });
  }
  if (msgItemId) {
    send('response.content_part.done', {
      type: 'response.content_part.done',
      sequence_number: sequence(),
      item_id: msgItemId,
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    send('response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: sequence(),
      output_index: 1,
      item: { type: 'message', id: msgItemId, role: 'assistant', status: 'completed', content: [] },
    });
  }
  for (const [, item] of callItems) {
    send('response.output_item.done', {
      type: 'response.output_item.done',
      sequence_number: sequence(),
      output_index: item.output_index,
      item: {
        type: 'function_call',
        id: item.item_id,
        call_id: item.call_id,
        name: item.name,
        arguments: '',
        status: 'completed',
      },
    });
  }

  send('response.completed', {
    type: 'response.completed',
    sequence_number: sequence(),
    response: {
      ...responseTemplate,
      status: 'completed',
      usage: {
        input_tokens: usage.input_tokens,
        input_tokens_details: { cached_tokens: usage.cached_tokens },
        output_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens,
      },
    },
  });
  res.end();
}
