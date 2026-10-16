/**
 * Проверка своей рамки: окно создаётся без системных украшений и остаётся
 * растягиваемым.
 *
 *   npm run smoke:window
 *
 * Своих полос по краям в приложении нет — окно растягивает сам Chromium, как
 * безрамочное. Поэтому считать арифметику больше нечего, а вот то, что
 * растягивание не потерялось, важно: `frame: false` без `resizable: true` дал бы
 * окно, которое нельзя изменить мышью, а без минимума размера — окно, сжимаемое
 * «в ноль». Проверка держит эти условия и состояние, которое читает своя рамка.
 */
const { app } = require('electron');
const { createWelcomeWindow, windowState } = require('../dist/main/window.js');

app.whenReady().then(() => {
  // Стартовое окно — та же своя рамка, что у IDE, только меньше размером.
  const window = createWelcomeWindow();
  window.setSize(820, 560);

  const results = [];
  const check = (label, actual, ok, expected) => {
    results.push(
      `${ok ? '  ok  ' : ' FAIL '} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (ждали ${JSON.stringify(expected)})`}`,
    );
    return ok;
  };

  const minSize = window.getMinimumSize();
  const state = windowState(window);
  const fields = Object.keys(state).sort().join(',');

  const passed = [
    check('окно растягиваемое', window.isResizable(), window.isResizable() === true, true),
    check('минимум размера задан', minSize, minSize[0] > 0 && minSize[1] > 0, ['> 0', '> 0']),
    check('окно не сжалось ниже минимума', window.getSize(), window.getSize()[0] >= minSize[0], `>= ${minSize[0]}`),
    check('рамка своя', state.customControls, state.customControls === true, true),
    check(
      'состояние окна для рамки',
      fields,
      fields === 'customControls,fullScreen,maximized,platform',
      'customControls,fullScreen,maximized,platform',
    ),
  ].every(Boolean);

  console.log(results.join('\n'));
  console.log('[chui]', passed ? 'рамка и растягивание на месте' : 'проверки не прошли');

  window.destroy();
  app.exit(passed ? 0 : 1);
});
