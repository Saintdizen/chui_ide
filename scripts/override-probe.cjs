/**
 * Проба «Переопределить методы предка»: заглушка появляется в файле.
 *
 *   npm run probe:override
 *
 * Зачем отдельная проба. Команда собирает заготовку по карте символов и по строке
 * объявления в файле предка, а вставляет её в конец тела класса. Юнит-тесты видят
 * правила (`tests/override-snippet.test.ts`), но не видят связки: курсор, попап с
 * выбором, вставка в нужное место файла. Проверяем здесь именно её — снаружи, через
 * палитру команд, как это делает человек.
 *
 * Карта символов подставная: сборка настоящей требует языкового сервера, а проверяем
 * мы не её (у неё своя проба, `npm run probe:symbols`). Файл предка читается настоящий —
 * параметры берутся из него.
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

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

/** Подставная карта: `Parser` наследует `Base`, у него один переопределяемый метод. */
function fakeIndex(basePath) {
  return {
    status: () => ({
      root: null,
      phase: 'ready',
      files: 2,
      decls: 4,
      dependencyFiles: 0,
      dependencyPackages: 0,
      skipped: 0,
    }),
    refresh: () => undefined,
    inherited: (name) => ({
      name,
      declared: { name, path: basePath, line: 3, bases: [] },
      ancestors: ['Base'],
      members: [
        { name: 'run', kind: 'метод', line: 4, path: basePath, from: 'Base' },
        { name: 'reset', kind: 'метод', line: 7, path: basePath, from: 'Base' },
      ],
      phase: 'ready',
    }),
  };
}

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-override-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  const basePath = path.join(project, 'base.py');
  await fs.writeFile(
    basePath,
    [
      'class Base:',
      '    def run(self, value: int, *, strict=False):',
      '        pass',
      '',
      '    def reset(self):',
      '        pass',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(project, 'app.py'),
    'from base import Base\n\n\nclass Parser(Base):\n    def own(self):\n        pass\n',
    'utf8',
  );

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({
    settings,
    workspace,
    ai,
    terminals,
    git,
    host: new HostClient(),
    index: fakeIndex(basePath),
  });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Открываем файл наследника и ставим курсор внутрь класса — так же, как человек.
  const opened = await ask(
    ide,
    `(async () => {
      const row = [...document.querySelectorAll('.tree-row[data-path]')].find((node) =>
        node.getAttribute('data-path').endsWith('app.py'),
      );
      if (!row) return 'ряд файла не найден';
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        остров: document.querySelector('.editor-island')?.className ?? null,
        вкладки: [...document.querySelectorAll('.tab-label')].map((node) => node.textContent),
        строк: document.querySelectorAll('.editor-line, .own-editor-line').length,
      };
    })()`,
  );
  console.log(`[открытие] ${JSON.stringify(opened)}`);

  // Курсор — внутрь класса: команда отказывает, если он на верхнем уровне файла.
  // Ставим его переходом к строке (Ctrl+G) — так же, как это делает человек.
  const caret = await ask(
    ide,
    `(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const input = document.querySelector('.own-editor-goto input, .own-editor-goto-input');
      if (!input) return { error: 'нет поля перехода к строке' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '5');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { строка: 5 };
    })()`,
  );
  console.log(`[курсор] ${JSON.stringify(caret)}`);

  // Палитра команд: тот же путь, которым команду зовёт человек. Кнопки в шапке нет
  // (её убрали из вида, но узел остался), поэтому жмём её — Enter-сочетание
  // перехватывает редактор.
  const invoked = await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find((item) =>
        (item.getAttribute('title') ?? '').startsWith('Палитра команд'),
      );
      if (!button) return { error: 'нет кнопки палитры' };
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const input = document.querySelector('.palette-input');
      if (!input) return { error: 'палитра не открылась' };
      input.value = 'Переопределить методы';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const items = [...document.querySelectorAll('.palette-item')];
      const target = items[0];
      if (!target) {
        return { error: 'команды нет в палитре', есть: [...document.querySelectorAll('.palette-item-title')].map((n) => n.textContent) };
      }
      target.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      return {
        пункты: [...document.querySelectorAll('.context-menu button')].map((node) => node.textContent.trim()),
      };
    })()`,
  );
  console.log('[палитра]', JSON.stringify(invoked));
  check(
    'команда нашлась и открыла список предков',
    Array.isArray(invoked?.пункты) && invoked.пункты.some((text) => text.includes('run')),
    invoked,
  );

  const picked = await ask(
    ide,
    `(async () => {
      const item = [...document.querySelectorAll('.context-menu button')].find((node) =>
        node.textContent.includes('run'),
      );
      if (!item) return { error: 'нет пункта run' };
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      // Текст редактора из DOM: видно, дошла ли вставка до документа.
      const island = document.querySelector('.editor-island');
      return {
        строки: [...island.querySelectorAll('[class*="line"], .own-editor-row, div')]
          .map((node) => node.textContent)
          .filter((text) => text && text.length < 120)
          .slice(0, 20),
        тост: document.querySelector('.toast-text')?.textContent ?? null,
      };
    })()`,
  );
  console.log('[вставка]', JSON.stringify(picked).slice(0, 600));

  // Читаем файл с диска: вставка идёт через документ, а сохраняет его редактор.
  // Сохраняем кнопкой шапки: после клика по пункту меню фокус не в редакторе, и
  // сочетание Ctrl+S уходит в никуда — человек жмёт кнопку или возвращается в текст.
  const saved = await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find((item) =>
        (item.getAttribute('title') ?? '').startsWith('Сохранить всё'),
      );
      if (!button) return 'нет кнопки сохранения';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      return 'сохранено';
    })()`,
  );
  console.log(`[сохранение] ${saved}`);
  await wait(600);

  const text = await fs.readFile(path.join(project, 'app.py'), 'utf8');
  console.log('[файл]', JSON.stringify(text));

  check('заготовка метода появилась', text.includes('def run('), text.includes('def run('));
  check('параметры взяты у предка', text.includes('value: int'), text.includes('value: int'));
  check('self не потерялся и не удвоился', /def run\(self, value: int/.test(text), text.match(/def run\([^)]*\)/)?.[0]);
  check(
    'вызов предка с теми же аргументами, именованные — по имени',
    text.includes('super().run(value, strict=strict)'),
    text.match(/super\(\)\.run\([^)]*\)/)?.[0],
  );
  check('заготовка встала внутрь класса', /class Parser\(Base\):[\s\S]*def run\(/.test(text));

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[проба] переопределение: есть расхождения' : '[проба] переопределение собирает заготовку');
  app.exit(failed ? 1 : 0);
});
