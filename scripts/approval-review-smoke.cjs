/*
 * Проверка подтверждений моделью: запрос, разбор ответа и пределы.
 *
 * Настоящий провайдер не нужен: локальный сервер отдаёт тот же поток SSE, что и
 * OpenAI-совместимый, а сервис разбирает его как обычно. Проверяем то, чего не
 * видно в юнит-тестах (там чистый разбор): провод запроса — какая модель взята,
 * что ушло в промпт, сколько сообщений; отказ в сторону вопроса на мусорном
 * ответе и на ошибке сервера; молчание режет сигнал человека, а не свой предел.
 *
 *   npm run smoke:review
 */
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { AiService } = require('../dist/main/ai/service.js');
const { isDangerousCommand } = require('../dist/main/ai/agent-tools.js');
const { shouldReview } = require('../dist/shared/approval-review.js');
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
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 60, completion_tokens: 8 } },
  ];
  const body = chunks.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('');
  return `${body}data: [DONE]\n\n`;
}

async function main() {
  /** Что сервер ответит на следующий запрос: текст, код ошибки или молчание. */
  let answer = 'ALLOW: только чтение';
  let mode = 'text';
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
      requests.push(raw ? JSON.parse(raw) : null);
      if (mode === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'сервер прилёг' } }));
        return;
      }
      if (mode === 'hang') {
        // Ни ответа, ни закрытия: проверяем собственный предел времени.
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(textSse(answer));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-review-'));
  const settings = {
    ai: {
      enabled: true,
      providers: [{ id: 'local', label: 'Локальный', baseUrl, models: ['test', 'дешёвая'], hasApiKey: false }],
      activeProviderId: 'local',
      activeModel: 'test',
      temperature: 0,
      maxTokens: 256,
      compactAtTokens: 100_000,
      systemPrompt: '',
      reasoningEffort: 'off',
      maxSteps: 8,
      approvalReview: true,
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
  const ai = new AiService(settings, workspace, undefined);

  /* ── 1. разрешение ────────────────────────────────────────────────────── */

  answer = 'ALLOW: команда только читает каталог';
  const allow = await ai.reviewCommand('ls -la', '/tmp/project', new AbortController().signal);
  ok('разрешение прочитано', allow?.decision === 'allow', JSON.stringify(allow));
  ok('причина сохранена', allow?.reason === 'команда только читает каталог', allow?.reason);

  const sent = requests.at(-1) ?? {};
  ok('в запросе ровно два сообщения: инструкция и команда', sent.messages?.length === 2, sent.messages?.length);
  ok('инструкция требует одну строку', /ALLOW:/.test(sent.messages?.[0]?.content ?? ''));
  ok(
    'команда и проект ушли в запрос',
    (sent.messages?.[1]?.content ?? '').includes('ls -la') &&
      (sent.messages?.[1]?.content ?? '').includes('/tmp/project'),
  );
  ok('инструментов и истории в запросе нет', sent.tools === undefined && sent.messages?.length === 2);
  ok('взята активная модель', sent.model === 'test', sent.model);
  ok(
    'потолок ответа маленький: это решение, а не рассказ',
    typeof sent.max_tokens === 'number' && sent.max_tokens <= 100,
    sent.max_tokens,
  );

  /* ── 2. вопрос человеку ───────────────────────────────────────────────── */

  answer = 'ASK: команда ставит пакеты в систему';
  const ask = await ai.reviewCommand('npm install left-pad', '/tmp/project', new AbortController().signal);
  ok('вопрос человеку прочитан', ask?.decision === 'ask', JSON.stringify(ask));

  answer = 'Думаю, можно';
  const garbage = await ai.reviewCommand('ls', '/tmp/project', new AbortController().signal);
  ok('ответ не по форме — вопрос человеку', garbage?.decision === 'ask', JSON.stringify(garbage));

  /* ── 3. модель проверки из настроек ───────────────────────────────────── */

  settings.ai.reviewModel = 'дешёвая';
  answer = 'ALLOW: чтение';
  await ai.reviewCommand('cat README.md', '/tmp/project', new AbortController().signal);
  ok('проверяет модель из настроек, а не активная', requests.at(-1)?.model === 'дешёвая', requests.at(-1)?.model);
  delete settings.ai.reviewModel;

  /* ── 4. сбой и молчание сервера — решение за человеком ────────────────── */

  mode = 'error';
  const failed = await ai.reviewCommand('ls', '/tmp/project', new AbortController().signal);
  ok('ошибка сервера — не разрешение', failed === null, JSON.stringify(failed));

  mode = 'hang';
  const started = Date.now();
  // Предела времени у проверки больше нет: прогон и так ограничен сигналом
  // человека, а жёсткий предел рвал нормальный медленный ответ. Своё ждёт
  // терпеливо; здесь его будит человек через 12с — это и должно произойти.
  const person = new AbortController();
  setTimeout(() => person.abort(), 12_000);
  const hung = await ai.reviewCommand('ls', '/tmp/project', person.signal);
  const waited = Date.now() - started;
  ok('молчащий сервер — не разрешение', hung === null, JSON.stringify(hung));
  ok('молчание режет сигнал человека', waited < 14_000, `${waited} мс`);
  mode = 'text';

  /* ── 5. без провайдера проверять нечем ────────────────────────────────── */

  const saved = settings.ai.activeProviderId;
  delete settings.ai.activeProviderId;
  const noProvider = await ai.reviewCommand('ls', null, new AbortController().signal);
  ok('без провайдера — null, а не отказ', noProvider === null, JSON.stringify(noProvider));
  settings.ai.activeProviderId = saved;

  /* ── 6. правило «что вообще проверяем» ────────────────────────────────── */

  // Ровно те две функции, которыми пользуется мост в main/ipc/register.ts.
  const gate = (command) => shouldReview(command, { enabled: true, dangerous: isDangerousCommand(command) });
  ok('обычная команда проверяется', gate('git status --short') === true);
  ok('сборка проверяется', gate('npm run build') === true);
  ok('удаление — мимо модели, к человеку', gate('rm -rf build') === false);
  ok('sudo — мимо модели, к человеку', gate('sudo systemctl restart nginx') === false);
  ok('force-push — мимо модели, к человеку', gate('git push --force origin main') === false);

  server.close();
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);

  console.log(
    failures === 0 ? '\nпроверка подтверждений: провод, разбор и пределы в порядке' : `\nпровалов: ${failures}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[smoke] сбой:', error);
  process.exit(1);
});
