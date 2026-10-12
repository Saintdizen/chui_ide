/*
 * Сообщение коммита по diff: запрос к модели без сети и ключа.
 *
 * Локальный сервер отдаёт тот же поток событий (SSE), что и настоящий
 * OpenAI-совместимый провайдер, а сервис разбирает его как обычно. Проверяем
 * провод и сборку: системная инструкция, diff в промпте, факт «с индексом» и
 * обрезка ответа до чистого текста сообщения.
 */
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { AiService } = require('../dist/main/ai/service.js');
const { ProjectMemory } = require('../dist/main/ai/project-memory.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');

let failures = 0;
function ok(name, condition, extra) {
  if (condition) console.log(`  ok   ${name}${extra ? `: ${extra}` : ''}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`);
  }
}

/** Ответ модели одним куском текста в формате OpenAI-совместимого SSE. */
function textSse(text) {
  const chunks = [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 12 } },
  ];
  return chunks.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('') + 'data: [DONE]\n\n';
}

// Модель отвечает «как есть» — с ограждением, точкой в конце темы и подписью:
// ровно то, что она любит добавлять и что в git log не нужно.
const MESSY =
  '```\nСообщение коммита: Редактор: автосообщение коммита.\n\n- кнопка в панели изменений\n- обрезка diff\n```';

const DIFF = [
  'diff --git a/src/renderer/ui/source-control.ts b/src/renderer/ui/source-control.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  '',
].join('\n');

async function main() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.url.endsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test' }] }));
        return;
      }
      requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(textSse(MESSY));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-commitmsg-'));
  const settings = {
    ai: {
      enabled: true,
      providers: [{ id: 'local', label: 'Локальный', baseUrl, models: ['test'], hasApiKey: false }],
      activeProviderId: 'local',
      activeModel: 'test',
      temperature: 0,
      maxTokens: 256,
      compactAtTokens: 100_000,
      systemPrompt: '',
      reasoningEffort: 'off',
      maxSteps: 8,
      confirmDangerous: true,
      webSearch: { enabled: false, provider: 'searxng', endpoint: '', hasApiKey: false },
      browser: { enabled: false, executable: '', headless: true },
      sandbox: { enabled: false, image: 'python:3.12-slim', workdir: '/workspace', network: true },
    },
    get() {
      return this;
    },
    file() {
      return path.join(dir, 'settings.json');
    },
    resolveApiKey() {
      return undefined;
    },
    resolveWebSearchKey() {
      return undefined;
    },
  };

  const workspace = new WorkspaceService(() => undefined);
  const memory = new ProjectMemory(path.join(dir, 'memory'));
  const ai = new AiService(settings, workspace, memory);

  const result = await ai.commitMessage(
    { diff: DIFF, staged: true, branch: 'dev', untracked: ['tests/new.test.ts'] },
    new AbortController().signal,
  );

  ok('запрос ушёл один', requests.length === 1, String(requests.length));
  const body = requests[0]?.body ?? {};
  const system = (body.messages ?? []).find((message) => message.role === 'system')?.content ?? '';
  const user = (body.messages ?? []).find((message) => message.role === 'user')?.content ?? '';

  ok('в запросе есть системная инструкция про сообщение коммита', /сообщение коммита/i.test(system));
  ok('модели сказано писать по-русски и без кавычек', /русски/i.test(system) && /кавыч/i.test(system));
  ok('в промпте лежит сам diff', user.includes('+const b = 2;'), user.slice(0, 60));
  ok('сказано, что коммитятся проиндексированные правки', /проиндексированные/.test(user));
  ok('названа ветка', user.includes('dev'));
  ok('перечислены новые файлы', user.includes('tests/new.test.ts'));
  ok('температура низкая: сообщение — не творчество', body.temperature <= 0.3, String(body.temperature));

  ok('ограждение снято', !result.message.includes('```'), result.message);
  ok('подпись «Сообщение коммита:» снята', !/сообщение коммита:/i.test(result.message));
  ok('тема без точки в конце', result.message.split('\n')[0] === 'Редактор: автосообщение коммита');
  ok('тело из пунктов сохранено', result.message.includes('- обрезка diff'), result.message);

  // Без выбранной модели — понятная ошибка, а не пустое сообщение.
  settings.ai.activeModel = '';
  let failed = '';
  try {
    await ai.commitMessage({ diff: DIFF, staged: false }, new AbortController().signal);
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  }
  ok('без модели ошибка объясняет, что делать', /Не выбрана модель/.test(failed), failed);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(
    failures ? `[chui] сообщение коммита: есть расхождения (${failures})` : '[chui] сообщение коммита работает',
  );
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
