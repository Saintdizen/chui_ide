/**
 * Проба панели «Задачи»: пометки TODO/FIXME/HACK/XXX по проекту.
 *
 *   npm run probe:todo
 *
 * Юнит-тесты проверяют разбор и группировку находок (`tests/todo-list.test.ts`) на
 * данных в памяти. Здесь проверяется то, чего они не видят: как список собирается из
 * НАСТОЯЩЕГО поиска по проекту и как ведёт себя в окне — открытие вкладки командой,
 * строки с видами пометок, фильтр и переход по клику в файл.
 *
 * Даже если ripgrep в системе не установлен, поиск идёт своим обходом — обе дороги
 * дают один результат, и панель от этого не зависит.
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
  Promise.race([window.webContents.executeJavaScript(expression).catch((e) => `ошибка: ${e.message}`), wait(timeoutMs).then(() => 'нет ответа')]);

const SOURCE = [
  'const value = 1; // TODO: переписать на класс',
  '',
  'function risky() {',
  '  // FIXME: падает на пустом вводе',
  '  return value;',
  '}',
  '',
  '// HACK: обходной путь, убрать после релиза',
  '// XXX: проверить лицензию',
  '',
].join('\n');

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-todo-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'a.ts'), SOURCE, 'utf8');
  await fs.writeFile(path.join(project, 'b.ts'), '// TODO: второй файл\nconst other = 2;\n', 'utf8');

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

  // Открываем панель командой через палитру — тем же путём, что и человек.
  const opened = await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find((item) =>
        (item.getAttribute('title') ?? '').startsWith('Палитра команд'),
      );
      if (!button) return 'нет кнопки палитры';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const input = document.querySelector('.palette-input');
      input.value = 'задачи';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 240));
      const item = [...document.querySelectorAll('.palette-item')].find((node) =>
        (node.querySelector('.palette-item-title')?.textContent ?? '').includes('Задачи'),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return 'открыли';
    })()`,
  );
  console.log(`[задачи] открыть панель: ${JSON.stringify(opened)}`);
  await wait(1200);

  const panel = await ask(
    ide,
    `(() => {
      const rows = [...document.querySelectorAll('.todo-row')];
      return {
        заголовок: document.querySelector('.todo-title')?.textContent ?? null,
        сводка: document.querySelector('.todo-summary')?.textContent ?? null,
        всего_строк: rows.length,
        строки: rows.map((row) => ({
          вид: row.querySelector('.todo-marker')?.textContent ?? '',
          текст: row.querySelector('.todo-text')?.textContent ?? '',
          место: row.querySelector('.todo-position')?.textContent ?? '',
        })),
        файлы: [...document.querySelectorAll('.todo-file')].map((n) => n.textContent),
        пусто: document.querySelector('.todo-empty')?.textContent ?? null,
      };
    })()`,
  );
  console.log(`[задачи] список: ${JSON.stringify(panel, null, 2)}`);

  // Фильтр: оставляем только строки со словом «падает».
  const filtered = await ask(
    ide,
    `(() => {
      const field = document.querySelector('.todo-filter');
      field.value = 'падает';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      const rows = [...document.querySelectorAll('.todo-row')];
      return {
        строк: rows.length,
        тексты: rows.map((row) => row.querySelector('.todo-text')?.textContent ?? ''),
      };
    })()`,
  );
  console.log(`[задачи] фильтр «падает»: ${JSON.stringify(filtered, null, 2)}`);

  // Снимаем фильтр и переходим по первой строке — файл должен открыться вкладкой.
  const navigated = await ask(
    ide,
    `(async () => {
      const field = document.querySelector('.todo-filter');
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      const first = document.querySelector('.todo-row');
      if (!first) return 'нет строк';
      first.click();
      await new Promise((resolve) => setTimeout(resolve, 800));
      return {
        вкладка: document.querySelector('.tab.is-active .tab-label')?.textContent ?? null,
        есть_редактор: Boolean(document.querySelector('.own-editor')),
      };
    })()`,
  );
  console.log(`[задачи] переход по клику: ${JSON.stringify(navigated, null, 2)}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
