/*
 * Anthropic Messages API без сети и ключа: локальный сервер отдаёт тот же поток
 * событий (SSE), что и настоящий Anthropic, а провайдер разбирает его так же.
 *
 * Проверяем провод и сборку запроса: текст, размышления, вызов инструмента,
 * системный промпт отдельным полем, tool_result внутри user-хода, картинки
 * блоками image, и режим расширенного мышления (thinking + отсутствие temperature).
 */
const http = require('node:http');
const assert = require('node:assert/strict');

const { AnthropicProvider, toAnthropicMessages } = require('../dist/main/ai/anthropic.js');

let failures = 0;
function ok(name, condition, extra) {
  if (condition) console.log(`  ok   ${name}${extra ? `: ${extra}` : ''}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`);
  }
}

/** Отправка одного SSE-события в формате Anthropic. */
function sse(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function startServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });

      if (req.url.endsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'claude-opus-4-1' }, { id: 'claude-sonnet-4-5' }] }));
        return;
      }

      if (req.url.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const scenario = req.headers['x-scenario'];
        if (scenario === 'tool') {
          sse(res, 'message_start', { message: { usage: { input_tokens: 12 } } });
          sse(res, 'content_block_start', {
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' },
          });
          sse(res, 'content_block_delta', {
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"/x.ts"' },
          });
          sse(res, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '}' } });
          sse(res, 'content_block_stop', { index: 0 });
          sse(res, 'message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
          sse(res, 'message_stop', {});
        } else if (scenario === 'thinking') {
          sse(res, 'message_start', { message: { usage: { input_tokens: 20 } } });
          sse(res, 'content_block_start', { index: 0, content_block: { type: 'thinking' } });
          sse(res, 'content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Думаю…' } });
          sse(res, 'content_block_stop', { index: 0 });
          sse(res, 'content_block_start', { index: 1, content_block: { type: 'text' } });
          sse(res, 'content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Ответ' } });
          sse(res, 'content_block_stop', { index: 1 });
          sse(res, 'message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 3 } });
          sse(res, 'message_stop', {});
        } else {
          sse(res, 'message_start', { message: { usage: { input_tokens: 10 } } });
          sse(res, 'content_block_start', { index: 0, content_block: { type: 'text' } });
          sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Привет' } });
          sse(res, 'content_block_stop', { index: 0 });
          sse(res, 'message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
          sse(res, 'message_stop', {});
        }
        res.end();
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });
  });
  return { server, requests };
}

async function main() {
  const { server, requests } = startServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const provider = new AnthropicProvider({ id: 'anthropic', label: 'Anthropic', baseUrl: base, apiKey: 'test-key' });
  const signal = new AbortController().signal;

  /* 1. Список моделей */
  const models = await provider.listModels(signal);
  ok('список моделей отсортирован', models.join(',') === 'claude-opus-4-1,claude-sonnet-4-5', models.join(','));

  /* 2. Обычный поток */
  const done = await provider.streamChat(
    { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'привет' }] },
    { onDelta: () => undefined },
    signal,
  );
  ok('текст собран', done.text === 'Привет', done.text);
  ok('usage из message_start/message_delta', done.usage?.promptTokens === 10 && done.usage?.completionTokens === 5);
  ok('finish_reason end_turn', done.finishReason === 'end_turn', done.finishReason);

  /* 3. Заголовки Anthropic */
  const last = requests.at(-1);
  ok('заголовок x-api-key', last.headers['x-api-key'] === 'test-key');
  ok('заголовок anthropic-version', last.headers['anthropic-version'] === '2023-06-01');

  /* 4. Размышления */
  let reasoned = '';
  const thinkDone = await streamWithScenario(
    provider,
    'thinking',
    { onDelta: () => undefined, onReasoning: (t) => (reasoned += t) },
    signal,
  );
  ok('размышления пришли', reasoned === 'Думаю…', reasoned);
  ok('reasoning в ответе', thinkDone.reasoning === 'Думаю…');
  ok('max_tokens → length', thinkDone.finishReason === 'length', thinkDone.finishReason);

  /* 6. tool_use */
  const toolCall = await streamWithScenario(provider, 'tool', { onDelta: () => undefined }, signal);
  ok('инструмент собран', toolCall.toolCalls?.length === 1 && toolCall.toolCalls[0].name === 'read_file');
  ok(
    'аргументы инструмента склеены',
    toolCall.toolCalls[0].arguments === '{"path":"/x.ts"}',
    toolCall.toolCalls[0].arguments,
  );
  ok('stop_reason tool_use', toolCall.finishReason === 'tool_calls', toolCall.finishReason);

  /* 7. Сборка сообщений: system, tool_result в user, картинки */
  const mapped = toAnthropicMessages([
    { role: 'system', content: 'Ты — ассистент.' },
    { role: 'user', content: 'смотри', images: ['data:image/png;base64,AAAA'] },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read_file', arguments: '{"path":"/a"}' }] },
    { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'содержимое' },
    { role: 'assistant', content: 'готово' },
  ]);
  ok('system вынесен отдельным полем', mapped.system === 'Ты — ассистент.');
  const roles = mapped.messages.map((m) => m.role).join(',');
  ok('tool_result лежит в user-ходе', roles === 'user,assistant,user,assistant', roles);
  const toolResultMsg = mapped.messages[2];
  ok(
    'tool_result на месте',
    toolResultMsg.content[0].type === 'tool_result' && toolResultMsg.content[0].tool_use_id === 't1',
  );
  const userBlocks = mapped.messages[0].content;
  ok(
    'картинка стала блоком image',
    Array.isArray(userBlocks) && userBlocks.some((b) => b.type === 'image' && b.source.data === 'AAAA'),
  );

  /* 8. Расширенное мышление: thinking + без temperature */
  await streamWithScenario(provider, 'thinking', { onDelta: () => undefined }, signal, { reasoningEffort: 'medium' });
  const thinkReq = requests.at(-1).body;
  ok('budget_thinking по усилию', thinkReq.thinking?.type === 'enabled' && thinkReq.thinking.budget_tokens === 4096);
  ok('temperature не уходит при мышлении', thinkReq.temperature === undefined);
  ok('max_tokens больше бюджета', thinkReq.max_tokens > thinkReq.thinking.budget_tokens, String(thinkReq.max_tokens));

  server.close();
  console.log(failures === 0 ? '\n[chui] Anthropic Messages API работает' : `\n[chui] ошибок: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Вызов со «сценарием»: провайдер не умеет заголовки, поэтому подменяем URL. */
function streamWithScenario(provider, scenario, handlers, signal, extra = {}) {
  // Сценарий выбирает сервер по заголовку x-scenario; провайдер его не ставит,
  // поэтому здесь идём тем же классом, но с прокси-URL, а заголовок задаёт fetch.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) =>
    originalFetch(url, { ...init, headers: { ...(init.headers ?? {}), 'x-scenario': scenario } });
  return provider
    .streamChat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'x' }], ...extra }, handlers, signal)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
