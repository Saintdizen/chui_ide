/**
 * Проба блока «Открытые редакторы»: список файлов над деревом.
 *
 *   npm run probe:open-editors
 *
 * Открываем два файла из дерева и проверяем, что блок показывает оба, отмечает
 * активный и закрывает файл по крестику.
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/**
 * Открыть файл из дерева: папка раскрывается одним кликом, файл — двойным.
 * Строки дерева приезжают асинхронно после открытия проекта, поэтому ждём их: без этого
 * проба кликала по пустому дереву и молча ничего не проверяла.
 */
const openInTree = (window, name) =>
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
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return 'кликнут';
    })()`,
  );

/** Что показывает блок открытых редакторов: имена по порядку и какое активно. */
const blockState = (window) =>
  ask(
    window,
    `(() => {
      const block = document.querySelector('.open-editors');
      if (!block) return { exists: false };
      const rows = [...block.querySelectorAll('.open-editor')];
      const nameOf = (row) => row.querySelector('.open-editor-name')?.textContent ?? null;
      const active = rows.find((row) => row.classList.contains('is-active'));
      return {
        exists: true,
        hidden: block.hidden,
        names: rows.map(nameOf).join(','),
        active: active ? nameOf(active) : null,
      };
    })()`,
  );

/** Закрыть файл крестиком в блоке: тот же путь, что у мыши. */
const closeInBlock = (window, name) =>
  ask(
    window,
    `(() => {
      const row = [...document.querySelectorAll('.open-editor')].find(
        (item) => item.querySelector('.open-editor-name')?.textContent === ${JSON.stringify(name)},
      );
      if (!row) return 'нет строки ' + ${JSON.stringify(name)};
      row.querySelector('.open-editor-close').click();
      return 'закрыт';
    })()`,
  );

/** Три файла рядом: двух хватит для списка, третий — чтобы было что не открывать. */
async function makeProject(project) {
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    await fs.writeFile(path.join(project, 'src', name), `export const ${name[0]} = 1;\n`, 'utf8');
  }
}

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-open-editors-'));
  const project = path.join(dir, 'demo-project');
  const sessionDir = path.join(dir, 'sessions');
  const settingsFile = path.join(dir, 'settings.json');

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
  console.log(`[проба] проект: ${project}`);

  const ide = openIdeWindow();
  await wait(7000);

  await openInTree(ide, 'src');
  await wait(1200);
  for (const name of ['a.ts', 'b.ts']) {
    console.log(`[проба] открыть ${name}: ${JSON.stringify(await openInTree(ide, name))}`);
    await wait(800);
  }
  await wait(600);

  const opened = await blockState(ide);
  console.log(`[проба] блок: ${JSON.stringify(opened)}`);
  console.log(`[проба] закрыть a.ts: ${JSON.stringify(await closeInBlock(ide, 'a.ts'))}`);
  await wait(600);
  const afterClose = await blockState(ide);
  console.log(`[проба] после закрытия: ${JSON.stringify(afterClose)}`);

  if (!opened.exists || opened.names === undefined) {
    console.log('[проба] ПРОВАЛ: блока нет в панели');
  } else if (opened.names !== 'a.ts,b.ts' || opened.active !== 'b.ts') {
    console.log(`[проба] ПРОВАЛ: в блоке [${opened.names}], активно ${opened.active}`);
  } else if (afterClose.names !== 'b.ts') {
    console.log(`[проба] ПРОВАЛ: после закрытия в блоке [${afterClose.names}]`);
  } else {
    console.log('[проба] ОК: блок показывает открытые файлы, отмечает активный и закрывает по крестику');
  }

  terminals.dispose();
  workspace.dispose();
  // Каталог не убираем: он общий для двух запусков, его чистит внешний скрипт.
  app.exit(0);
});
