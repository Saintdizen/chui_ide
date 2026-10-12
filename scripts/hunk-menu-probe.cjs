/**
 * Проба меню блока из жёлоба: правый клик по полоске изменения.
 *
 *   npm run probe:hunkmenu
 *
 * Репозиторий настоящий: файл коммитится, потом правится, чтобы в жёлобе появилась
 * полоска. Дальше — живой правый клик по полоске и проверка, что меню предложило
 * именно действия с блоком, а сам git их исполнил (файл ушёл в индекс).
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const { execFile } = require('node:child_process');
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

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-hunk-probe-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  const file = path.join(project, 'lines.txt');

  const lines = Array.from({ length: 20 }, (_, index) => `строка ${index + 1}`);
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  await git(project, ['init', '-q']);
  await git(project, ['config', 'user.email', 'test@example.com']);
  await git(project, ['config', 'user.name', 'Test']);
  await git(project, ['add', '-A']);
  await git(project, ['commit', '-q', '-m', 'init']);

  // Правка в одном месте: в жёлобе появится полоска на этой строке.
  const edited = [...lines];
  edited[4] = 'строка 5 ИЗМЕНЕНА';
  await fs.writeFile(file, `${edited.join('\n')}\n`, 'utf8');

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

  // Открываем файл из дерева — тем же путём, что человек.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'lines.txt',
      );
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return Boolean(row);
    })()`,
  );
  // Полоски считаются с задержкой (change-gutter ждёт 300 мс) — даём время.
  await wait(3000);

  const stripes = await ask(
    ide,
    `(() => {
      const rows = [...document.querySelectorAll('.own-editor-strip-row')].filter((row) =>
        row.classList.contains('change-gutter'),
      );
      return rows.map((row) => ({
        класс: row.className,
        строки: row.parentElement?.children ? [...row.parentElement.children].indexOf(row) + 1 : null,
        подсказка: row.title ?? null,
      }));
    })()`,
  );
  console.log(`[hunkmenu] полоски в жёлобе: ${JSON.stringify(stripes)}`);

  // Правый клик по полоске: сперва mousedown (из него приложение берёт координаты
  // меню), затем contextmenu — так же, как это делает система при правом клике.
  const opened = await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.own-editor-strip-row')].find((item) =>
        item.classList.contains('change-gutter'),
      );
      if (!row) return 'нет полоски';
      const rect = row.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      row.parentElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
      row.parentElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
      return { x, y, есть: true };
    })()`,
  );
  console.log(`[hunkmenu] правый клик: ${JSON.stringify(opened)}`);
  await wait(1200);

  const menu = await ask(
    ide,
    `[...document.querySelectorAll('.context-menu .context-item')].map((item) => item.textContent.trim())`,
  );
  console.log(`[hunkmenu] пункты меню: ${JSON.stringify(menu)}`);

  // Выбираем «Проиндексировать это изменение» и смотрим, что git действительно
  // перенёс правку в индекс.
  const chosen = await ask(
    ide,
    `(async () => {
      const item = [...document.querySelectorAll('.context-menu .context-item')].find((node) =>
        (node.textContent ?? '').includes('Проиндексировать'),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return 'выбрано';
    })()`,
  );
  console.log(`[hunkmenu] выбор пункта: ${JSON.stringify(chosen)}`);
  await wait(1500);

  const staged = await git(project, ['diff', '--cached', '--numstat']);
  const unstaged = await git(project, ['diff', '--numstat']);
  console.log(`[hunkmenu] в индексе: ${JSON.stringify(staged.stdout.trim())}`);
  console.log(`[hunkmenu] вне индекса: ${JSON.stringify(unstaged.stdout.trim())}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
