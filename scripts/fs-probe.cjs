/**
 * Диагностика (не проверка): открываем проект, создаём файл и папку через
 * интерфейс проводника и жмём «Обновить». Смотрим, появляются ли они в дереве
 * и отвечает ли окно после этого.
 *
 *   ./node_modules/.bin/electron scripts/fs-probe.cjs
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

app.on('web-contents-created', (_event, contents) => {
  const tag = `[проба][${contents.id}]`;
  contents.on('unresponsive', () => console.log(`${tag} НЕ ОТВЕЧАЕТ`));
  contents.on('responsive', () => console.log(`${tag} снова отвечает`));
  contents.on('render-process-gone', (_e, details) => console.log(`${tag} renderer упал: ${details.reason}`));
  contents.on('console-message', (event, level, message) => {
    const text = typeof message === 'string' ? message : (event?.message ?? '');
    console.log(`${tag} консоль: ${text}`);
  });
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (window, expression, timeoutMs = 15000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'НЕТ ОТВЕТА'),
  ]);

const state = `({
  tree: [...document.querySelectorAll('.tree-row')].map((r) => r.textContent.trim()),
  toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()),
  loading: document.querySelector('.tree-loading')?.textContent ?? null,
  tabs: [...document.querySelectorAll('.tab-title')].map((t) => t.textContent.trim()),
})`;

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-fs-probe-'));
  const project = path.join(dir, 'demo-project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');
  await fs.writeFile(path.join(project, 'src', 'index.js'), 'console.log(1);\n', 'utf8');

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
  // Ждём загрузку документа: до неё `executeJavaScript` копится в очереди.
  await Promise.race([new Promise((resolve) => ide.webContents.once('did-finish-load', resolve)), wait(30000)]);
  await wait(5000);
  console.log('[проба] старт:', JSON.stringify(await ask(ide, state)));

  // 1. Раскрываем папку src и создаём в ней файл.
  const expand = `(() => {
    const row = [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.includes('src'));
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return Boolean(row);
  })()`;
  console.log('[проба] клик по src:', await ask(ide, expand));
  await wait(700);

  const newFile = `(() => {
    const button = [...document.querySelectorAll('.panel-actions button')].find((b) => b.title === 'Новый файл');
    button?.click();
    return Boolean(button);
  })()`;
  console.log('[проба] кнопка «Новый файл»:', await ask(ide, newFile));
  await wait(500);

  const type = `(() => {
    const input = document.querySelector('.tree-input');
    if (!input) return 'нет поля ввода';
    input.value = 'probe.js';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'введено';
  })()`;
  console.log('[проба] ввод имени:', await ask(ide, type));
  await wait(1500);
  console.log('[проба] после создания файла:', JSON.stringify(await ask(ide, state)));
  console.log('[проба] файл на диске:', await fs.readdir(path.join(project, 'src')));

  // 2. Создаём папку в корне.
  const newDir = `(() => {
    const row = [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.includes('README.md'));
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const button = [...document.querySelectorAll('.panel-actions button')].find((b) => b.title === 'Новая папка');
    button?.click();
    return Boolean(button);
  })()`;
  console.log('[проба] кнопка «Новая папка»:', await ask(ide, newDir));
  for (const delay of [300, 700, 1500]) {
    await wait(delay);
    const found = await ask(ide, `Boolean(document.querySelector('.tree-input'))`);
    console.log(`[проба] поле ввода имени через ${delay} мс:`, found);
    if (found === true) break;
  }
  console.log(
    '[проба] ввод имени папки:',
    await ask(
      ide,
      `(() => {
    const input = document.querySelector('.tree-input');
    if (!input) return 'нет поля ввода';
    input.value = 'probe-dir';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 'введено';
  })()`,
    ),
  );
  await wait(1500);
  console.log('[проба] после создания папки:', JSON.stringify(await ask(ide, state)));
  console.log('[проба] диск:', await fs.readdir(project));

  // 3. Кнопка «Обновить».
  const t0 = Date.now();
  console.log(
    '[проба] кнопка «Обновить»:',
    await ask(
      ide,
      `(() => {
    const button = [...document.querySelectorAll('.panel-actions button')].find((b) => b.title === 'Обновить');
    button?.click();
    return Boolean(button);
  })()`,
    ),
  );
  await wait(2000);
  const after = await ask(ide, state);
  console.log(`[проба] через ${Date.now() - t0} мс после «Обновить»:`, JSON.stringify(after));

  // 4. Контекстное меню редактора: правый клик настоящим событием и замер фона.
  console.log(
    '[проба] открываю index.js:',
    await ask(
      ide,
      `(() => {
    const row = [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.includes('index.js'));
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return Boolean(row);
  })()`,
    ),
  );
  await wait(1200);
  const point = await ask(
    ide,
    `(() => {
    const rect = document.querySelector('.monaco-editor')?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.x + 60), y: Math.round(rect.y + 40) } : null;
  })()`,
  );
  if (point) {
    ide.focus();
    ide.webContents.focus();
    await wait(300);
    ide.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    ide.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await wait(300);
    ide.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'right', clickCount: 1 });
    ide.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'right', clickCount: 1 });
    await wait(800);
    console.log(
      '[проба] меню редактора:',
      JSON.stringify(
        await ask(
          ide,
          `(() => {
      const root = document.querySelector('.shadow-root-host')?.shadowRoot;
      const menu = root?.querySelector('.monaco-menu');
      if (!menu) return 'меню не открылось';
      const item = root.querySelector('.action-menu-item');
      return {
        bg: getComputedStyle(menu).backgroundColor,
        radius: getComputedStyle(menu).borderRadius,
        fore: item ? getComputedStyle(item).color : null,
        padding: getComputedStyle(menu).padding,
      };
    })()`,
        ),
      ),
    );
    const menuShot = await ide.capturePage();
    await fs.writeFile(path.join(process.env.TMPDIR ?? '/tmp', 'chui-menu-probe.png'), menuShot.toPNG());
  }

  const image = await ide.capturePage();
  const shot = path.join(process.env.TMPDIR ?? '/tmp', 'chui-fs-probe.png');
  await fs.writeFile(shot, image.toPNG());
  console.log('[проба] снимок:', shot);
  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
