/**
 * Проба панели живых агентов: кто работает, чем занят и как его снять.
 *
 *   npm run probe:agents
 *
 * Юниты (`tests/agents.test.ts`) проверяют реестр без окна. Здесь — то, чего они
 * не видят: панель над полем ввода, живой прогон с двумя подзадачами и действия
 * человека по ним.
 *
 * Проверяем:
 *
 *  1. ход запустил двух агентов — панель появилась и назвала их число;
 *  2. у работающего видно состояние, чем занят, время и обе кнопки — «остановить»
 *     и «сказать»;
 *  3. сообщение доезжает: текст, отправленный человеком, оказывается в следующем
 *     запросе к модели (так работает почта агента — «перед следующим шагом»);
 *  4. «остановить» снимает одного: у него `stopped`, второй продолжает и `done`;
 *  5. панель сворачивается в строку и разворачивается обратно;
 *  6. в ленте есть карточка подзадач со сводкой — панель её не подменяет.
 *
 * Провайдер подменён локальным сервером (как в `probe:runlog`): прогон настоящий,
 * модель отвечает по сценарию. Подзадача идёт медленно нарочно — иначе сообщение
 * и остановка не успели бы попасть между её шагами.
 *
 * Снимок — `.chui_ide/probe-shots/agents-panel.png`.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { PushTopic } = require('../dist/shared/api.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();
app.on('window-all-closed', () => {});

const PROJECT = path.join(__dirname, '..');
const SHOTS = path.join(PROJECT, '.chui_ide', 'probe-shots');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`[проба] ${text}`);

let failed = 0;
const check = (label, condition, extra) => {
  if (!condition) failed += 1;
  const tail = extra !== undefined ? `: ${JSON.stringify(extra)}` : '';
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${tail}`);
};

const ask = (window, expression, timeoutMs = 30_000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Что пришло модели в подзадаче: по этому видно, доехало ли сообщение человека. */
const SUB_TEXTS = [];

/** Сколько модель «думает» над шагом подзадачи: человеку нужно окно на действие. */
const SUBAGENT_DELAY = 2600;

/**
 * Провайдер по сценарию. Главный агент на первом шаге заказывает бригаду из двух
 * подзадач (`task` с `tasks`), на втором — отвечает текстом. Подзадача на первом
 * шаге читает файл, на втором отдаёт отчёт; между шагами она ждёт, поэтому почта
 * и остановка попадают как раз туда, где их обрабатывает прогон.
 */
function fakeProvider(projectDir) {
  let mainCalls = 0;
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      const messages = body.messages ?? [];
      const isSubagent = messages.some(
        (message) => message.role === 'system' && String(message.content ?? '').includes('(sub-agent)'),
      );
      const hasToolResult = messages.some((message) => message.role === 'tool');

      const chunk = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      const finish = (reason, usage) => {
        chunk({ choices: [{ delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) });
        response.write('data: [DONE]\n\n');
        response.end();
      };

      response.writeHead(200, { 'content-type': 'text/event-stream' });

      if (isSubagent) {
        // Всё, что увидела подзадача: по этому проверяется доставка сообщения.
        SUB_TEXTS.push(messages.map((message) => String(message.content ?? '')).join('\n'));
        await wait(SUBAGENT_DELAY);
        if (!hasToolResult) {
          chunk({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `sub-${SUB_TEXTS.length}`,
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: path.join(projectDir, 'main.py') }),
                      },
                    },
                  ],
                },
              },
            ],
          });
          finish('tool_calls');
          return;
        }
        chunk({ choices: [{ delta: { content: 'Отчёт: файл прочитан, ничего опасного.' } }] });
        finish('stop', { prompt_tokens: 80, completion_tokens: 12 });
        return;
      }

      mainCalls += 1;
      if (!hasToolResult) {
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `main-${mainCalls}`,
                    type: 'function',
                    function: {
                      name: 'task',
                      arguments: JSON.stringify({
                        tasks: [
                          { description: 'Первый разбор', prompt: 'Прочитай main.py и скажи, что там.' },
                          { description: 'Второй разбор', prompt: 'Прочитай main.py и скажи, что там ещё.' },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
        finish('tool_calls');
        return;
      }
      chunk({ choices: [{ delta: { content: 'Бригада закончила: оба отчёта у меня.' } }] });
      finish('stop', { prompt_tokens: 140, completion_tokens: 20 });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Состояние панели: заголовок, строки агентов и их кнопки. */
const PANEL = `(() => {
  const box = document.querySelector('.composer-agents');
  if (!box || box.hidden) return { видна: false, строки: [] };
  const chat = document.querySelector('.chat');
  return {
    видна: true,
    // Панель агентов живёт в композере: если сам чат не показан, снимок был бы пустым.
    чатВиден: chat ? chat.getBoundingClientRect().width > 0 : false,
    заголовок: document.querySelector('.agents-title')?.textContent ?? '',
    строки: [...document.querySelectorAll('.agent-row')].map((row) => ({
      класс: row.className,
      имя: row.querySelector('.agent-name')?.textContent ?? '',
      мета: row.querySelector('.agent-meta')?.textContent ?? '',
      занят: row.querySelector('.agent-activity')?.textContent ?? '',
      стоп: row.querySelector('[title^="Остановить"]') !== null,
      сказать: row.querySelector('[title^="Сказать"]') !== null,
    })),
    свёрнута: document.querySelector('.agents-collapsed') !== null,
  };
})()`;

/** Открыть чат и отправить вопрос в режиме «Агент». */
const OPEN_CHAT = `(async () => {
  if (!document.querySelector('.chat')?.getBoundingClientRect().width) {
    document.querySelector('[title*="AI Assistant"]')?.click();
    await new Promise((r) => setTimeout(r, 600));
  }
  const mode = [...document.querySelectorAll('.composer-select')].find((node) => {
    const text = node.querySelector('.select-value')?.textContent ?? '';
    return ['Вопрос', 'Агент', 'План'].includes(text);
  });
  if (mode) {
    mode.click();
    await new Promise((r) => setTimeout(r, 150));
    [...document.querySelectorAll('.select-popup .select-item')]
      .find((node) => (node.querySelector('.select-item-label')?.textContent ?? '') === 'Агент')
      ?.click();
    await new Promise((r) => setTimeout(r, 250));
  }
  const input = document.querySelector('.chat-input');
  if (!input) return { error: 'нет поля ввода' };
  input.value = 'Разбери проект двумя подзадачами';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  return { отправлено: true, поле: input.value, режим: mode?.querySelector('.select-value')?.textContent ?? null };
})()`;

/** Нажать кнопку с подсказкой в строке агента: 0 — первый, 1 — второй. */
const clickInRow = (win, index, titlePrefix) =>
  ask(
    win,
    `(() => {
      const row = [...document.querySelectorAll('.agent-row')][${index}];
      if (!row) return 'нет строки';
      const button = row.querySelector('[title^="${titlePrefix}"]');
      if (!button) return 'нет кнопки';
      button.click();
      return 'нажата';
    })()`,
  );

/** Сказать агенту: поле открывается кнопкой «Сказать», Enter отправляет. */
const messageAgent = (win, index, text) =>
  ask(
    win,
    `(async () => {
      const row = [...document.querySelectorAll('.agent-row')][${index}];
      if (!row) return 'нет строки';
      row.querySelector('[title^="Сказать"]')?.click();
      await new Promise((r) => setTimeout(r, 200));
      const input = document.querySelector('.agent-message');
      if (!input) return 'нет поля';
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return 'отправлено';
    })()`,
  );

app.whenReady().then(async () => {
  step('старт');
  await fs.mkdir(SHOTS, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-agents-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'main.py'), 'print("привет")\n', 'utf8');

  const provider = await fakeProvider(project);
  const baseUrl = `http://127.0.0.1:${provider.port}/v1`;

  // Настройки — файлом, а не `update`: так в них ровно один провайдер (сборщик
  // настроек иначе оставляет свой «OpenAI» первым, и прогон ушёл бы в него).
  // Ключ миграция перенесёт в credentials.json — как в жизни.
  await fs.writeFile(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      ai: {
        enabled: true,
        providers: [
          {
            id: 'probe',
            label: 'Probe',
            baseUrl,
            models: ['probe-1'],
            defaultModel: 'probe-1',
            apiKey: 'probe-key',
          },
        ],
        activeProviderId: 'probe',
        activeModel: 'probe-1',
        systemPrompt: '',
        maxSteps: 6,
        maxTokens: 256,
        compactAtTokens: 100_000,
        temperature: 0,
        reasoningEffort: 'off',
        confirmDangerous: true,
      },
    }),
    'utf8',
  );

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));

  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  // Полный доступ: подтверждений в пробе не ждём — проверяем панель, а не ревью.
  ai.setPermission('full');
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  // Как в приложении (`main/index.ts`): список живых агентов едет push-событием,
  // панель на него подписана и по таймеру ничего не спрашивает.
  ai.onAgentsChanged((agents) => pushToRenderers(PushTopic.Agents, { agents }));
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  step('спрашиваю агента: две подзадачи разом');
  const opened = await ask(ide, OPEN_CHAT);
  check('вопрос отправлен', opened?.отправлено === true, opened);

  // Панель появляется на первом push-событии реестра: ждём её, а не фиксированную паузу.
  let panel = { видна: false, строки: [] };
  for (let attempt = 0; attempt < 40 && panel.строки.length < 2; attempt += 1) {
    await wait(250);
    panel = await ask(ide, PANEL);
  }
  check('панель агентов появилась', panel.видна === true, panel);
  check('в заголовке названо число агентов', (panel.заголовок ?? '').includes('Агенты: 2'), panel.заголовок);
  check(
    'в списке двое',
    panel.строки.length === 2,
    panel.строки.map((row) => row.имя),
  );
  step('состояние работающего агента');
  const first = panel.строки[0] ?? {};
  check('агент назван по описанию', first.имя === 'Первый разбор', first.имя);
  check('в строке видно состояние и номер', (first.мета ?? '').includes('agent-1'), first.мета);
  check('в строке видно, чем занят', (first.занят ?? '').length > 0, first.занят);
  check('у работающего есть «остановить» и «сказать»', first.стоп === true && first.сказать === true, first);
  check('панель агентов стоит в чате, а не в скрытом узле', panel.чатВиден === true, panel.чатВиден);
  // Снимок — пока агенты идут: на нём видно то, ради чего панель и сделана.
  const shot = await ide.capturePage();
  await fs.writeFile(path.join(SHOTS, 'agents-panel.png'), shot.toPNG());
  step('сворачиваю панель');
  const collapsed = await ask(
    ide,
    `(() => {
      const toggle = document.querySelector('.agent-toggle');
      if (!toggle) return 'нет кнопки';
      toggle.click();
      return 'нажата';
    })()`,
  );
  check('кнопка сворачивания нажата', collapsed === 'нажата', collapsed);
  await wait(400);
  const folded = await ask(ide, PANEL);
  check(
    'свёрнутая панель прячет строки и называет идущих',
    folded.свёрнута === true && folded.строки.length === 0,
    folded,
  );
  // Разворачиваем обратно: дальше нужны строки с кнопками.
  await ask(
    ide,
    `(() => {
      document.querySelector('.agent-toggle')?.click();
      return 'нажата';
    })()`,
  );
  await wait(300);

  step('говорю первому агенту слово');
  const NOTE = 'Сделай упор на тесты, а не на стиль';
  check('сообщение отправлено из панели', (await messageAgent(ide, 0, NOTE)) === 'отправлено');

  step('снимаю второго агента');
  check('кнопка «остановить» нажата', (await clickInRow(ide, 1, 'Остановить')) === 'нажата');

  // Ждём конца хода: первый агент доходит до отчёта, второй остаётся снят.
  let final = { строки: [] };
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(500);
    final = await ask(ide, PANEL);
    const classes = (final.строки ?? []).map((row) => row.класс);
    if (classes.some((name) => name.includes('is-stopped')) && classes.some((name) => name.includes('is-done'))) break;
  }
  const classes = (final.строки ?? []).map((row) => row.класс);
  check(
    'снятый агент помечен «остановлен»',
    classes.some((name) => name.includes('is-stopped')),
    classes,
  );
  check(
    'второй агент доработал до отчёта',
    classes.some((name) => name.includes('is-done')),
    classes,
  );
  // Сообщение человека — не «отправлено и забыто»: оно в следующем запросе к модели.
  check(
    'сообщение доехало агенту перед шагом',
    SUB_TEXTS.some((text) => text.includes(NOTE)),
    SUB_TEXTS.length,
  );

  step('смотрю ленту: сводка подзадач на месте');
  const feed = await ask(
    ide,
    `(() => {
      const cards = [...document.querySelectorAll('.tool-card')];
      const head = cards.map((card) => (card.querySelector('.tool-head')?.textContent ?? '').trim());
      return {
        карточек: cards.length,
        заголовки: head,
        лента: (document.querySelector('.chat-thread')?.textContent ?? '').slice(-400),
      };
    })()`,
  );
  check('в ленте есть карточка вызова', feed.карточек > 0, feed.карточек);
  // Карточка — не вместо панели, а рядом: в ней видно, ЧТО заказали.
  // Аргументы в ней обрезаны, поэтому проверяем начало — имя первой подзадачи.
  const cardText = (feed.заголовки ?? []).join(' ');
  check(
    'в карточке ленты видно, что заказали',
    cardText.includes('Подзадача') && cardText.includes('Первый разбор'),
    cardText.slice(0, 160),
  );
  check('ответ модели виден в ленте', (feed.лента ?? '').includes('Бригада закончила'), feed.лента?.slice(0, 120));

  await wait(300);
  console.log(failed === 0 ? '\nпанель агентов работает' : `\nпровалов: ${failed}`);
  console.log(`Снимок: ${path.join(SHOTS, 'agents-panel.png')}`);
  app.exit(failed === 0 ? 0 : 1);
});

// Проба не должна висеть: без этого исключение оставляло окно открытым до таймаута.
process.on('unhandledRejection', (error) => {
  console.error('проба упала:', error);
  app.exit(1);
});
