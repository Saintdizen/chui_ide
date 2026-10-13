/**
 * Проба возврата к версии на диске: «Перечитать с диска».
 *
 *   npm run probe:revert
 *
 * Временный репозиторий и настоящая IDE. Файл правится В БУФЕРЕ (на диск ничего
 * не пишется) — так же выглядит правка агента, когда файл записывает человек. Дальше
 * проба жмёт команду в меню вкладки и смотрит то, что видит человек: точка и пометка
 * «не сохранён» в дереве и на вкладке, а также текст в редакторе. Возврат обязан
 * вернуть текст с диска и снять «грязность» — иначе такой файл оставался бы «не
 * сохранён» до самого закрытия окна, и каждый раз о нём спрашивал бы диалог выхода.
 *
 * Системный диалог подтверждения в окне не поднимается: проба подменяет
 * `dialog.showMessageBox` в main на «согласен» (ответ 0 — первая кнопка, она же
 * подтверждающая) — иначе модальное окно остановило бы проверку.
 */
const { app, dialog } = require('electron');
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

/** Что видно у файла: пометки строки в дереве и классы вкладки. */
const fileState = (window, name) =>
  ask(
    window,
    `(() => {
      const row = [...document.querySelectorAll('.explorer .tree-rows .tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
      );
      const tab = [...document.querySelectorAll('.tab')].find(
        (item) => item.textContent.trim() === ${JSON.stringify(name)},
      );
      return {
        точка: row?.querySelector('.tree-dot') ? [...row.querySelector('.tree-dot').classList] : null,
        подсказка: row?.title ?? null,
        вкладка: tab ? [...tab.classList] : null,
        текст: [...document.querySelectorAll('.own-editor-line')].map((line) => line.textContent).join('\\n'),
      };
    })()`,
  );

app.whenReady().then(async () => {
  // Вместо человека на подтверждении: первая кнопка подтверждающая (см. `dialog.confirm`).
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });

  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-revert-probe-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'note.txt'), 'строка с диска\n', 'utf8');
  await git(project, ['init', '-q']);
  await git(project, ['config', 'user.email', 'test@example.com']);
  await git(project, ['config', 'user.name', 'Test']);
  await git(project, ['add', '-A']);
  await git(project, ['commit', '-q', '-m', 'init']);

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  let gitService;
  gitService = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
    () => void gitService.refresh(),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git: gitService, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Открываем файл двойным кликом и правим его в буфере: на диск ничего не пишем.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'note.txt',
      );
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return Boolean(row);
    })()`,
  );
  await wait(3000);
  await ask(ide, `document.querySelector('.own-editor-input')?.focus(); 'ok'`);
  ide.webContents.sendInputEvent({ type: 'char', keyCode: 'Z' });
  await wait(2000);

  console.log('[revert] файл на диске:', JSON.stringify(await fs.readFile(path.join(project, 'note.txt'), 'utf8')));
  const dirty = await fileState(ide, 'note.txt');
  console.log('[revert] правка в буфере:', JSON.stringify({ ...dirty, текст: dirty.текст.split('\n').slice(0, 1) }));
  check('правленый буфер помечен точкой «не сохранён»', dirty.точка?.includes('is-modified') === true, dirty.точка);
  check('вкладка помечена правкой', dirty.вкладка?.includes('is-dirty') === true, dirty.вкладка);

  // Команда живёт в меню вкладки — жмём её так же, как человек.
  const clicked = await ask(
    ide,
    `(() => {
      const tab = [...document.querySelectorAll('.tab')].find(
        (item) => item.textContent.trim() === 'note.txt',
      );
      if (!tab) return 'нет вкладки';
      const rect = tab.getBoundingClientRect();
      tab.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(rect.left + 5),
          clientY: Math.round(rect.top + 5),
        }),
      );
      return 'меню открыто';
    })()`,
  );
  await wait(600);
  const menuItem = await ask(
    ide,
    `(() => {
      const item = [...document.querySelectorAll('.popup-menu button, .context-menu button')].find((node) =>
        node.textContent.includes('Перечитать с диска'),
      );
      if (!item) {
        return [...document.querySelectorAll('.popup-menu button, .context-menu button')].map((node) => node.textContent);
      }
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'нажато';
    })()`,
  );
  console.log('[revert] меню вкладки:', clicked, '· пункт:', JSON.stringify(menuItem));
  await wait(2500);

  const after = await fileState(ide, 'note.txt');
  console.log('[revert] после возврата:', JSON.stringify({ ...after, текст: after.текст.split('\n').slice(0, 1) }));
  check('правка в буфере отброшена — точки нет', after.точка === null, after.точка);
  check('вкладка больше не помечена правкой', after.вкладка?.includes('is-dirty') === false, after.вкладка);
  check('на экране текст с диска', after.текст.startsWith('строка с диска') === true, after.текст.split('\n')[0]);
  check('файл на диске не тронут', (await fs.readFile(path.join(project, 'note.txt'), 'utf8')) === 'строка с диска\n');

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[revert] ЕСТЬ ПАДЕНИЯ' : '[revert] всё сошлось');
  app.exit(failed ? 1 : 0);
});
