/**
 * Проба «Сохранить как…» (Save As) в настоящем окне.
 *
 *   npm run probe:saveas
 *
 * Системный диалог выбора пути подменяем своим — иначе проба ждала бы человека.
 * Всё остальное настоящее: файл пишется на диск, вкладка переезжает, панель
 * изменений и дерево видят новый путь.
 *
 * Проверяем то, чего не видно в юнит-тестах: диалог спрашивают один раз с путём
 * текущего файла, копия появляется на диске, прежний файл остаётся нетронутым,
 * вкладка переезжает на новый путь вместе с несохранённой правкой.
 */
const { app, dialog } = require('electron');
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

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-saveas-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  const original = path.join(project, 'demo.ts');
  const copy = path.join(project, 'demo.copy.ts');
  await fs.writeFile(original, 'const value = 1;\n', 'utf8');

  // Диалог сохранения — свой: проба отвечает путём рядом с исходным файлом.
  // Так проверяются и путь по умолчанию, и то, что копия встаёт рядом с оригиналом.
  let asked = null;
  dialog.showSaveDialog = async (_window, options) => {
    asked = options;
    return { canceled: false, filePath: copy };
  };

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Открываем файл из дерева — тем же путём, что человек.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'demo.ts',
      );
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return Boolean(row);
    })()`,
  );
  await wait(2500);

  // Правка в редакторе: печатаем символ, как настоящий человек. Так проверяем, что
  // несохранённая правка уезжает в новый файл, а не теряется при закрытии вкладки.
  const rect = await ask(
    ide,
    `(() => {
      const v = document.querySelector('.own-editor-viewport')?.getBoundingClientRect();
      return v ? { x: Math.round(v.left + 60), y: Math.round(v.top + 20) } : null;
    })()`,
  );
  if (rect && typeof rect === 'object') {
    ide.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    ide.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await wait(300);
    ide.webContents.sendInputEvent({ type: 'char', keyCode: '@' });
    await wait(400);
  }

  const tabsBefore = await ask(ide, `[...document.querySelectorAll('.tab .tab-label')].map((n) => n.textContent)`);
  console.log(`[saveas] вкладки до: ${JSON.stringify(tabsBefore)}`);

  // Команда из палитры — тем же путём, что в меню и по Ctrl+Shift+S.
  const started = await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find((item) =>
        (item.getAttribute('title') ?? '').startsWith('Палитра команд'),
      );
      if (!button) return 'нет кнопки палитры';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const input = document.querySelector('.palette-input');
      if (!input) return 'нет поля ввода';
      input.value = 'сохранить как';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const item = [...document.querySelectorAll('.palette-item')].find((node) =>
        (node.querySelector('.palette-item-title')?.textContent ?? '').includes('Сохранить как'),
      );
      if (!item) return 'пункта нет';
      item.click();
      return 'запущено';
    })()`,
  );
  console.log(`[saveas] запуск команды: ${JSON.stringify(started)}`);
  await wait(1500);

  const tabsAfter = await ask(ide, `[...document.querySelectorAll('.tab .tab-label')].map((n) => n.textContent)`);
  const activeName = await ask(ide, `document.querySelector('.tab.is-active .tab-label')?.textContent ?? null`);
  const editorText = await ask(ide, `document.querySelector('.own-editor')?.textContent?.slice(0, 40) ?? null`);
  const dirty = await ask(ide, `document.querySelectorAll('.tab.is-dirty').length`);

  const originalText = await fs.readFile(original, 'utf8').catch(() => 'нет файла');
  const copyText = await fs.readFile(copy, 'utf8').catch(() => 'нет файла');

  console.log(`[saveas] диалог получил путь по умолчанию: ${JSON.stringify(asked?.defaultPath)}`);
  console.log(`[saveas] вкладки после: ${JSON.stringify(tabsAfter)}`);
  console.log(`[saveas] активная вкладка: ${JSON.stringify(activeName)}`);
  console.log(`[saveas] несохранённых вкладок: ${JSON.stringify(dirty)}`);
  console.log(`[saveas] текст редактора: ${JSON.stringify(editorText)}`);
  console.log(`[saveas] прежний файл на диске: ${JSON.stringify(originalText)}`);
  console.log(`[saveas] копия на диске: ${JSON.stringify(copyText)}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
