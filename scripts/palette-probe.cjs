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

  // Палитра открывается кнопкой шапки — тем же путём, что и человеком.
  const openedPalette = await ask(
    ide,
    `(() => {
      const button = [...document.querySelectorAll('.icon-btn')].find((item) =>
        (item.getAttribute('title') ?? '').startsWith('Палитра команд'),
      );
      if (!button) return 'нет кнопки палитры';
      button.click();
      return 'нажата';
    })()`,
  );
  console.log(`[проба] открыть палитру: ${JSON.stringify(openedPalette)}`);
  await wait(800);

  // Общий счёт и разрез по категориям: так видно, что перенос случился.
  const summary = await ask(
    ide,
    `(() => {
      const items = [...document.querySelectorAll('.palette-item')];
      const categories = {};
      for (const item of items) {
        const category = item.querySelector('.palette-item-category')?.textContent ?? '(нет)';
        categories[category] = (categories[category] ?? 0) + 1;
      }
      return { видно: items.length, категории: categories };
    })()`,
  );
  console.log(`[проба] пунктов в палитре: ${JSON.stringify(summary, null, 2)}`);

  // Поиск по англоязычному псевдониму действия.
  const search = await ask(
    ide,
    `(() => {
      const input = document.querySelector('.palette-input');
      if (!input) return 'нет поля ввода';
      input.value = 'indent';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return [...document.querySelectorAll('.palette-item')].map(
        (item) =>
          (item.querySelector('.palette-item-title')?.textContent ?? '') +
          ' — ' +
          (item.querySelector('.palette-item-category')?.textContent ?? ''),
      );
    })()`,
  );
  console.log(`[проба] поиск indent: ${JSON.stringify(search, null, 2)}`);

  // Запуск действия: indent сдвигает строки — по тексту модели и проверяем.
  const runResult = await ask(
    ide,
    `(async () => {
      const before = document.querySelector('.own-editor-line')?.textContent ?? '';
      const input = document.querySelector('.palette-input');
      input.value = 'indent';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      const item = [...document.querySelectorAll('.palette-item')].find((node) =>
        (node.querySelector('.palette-item-title')?.textContent ?? '').includes('отступ'),
      );
      if (!item) return { запуск: 'пункта нет', список: [...document.querySelectorAll('.palette-item-title')].map((n) => n.textContent) };
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const after = document.querySelector('.own-editor-line')?.textContent ?? '';
      return {
        пункт: item.querySelector('.palette-item-title')?.textContent,
        закрылась: document.querySelector('.palette')?.closest('.overlay')?.hidden ?? null,
        текстИзменился: before !== after,
        было: before.slice(0, 40),
        стало: after.slice(0, 40),
      };
    })()`,
  );
  console.log(`[проба] запуск действия: ${JSON.stringify(runResult, null, 2)}`);

  // «Сохранить как…» — не действие редактора, а команда приложения. Проверяем, что она
  // доехала до палитры (то есть зарегистрирована в реестре команд). Меню «☰» проверяем
  // отдельной пробой: оно двухуровневое и требует настоящего наведения мышью.
  const saveAs = await ask(
    ide,
    `(async () => {
      const paletteButton = [...document.querySelectorAll('.icon-btn')].find((item) =>
        (item.getAttribute('title') ?? '').startsWith('Палитра команд'),
      );
      if (!paletteButton) return 'нет кнопки палитры';
      paletteButton.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const input = document.querySelector('.palette-input');
      if (!input) return 'нет поля ввода';
      input.value = 'сохранить как';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 220));
      return [...document.querySelectorAll('.palette-item-title')].map((n) => n.textContent ?? '');
    })()`,
  );
  console.log(`[проба] «Сохранить как…» в палитре: ${JSON.stringify(saveAs, null, 2)}`);

  // «Сообщение коммита по diff»: команда должна быть в палитре, а кнопка — в панели
  // изменений. Сам запрос к модели не запускаем: в пробе модель не настроена, и
  // настоящий AI-прогон был бы проверкой другого (для него есть smoke:commitmsg).
  const commitMessage = await ask(
    ide,
    `(async () => {
      const openPalette = async (query) => {
        const button = [...document.querySelectorAll('.icon-btn')].find((item) =>
          (item.getAttribute('title') ?? '').startsWith('Палитра команд'),
        );
        button?.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const input = document.querySelector('.palette-input');
        input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 240));
      };

      await openPalette('сообщение коммита');
      const titles = [...document.querySelectorAll('.palette-item-title')].map((n) => n.textContent ?? '');

      // Панель изменений открываем её же командой — тем же путём, что человек.
      await openPalette('показать изменения');
      const item = [...document.querySelectorAll('.palette-item')].find((node) =>
        (node.querySelector('.palette-item-title')?.textContent ?? '').includes('Показать изменения'),
      );
      item?.click();
      await new Promise((resolve) => setTimeout(resolve, 600));

      const fromDiff = document.querySelector('.sc-from-diff');
      return {
        палитра: titles,
        кнопка: Boolean(fromDiff),
        подсказка: fromDiff?.getAttribute('title') ?? null,
        естьПолеКоммита: Boolean(document.querySelector('.sc-message')),
      };
    })()`,
  );
  console.log(`[проба] сообщение коммита по diff: ${JSON.stringify(commitMessage, null, 2)}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
