/**
 * Проба трассы прогона: строка итога под ответом и окно «Прогон».
 *
 *   npm run probe:runlog
 *
 * Трассу собирает main (он один знает системные сообщения, состав инструментов и
 * время шага), показывает renderer. Юнит-тесты проверяют только подписи
 * (`tests/run-log.test.ts`), а стык «прогон → строка → окно» виден лишь в живом
 * окне, поэтому здесь:
 *
 *   1. после настоящего прогона под ответом появляется строка итога со временем,
 *      шагами и вызовами;
 *   2. она нажимается и открывает окно трассы, разложенное по шапке, телу и подвалу;
 *   3. в окне есть раздел «Что ушло модели» (системные инструкции и контекст
 *      проекта отдельными блоками) и шаги с вызовами — с временем и итогом;
 *   3а. у вызова пять вкладок (сводка, аргументы, результат, схема, время),
 *      и каждая показывает своё: поля аргументов, схему инструмента, разбор времени;
 *   4. пустой случай тоже честный: без прогона окно говорит, что прогонов не было.
 *
 * Модель подменена локальным OpenAI-совместимым сервером: он отвечает одним
 * вызовом инструмента и затем текстом — этого хватает, чтобы в трассе был
 * не один шаг. Нужен собранный код (`npm run build`).
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { ChatStore } = require('../dist/main/ai/chat-store.js');
const { GitService } = require('../dist/main/git/git.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();
app.on('window-all-closed', () => {});

let failed = 0;
const check = (label, condition, extra) => {
  if (!condition) failed += 1;
  const tail = extra !== undefined ? `: ${JSON.stringify(extra)}` : '';
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${tail}`);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 30_000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/**
 * Провайдер с двумя шагами: на первом модель зовёт инструмент, на втором —
 * отвечает текстом. Так в трассе появляется ровно то, что нужно проверить:
 * шаг с вызовом и время у него.
 */
function fakeProvider(projectDir) {
  let calls = 0;
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      calls += 1;
      const body = raw ? JSON.parse(raw) : {};
      const hasToolResult = (body.messages ?? []).some((message) => message.role === 'tool');
      response.writeHead(200, { 'content-type': 'text/event-stream' });

      const chunk = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (!hasToolResult) {
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'probe-call-1',
                    type: 'function',
                    function: { name: 'list_dir', arguments: JSON.stringify({ path: projectDir }) },
                  },
                ],
              },
            },
          ],
        });
        chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        chunk({ choices: [{ delta: { content: 'Проба: список получен, отвечаю.' } }] });
        chunk({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 18 },
        });
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls: () => calls }));
  });
}

app
  .whenReady()
  .then(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-runlog-'));
    const project = path.join(dir, 'demo');
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'main.py'), 'print(1)\n', 'utf8');
    // Проект нужен раньше провайдера: вызов инструмента в пробе идёт по нему.
    const provider = await fakeProvider(project);
    await fs.writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        ai: {
          enabled: true,
          providers: [
            {
              id: 'probe',
              label: 'Probe',
              baseUrl: `http://127.0.0.1:${provider.port}/v1`,
              models: ['probe-1'],
              defaultModel: 'probe-1',
              apiKey: 'key',
            },
          ],
          activeProviderId: 'probe',
          activeModel: 'probe-1',
          systemPrompt: 'ПРОБНЫЕ-ИНСТРУКЦИИ: отвечай кратко.',
          maxSteps: 6,
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
    const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
    const host = new HostClient();
    registerIpc({
      settings,
      workspace,
      ai,
      terminals,
      git,
      chatStore: new ChatStore(path.join(dir, 'chats')),
      host,
    });
    await workspace.open(project);

    const ide = openIdeWindow();
    await wait(6000);

    // Права «Правки»: команды агента не спрашиваем, а list_dir — чтение, он и так проходит.
    // Права «Спрашивать», но режим — «Агент»: инструменты должны быть предложены
    // модели (без них вкладка «Схема» была бы пуста, и проверять её было бы не на чем).
    const opened = await ask(
      ide,
      `(async () => {
        if (!document.querySelector('.chat-panel')?.getBoundingClientRect().width) {
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
        const input = document.querySelector('.chat-panel textarea, .chat-footer textarea');
        if (!input) return { error: 'нет поля ввода' };
        input.value = 'Покажи список файлов проекта';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 4000));
        return { отправлено: true, режим: mode?.querySelector('.select-value')?.textContent ?? null };
      })()`,
    );
    check('вопрос отправлен', opened?.отправлено === true, opened);
    check('режим — «Агент»: инструменты предложены', opened?.режим === 'Агент', opened?.режим);
    check('модель ответила дважды: вызов и текст', provider.calls() >= 2, provider.calls());

    /* ── 1. строка итога под ответом ──────────────────────────────────────── */

    const line = await ask(
      ide,
      `(() => {
        const node = document.querySelector('.run-summary');
        if (!node) return null;
        return {
          текст: (node.textContent ?? '').replace(/\\s+/g, ' ').trim(),
          подсказка: node.getAttribute('title') ?? '',
          кнопка: node.tagName,
        };
      })()`,
    );

    check('под ответом появилась строка итога', line !== null, line === null ? 'строки нет' : undefined);
    check('в строке названо время прогона', /\d+ (мс|с|м)/.test(line?.текст ?? ''), line?.текст);
    check('в строке названы шаги', (line?.текст ?? '').includes('шаг'), line?.текст);
    check('в строке названы вызовы', (line?.текст ?? '').includes('вызов'), line?.текст);
    check('строка — кнопка с подсказкой', line?.кнопка === 'BUTTON' && (line?.подсказка ?? '').length > 0, line);

    /* ── 2. окно трассы ───────────────────────────────────────────────────── */

    const dialog = await ask(
      ide,
      `(async () => {
        document.querySelector('.run-summary').click();
        await new Promise((r) => setTimeout(r, 700));
        const modal = document.querySelector('.run-modal');
        if (!modal) return null;
        const box = (node) => {
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), h: Math.round(rect.height) };
        };
        return {
          окно: box(modal),
          шапка: box(modal.querySelector('.modal-header')),
          тело: box(modal.querySelector('.modal-body')),
          итог: (modal.querySelector('.run-total')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
          разделов: [...modal.querySelectorAll('.run-section-title')].map((n) => n.textContent),
          свёрнутых: modal.querySelectorAll('.run-fold').length,
          шагов: modal.querySelectorAll('.run-step').length,
          вызовов: modal.querySelectorAll('.run-call').length,
          имяВызова: modal.querySelector('.run-call-name')?.textContent ?? '',
          времяВызова: modal.querySelector('.run-call-time')?.textContent ?? '',
          модель: (modal.querySelector('.run-frame')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        };
      })()`,
    );

    check('окно трассы открылось', dialog !== null, dialog === null ? 'окна нет' : undefined);
    check(
      'окно разложено по шапке и телу',
      Boolean(dialog?.шапка && dialog?.тело && dialog.шапка.bottom === dialog.тело.top),
      dialog && { шапка: dialog.шапка.bottom, тело: dialog.тело.top },
    );
    check('в итоге окна те же цифры', (dialog?.итог ?? '').includes('шаг'), dialog?.итог);
    check(
      'есть раздел «Что ушло модели» и «Шаги прогона»',
      (dialog?.разделов ?? []).includes('Что ушло модели') && (dialog?.разделов ?? []).includes('Шаги прогона'),
      dialog?.разделов,
    );
    check('инструкции и контекст свёрнуты в блоки', (dialog?.свёрнутых ?? 0) >= 2, dialog?.свёрнутых);
    check('шагов больше одного: был вызов инструмента', (dialog?.шагов ?? 0) >= 2, dialog?.шагов);
    check('в шаге виден вызов', (dialog?.вызовов ?? 0) >= 1, dialog?.вызовов);
    check('вызов назван по имени инструмента', dialog?.имяВызова === 'list_dir', dialog?.имяВызова);
    check('у вызова есть время', /(мс|с)$/.test(dialog?.времяВызова ?? ''), dialog?.времяВызова);
    check('в рамке видно модель и режим', (dialog?.модель ?? '').includes('probe-1'), dialog?.модель);
    /* ── 2б. вкладки вызова ─────────────────────────────────────────────── */

    const tabs = await ask(
      ide,
      `(async () => {
        const call = document.querySelector('.run-call');
        if (!call) return null;
        const strip = [...call.querySelectorAll('.run-call-tab')];
        const shown = () => {
          const node = [...call.querySelectorAll('.run-call-panel')].find((panel) => !panel.hidden);
          return (node?.textContent ?? '').replace(/\\s+/g, ' ').trim();
        };
        const pick = async (label) => {
          strip.find((node) => node.textContent === label)?.click();
          await new Promise((r) => setTimeout(r, 150));
          return { текст: shown(), активно: strip.filter((node) => node.classList.contains('is-active')).length };
        };
        return {
          подписи: strip.map((node) => node.textContent),
          сводка: shown(),
          аргументы: await pick('Аргументы'),
          схема: await pick('Схема'),
          время: await pick('Время'),
        };
      })()`,
    );

    check(
      'у вызова пять вкладок',
      JSON.stringify(tabs?.подписи) === JSON.stringify(['Сводка', 'Аргументы', 'Результат', 'Схема', 'Время']),
      tabs?.подписи,
    );
    check('открыта сводка вызова', (tabs?.сводка ?? '').length > 0, tabs?.сводка);
    check('в аргументах есть поля вызова', (tabs?.аргументы?.текст ?? '').includes('path'), tabs?.аргументы?.текст);
    check('в схеме видны поля инструмента', (tabs?.схема?.текст ?? '').includes('properties'), tabs?.схема?.текст);
    check(
      'во времени есть начало и иерархия',
      (tabs?.время?.текст ?? '').includes('начало') && (tabs?.время?.текст ?? '').includes('вызов 1 из'),
      tabs?.время?.текст,
    );
    check(
      'открыта ровно одна вкладка',
      [tabs?.аргументы?.активно, tabs?.схема?.активно, tabs?.время?.активно].every((count) => count === 1),
      [tabs?.аргументы?.активно, tabs?.схема?.активно, tabs?.время?.активно],
    );

    /* ── 3. системные инструкции в окне ───────────────────────────────────── */

    const instructions = await ask(
      ide,
      `(() => {
        const modal = document.querySelector('.run-modal');
        const folds = [...modal.querySelectorAll('.run-fold')];
        const target = folds.find((node) => (node.querySelector('.run-fold-head')?.textContent ?? '').includes('Системные инструкции'));
        if (!target) return 'нет блока инструкций';
        target.open = true;
        return (target.querySelector('.run-text')?.textContent ?? '').slice(0, 80);
      })()`,
    );
    check(
      'в трассе есть настоящие системные инструкции',
      String(instructions).includes('ПРОБНЫЕ-ИНСТРУКЦИИ'),
      instructions,
    );

    /* ── 4. пустой случай ─────────────────────────────────────────────────── */

    pushToRenderers('menu:command', { command: 'ai.newChat' });
    await wait(600);
    pushToRenderers('menu:command', { command: 'ai.runLog' });
    await wait(700);

    const emptiness = await ask(
      ide,
      `(() => {
        const modal = document.querySelector('.run-modal');
        if (!modal) return null;
        return {
          пусто: (modal.querySelector('.run-empty')?.textContent ?? '').trim(),
          шагов: modal.querySelectorAll('.run-step').length,
        };
      })()`,
    );
    check('в новой беседе окно говорит, что прогонов не было', (emptiness?.пусто ?? '').length > 0, emptiness);
    check('и не показывает чужих шагов', emptiness?.шагов === 0, emptiness?.шагов);

    const shots = path.join(__dirname, '..', '.chui_ide', 'probe-shots');
    await fs.mkdir(shots, { recursive: true });
    await ask(ide, `(() => { document.querySelector('.modal .icon-btn')?.click(); return true; })()`);
    await wait(300);
    await ask(ide, `(() => { document.querySelector('.run-summary')?.click(); return true; })()`);
    await wait(600);
    const shot = path.join(shots, 'run-log.png');
    await fs.writeFile(shot, (await ide.capturePage()).toPNG());

    console.log(failed === 0 ? '\nтрасса прогона: строка итога и окно на месте' : `\nпровалов: ${failed}`);
    console.log(`Снимок: ${shot}`);

    provider.server.close();
    terminals.dispose();
    workspace.dispose();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    app.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error('[проба] сбой:', error);
    app.exit(1);
  });
