/**
 * Проба переходов: видит ли редактор соседние файлы проекта.
 *
 *   npm run probe:nav [путь-к-проекту]
 *
 * Проверяем две вещи, которых не поймать юнит-тестами (там нет ни Monaco, ни
 * сервиса TypeScript, ни живого окна):
 *
 * 1. Node/TypeScript. Открываем файл, который импортирует соседний модуль.
 *    Встроенный сервис TypeScript должен знать этот модуль — иначе он подчёркивает
 *    импорт «Cannot find module» и переход по нему никуда не ведёт. Контроль: файл
 *    с НАСТОЯЩИМ промахом (импорт несуществующего модуля) обязан остаться с ошибкой —
 *    так видно, что мы не просто выключили проверку.
 *
 * 2. Python. Спрашиваем у языкового сервера переход к определению из второго файла
 *    в первый — ровно то, что делает Ctrl+Click. Сервер поднимается только если он
 *    настроен и есть в PATH; без сервера проба честно об этом скажет.
 *
 * Считаем проблемы в статусбаре: он показывает то же, что видит человек.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');
const { LspService } = require('../dist/main/lsp/lsp.js');
const { pythonInterpreterFor } = require('../dist/main/python/environments.js');
const { projectEnv } = require('../dist/main/project-env.js');

registerAppScheme();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (window, expression, timeoutMs = 30000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Открыть файл кликом в дереве: сперва папку, потом сам файл. */
const clickTree = (window, name) =>
  ask(
    window,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
      );
      if (!row) return 'нет узла';
      // Папка раскрывается одним кликом, файл может требовать двойной (настройка),
      // поэтому шлём оба события: нам нужно именно открыть.
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return 'кликнут';
    })()`,
    10000,
  );

/** Какая вкладка открыта: так видно, что файл действительно показан редактору. */
const activeTab = (window) => ask(window, `document.querySelector('.tab.is-active')?.textContent ?? null`, 10000);

/** Дождаться, пока файл станет активной вкладкой: открытие идёт вслед за кликом. */
const waitForTab = async (window, name, seconds = 10) => {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1) {
    await wait(1000);
    const tab = await activeTab(window);
    if (typeof tab === 'string' && tab.includes(name)) return tab;
  }
  return `не дождались: ${await activeTab(window)}`;
};

/** Наблюдать за статусбаром: сервис TypeScript отвечает не мгновенно. */
const watchProblems = async (window, label, seconds) => {
  for (let elapsed = 0; elapsed < seconds; elapsed += 3) {
    await wait(3000);
    const state = await problems(window);
    console.log(`[проба] ${label}, ${elapsed + 3} с: ${JSON.stringify(state)}`);
    if (state.показано) return;
  }
};

/** Что показывает статусбар про проблемы. */
const problems = (window) =>
  ask(
    window,
    `(() => {
      const item = document.querySelector('.status-problems');
      if (!item) return { есть: false };
      return { показано: !item.hidden, счётчики: item.querySelector('.status-problems-counts')?.textContent ?? null };
    })()`,
    10000,
  );

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-nav-probe-'));
  const project = process.argv[2] ?? path.join(dir, 'demo-project');

  if (!process.argv[2]) {
    await fs.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.mkdir(path.join(project, 'pkg'), { recursive: true });
    // Сосед, который есть: импорт должен найтись.
    await fs.writeFile(path.join(project, 'src', 'b.ts'), 'export const value = 41;\n', 'utf8');
    await fs.writeFile(
      path.join(project, 'src', 'a.ts'),
      "import { value } from './b';\nconsole.log(value + 1);\n",
      'utf8',
    );
    // Контроль: соседа нет — ошибка обязана остаться.
    await fs.writeFile(
      path.join(project, 'src', 'c.ts'),
      "import { nope } from './nope';\nconsole.log(nope);\n",
      'utf8',
    );
    // Python: определение в другом файле — то же, что делает Ctrl+Click.
    await fs.writeFile(path.join(project, 'pkg', 'alpha.py'), 'def helper() -> int:\n    return 7\n', 'utf8');
    await fs.writeFile(path.join(project, 'pkg', 'beta.py'), 'from alpha import helper\n\nprint(helper())\n', 'utf8');
  }

  serveRenderer();

  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  const lsp = new LspService(
    () => workspace.rootPath(),
    () => settings.get().lsp,
    (topic, payload) => pushToRenderers(topic, payload),
    () => pythonInterpreterFor(workspace.rootPath(), settings.get().run.pythonPath),
    () => projectEnv(workspace.rootPath()),
  );
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient(), lsp });

  await workspace.open(project);
  console.log(`[проба] проект: ${project}`);

  const ide = openIdeWindow();
  await wait(6000);

  /* ── Node: соседний модуль виден ────────────────────────────────────────── */

  console.log(`[проба] раскрыть src: ${JSON.stringify(await clickTree(ide, 'src'))}`);
  await wait(1500);
  console.log(`[проба] открыть a.ts: ${JSON.stringify(await clickTree(ide, 'a.ts'))}`);
  console.log(`[проба] вкладка: ${JSON.stringify(await waitForTab(ide, 'a.ts'))}`);
  // Сервис TypeScript отвечает не сразу: даём ему время.
  await watchProblems(ide, 'a.ts (импорт есть)', 15);

  console.log(`[проба] открыть c.ts: ${JSON.stringify(await clickTree(ide, 'c.ts'))}`);
  console.log(`[проба] вкладка: ${JSON.stringify(await waitForTab(ide, 'c.ts'))}`);
  await watchProblems(ide, 'c.ts (импорта нет)', 15);

  /* ── Python: переход к определению в другой файл ───────────────────────── */

  const status = await lsp.status();
  console.log(`[проба] серверы: ${JSON.stringify(status)}`);
  if (status.running.length === 0) {
    console.log('[проба] языковой сервер не настроен: Python-переход проверить нечем');
  }

  const beta = path.join(project, 'pkg', 'beta.py');
  const alpha = path.join(project, 'pkg', 'alpha.py');
  const text = await fs.readFile(beta, 'utf8');
  await lsp.open(beta, 'python', text);
  // Строка 3, столбец 8 — имя `helper` в вызове `print(helper())`.
  const definitions = await lsp.definition(beta, 'python', text, 3, 8);
  console.log(`[проба] Python-переход: ${JSON.stringify(definitions)}`);
  console.log(`[проба] ожидаем файл: ${alpha}`);

  terminals.dispose();
  lsp.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
