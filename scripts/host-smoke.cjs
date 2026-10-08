/**
 * Проверка обратного моста main → renderer: renderer исполняет действие,
 * main получает результат, ошибки и отмена доезжают корректно.
 *
 *   npm run smoke:host
 *
 * Нужен собранный main (npm run build:main). Окно не показывается.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const { HostClient } = require('../dist/main/ipc/host.js');

let failed = false;
const check = (label, condition, extra) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

app.whenReady().then(async () => {
  const host = new HostClient();
  host.attach();

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  try {
    await window.loadURL('data:text/html,<html><body>host-smoke</body></html>');

    // Регистрируем обработчик так же, как это делает панель чата.
    await window.webContents.executeJavaScript(`
      window.__seen = [];
      window.chui.onHostRequest((request) => {
        window.__seen.push(request);

        // Намеренное молчание нужно, чтобы проверить закрытие окна.
        if (request.params && request.params.silent) return;

        if (request.method === 'ai.applyEdits') {
          const edits = request.params.edits;
          if (edits[0].path === '/nope') {
            window.chui.replyHostRequest({
              id: request.id,
              ok: false,
              error: { code: -32602, message: 'путь вне рабочей папки' },
            });
            return;
          }
          window.chui.replyHostRequest({
            id: request.id,
            ok: true,
            value: {
              rejected: false,
              result: { reports: [{ path: edits[0].path, applied: 1, version: 3 }], failed: [] },
            },
          });
          return;
        }

        // Как HostService: неизвестный метод — ошибка, а не тишина.
        window.chui.replyHostRequest({
          id: request.id,
          ok: false,
          error: { code: -32601, message: 'renderer не умеет «' + request.method + '»' },
        });
      });
      true;
    `);

    check('мост отдаёт onHostRequest и replyHostRequest', await window.webContents.executeJavaScript(
      `typeof window.chui.onHostRequest === 'function' && typeof window.chui.replyHostRequest === 'function'`,
    ));

    const value = await host.request(window.webContents, 'ai.applyEdits', {
      edits: [{ path: '/tmp/a.ts', edits: [] }],
    });
    check('ответ renderer доехал до main', value.rejected === false && value.result.reports[0].applied === 1, value);

    const seen = await window.webContents.executeJavaScript('window.__seen.length');
    check('renderer получил запрос с params', seen === 1, seen);

    let errorCode = null;
    let errorMessage = '';
    try {
      await host.request(window.webContents, 'ai.applyEdits', { edits: [{ path: '/nope', edits: [] }] });
    } catch (error) {
      errorCode = error.code;
      errorMessage = error.message;
    }
    check('ошибка renderer приезжает кодом', errorCode === -32602, { errorCode, errorMessage });

    let missingCode = null;
    try {
      await host.request(window.webContents, 'ai.unknown', {});
    } catch (error) {
      missingCode = error.code;
    }
    check('неизвестный метод не зависает', missingCode === -32601, missingCode);

    const controller = new AbortController();
    controller.abort();
    let abortCode = null;
    try {
      await host.request(window.webContents, 'ai.applyEdits', { edits: [] }, controller.signal);
    } catch (error) {
      abortCode = error.code;
    }
    check('отменённый сигнал прерывает ожидание', abortCode === -32800, abortCode);

    // Ответ на запрос, которого уже никто не ждёт, не должен ломать HostClient.
    const stale = await window.webContents.executeJavaScript(
      `window.chui.replyHostRequest({ id: 'нет-такого', ok: true, value: null })`,
    );
    check('запоздалый ответ игнорируется', stale === false, stale);

    // Окно закрылось, пока renderer думал — ожидание в main не должно висеть.
    const hanging = host.request(window.webContents, 'ai.applyEdits', { edits: [], silent: true });
    window.destroy();
    let closedCode = null;
    try {
      await hanging;
    } catch (error) {
      closedCode = error.code;
    }
    check('закрытие окна прерывает ожидание', closedCode === -32603, closedCode);
  } catch (error) {
    failed = true;
    console.error('[chui] исключение:', error);
  } finally {
    if (!window.isDestroyed()) window.destroy();
    console.log(failed ? '[chui] обратный мост НЕ прошёл' : '[chui] обратный мост работает');
    app.exit(failed ? 1 : 0);
  }
});
