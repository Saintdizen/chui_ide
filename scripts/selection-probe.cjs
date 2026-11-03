// Проба выбора в дереве: несколько файлов, отметка ctrl+кликом, затем обновление
// дерева (на диске меняется файл — тот же путь, что у сохранения и git-статуса).
// Выбор должен пережить обновление. Запуск: npm run probe:selection

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

// Без этого схема app:// не зарегистрирована и окно грузит пустоту.
registerAppScheme();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Выполнить в окне и дождаться результата. */
const ask = (window, code) =>
  Promise.race([
    window.webContents.executeJavaScript(code, true).catch((error) => `ошибка: ${error.message}`),
    wait(20000).then(() => 'нет ответа'),
  ]);

/** Отметить строку дерева кликом с модификатором (ctrl — добавить к выбору). */
const clickRow = (window, name, ctrl) =>
  ask(
    window,
    `(async () => {
      const findRow = () => [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
      );
      const started = Date.now();
      let row = findRow();
      while (!row && Date.now() - started < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        row = findRow();
      }
      if (!row) {
        const names = [...document.querySelectorAll('.tree-name')].map((node) => node.textContent).join(',');
        return 'нет узла ' + ${JSON.stringify(name)} + '; видно: [' + names + ']';
      }
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${ctrl ? 'true' : 'false'} }));
      return 'кликнут';
    })()`,
  );

/** Что сейчас выделено в дереве — по имени строки. */
const selectedNames = (window) =>
  ask(
    window,
    `[...document.querySelectorAll('.tree-row.is-selected')].map(
      (row) => row.querySelector('.tree-name')?.textContent,
    )`,
  );

/**
 * Пометить все строки дерева. Новые строки метки не получат — так видно, что дерево
 * действительно перерисовалось, а не просто «выбор не изменился».
 */
const markRows = (window) =>
  ask(
    window,
    `(() => {
      const rows = [...document.querySelectorAll('.tree-row')];
      for (const row of rows) row.dataset.probeMark = '1';
      return rows.length;
    })()`,
  );

/** Сколько помеченных строк осталось: ноль — дерево перерисовалось целиком. */
const marksLeft = (window) =>
  ask(window, `document.querySelectorAll('.tree-row[data-probe-mark]').length`);

/** Три файла рядом: для выбора этого хватает. */
async function makeProject(project) {
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    await fs.writeFile(path.join(project, 'src', name), `export const ${name[0]} = 1;\n`, 'utf8');
  }
}

app.whenReady().then(async () => {
  const dir = process.env.CHUI_PROBE_DIR ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'chui-selection-probe-')));
  const project = path.join(dir, 'demo-project');
  const settingsFile = path.join(dir, 'settings.json');
  const sessionDir = path.join(dir, 'sessions');
  const target = path.join(project, 'src', 'b.ts');

  await makeProject(project);
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

  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient(), sessions });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(7000);

  console.log(`[проба] раскрыть папку: ${JSON.stringify(await clickRow(ide, 'src', false))}`);
  await wait(1200);
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    console.log(`[проба] отметить ${name}: ${JSON.stringify(await clickRow(ide, name, true))}`);
  }
  await wait(300);
  const before = await selectedNames(ide);
  console.log(`[проба] выбрано до обновления: ${JSON.stringify(before)}`);

  // Обновление дерева тем же путём, что и сохранение: файл меняется на диске.
  await markRows(ide);
  await fs.writeFile(target, 'export const b = 2;\n', 'utf8');
  await wait(2500);
  const repainted = await marksLeft(ide);
  const after = await selectedNames(ide);
  const files = (names) => names.filter((name) => name?.endsWith('.ts')).join(',');
  console.log(`[проба] строк осталось со старой меткой: ${JSON.stringify(repainted)} (0 — дерево перерисовалось)`);
  console.log(`[проба] выбрано после обновления: ${JSON.stringify(after)}`);
  if (repainted !== 0) {
    console.log('[проба] НЕЯСНО: дерево не перерисовалось, выбор проверять не на чем');
  } else if (files(before) === files(after) && files(before) === 'a.ts,b.ts,c.ts') {
    console.log('[проба] ОК: выбор из трёх файлов пережил перерисовку');
  } else {
    console.log(`[проба] ПРОВАЛ: до [${files(before)}], после [${files(after)}]`);
  }

  terminals.dispose();
  workspace.dispose();
  app.exit(0);
});
