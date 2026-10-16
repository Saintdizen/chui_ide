/**
 * Проба виртуализации дерева: папка с тысячами файлов.
 *
 *   npm run probe:tree
 *
 * Проводник рисует только окно строк вокруг видимой части, а не весь список.
 * Проба заводит папку в 3000 файлов и смотрит, что узлов в DOM мало (единицы
 * десятков), прокрутка честная (её длина — под весь список), а после прокрутки
 * вниз появляются последние файлы: если бы виртуализация не работала, дерево
 * держало бы 3000 узлов и это было бы видно по их числу.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([window.webContents.executeJavaScript(expression), wait(timeoutMs).then(() => 'нет ответа')]);

const MANY = 3000;

/** Случилась ли ошибка: окно строк, оставшееся куцым, — это провал, а не отчёт. */
let failed = false;

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-tree-probe-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'many'), { recursive: true });
  for (let index = 0; index < MANY; index += 1) {
    const name = `file-${String(index).padStart(4, '0')}.txt`;
    await fs.writeFile(path.join(project, 'many', name), `${index}\n`, 'utf8');
  }
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const gitService = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git: gitService, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Раскрываем папку `many` — её дети и есть большой список.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'many',
      );
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(row);
    })()`,
  );
  await wait(3000);

  const snapshot = () =>
    ask(
      ide,
      `(() => {
        const tree = document.querySelector('.explorer .tree');
        const names = [...document.querySelectorAll('.explorer .tree-rows .tree-row .tree-name')].map(
          (node) => node.textContent,
        );
        return {
          вDOM: names.length,
          распорки: document.querySelectorAll('.explorer .tree-rows .tree-gap').length,
          высота: tree ? Math.round(tree.scrollHeight) : 0,
          видно: tree ? Math.round(tree.clientHeight) : 0,
          первый: names[0] ?? null,
          последний: names[names.length - 1] ?? null,
        };
      })()`,
    );

  console.log(`[tree] всего файлов в папке: ${MANY}`);
  console.log(`[tree] сверху: ${JSON.stringify(await snapshot())}`);

  // Прокручиваем почти в самый низ и смотрим, что рисуются последние файлы.
  await ask(
    ide,
    `(() => {
      const tree = document.querySelector('.explorer .tree');
      tree.scrollTop = tree.scrollHeight;
      return true;
    })()`,
  );
  await wait(800);
  console.log(`[tree] снизу: ${JSON.stringify(await snapshot())}`);

  /* Окно строк считают по ВЫСОТЕ панели в момент отрисовки. Если она была нулевой
     (раскладка не встала, переключали панели, тянули окно), окно схлопывалось в
     пару строк и таким и оставалось: прокрутка честная, а строк мало и ниже пустота.
     Высоту меняем и смотрим, что окно пересчиталось на новую. */
  await ask(
    ide,
    `(() => {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) sidebar.style.display = 'none';
      const tree = document.querySelector('.explorer .tree');
      if (tree) {
        tree.scrollTop = 2000;
        tree.dispatchEvent(new Event('scroll'));
      }
      return true;
    })()`,
  );
  await wait(500);
  const collapsed = await snapshot();
  await ask(
    ide,
    `(() => {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) sidebar.style.display = '';
      return true;
    })()`,
  );
  await wait(900);
  const regrown = await snapshot();
  console.log(`[tree] при нулевой высоте: ${JSON.stringify(collapsed)}`);
  console.log(`[tree] после возврата высоты: ${JSON.stringify(regrown)}`);
  // Куцым окно выдаёт себя двумя приметами: строк меньше, чем влезает в высоту, и
  // нет распорки сверху (окно прижато к началу, хотя прокрутка стоит в середине).
  const coversViewport = regrown.вDOM >= 20;
  const scrolledWindow = regrown.распорки >= 1;
  if (coversViewport && scrolledWindow) {
    console.log('[tree] окно строк пересчитано на высоту панели');
  } else {
    console.log('[tree] ПРОВАЛ: окно осталось куцым — строк видно мало, ниже пустота');
    failed = true;
  }

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(failed ? 1 : 0);
});
