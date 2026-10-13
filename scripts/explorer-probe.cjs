/**
 * Проба проводника: множественное выделение и перенос перетаскиванием.
 *
 *   npm run probe:explorer
 *
 * Дерево — настоящее (реальные папки и файлы на диске), окно — настоящее: клики
 * с `Ctrl`/`Shift` и перетаскивание отправляются живыми событиями, а результат
 * переноса проверяется по файловой системе, а не по разметке: дерево могло
 * покраситься правильно, а файл остаться на месте.
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

const exists = async (target) => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-explorer-probe-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(project, 'lib'), { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');
  await fs.writeFile(path.join(project, 'note.txt'), 'перенос\n', 'utf8');
  await fs.writeFile(path.join(project, 'src', 'a.ts'), 'const a = 1;\n', 'utf8');

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

  // Счётчик выделенного и имена — по ним видно, сработали ли `Ctrl` и `Shift`.
  const selected = () =>
    ask(
      ide,
      `[...document.querySelectorAll('.tree-row.is-selected')].map((row) => row.querySelector('.tree-name')?.textContent ?? '')`,
    );

  const click = (name, modifiers) =>
    ask(
      ide,
      `(() => {
        const row = [...document.querySelectorAll('.tree-row')].find(
          (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
        );
        if (!row) return 'нет строки ${name}';
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, ...${JSON.stringify(modifiers)} }));
        return 'ok';
      })()`,
    );

  console.log(`[explorer] один клик: ${JSON.stringify(await click('README.md', {}))}`);
  await wait(300);
  console.log(`[explorer] выделено: ${JSON.stringify(await selected())}`);

  console.log(`[explorer] Ctrl+клик: ${JSON.stringify(await click('note.txt', { ctrlKey: true }))}`);
  await wait(300);
  console.log(`[explorer] выделено после Ctrl: ${JSON.stringify(await selected())}`);

  console.log(`[explorer] Ctrl+клик по тому же — снять: ${JSON.stringify(await click('note.txt', { ctrlKey: true }))}`);
  await wait(300);
  console.log(`[explorer] выделено после снятия: ${JSON.stringify(await selected())}`);

  // Перенос: тащим `note.txt` (уже выделен) на папку `src`.
  const dragged = await ask(
    ide,
    `(() => {
      const rows = [...document.querySelectorAll('.tree-row')];
      const from = rows.find((item) => item.querySelector('.tree-name')?.textContent === 'note.txt');
      const to = rows.find((item) => item.querySelector('.tree-name')?.textContent === 'src');
      if (!from || !to) return 'нет строк';
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
      const marked = to.classList.contains('is-drop-target');
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      return { подсвечена: marked };
    })()`,
  );
  console.log(`[explorer] перетаскивание: ${JSON.stringify(dragged)}`);
  await wait(1500);

  const movedInto = await exists(path.join(project, 'src', 'note.txt'));
  const stayedPut = await exists(path.join(project, 'note.txt'));
  console.log(`[explorer] note.txt переехал в src: ${movedInto}; остался на месте: ${stayedPut}`);

  // Второй перенос: тащим README.md на папку lib.
  await ask(
    ide,
    `(() => {
      const rows = [...document.querySelectorAll('.tree-row')];
      const from = rows.find((item) => item.querySelector('.tree-name')?.textContent === 'README.md');
      const to = rows.find((item) => item.querySelector('.tree-name')?.textContent === 'lib');
      if (!from || !to) return 'нет строк';
      from.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
      return 'ok';
    })()`,
  );
  await wait(1500);
  console.log(`[explorer] README.md в lib: ${await exists(path.join(project, 'lib', 'README.md'))}`);

  const finalTree = await ask(
    ide,
    `[...document.querySelectorAll('.tree-row .tree-name')].map((node) => node.textContent)`,
  );
  console.log(`[explorer] дерево в конце: ${JSON.stringify(finalTree)}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
