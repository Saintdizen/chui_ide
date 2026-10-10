/**
 * Проверка моста `window.chui`: preload собирается, contextBridge отдаёт его
 * странице и renderer видит только четыре метода, а не весь ipcRenderer.
 *
 * Отдельная проверка на песочницу — не роскошь: с `sandbox: true` preload не
 * грузится вовсе, а интерфейс остаётся пустым без единой строки в консоли.
 * Сейчас песочница выключена (`window.ts`), и вот почему: `tsc` компилирует
 * preload без бандлинга, а песочному preload относительный `require` недоступен
 * — он умеет требовать только `electron`, `events`, `timers` и `url`.
 * Проверить: `npm run smoke:bridge -- true` (сегодня — падение с `module not found`).
 */
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// По умолчанию — то же, что в `window.ts`: тогда проверка отвечает за сборку.
const SANDBOX = process.argv[2] === 'true';
const dist = path.join(__dirname, '..', 'dist');

const EXPECTED_KEYS = [
  'call',
  'cancel',
  'off',
  'onHostRequest',
  'onPush',
  'onRpcEvent',
  'platform',
  'replyHostRequest',
  'versions',
];

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(dist, 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: SANDBOX,
      spellcheck: false,
    },
  });

  const failures = [];
  const check = (label, ok, detail) => {
    failures.push(...(ok ? [] : [` FAIL ${label}: ${detail}`]));
    return ok;
  };

  window.webContents.on('preload-error', (_event, file, error) => {
    failures.push(` FAIL preload: ${file}: ${error?.message}`);
  });

  // Страница-заглушка: проверяем ровно мост, без renderer'а приложения.
  await window.loadURL('data:text/html,<html><body>bridge</body></html>');

  const info = await window.webContents.executeJavaScript(
    `({
       bridge: typeof window.chui,
       keys: window.chui ? Object.keys(window.chui).sort() : null,
       platform: window.chui ? window.chui.platform : null,
       node: window.chui ? window.chui.versions.node : null,
       subscription: window.chui ? window.chui.onRpcEvent(function () {}) : null,
     })`,
  );

  check('мост доступен странице', info.bridge === 'object', `typeof window.chui = ${info.bridge}`);
  check(
    'набор методов',
    JSON.stringify(info.keys) === JSON.stringify(EXPECTED_KEYS),
    `получено ${JSON.stringify(info.keys)}`,
  );
  check('platform на месте', typeof info.platform === 'string' && info.platform !== '', `platform = ${info.platform}`);
  check('версии на месте', typeof info.node === 'string' && info.node !== '', `versions.node = ${info.node}`);
  check(
    'подписка регистрируется',
    typeof info.subscription === 'number' && info.subscription > 0,
    `onRpcEvent вернул ${info.subscription}`,
  );

  console.log(`[chui] sandbox=${SANDBOX} ${JSON.stringify(info)}`);
  if (failures.length > 0) console.log(failures.join('\n'));
  console.log('[chui]', failures.length === 0 ? 'мост работает' : 'мост сломан');

  window.destroy();
  app.exit(failures.length === 0 ? 0 : 1);
});
