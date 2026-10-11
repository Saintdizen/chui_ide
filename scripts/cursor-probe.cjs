/**
 * Проба места работы: возвращается ли курсор туда, где он был, после перезапуска.
 *
 *   npm run probe:cursor
 *
 * Запускается ДВУМЯ процессами — в одном окно второго раза не поднять: регистрация
 * обработчиков IPC повторной быть не может. Общий каталог проекта и сессий между
 * запусками передаётся переменными окружения.
 *
 * Проверяем две половины отдельно:
 *
 * 1. `save` — открыть файл в окне и убедиться, что позиция курсора попала в сессию.
 * 2. `check` — положить позицию в сессию ДО запуска и убедиться, что редактор встал
 *    именно на неё. Это и есть возврат на место работы: вкладка открыта, курсор там,
 *    где его оставили, а не в начале файла.
 *
 * Позицию во втором случае задаём файлом, а не клавишами: движение курсора зависит
 * от того, отдан ли окну фокус системой, и проверка вышла бы не про то, что видит
 * человек.
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
const { SessionStore } = require('../dist/main/session-store.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

/** Строка, на которую должен встать курсор в проверке возврата. */
const TARGET_LINE = 40;
const TARGET_COLUMN = 3;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Открыть файл из дерева: папка раскрывается одним кликом, файл — двойным. */
const openInTree = (window, name) =>
  ask(
    window,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
      );
      if (!row) return 'нет узла';
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return 'кликнут';
    })()`,
  );

/** Позиция курсора из статусбара: это то же число, что видит человек. */
const cursorText = (window) =>
  ask(
    window,
    `[...document.querySelectorAll('.status-item')].map((n) => n.textContent).filter((t) => t && t.includes(':'))[0] ?? null`,
  );

/** Какая вкладка активна. */
const activeTab = (window) => ask(window, `document.querySelector('.tab.is-active')?.textContent ?? null`);

/** Длинный файл: строка 40 заметно отличается от первой. */
async function makeProject(project) {
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  const lines = Array.from({ length: 60 }, (_, index) => `const line${index + 1} = ${index + 1};`);
  await fs.writeFile(path.join(project, 'src', 'long.ts'), `${lines.join('\n')}\n`, 'utf8');
}

app.whenReady().then(async () => {
  const mode = process.env.CHUI_PROBE_MODE ?? 'save';
  const dir = process.env.CHUI_PROBE_DIR ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'chui-cursor-probe-')));
  const project = path.join(dir, 'demo-project');
  const sessionDir = path.join(dir, 'sessions');
  const settingsFile = path.join(dir, 'settings.json');
  const file = path.join(project, 'src', 'long.ts');

  if (mode === 'save') await makeProject(project);
  serveRenderer();

  const settings = new SettingsStore(settingsFile);
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  const sessions = new SessionStore(sessionDir);

  // В проверке возврата позицию кладём в сессию ДО запуска окна: так проверяем
  // именно восстановление, а не движение курсора клавишами.
  if (mode === 'check') {
    sessions.save(project, {
      tabs: [file],
      activeTab: file,
      expanded: [path.join(project, 'src')],
      cursors: { [file]: { line: TARGET_LINE, column: TARGET_COLUMN } },
    });
    console.log(`[проба] в сессию записано: ${TARGET_LINE}:${TARGET_COLUMN}`);
  }

  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient(), sessions });
  await workspace.open(project);
  console.log(`[проба] проект: ${project}`);

  const ide = openIdeWindow();
  await wait(7000);

  if (mode === 'save') {
    await openInTree(ide, 'src');
    await wait(1200);
    console.log(`[проба] открыть файл: ${JSON.stringify(await openInTree(ide, 'long.ts'))}`);
    // Сессия пишется с задержкой: ждём, пока она осядет на диск.
    await wait(3000);
    const saved = sessions.load(project);
    console.log(`[проба] в сессии: ${JSON.stringify(saved.cursors ?? null)}`);
    console.log(`[проба] ожидаем ключ: ${file}`);
  } else {
    console.log(`[проба] вкладка: ${JSON.stringify(await activeTab(ide))}`);
    await wait(2000);
    console.log(`[проба] курсор после перезапуска: ${JSON.stringify(await cursorText(ide))}`);
    console.log(`[проба] ожидаем: ${TARGET_LINE}:${TARGET_COLUMN}`);
  }

  terminals.dispose();
  workspace.dispose();
  // Каталог не убираем: он общий для двух запусков, его чистит внешний скрипт.
  app.exit(0);
});
