/**
 * Проба запуска с подсказками: сколько уведомлений о подключённых языковых серверах
 * видит человек при открытии проекта.
 *
 *   npm run probe:lspstart
 *
 * Проба про старт, а не про серверы: в момент загрузки окна поиск серверов зовут
 * несколько раз (загрузка, открытие проекта, смена активного корня), и раньше
 * каждый прогон дописывал тот же список и показывал СВОЁ уведомление — на экране
 * появлялись два-три одинаковых тоста. Проверяем то, что видит человек: сколько
 * уведомлений одновременно в кадре и складывается ли текст в один список.
 *
 * Серверы ищутся по-настоящему в этом же проекте (в нём стоят серверы поставки),
 * поэтому окно должно поднимать IDE на каталоге с `node_modules`.
 *
 * Отчёт — вывод в консоль; окно закрывается само.
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
const { createApplicationMenu } = require('../dist/main/menu.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TOASTS = "[...document.querySelectorAll('.toast-text')].map((node) => node.textContent)";

app.whenReady().then(async () => {
  // Настройки — свои: список серверов должен быть ПУСТ, иначе дописывать нечего и
  // проверка пройдёт, ничего не проверив.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-start-'));

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai: new AiService(settings, workspace), terminals, git, host: new HostClient() });
  createApplicationMenu();
  // Проект — сам этот каталог: в нём есть серверы поставки, которые и находятся.
  await workspace.open(path.join(__dirname, '..'));

  const ide = openIdeWindow();
  // Опрос идёт С ПЕРВОГО кадра: уведомление живёт четыре секунды, а прогрев окна
  // дольше — к первому «осмысленному» опросу его уже нет.
  const texts = [];
  let maxAtOnce = 0;
  let maxLspAtOnce = 0;
  for (let step = 0; step < 80; step += 1) {
    const frame = await ide.webContents.executeJavaScript(TOASTS).catch(() => []);
    for (const text of frame) if (!texts.includes(text)) texts.push(text);
    maxAtOnce = Math.max(maxAtOnce, frame.length);
    maxLspAtOnce = Math.max(maxLspAtOnce, frame.filter((text) => text.includes('Языковые серверы подключены')).length);
    await wait(150);
  }

  const lspTexts = texts.filter((text) => text.includes('Языковые серверы подключены'));
  check('о подключении серверов сказано', lspTexts.length > 0, texts);
  check('уведомление о серверах одно, а не по одному на каждый вызов', maxLspAtOnce === 1, {
    одновременно: maxLspAtOnce,
  });
  check('в кадре не бывает нескольких уведомлений сразу', maxAtOnce <= 1, { одновременно: maxAtOnce, тексты: texts });
  if (lspTexts.length > 0) {
    // Список в уведомлении — тот же, что записался в настройки: иначе человек видит
    // одно, а работает другое.
    const saved = settings.get().lsp.servers.map((server) => server.language);
    const shown = lspTexts[0].replace('Языковые серверы подключены: ', '').split(', ');
    check('уведомление перечислило ровно записанные языки', shown.join(',') === saved.slice(-shown.length).join(','), {
      показано: shown,
      записано: saved,
    });
  }

  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[проба] старт подсказок: есть расхождения' : '[проба] о серверах сказано один раз');
  app.exit(failed ? 1 : 0);
});
