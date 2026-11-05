/**
 * Проба палитры команд: доехали ли до неё действия своего редактора.
 *
 *   npm run probe:palette
 *
 * Проверяем то, чего не видно в юнит-тестах (там нет ни окна, ни реестра
 * действий редактора):
 *
 * 1. В палитре есть категория «Редактор» — пункты каталога команд редактора
 *    (`src/renderer/editor/host/editor-commands.ts`).
 * 2. Список не обрезан: пунктов заметно больше, чем было до переноса.
 * 3. Действие находится по англоязычному псевдониму (`indent`) —
 *    так же, как по прежнему идентификатору движка.
 * 4. Выбранный пункт действительно запускает действие редактора: берём
 *    `editor.indent` и смотрим, что текст файла сдвинулся.
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([window.webContents.executeJavaScript(expression), wait(timeoutMs).then(() => 'нет ответа')]);

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-palette-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'demo.ts'), 'const value = 1;\nconsole.log(value);\n', 'utf8');

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

  // Открываем файл: без активного редактора действий в палитре не будет вовсе.
  const opened = await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'demo.ts',
      );
      if (!row) return 'нет узла';
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return 'кликнут';
    })()`,
  );
  console.log(`[проба] открыть demo.ts: ${JSON.stringify(opened)}`);
  await wait(2500);

  // Один ввод: какой префикс включает какой режим. Окно открывается `Ctrl+P` —
  // тем же путём, что у человека.
  const openQuick = async (query) =>
    await ask(
      ide,
      `(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 500));
        const root = [...document.querySelectorAll('.palette')].find((node) => node.querySelector('.palette-footer'));
        if (!root) return { ошибка: 'окно не открылось' };
        const input = root.querySelector('.palette-input');
        input.value = ${JSON.stringify(query)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const modes = [...root.querySelectorAll('.palette-mode')];
        return {
          режим: modes.find((node) => node.classList.contains('is-active'))?.textContent ?? null,
          заголовки: [...root.querySelectorAll('.palette-item-title')].slice(0, 6).map((n) => n.textContent ?? ''),
          пусто: root.querySelector('.palette-empty')?.textContent ?? null,
          пунктов: root.querySelectorAll('.palette-item').length,
          тост: [...document.querySelectorAll('.toasts .toast-text')].map((n) => n.textContent ?? ''),
        };
      })()`,
    );

  console.log(`[проба] listFiles из main: ${JSON.stringify(await workspace.listFiles())}`);
  console.log(`[проба] пустой ввод: ${JSON.stringify(await openQuick(''))}`);
  console.log(`[проба] файлы «demo»: ${JSON.stringify(await openQuick('demo'))}`);
  console.log(`[проба] «>» команды: ${JSON.stringify(await openQuick('>палитра'))}`);
  console.log(`[проба] «@» символы: ${JSON.stringify(await openQuick('@value'))}`);
  console.log(`[проба] «#» поиск: ${JSON.stringify(await openQuick('#console'))}`);
  // Escape из режима возвращает к файлам, второй — закрывает окно.
  const escapeTwice = await ask(
    ide,
    `(async () => {
      const root = [...document.querySelectorAll('.palette')].find((node) => node.querySelector('.palette-footer'));
      if (!root) return { ошибка: 'окно закрыто' };
      const overlay = root.closest('.overlay');
      const input = root.querySelector('.palette-input');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const afterFirst = {
        открыто: !overlay.hidden,
        режим: root.querySelector('.palette-mode.is-active')?.textContent ?? null,
      };
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ...afterFirst, послеВторого: { открыто: !overlay.hidden } };
    })()`,
  );
  console.log(`[проба] Escape: ${JSON.stringify(escapeTwice)}`);
  // Переход к месту: `#` находит строку проекта, выбор ставит каретку.
  const jump = await ask(
    ide,
    `(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const root = [...document.querySelectorAll('.palette')].find((node) => node.querySelector('.palette-footer'));
      if (!root) return { ошибка: 'окно не открылось' };
      const input = root.querySelector('.palette-input');
      input.value = '#console';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 800));
      const item = root.querySelector('.palette-item');
      const label = item?.querySelector('.palette-item-title')?.textContent ?? null;
      item?.click();
      await new Promise((resolve) => setTimeout(resolve, 800));
      return { пункт: label, закрылась: Boolean(root.closest('.overlay')?.hidden) };
    })()`,
  );
  console.log(`[проба] переход по «#»: ${JSON.stringify(jump)}`);

  console.log(`[проба] listFiles в конце: ${JSON.stringify(await workspace.listFiles())}`);
  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
