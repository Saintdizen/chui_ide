/**
 * Проба окна локальной истории файла: шапка · тело · подвал.
 *
 *   npm run probe:history
 *
 * Окно истории — модалка с фиксированной высотой, а действия у неё живут в подвале:
 * так кнопки держатся у нижнего края, а тело (список записей и предпросмотр) тянется
 * на всё свободное место. Раньше ряд действий лежал ПОСЛЕДНИМ ребёнком тела, и в
 * коротком окне он висел посреди окна, а под ним оставалась пустая полоса.
 *
 * Проверяем мерой, а не на глаз: у окна ровно три части, они идут впорядке
 * шапка → тело → подвал и стыкуются без зазоров; низ подвала совпадает с низом окна;
 * список и предпросмотр занимают высоту тела, а не свои прежние 54vh.
 *
 * Нужен собранный код: `npm run build`. Снимок — `.chui_ide/probe-shots/history-modal.png`.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { HistoryStore } = require('../dist/main/project/history-store.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();
app.on('window-all-closed', () => {});

let failed = 0;
const check = (label, condition, extra) => {
  if (!condition) failed += 1;
  const tail = extra !== undefined ? `: ${JSON.stringify(extra)}` : '';
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${tail}`);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-history-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  const note = path.join(project, 'note.txt');
  await fs.writeFile(note, 'первый вариант\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  // Снимки прежнего содержимого — источник локальной истории (см. src/main/index.ts).
  const history = new HistoryStore(path.join(dir, 'history'));
  workspace.onBeforeChange = (file, reason) => {
    const root = workspace.rootPath();
    if (!root) return;
    return history.capture(root, file, reason).catch(() => undefined);
  };
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git, history, host: new HostClient() });
  await workspace.open(project);
  // Две перезаписи — два снимка: у ленты истории должно быть что показать.
  await workspace.writeFile(note, 'второй вариант\n');
  await workspace.writeFile(note, 'третий вариант\n');

  const ide = openIdeWindow();
  await wait(6000);

  console.log('[проба] открываю «Локальная история» из дерева');
  await ask(
    ide,
    `(async () => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'note.txt',
      );
      if (!row) return 'нет строки';
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8 }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const item = [...document.querySelectorAll('.context-menu .context-item')].find((node) =>
        (node.textContent ?? '').includes('Локальная история'),
      );
      if (!item) return 'нет пункта';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      return 'открыто';
    })()`,
  );

  const geo = await ask(
    ide,
    `(() => {
      const modal = document.querySelector('.history-modal');
      if (!modal) return null;
      const box = (sel) => {
        const node = document.querySelector(sel);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), h: Math.round(rect.height) };
      };
      const rect = modal.getBoundingClientRect();
      return {
        окно: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), h: Math.round(rect.height) },
        шапка: box('.history-modal .modal-header'),
        тело: box('.history-modal .modal-body'),
        подвал: box('.history-modal .modal-footer'),
        список: box('.history-list'),
        предпросмотр: box('.history-preview'),
        кнопокВПодвале: document.querySelectorAll('.history-modal .modal-footer .btn').length,
        старыйРяд: document.querySelectorAll('.history-actions').length,
        записей: document.querySelectorAll('.history-row').length,
      };
    })()`,
  );

  check('окно истории открылось', geo !== null, geo === null ? 'окна нет' : undefined);
  check('у окна есть шапка, тело и подвал', Boolean(geo?.шапка && geo.тело && geo.подвал), {
    шапка: Boolean(geo?.шапка),
    тело: Boolean(geo?.тело),
    подвал: Boolean(geo?.подвал),
  });
  check(
    'части идут шапка → тело → подвал без зазоров',
    Boolean(geo && geo.шапка.bottom === geo.тело.top && geo.тело.bottom === geo.подвал.top),
    geo && { шапка: geo.шапка.bottom, тело: geo.тело.top, подвал: geo.тело.bottom },
  );
  check(
    'подвал прижат к нижнему краю окна',
    Boolean(geo && Math.abs(geo.подвал.bottom - geo.окно.bottom) <= 1),
    geo && {
      подвал: geo.подвал.bottom,
      окно: geo.окно.bottom,
    },
  );
  check('действия ушли в подвал', (geo?.кнопокВПодвале ?? 0) >= 2, geo?.кнопокВПодвале);
  check('прежнего ряда действий внутри тела нет', geo?.старыйРяд === 0, geo?.старыйРяд);
  check('лента записей наполнена', (geo?.записей ?? 0) >= 2, geo?.записей);
  check(
    'тело занимает середину окна, а не высоту содержимого',
    Boolean(geo && geo.тело.h > geo.окно.h / 2),
    geo && { тело: geo.тело.h, окно: geo.окно.h },
  );
  check(
    'список и предпросмотр растянуты по телу',
    Boolean(geo?.список && Math.abs(geo.список.h - geo.тело.h) <= 40),
    geo && { список: geo.список.h, тело: geo.тело.h },
  );

  const shots = path.join(__dirname, '..', '.chui_ide', 'probe-shots');
  await fs.mkdir(shots, { recursive: true });
  await fs.writeFile(path.join(shots, 'history-modal.png'), (await ide.capturePage()).toPNG());

  console.log(failed === 0 ? '\nокно истории разложено по шапке, телу и подвалу' : `\nпровалов: ${failed}`);
  console.log(`Снимок: ${path.join(shots, 'history-modal.png')}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(failed === 0 ? 0 : 1);
});
