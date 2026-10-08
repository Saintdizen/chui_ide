/**
 * Проверка своей рамки: окно без системных украшений, его размеры
 * считаются по краям и зажимаются по минимуму.
 *
 *   npm run smoke:window
 */
const { app, BrowserWindow } = require('electron');
const { applyBounds, windowState } = require('../dist/main/window.js');

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 800, height: 600, show: false, frame: false });
  window.setMinimumSize(400, 300);

  const results = [];
  const check = (label, patch, expected) => {
    const actual = applyBounds(window, patch);
    const ok = Object.entries(expected).every(([key, value]) => Math.abs(actual[key] - value) <= 1);
    results.push(`${ok ? '  ok  ' : ' FAIL '} ${label}: ${JSON.stringify(actual)}`);
    return ok;
  };

  const passed = [
    check('перенос окна', { x: 120, y: 90 }, { x: 120, y: 90, width: 800, height: 600 }),
    check('растянуть за правый-нижний край', { width: 1000, height: 700 }, { width: 1000, height: 700 }),
    check('сдвинуть левый край вправо', { x: 200, width: 920 }, { x: 200, width: 920 }),
    check('ниже минимума зажимается', { width: 100, height: 50 }, { width: 400, height: 300 }),
  ].every(Boolean);

  console.log(results.join('\n'));
  console.log(
    `[chui] состояние окна: ${JSON.stringify(windowState(window))}`,
    '\n[chui]',
    passed ? 'рамка и размеры работают' : 'проверки не прошли',
  );

  window.destroy();
  app.exit(passed ? 0 : 1);
});
