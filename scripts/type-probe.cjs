/**
 * Диагностика: печатается ли текст в редакторе и открывается ли контекстное меню.
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

registerAppScheme();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (w, expression, t = 20000) =>
  Promise.race([w.webContents.executeJavaScript(expression), wait(t).then(() => 'нет ответа')]);

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-type-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'demo.ts'), 'const value = 1;\nconsole.log(value);\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((t, p) => pushToRenderers(t, p));
  const git = new GitService(
    () => workspace.rootPath(),
    (t, p) => pushToRenderers(t, p),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((t, p) => pushToRenderers(t, p));
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  await ask(
    ide,
    `(() => {
    const row = [...document.querySelectorAll('.tree-row')].find(
      (item) => item.querySelector('.tree-name')?.textContent === 'demo.ts');
    if (!row) return 'нет узла';
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return 'кликнут';
  })()`,
  );
  await wait(2500);

  const state = await ask(
    ide,
    `(() => {
    const input = document.querySelector('.own-editor-input');
    const rect = input?.getBoundingClientRect();
    const style = input ? getComputedStyle(input) : null;
    return {
      есть_редактор: !!document.querySelector('.own-editor'),
      есть_поле: !!input,
      поле_стиль: style ? { display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents } : null,
      поле_рамка: rect ? { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) } : null,
      активный: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
      фокус_в_документе: document.hasFocus(),
      текст_до: document.querySelector('.own-editor')?.textContent?.slice(0, 40) ?? null,
    };
  })()`,
  );
  console.log('СОСТОЯНИЕ', JSON.stringify(state, null, 2));

  // Как человек: бросаем фокус на body, кликаем мышью по тексту, печатаем.
  await ask(ide, `(() => { document.activeElement?.blur?.(); document.body.focus?.(); return 'сброшен'; })()`);
  const rect = await ask(
    ide,
    `(() => {
    const v = document.querySelector('.own-editor-viewport').getBoundingClientRect();
    return { x: Math.round(v.left + 60), y: Math.round(v.top + 30) };
  })()`,
  );
  ide.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  ide.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await wait(300);
  const afterClick = await ask(
    ide,
    `(() => ({
    активный: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
  }))()`,
  );
  const before = await ask(ide, `document.querySelector('.own-editor')?.textContent?.length ?? -1`);
  ide.webContents.sendInputEvent({ type: 'char', keyCode: 'X' });
  await wait(400);
  const after = await ask(
    ide,
    `(() => ({
    длина: document.querySelector('.own-editor')?.textContent?.length ?? -1,
    текст: document.querySelector('.own-editor')?.textContent?.slice(0, 30) ?? null,
    активный: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
  }))()`,
  );
  console.log('КЛИК+ПЕЧАТЬ', JSON.stringify({ после_клика: afterClick, before, after }, null, 2));

  const menu = await ask(
    ide,
    `(() => {
    const viewport = document.querySelector('.own-editor-viewport');
    if (!viewport) return 'нет полотна';
    const rect = viewport.getBoundingClientRect();
    const x = Math.round(rect.left + 60), y = Math.round(rect.top + 30);
    const target = document.elementFromPoint(x, y);
    target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    const after = document.querySelector('.popup-menu, .context-menu, .select-popup');
    return {
      цель: target ? target.className : null,
      меню_появилось: !!after,
      меню_класс: after ? after.className : null,
    };
  })()`,
  );
  console.log('КОНТЕКСТНОЕ МЕНЮ', JSON.stringify(menu, null, 2));

  // Фичи ввода: пары скобок, комментарий Ctrl+/, перенос строки Alt+↓.
  const readText = () =>
    ask(ide, `[...document.querySelectorAll('.own-editor-line')].map((n) => n.textContent).join('\\n')`);
  await ask(ide, `document.querySelector('.own-editor-input')?.focus(); 'ok'`);
  ide.webContents.sendInputEvent({ type: 'char', keyCode: '(' });
  await wait(300);
  console.log('ПАРА СКОБОК', JSON.stringify(await readText()));
  ide.webContents.sendInputEvent({ type: 'keyDown', keyCode: '/', modifiers: ['control'] });
  ide.webContents.sendInputEvent({ type: 'keyUp', keyCode: '/', modifiers: ['control'] });
  await wait(300);
  console.log('CTRL+/', JSON.stringify(await readText()));
  ide.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down', modifiers: ['alt'] });
  ide.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down', modifiers: ['alt'] });
  await wait(300);
  console.log('ALT+DOWN', JSON.stringify(await readText()));

  await wait(500);
  const errors = await ask(ide, `window.__errors ?? 'нет окна ошибок'`).catch(() => []);
  console.log('ОШИБКИ СТРАНИЦЫ', JSON.stringify(errors, null, 2));

  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
