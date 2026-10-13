/**
 * Проба сортировки дерева: по имени, по времени изменения и по пометкам git.
 *
 *   npm run probe:sort
 *
 * Имена файлов подобраны так, чтобы порядок «по имени» отличался от «по времени»:
 * иначе проверка ничего не доказывала бы. Настройка меняется на лету (как это
 * делает человек в окне настроек) — окно перерисовывает дерево само.
 */
const { app } = require('electron');
const { execFile } = require('node:child_process');
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

const git = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });

let failed = false;
const check = (label, condition, extra) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-sort-probe-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });

  // Имена: a…, m…, z… (порядок по имени). Время зададим так, чтобы «по времени»
  // давало обратный порядок — тогда сортировки не спутать.
  const names = ['alpha.ts', 'middle.ts', 'zeta.ts'];
  for (const name of names) await fs.writeFile(path.join(project, name), `// ${name}\n`, 'utf8');

  await git(project, ['init', '-q']);
  await git(project, ['config', 'user.email', 'test@example.com']);
  await git(project, ['config', 'user.name', 'Test']);
  await git(project, ['add', '-A']);
  await git(project, ['commit', '-q', '-m', 'init']);

  // Время правки: alpha — старое, middle — среднее, zeta — свежее.
  const base = Math.floor(Date.now() / 1000) - 3600;
  await fs.utimes(path.join(project, 'alpha.ts'), base, base);
  await fs.utimes(path.join(project, 'middle.ts'), base + 600, base + 600);
  await fs.utimes(path.join(project, 'zeta.ts'), base + 1200, base + 1200);

  // Правка zeta — единственный файл с пометкой git.
  await fs.writeFile(path.join(project, 'zeta.ts'), '// zeta изменён\n', 'utf8');

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

  /** Имена строк дерева в текущем порядке (кроме заголовков/закреплённых). */
  const order = () =>
    ask(
      ide,
      `[...document.querySelectorAll('.explorer .tree-rows .tree-row .tree-name')].map((node) => node.textContent)`,
    );

  const setSort = async (sort) => {
    settings.update({ explorer: { sort } });
    await wait(1200);
    return order();
  };

  const byName = await setSort('name');
  console.log(`[sort] по имени: ${JSON.stringify(byName)}`);
  check('по имени: алфавитный порядок', JSON.stringify(byName) === JSON.stringify(names), byName);

  const byModified = await setSort('modified');
  console.log(`[sort] по времени: ${JSON.stringify(byModified)}`);
  check(
    'по времени: свежие выше',
    JSON.stringify(byModified) === JSON.stringify(['zeta.ts', 'middle.ts', 'alpha.ts']),
    byModified,
  );

  const byGit = await setSort('git');
  console.log(`[sort] по пометкам git: ${JSON.stringify(byGit)}`);
  check('по git: изменённый файл выше', Array.isArray(byGit) && byGit[0] === 'zeta.ts' && byGit.length === 3, byGit);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[sort] ЕСТЬ ПАДЕНИЯ' : '[sort] всё сошлось');
  app.exit(failed ? 1 : 0);
});
