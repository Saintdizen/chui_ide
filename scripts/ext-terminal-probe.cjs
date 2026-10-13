/**
 * Проба запуска терминала системы из дерева.
 *
 *   npm run probe:extterminal
 *
 * Настоящий терминал в прогоне открывать нельзя (окно вне IDE, и его негде взять
 * в headless). Поэтому в PATH подкладывается подставной `gnome-terminal` — скрипт,
 * который записывает свой рабочий каталог в файл. Так проверяется то, что важно:
 * команда выбрана, процесс запущен ОТДЕЛЬНО от IDE и получил ПРАВИЛЬНУЮ папку.
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

let failed = false;
const check = (label, condition, extra) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-extterm-probe-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(project, 'lib'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'a.ts'), 'const a = 1;\n', 'utf8');

  // Подставной терминал: записывает свой рабочий каталог в маркер и выходит.
  const binDir = path.join(dir, 'fake-bin');
  await fs.mkdir(binDir, { recursive: true });
  const marker = path.join(dir, 'marker.txt');
  const fake = path.join(binDir, 'gnome-terminal');
  await fs.writeFile(fake, `#!/bin/sh\nprintf '%s' "$PWD" > "$CHUI_TERMINAL_MARKER"\n`, 'utf8');
  await fs.chmod(fake, 0o755);

  // Подставной каталог идёт ПЕРВЫМ: подменяем настоящий терминал, если он есть.
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.CHUI_TERMINAL_MARKER = marker;
  delete process.env.TERMINAL;

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

  // Правый клик по папке `src` → «Открыть терминал системы».
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.explorer .tree-rows .tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'src',
      );
      if (!row) return 'нет строки';
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8 }));
      return 'ok';
    })()`,
  );
  await wait(600);
  const menu = await ask(
    ide,
    `[...document.querySelectorAll('.context-menu .context-item')].map((node) => node.textContent.trim())`,
  );
  console.log(`[extterm] пункты меню: ${JSON.stringify(menu)}`);
  check(
    'в меню есть «Открыть терминал системы»',
    Array.isArray(menu) && menu.includes('Открыть терминал системы'),
    menu,
  );

  await ask(
    ide,
    `(async () => {
      const item = [...document.querySelectorAll('.context-menu .context-item')].find(
        (node) => node.textContent.trim() === 'Открыть терминал системы',
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 'нажато';
    })()`,
  );
  await wait(2000);

  const written = await fs.readFile(marker, 'utf8').catch(() => null);
  console.log(`[extterm] рабочий каталог терминала: ${JSON.stringify(written)}`);
  check('терминал запущен отдельным процессом', written !== null, written);
  check('рабочий каталог — выбранная папка', written === path.join(project, 'src'), {
    получено: written,
    ожидалось: path.join(project, 'src'),
  });

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[extterm] ЕСТЬ ПАДЕНИЯ' : '[extterm] всё сошлось');
  app.exit(failed ? 1 : 0);
});
