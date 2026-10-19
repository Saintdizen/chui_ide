/**
 * Проверка чипа языкового сервера в статусбаре и его попапа.
 *
 * Главное, что проверяем: «почему нет подсказок» видно прямо в окне. Чип называет
 * сервер языка и источник, а попап перечисляет запущенное и то, что не поднялось.
 * Серверов в пробе нет — вместо них подставной `lsp`: настоящие процессы тут ни к
 * чему, проверяется показ состояния, а не запуск серверов.
 *
 *   ./node_modules/.bin/electron scripts/lsp-status-probe.cjs
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

/**
 * Подставная карта символов: она «собирается». Настоящая сборка читает весь проект
 * и поднимает серверы — здесь проверяется только показ состояния, поэтому ответ готовый.
 */
function fakeIndex() {
  return {
    status: () => ({
      root: null,
      phase: 'warming',
      files: 812,
      decls: 4000,
      dependencyFiles: 120,
      dependencyPackages: 9,
      skipped: 0,
    }),
    refresh: () => undefined,
    inherited: (name) => ({ name, declared: null, ancestors: [], members: [], phase: 'warming' }),
  };
}

/** Подставной сервис серверов: состояние отдаём готовым, процессы не запускаем. */
function fakeLsp(status) {
  return {
    open: async () => undefined,
    change: () => undefined,
    close: () => undefined,
    restart: () => ({ running: [], servers: [], failed: [] }),
    status: () => status,
    request: async () => null,
    projectSymbols: () => [],
    // Прогрев зовётся renderer'ом при открытии проекта: подставному сервису он ни к чему.
    prewarm: async () => undefined,
    outline: async () => null,
    completionTriggers: () => ({ triggerCharacters: [], allCommitCharacters: [], resolveProvider: false }),
  };
}

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-status-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  // Python-файл: именно для его языка в статусбаре встаёт чип сервера.
  await fs.writeFile(path.join(project, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
  await fs.writeFile(path.join(project, 'main.py'), 'print(1)\n', 'utf8');

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
    index: fakeIndex(),
    // Статус для чипа: python поднят из поставки, go — не поднялся.
    lsp: fakeLsp({
      running: ['python'],
      servers: [{ language: 'python', label: 'Pyright', origin: 'bundled' }],
      failed: [{ language: 'go', reason: 'сервер не найден' }],
    }),
  });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);
  // Намеренно низкое окно: попап не должен вылезать за нижний край.
  ide.setSize(900, 480);
  await wait(800);

  // Открываем Python-файл двойным щелчком в дереве — так же, как это делает человек:
  // от активного языка зависит, чей сервер показывать в чипе.
  const opened = await ask(
    ide,
    `(async () => {
      const row = [...document.querySelectorAll('.tree-row[data-path]')].find((node) =>
        node.getAttribute('data-path').endsWith('main.py'),
      );
      if (!row) return 'ряд файла не найден';
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return document.querySelector('.status-lsp') ? 'чип есть' : 'чипа нет';
    })()`,
  );
  console.log(`[открытие] ${opened}`);

  const report = await ask(
    ide,
    `(async () => {
      const chip = document.querySelector('.status-lsp');
      if (!chip) return { error: 'чипа языкового сервера нет' };
      chip.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const box = document.querySelector('.popover-lsp-status');
      const rect = box ? box.getBoundingClientRect() : null;
      return {
        chipText: chip.textContent.trim(),
        chipTitle: chip.title,
        chipHidden: chip.hidden,
        rows: [...document.querySelectorAll('.lsp-status-row')].map((row) => row.textContent.trim()),
        failedRows: document.querySelectorAll('.lsp-status-row.is-failed').length,
        actions: [...document.querySelectorAll('.lsp-status-action')].map((button) => button.textContent.trim()),
        popoverFits: rect ? rect.top >= 0 && rect.bottom <= window.innerHeight && rect.left >= 0 : null,
        symbolsText: document.querySelector('.status-symbols')?.textContent.trim() ?? null,
        symbolsHidden: document.querySelector('.status-symbols')?.hidden ?? null,
        window: { width: window.innerWidth, height: window.innerHeight },
      };
    })()`,
  );

  const failures = [];
  const ok = (label, condition, extra = '') => {
    console.log(`  ${condition ? 'ok  ' : 'ПЛОХО'} ${label}${extra ? `: ${extra}` : ''}`);
    if (!condition) failures.push(label);
  };

  if (report?.error) {
    ok('чип языкового сервера есть', false, report.error);
  } else {
    ok('чип называет сервер языка', report.chipText === 'Pyright', report.chipText);
    ok('подсказка чипа говорит об источнике', String(report.chipTitle).includes('поставка IDE'), report.chipTitle);
    ok('чип виден', report.chipHidden === false);
    ok(
      'попап перечисляет серверы',
      report.rows.some((row) => row.includes('Pyright')),
      report.rows.join(' | '),
    );
    ok('не поднявшийся сервер показан отдельно', report.failedRows >= 1, String(report.failedRows));
    ok('в попапе есть действия', report.actions.length === 2, report.actions.join(', '));
    ok('попап помещается в окно', report.popoverFits === true, JSON.stringify(report.window));
    // Карта символов собирается — в полосе состояния видно, сколько уже разобрано.
    ok('виджет карты символов показывает сборку', report.symbolsText === 'Символы: 812…', report.symbolsText);
    ok('виджет карты символов виден', report.symbolsHidden === false, String(report.symbolsHidden));
  }

  const shot = path.join(process.env.TMPDIR ?? '/tmp', 'chui-lsp-status-probe.png');
  await fs.writeFile(shot, (await ide.capturePage()).toPNG());
  console.log(`[языковые серверы] снимок: ${shot}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failures.length === 0 ? '[chui] чип языковых серверов работает' : `[chui] ошибок: ${failures.length}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
