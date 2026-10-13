/**
 * Проба своего редактора: верстка в настоящем Chromium.
 *
 *   npm run probe:editor
 *
 * Юнит-тесты проверяют арифметику (`line-layout`, `viewport`, `selection`) в Node,
 * но не видят главного: как это ложится на экран. Здесь страница с редактором
 * открывается в окне Electron, и проба:
 *
 * 1. Снимает геометрию: высоту строки, ширину числа, ширину полосы номеров, размер
 *    полотна. По ним видно, совпадает ли расчёт с тем, что нарисовано.
 * 2. Проверяет виртуализацию: в DOM должны быть только видимые строки, а не две
 *    тысячи. Если бы рисовалось всё, снимок бы это показал, но числа надёжнее.
 * 3. Двигает каретку по строке с табуляцией и по строке с широкими знаками: ширина
 *    табуляции должна быть кратна столбцу, а иероглиф — занимать две клетки. Это
 *    проверка раскладки по факту, а не по коду.
 * 4. Ставит выделение и прокручивает — и снимает PNG на каждом шаге.
 *
 * Отчёт кладётся в `.chui_ide/probe-editor.txt`, снимки — в `.chui_ide/probe-shots/`.
 */

const { app, BrowserWindow } = require('electron');
const { promises: fs, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('rolldown');

const PROJECT = path.join(__dirname, '..');
const ENTRY = path.join(PROJECT, 'src/renderer/probe/editor-probe.ts');
const OUT_DIR = path.join(PROJECT, '.chui_ide');
const SHOTS = path.join(OUT_DIR, 'probe-shots');
const REPORT = path.join(OUT_DIR, 'probe-editor.txt');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Оформление страницы: настоящие токены темы и настоящий шрифт кода. */
function pageStyles() {
  const read = (relative) => readFileSync(path.join(PROJECT, relative), 'utf8');
  // Ссылки на шрифты в `fonts.css` относительные — переписываем на абсолютные
  // file://, иначе из временного каталога они никуда не ведут.
  const fonts = read('src/renderer/styles/fonts.css').replace(/url\("([^"]+)"\)/g, (_match, href) => {
    const absolute = path.resolve(PROJECT, 'src/renderer/styles', href);
    return `url("${pathToFileURL(absolute).href}")`;
  });
  const theme = read('src/renderer/styles/theme.css');
  const editor = read('src/renderer/styles/editor.css');
  return [fonts, theme, editor].join('\n');
}

function pageHtml(styles) {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="dark light" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"
    />
    <style>${styles}</style>
    <style>
      html, body { margin: 0; height: 100%; background: var(--surface_window); }
      #probe-root { height: 100%; }
    </style>
  </head>
  <body>
    <div id="probe-root"></div>
    <script src="./bundle.js"></script>
  </body>
</html>`;
}

/** Собрать страницу пробы: бандл редактора плюс оформление. */
async function prepare() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(SHOTS, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-editor-probe-'));
  const bundle = path.join(dir, 'bundle.js');

  await build({
    input: ENTRY,
    platform: 'browser',
    output: { file: bundle, format: 'iife', sourcemap: false },
    // Отладочные сообщения сборщика в пробе не нужны.
    logLevel: 'silent',
  });

  await fs.writeFile(path.join(dir, 'index.html'), pageHtml(pageStyles()), 'utf8');
  return { dir, page: path.join(dir, 'index.html') };
}

/**
 * Дождаться, пока страница отрисует кадр. Без этого снимок может вернуть прежнее
 * изображение: `capturePage` берёт уже готовый кадр, а правка DOM его ещё не вызвала.
 * Двух кадров хватает — первый Chromium тратит на пересчёт, второй уже рисует.
 */
function settle(win) {
  return win.webContents
    .executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    )
    .catch(() => undefined);
}

/** Прочитать снимок окна и положить его в `.chui_ide/probe-shots`. */
async function shot(win, name) {
  await settle(win);
  // Снимок может не прийти (окно не нарисовало кадр) — не даём пробе зависнуть
  // на этом навсегда: лучше пропущенный снимок, чем оборванный отчёт.
  const image = await Promise.race([win.capturePage(), wait(10000).then(() => null)]);
  if (!image) return 'кадр не получен';
  const file = path.join(SHOTS, `editor-${name}.png`);
  await fs.writeFile(file, image.toPNG());
  return file;
}

/**
 * Действия на странице. Все они возвращают числа и строки — то, что проба печатает
 * и складывает в отчёт. Держим их одной строкой-выражением: `executeJavaScript`
 * получает функцию и вызывает её на месте.
 */
const CHECKS = {
  // 1. Геометрия: высота строки, ширина числа, полоса номеров, размер полотна, счёт строк.
  geometry: `(() => {
    const view = window.probe.view;
    const root = document.querySelector('.own-editor');
    const line = root.querySelector('.own-editor-line');
    const gutter = root.querySelector('.own-editor-gutter');
    const content = root.querySelector('.own-editor-content');
    const viewport = root.querySelector('.own-editor-viewport');
    // Ширину клетки берём тестом строки из нулей: она моноширинна и предсказуема.
    const probe = document.createElement('span');
    probe.textContent = '0000000000';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    line.append(probe);
    const charWidth = probe.getBoundingClientRect().width / 10;
    const lineHeight = line.getBoundingClientRect().height;
    probe.remove();
    return {
      всего_строк: view.element.querySelectorAll('.own-editor-line').length,
      ширина_клетки: Math.round(charWidth * 1000) / 1000,
      высота_строки: lineHeight,
      ширина_номеров: Math.round(gutter.getBoundingClientRect().width),
      высота_полотна: content.getBoundingClientRect().height,
      ширина_полотна: Math.round(content.getBoundingClientRect().width),
      поле_прокрутки: [viewport.clientWidth, viewport.clientHeight],
    };
  })()`,

  // 2. Виртуализация и содержимое: строк в DOM мало, тексты совпадают с моделью.
  // Ищем ТОЛЬКО внутри редактора пробы: на странице живут и другие редакторы
  // (хозяин, рабочее место, сравнение), и общий `querySelectorAll` собрал бы их
  // строки вместе — тогда индексы строк и номеров разъехались бы.
  virtual: `(() => {
    const view = window.probe.view;
    const buffer = window.probe.buffer;
    const scope = view.element;
    const rows = [...scope.querySelectorAll('.own-editor-line')];
    const numbers = [...scope.querySelectorAll('.own-editor-gutter-row')].map((n) => Number(n.textContent));
    return {
      всего_в_документе: buffer.lineCount,
      строк_в_DOM: rows.length,
      виртуализация: rows.length * 10 < buffer.lineCount,
      номера_подряд: numbers.every((value, index) => index === 0 || value === numbers[index - 1] + 1),
      первый_номер: numbers[0],
      первая_строка: rows[0]?.textContent ?? null,
      тексты_совпадают: rows.every((row, index) =>
        row.textContent === buffer.lineText(numbers[index])),
    };
  })()`,

  // 3. Раскладка по факту: табуляция кратна столбцу, широкий знак — две клетки.
  layout: `(() => {
    const view = window.probe.view;
    const buffer = window.probe.buffer;
    const root = document.querySelector('.own-editor');
    // Координату каретки спрашиваем у вида (caretPoint), а не у DOM-узла: слой кареток
    // пересобирается на каждое движение (replaceChildren), и узел, взятый один раз,
    // остаётся отсоединённым со старым translate(0px) — проба мерила бы нули.
    const xAt = (line, column) => {
      const offset = buffer.lineStart(line) + column - 1;
      view.setSelection({ anchor: offset, active: offset });
      return view.caretPoint(offset).left;
    };
    const line = root.querySelector('.own-editor-line');
    const probe = document.createElement('span');
    probe.textContent = '0000000000';
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    line.append(probe);
    const charWidth = probe.getBoundingClientRect().width / 10;
    probe.remove();

    // Строка 5: «\\tтабуляция…» — после первого таба каретка стоит на 4-м столбце.
    const tabStart = xAt(5, 1);
    const afterTab = xAt(5, 2);
    // Строка 6: «const wide = "日本語のテキスト" + …»
    // 15-й столбец — перед первым иероглифом, 22-й — после семи широких знаков.
    const beforeWide = xAt(6, 15);
    const afterWide = xAt(6, 22);
    return {
      клетка: Math.round(charWidth * 1000) / 1000,
      таб_x: Math.round(afterTab - tabStart),
      таб_четыре_клетки: Math.abs((afterTab - tabStart) - charWidth * 4) < 0.5,
      до_широких: Math.round(beforeWide),
      после_широких: Math.round(afterWide),
      ширина_семи: Math.round((afterWide - beforeWide) / charWidth),
      широкие_две_клетки: Math.abs((afterWide - beforeWide) - charWidth * 14) < 1,
    };
  })()`,

  // 3b. Выравнивание: строка в DOM стоит там же, где её считает модель. Ловит сдвиг
  // слоёв: текст (слой со translateY) и абсолютные координаты считаются по-разному.
  alignment: `(() => {
    const view = window.probe.view;
    const buffer = window.probe.buffer;
    const scope = view.element;
    const content = scope.querySelector('.own-editor-content');
    const contentTop = content.getBoundingClientRect().top;
    const rows = [...scope.querySelectorAll('.own-editor-line')];
    const numbers = [...scope.querySelectorAll('.own-editor-gutter-row')].map((n) => Number(n.textContent));
    const out = [];
    for (let i = 0; i < Math.min(rows.length, 5); i += 1) {
      const line = numbers[i];
      if (line === undefined) break;
      const domY = Math.round(rows[i].getBoundingClientRect().top - contentTop);
      const modelY = Math.round(view.caretPoint(buffer.lineStart(line)).top);
      out.push({ строка: line, domY, modelY, сдвиг: domY - modelY });
    }
    const firstNumber = numbers[0] ?? null;
    return { первая_строка: firstNumber, выравнивание: out, линия_1_видна: numbers.includes(1) };
  })()`,

  // 4. Каретка и выделение: каретка прячется при выделении, прямоугольники появляются.
  selection: `(() => {
    const view = window.probe.view;
    const root = document.querySelector('.own-editor');
    // Каретку спрашиваем заново после каждого движения: слой кареток пересобирается
    // (replaceChildren), и узел, взятый один раз, остаётся отсоединённым и не меняется.
    const caretDisplay = () => root.querySelector('.own-editor-caret')?.style.display ?? 'нет';
    const rects = () => [...root.querySelectorAll('.own-editor-selection-rect')].map((node) => {
      const match = node.style.transform.match(/translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/);
      return {
        x: Math.round(Number(match?.[1] ?? 'NaN')),
        y: Math.round(Number(match?.[2] ?? 'NaN')),
        w: Math.round(parseFloat(node.style.width)),
      };
    });
    view.setSelection({ anchor: 0, active: 0 });
    const пусто = { каретка: caretDisplay(), прямоугольников: rects().length };
    // Выделение от конца третьей строки до столбца 6 четвёртой — две строки.
    view.setSelection({ anchor: 60, active: 140 });
    const итог = { каретка: caretDisplay(), прямоугольников: rects().length, прямоугольники: rects() };
    return { пусто, выделение: итог };
  })()`,

  // 5. Прокрутка: вниз, к концу файла и вбок по длинной строке.
  // Событие `scroll` приходит асинхронно, поэтому после сдвига ждём кадр — иначе
  // прочтём ещё не перерисованный DOM и решим, что прокрутка не работает.
  scroll: `(async () => {
    // Всё ищем внутри редактора пробы: на странице есть и другие редакторы.
    const scope = window.probe.view.element;
    const viewport = scope.querySelector('.own-editor-viewport');
    const linesLayer = scope.querySelector('.own-editor-lines');
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
    const numbers = () => [...scope.querySelectorAll('.own-editor-gutter-row')].map((n) => Number(n.textContent));
    viewport.scrollTop = 4000;
    await frame();
    const вниз = { первая: numbers()[0], последняя: numbers().at(-1), прокрутка: viewport.scrollTop };
    // Номера должны стоять напротив своих строк и ПОСЛЕ прокрутки: верх слоя номеров
    // совпадает с верхом слоя строк. Иначе номера уезжают под край поля.
    const textTop = scope.querySelector('.own-editor-line').getBoundingClientRect().top;
    const gutterTop = scope.querySelector('.own-editor-gutter-row').getBoundingClientRect().top;
    const номера_на_месте = Math.abs(textTop - gutterTop) <= 1;
    viewport.scrollTop = viewport.scrollHeight;
    await frame();
    const конец = { первая: numbers()[0], последняя: numbers().at(-1) };
    viewport.scrollLeft = 400;
    await frame();
    // Слой строк лежит внутри полотна, а полотно — внутри поля прокрутки, которое
    // начинается не от края окна, а правее полосы номеров. Поэтому сравниваем не с
    // нулём, а с левым краем поля: текст должен уехать ровно на прокрутку.
    const expected = viewport.getBoundingClientRect().left - viewport.scrollLeft;
    const actual = linesLayer.getBoundingClientRect().left;
    const вбок = {
      сдвиг: viewport.scrollLeft,
      ожидалось: Math.round(expected),
      текст_сдвинулся: Math.abs(actual - expected) <= 1,
      полотно: Math.round(scope.querySelector('.own-editor-content').getBoundingClientRect().width),
    };
    return { вниз, номера_на_месте, конец, вбок };
  })()`,

  // Сообщения об ошибках страницы: собираются обработчиком в модуле пробы.
  errors: `window.__errors ?? []`,

  // 7. Подсветка: какие роли токенов появились в разметке и каким цветом они вышли.
  // Цвет берём вычисленным — так проверяется вся цепочка «роль → переменная темы → CSS»,
  // а не только то, что спаны созданы.
  highlight: `(async () => {
    // Возвращаем прокрутку к началу: в верхних строках файла есть и комментарии, и
    // строки, и широкие знаки — по ним видно все роли.
    const viewport = document.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 40)));
    const root = document.querySelector('.own-editor');
    const roles = ['comment', 'string', 'number', 'keyword', 'keywordControl', 'identifier', 'function', 'type', 'tag', 'attribute'];
    const report = {};
    for (const role of roles) {
      const nodes = [...root.querySelectorAll('.own-editor-token-' + role)];
      const first = nodes[0];
      report[role] = {
        штук: nodes.length,
        цвет: first ? getComputedStyle(first).color : null,
        пример: first ? first.textContent.slice(0, 24) : null,
      };
    }
    // Переменные с корня: видно, совпадают ли они с палитрой темы.
    const style = getComputedStyle(root);
    const vars = {
      comment: style.getPropertyValue('--own-token-comment').trim(),
      keyword: style.getPropertyValue('--own-token-keyword').trim(),
    };
    // Строки из спанов должны складываться в тот же текст, что лежит в модели.
    const buffer = window.probe.buffer;
    const rows = [...root.querySelectorAll('.own-editor-line')];
    const numbers = [...root.querySelectorAll('.own-editor-gutter-row')].map((n) => Number(n.textContent));
    const textMatches = rows.every((row, index) => row.textContent === buffer.lineText(numbers[index]));
    return { роли: report, переменные: vars, текст_совпадает: textMatches };
  })()`,

  // 6. Номера строк не едут по горизонтали: слой лежит вне поля прокрутки.
  fixedGutter: `(async () => {
    const gutter = document.querySelector('.own-editor-gutter');
    const viewport = document.querySelector('.own-editor-viewport');
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
    const before = gutter.getBoundingClientRect().left;
    viewport.scrollLeft = 300;
    await frame();
    const after = gutter.getBoundingClientRect().left;
    return { до: Math.round(before), после: Math.round(after), не_двигается: before === after };
  })()`,
};

/**
 * Ввод живыми клавишами и мышью. Клавиши идут через Chromium (`sendInputEvent`) — то
 * есть тем же путём, что от человека: `keydown`/`beforeinput`, а не вызов метода
 * контроллера. Так проверяется связка DOM-события с контроллером, которую юнит-тесты
 * обойти не могут.
 */
async function multicursorCheck(win) {
  const send = (event) => win.webContents.sendInputEvent(event);
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const keys = async (keyCode, modifiers) => {
    send({ type: 'keyDown', keyCode, modifiers });
    send({ type: 'keyUp', keyCode, modifiers });
    await wait(90);
  };

  win.focus();
  // Две каретки — ставим прямо контроллеру, а печатаем живой клавишей: важно, что
  // ввод доходит до обеих и попадает в документ.
  await script(`(() => {
    const { view, buffer, controller, input } = window.probe;
    const viewport = view.element.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0; viewport.scrollLeft = 0;
    for (const popup of document.querySelectorAll('.own-editor-suggest')) popup.hidden = true;
    input.focus();
    controller.setSelections([
      { anchor: 1, active: 1 },
      { anchor: buffer.lineStart(3) + 1, active: buffer.lineStart(3) + 1 },
    ]);
    return true;
  })()`);

  const placed = await script(`(() => ({
    кареток: window.probe.view.element.querySelectorAll('.own-editor-caret').length,
    заливок: window.probe.view.element.querySelectorAll('.own-editor-selection-rect').length,
    строки_до: [window.probe.buffer.lineText(1), window.probe.buffer.lineText(3)],
  }))()`);

  send({ type: 'char', keyCode: 'Z' });
  await wait(90);
  const typed = await script(`(() => ({
    строки_после: [window.probe.buffer.lineText(1), window.probe.buffer.lineText(3)],
    каретки: window.probe.controller.selections.map((sel) => sel.active),
  }))()`);

  // Одно Ctrl+Z снимает ввод в обоих местах: шаг истории один.
  await keys('Z', ['control']);
  const undone = await script(`(() => ({
    строки_отмены: [window.probe.buffer.lineText(1), window.probe.buffer.lineText(3)],
    каретка: window.probe.controller.selections.length,
  }))()`);

  // Ctrl+Alt+↓ — каретка строкой ниже по тому же столбцу.
  await script(`(() => {
    const { controller, buffer } = window.probe;
    controller.setSelection({ anchor: buffer.lineStart(3) + 2, active: buffer.lineStart(3) + 2 });
    return true;
  })()`);
  await keys('Down', ['control', 'alt']);
  const added = await script(`(() => ({
    каретки: window.probe.controller.selections.map((sel) => sel.active),
    кареток_в_виде: window.probe.view.element.querySelectorAll('.own-editor-caret').length,
  }))()`);

  // Escape оставляет одну каретку.
  await keys('Escape');
  const collapsed = await script('window.probe.controller.selections.length');

  // Ctrl+D: слово под кареткой и следующее его вхождение (в файле пробы `const` повторяется).
  await script(`(() => {
    const { controller, buffer } = window.probe;
    controller.setSelection({ anchor: buffer.lineStart(3) + 1, active: buffer.lineStart(3) + 1 });
    return true;
  })()`);
  await keys('D', ['control']);
  const occurrenceOne = await script(`(() => {
    const { controller, buffer } = window.probe;
    return {
      пары: controller.selections.map((sel) => [sel.anchor, sel.active]),
      текст: buffer.getText(controller.selections[0].anchor, controller.selections[0].active),
    };
  })()`);
  await keys('D', ['control']);
  const occurrenceTwo = await script('window.probe.controller.selections.map((sel) => [sel.anchor, sel.active])');

  // Alt+протяжка — блочное выделение по столбцу: по выделению на каждой строке.
  const box = await script(`(() => {
    const { view, buffer, controller, input } = window.probe;
    const viewport = view.element.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0; viewport.scrollLeft = 0;
    input.focus();
    controller.setSelection({ anchor: 0, active: 0 });
    const rect = viewport.getBoundingClientRect();
    const a = view.caretPoint(buffer.lineStart(3));
    const b = view.caretPoint(buffer.lineStart(6));
    return {
      старт: { x: Math.round(rect.left + a.left + 2), y: Math.round(rect.top + a.top + 8) },
      конец: { x: Math.round(rect.left + b.left + 22), y: Math.round(rect.top + b.top + 8) },
    };
  })()`);
  send({ type: 'mouseDown', x: box.старт.x, y: box.старт.y, button: 'left', clickCount: 1, modifiers: ['alt'] });
  send({ type: 'mouseMove', x: box.конец.x, y: box.конец.y, button: 'left', modifiers: ['alt'] });
  await wait(60);
  send({ type: 'mouseMove', x: box.конец.x, y: box.конец.y, button: 'left', modifiers: ['alt'] });
  send({ type: 'mouseUp', x: box.конец.x, y: box.конец.y, button: 'left', clickCount: 1, modifiers: ['alt'] });
  await wait(60);
  const boxResult = await script(`(() => ({
    выделений: window.probe.controller.selections.length,
    пары: window.probe.controller.selections.map((sel) => [sel.anchor, sel.active]),
    заливок: window.probe.view.element.querySelectorAll('.own-editor-selection-rect').length,
  }))()`);

  return {
    две_каретки: placed,
    печать: typed,
    отмена: undone,
    каретка_ниже: added,
    escape: collapsed,
    вхождение_один: occurrenceOne,
    вхождение_два: occurrenceTwo,
    блочное: boxResult,
  };
}

async function typingCheck(win) {
  const send = (event) => win.webContents.sendInputEvent(event);
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const keys = async (keyCode, modifiers) => {
    send({ type: 'keyDown', keyCode, modifiers });
    send({ type: 'keyUp', keyCode, modifiers });
    await wait(80);
  };

  win.focus();
  // Начинаем с конца документа и чистой прокрутки — так результат предсказуем.
  await script(`(() => {
    const viewport = document.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0; viewport.scrollLeft = 0;
    window.probe.input.focus();
    window.probe.controller.moveDocEnd();
    return true;
  })()`);
  const before = await script('window.probe.buffer.length');

  for (const key of ['x', 'y', 'z']) {
    send({ type: 'char', keyCode: key });
    await wait(40);
  }
  const typed = await script(`(() => {
    const buffer = window.probe.buffer;
    return { длина: buffer.length, хвост: buffer.text.slice(-6), курсор: window.probe.controller.caret };
  })()`);

  await keys('Backspace');
  const afterBackspace = await script('window.probe.buffer.text.slice(-6)');

  await keys('Z', ['control']);
  const afterUndo = await script(`(() => ({
    хвост: window.probe.buffer.text.slice(-6),
    курсор: window.probe.controller.caret,
  }))()`);

  await keys('Home', ['control']);
  const afterHome = await script('window.probe.controller.caret');

  // Клик мышью в третью строку: координаты считаем от полотна, как их видит страница.
  const target = await script(`(() => {
    const view = window.probe.view;
    const buffer = window.probe.buffer;
    const viewport = view.element.querySelector('.own-editor-viewport');
    // Другие редакторы на странице пробы (хозяин, рабочее место, сравнение) могли
    // оставить свои попапы подсказок открытыми — они висят поверх и перехватывают
    // клик. Прячем их: проверяем клик именно по своему редактору. В приложении
    // редактор один, и такой помехи нет.
    for (const popup of document.querySelectorAll('.own-editor-suggest')) popup.hidden = true;
    viewport.scrollTop = 0; viewport.scrollLeft = 0;
    const rect = viewport.getBoundingClientRect();
    const offset = buffer.lineStart(3) + 2;
    const point = view.caretPoint(offset);
    return {
      x: Math.round(rect.left + point.left + 4),
      y: Math.round(rect.top + point.top + 8),
      смещение: offset,
      строка: 3,
    };
  })()`);
  send({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  send({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await wait(120);
  const afterClick = await script(`(() => ({
    смещение: window.probe.controller.caret,
    строка: window.probe.buffer.lineAt(window.probe.controller.caret),
  }))()`);

  return {
    длина_до: before,
    напечатано: typed,
    после_Backspace: afterBackspace,
    после_отмены: afterUndo,
    после_Ctrl_Home: afterHome,
    цель_клика: target,
    после_клика: afterClick,
  };
}

/**
 * Подсказки и наведение: набор слова живыми клавишами (список появляется сам), выбор
 * стрелкой, вставка Enter — и наведение мышью с паузой. Проверяем не только вид, но и
 * то, что клавиши попапа не утекли в текст.
 */
async function assistCheck(win) {
  const send = (event) => win.webContents.sendInputEvent(event);
  const script = (expression) => win.webContents.executeJavaScript(expression);

  const typeText = async (text) => {
    for (const char of text) {
      send({ type: 'char', keyCode: char });
      await wait(60);
    }
  };
  const key = async (keyCode, modifiers) => {
    send({ type: 'keyDown', keyCode, modifiers });
    send({ type: 'keyUp', keyCode, modifiers });
    await wait(120);
  };

  const suggestState = () =>
    script(`(() => {
      const panel = document.querySelector('.own-editor-suggest');
      const rows = [...document.querySelectorAll('.own-editor-suggest-item')];
      const box = panel?.getBoundingClientRect();
      return {
        видно: Boolean(panel) && !panel.hidden,
        строк: rows.length,
        подписи: rows.slice(0, 5).map((row) => row.querySelector('.own-editor-suggest-label').textContent),
        выбор: rows.findIndex((row) => row.classList.contains('is-active')),
        // Рамка попапа: по ней видно, куда он встал и попадает ли вообще в кадр.
        рамка: box ? { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width) } : null,
      };
    })()`);

  // Пустая строка в конце: печатаем в чистом месте, без соседних имён.
  await script(`(() => {
    const controller = window.probe.controller;
    const buffer = window.probe.buffer;
    const end = buffer.length;
    controller.selectRange(end, end);
    controller.applyEdit({ start: end, removed: '', inserted: '\\n' });
    window.probe.input.focus();
    return true;
  })()`);
  await wait(120);

  // Печатаем начало имени, которое есть в файле: `const` из строк документа.
  await typeText('cons');
  const afterTyping = await suggestState();
  const diagnostics = await script('window.probe.assistant.diagnostics');
  const surroundings = await script(`(() => {
    const caret = window.probe.controller.caret;
    const line = window.probe.buffer.lineAt(caret);
    return { курсор: caret, строка: line, текст: window.probe.buffer.lineText(line) };
  })()`);

  await key('Down');
  const afterArrow = await suggestState();
  // Снимок именно здесь: попап сейчас виден, а дальше по сценарию он закрывается.
  const shotSuggest = await shot(win, '09-suggest');

  const beforeAccept = await script('window.probe.buffer.text.slice(-8)');
  await key('Return');
  const afterAccept = await script(`(() => ({
    хвост: window.probe.buffer.text.slice(-12),
    попап: document.querySelector('.own-editor-suggest').hidden,
  }))()`);

  // Ctrl+Space: список без набранного начала.
  await key(' ', ['control']);
  const afterCtrlSpace = await suggestState();
  await key('Escape');
  const afterEscape = await suggestState();

  // Подсказка после точки: в классе печатаем `this.` — попап обязан показать поля и
  // методы ЭТОГО класса. Здесь нет языкового сервера (подставной молчит), поэтому
  // работает запасной разбор файла — тот, что нужен, когда сервера нет вовсе.
  await script(`(() => {
    const { controller, buffer } = window.probe;
    controller.applyEdits([{ start: 0, removed: buffer.getText(), inserted: 'class Widget {\\n  #size = 0;\\n  draw() {}\\n}\\n' }]);
    const end = buffer.length;
    controller.selectRange(end, end);
    controller.type('this.');
    window.probe.input.focus();
    return true;
  })()`);
  await wait(150);
  const memberState = await script(`(() => {
    const panel = document.querySelector('.own-editor-suggest');
    const rows = [...document.querySelectorAll('.own-editor-suggest-item')];
    const labels = rows.map((row) => row.querySelector('.own-editor-suggest-label').textContent);
    return {
      видно: Boolean(panel) && !panel.hidden,
      подписи: labels,
      только_члены: labels.length > 0 && labels.every((label) => label === 'draw' || label.startsWith('#')),
      строка: window.probe.buffer.lineText(window.probe.buffer.lineCount),
    };
  })()`);
  const shotMembers = await shot(win, '09b-members');
  await key('Escape');

  // Наведение: считаем пришедшие движения мыши, чтобы отличить «событие не дошло» от
  // «дошло, но подсказка решила не показываться».
  await script(`(() => {
    window.__moves = 0;
    const viewport = document.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0;
    viewport.addEventListener('mousemove', () => { window.__moves += 1; });
    return true;
  })()`);
  // Целимся не в начало строки (там `//` — знак, а не слово), а в первое слово:
  // смещение 6 — это 'проба', и пара пикселей внутрь его первой клетки.
  const target = await script(`(() => {
    const point = window.probe.view.clientPoint(6);
    return { x: Math.round(point.left + 2), y: Math.round(point.top + 10) };
  })()`);
  // Два шага: первый переносит курсор в поле прокрутки (Chromium на телепортацию шлёт
  // пачку `mouseleave` — для него курсор «побывал» на куче элементов), второй уже
  // целится в слово, и вот после него лишних leave нет.
  send({ type: 'mouseMove', x: target.x, y: target.y - 200, movementX: 1, movementY: 1 });
  await wait(120);
  send({ type: 'mouseMove', x: target.x, y: target.y, movementX: 1, movementY: 1 });
  await wait(700);
  const hoverState = () =>
    script(`(() => {
      const panel = document.querySelector('.own-editor-hover');
      const box = panel && !panel.hidden ? panel.getBoundingClientRect() : null;
      return {
        видно: Boolean(panel) && !panel.hidden,
        заголовок: panel?.querySelector('.own-editor-hover-title')?.textContent ?? null,
        строки: [...(panel?.querySelectorAll('.own-editor-hover-body div') ?? [])].map((n) => n.textContent),
        // Рамка в системе окна: по ней видно, встал попап У КУРСОРА или где-то ещё.
        рамка: box ? { left: Math.round(box.left), top: Math.round(box.top) } : null,
      };
    })()`);
  const afterHover = await hoverState();
  const shotHover = await shot(win, '10-hover');
  const moves = await script('window.__moves ?? 0');
  // Что видит наведение в этих координатах: слово, знак или ничего.
  const hoverProbe = await script(`(() => {
    const offset = window.probe.view.offsetAt(${target.x}, ${target.y});
    const line = window.probe.buffer.lineAt(offset);
    return { смещение: offset, строка: line, колонка: offset - window.probe.buffer.lineStart(line) };
  })()`);

  // Прямая проверка логики наведения: показываем то же место без мыши. Так видно, что
  // подсказка не зависит от доставки события — обрыв искали бы именно там.
  const directPoint = await script(`(() => {
    const point = window.probe.view.clientPoint(6);
    window.probe.hover.showAt(6, point.left, point.top);
    return { x: Math.round(point.left), y: Math.round(point.top) };
  })()`);
  const afterDirect = await hoverState();
  // Попап обязан стоять рядом с точкой наведения. Ловушка, ради которой проверка и
  // заведена: у `.own-editor` стоит `contain: layout paint style`, и `position: fixed`
  // ВНУТРИ редактора отсчитывался от него самого — подсказка уезжала от курсора на
  // смещение редактора в окне. Поэтому попап крепится к контейнеру, а не к полотну.
  // Попап ставится ВНИЗ-ВПРАВО от точки: смещение 12 по X и 18 по Y (см. `position`).
  // Проверка односторонняя: если попап уедет на смещение редактора в окне, разница
  // станет заметно больше и это сразу видно.
  const hoverPlacement = {
    точка: directPoint,
    рамка: afterDirect.рамка,
    рядом:
      afterDirect.рамка !== null &&
      afterDirect.рамка.left - directPoint.x >= 8 &&
      afterDirect.рамка.left - directPoint.x <= 48 &&
      afterDirect.рамка.top - directPoint.y >= 8 &&
      afterDirect.рамка.top - directPoint.y <= 48,
  };

  return {
    после_набора: afterTyping,
    диагностика: diagnostics,
    вокруг_курсора: surroundings,
    после_стрелки: afterArrow,
    снимок_подсказок: shotSuggest,
    хвост_до_вставки: beforeAccept,
    после_Enter: afterAccept,
    после_Ctrl_Space: afterCtrlSpace,
    после_Escape: afterEscape,
    после_точки: memberState,
    снимок_членов: shotMembers,
    движений_мыши: moves,
    наведение_координаты: hoverProbe,
    наведение_диагностика: await script('window.probe.hover.diagnostics'),
    наведение: afterHover,
    наведение_напрямую: afterDirect,
    наведение_место: hoverPlacement,
    снимок_наведения: shotHover,
  };
}

/**
 * Панель поиска живыми клавишами: Ctrl+F, набор запроса, счётчик, переходы, Ctrl+H
 * и замена. Так проверяется вся цепочка целиком — клавиша, поле, поиск, подсветка,
 * счётчик, правка через историю.
 */
async function findCheck(win) {
  const send = (event) => win.webContents.sendInputEvent(event);
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const wait_ = (ms) => wait(ms);

  const key = async (keyCode, modifiers) => {
    send({ type: 'keyDown', keyCode, modifiers });
    send({ type: 'keyUp', keyCode, modifiers });
    await wait_(120);
  };

  const state = () =>
    script(`(() => {
      const root = document.querySelector('.own-editor');
      const panel = document.querySelector('.own-editor-find');
      return {
        панель: Boolean(panel) && !panel.hidden,
        режим_замены: panel?.classList.contains('is-replace') ?? false,
        счётчик: document.querySelector('.own-editor-find-counter')?.textContent ?? '',
        сообщение: document.querySelector('.own-editor-find-message')?.hidden === false
          ? document.querySelector('.own-editor-find-message').textContent : null,
        прямоугольников: root.querySelectorAll('.own-editor-search-rect').length,
        текущих: root.querySelectorAll('.own-editor-search-rect.is-current').length,
        запрос: document.querySelector('.own-editor-find-input')?.value ?? '',
      };
    })()`);

  // Возвращаем документ и прокрутку в исходное состояние, чистим следы прошлой пробы.
  await script(`(() => {
    const viewport = document.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0; viewport.scrollLeft = 0;
    window.probe.input.focus();
    window.probe.controller.moveDocEnd();
    return true;
  })()`);

  win.focus();
  await key('F', ['control']);
  const opened = await state();

  // Запрос берём частый: так на экране видно сразу несколько подсвеченных совпадений.
  await script(`(() => {
    const field = document.querySelector('.own-editor-find-input');
    field.value = 'line';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    const viewport = document.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0;
    return true;
  })()`);
  await wait_(280);
  const afterQuery = await state();
  const shotAfterQuery = await shot(win, '07-find');

  // Переход к следующему совпадению клавишей Enter в поле.
  await key('Return');
  const afterNext = await state();

  // Режим замены: Ctrl+H в поле поиска должен раскрыть строку замены.
  await key('H', ['control']);
  const replaceMode = await state();

  // Замена всех: текст замены в поле, нажатие кнопки. Проверяем и сообщение, и отмену.
  const replaceResult = await script(`(async () => {
    const field = document.querySelectorAll('.own-editor-find-input')[1];
    field.value = 'L';
    const buttons = [...document.querySelectorAll('.own-editor-find-btn')];
    const all = buttons.find((node) => node.textContent === 'Заменить всё');
    const count = (text) => (text.match(/line/g) ?? []).length;
    const before = count(window.probe.buffer.text);
    all.click();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 200)));
    return {
      сообщение: document.querySelector('.own-editor-find-message')?.textContent ?? '',
      'вхождений_до': before,
      'вхождений_после': count(window.probe.buffer.text),
    };
  })()`);
  const afterReplaceAll = await state();
  const shotAfterReplace = await shot(win, '08-replace');

  // Отмена замены: Ctrl+Z должен вернуть текст — проверяем, что правка попала в историю.
  await script(`document.querySelector('.own-editor-find').hidden = true; window.probe.input.focus();`);
  await key('Z', ['control']);
  const undoResult = await script(`(() => ({
    'вхождений_после_отмены': (window.probe.buffer.text.match(/line/g) ?? []).length,
    можно_отменить_ещё: window.probe.controller.canUndo,
  }))()`);

  // Переход к строке: Ctrl+G, номер, Enter. Проверяем, что курсор встал на неё.
  await script(
    `window.probe.view.element.querySelector('.own-editor-viewport').scrollTop = 0; window.probe.input.focus();`,
  );
  await key('G', ['control']);
  const gotoOpened = await script(`(() => ({
    панель: !document.querySelector('.own-editor-goto').hidden,
    подставлено: document.querySelector('.own-editor-goto-input').value,
  }))()`);
  await script(`(() => {
    const field = document.querySelector('.own-editor-goto-input');
    field.value = '1500';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await key('Return');
  const gotoTarget = await script(`(() => ({
    строка: window.probe.buffer.lineAt(window.probe.controller.caret),
    закрылась: document.querySelector('.own-editor-goto').hidden,
  }))()`);

  return {
    открылась: opened,
    после_запроса: afterQuery,
    снимок_поиска: shotAfterQuery,
    после_Enter: afterNext,
    режим_замены: replaceMode,
    замена_всех: replaceResult,
    после_замены: afterReplaceAll,
    снимок_замены: shotAfterReplace,
    после_отмены: undoResult,
    переход_к_строке: gotoOpened,
    после_перехода: gotoTarget,
  };
}

/**
 * Хозяин редактора на скрытом полотне: открытие файлов, правки в документ и курсоры.
 * Тут проверяется связка, которой нет у отдельных слоёв: буфер достаёт всем слоям разом,
 * текст из буфера уходит в документ, а курсор помнится по файлам.
 */
async function hostCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  const opened = await script(`(() => {
    const { host, docA } = window.probeHost;
    return { активный: host.activePath, текст: host.currentText(docA.path), курсор: host.cursorState };
  })()`);

  // Вставка в курсор: текст обязан уйти в документ — он истина о содержимом.
  const inserted = await script(`(() => {
    const { host, docA } = window.probeHost;
    host.insertAtCursor('# вставка\\n');
    return {
      буфер: host.currentText(docA.path),
      документ: docA.value,
      совпадают: host.currentText(docA.path) === docA.value,
      грязный: docA.dirty,
    };
  })()`);

  // Правки извне в ОТКРЫТЫЙ файл: идут через контроллер, значит попадают в историю.
  const editsActive = await script(`(() => {
    const { host, docA } = window.probeHost;
    const result = host.applyEdits(docA, [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1, newText: '// шапка\\n' }]);
    return {
      применено: result.changes.length,
      пропущено: result.skipped.length,
      начало_буфера: host.currentText(docA.path).slice(0, 12),
      документ_совпал: host.currentText(docA.path) === docA.value,
    };
  })()`);

  // Другой файл: буфер обязан смениться, а язык — стать питоновским.
  const switched = await script(`(() => {
    const { host, docB } = window.probeHost;
    host.open(docB);
    const root = document.querySelector('#probe-host .own-editor');
    const tokens = root.querySelectorAll('[class^="own-editor-token-"]').length;
    return {
      активный: host.activePath,
      текст: host.currentText(docB.path),
      курсор: host.cursorState,
      строк_в_виде: root.querySelectorAll('.own-editor-line').length,
      токенов: tokens,
    };
  })()`);

  // Правки ЗА КАДРОМ: файл не открыт, правим прямо буфер — документ тоже обновляется.
  const editsBackground = await script(`(() => {
    const { host, docA } = window.probeHost;
    const before = host.currentText(docA.path);
    const result = host.applyEdits(docA, [{ startLine: 1, startColumn: 1, endLine: 2, endColumn: 1, newText: '' }]);
    return {
      до: before.split('\\n')[0],
      после: host.currentText(docA.path).split('\\n')[0],
      применено: result.changes.length,
      документ_совпал: host.currentText(docA.path) === docA.value,
      активный: host.activePath,
    };
  })()`);

  // Возврат к первому файлу: курсор должен встать туда, где его оставили.
  const restored = await script(`(() => {
    const { host, docA } = window.probeHost;
    host.open(docA);
    return { активный: host.activePath, курсор: host.cursorState };
  })()`);

  return {
    открытие: opened,
    вставка: inserted,
    правки_открытого: editsActive,
    переключение: switched,
    правки_за_кадром: editsBackground,
    возврат_к_файлу: restored,
  };
}

/**
 * Украшения строк на видимом редакторе: полоски изменений, значки, заливка строки,
 * подписи blame и волнистые подчёркивания. Проба ставит набор снаружи — как это делает
 * хозяин по данным git, отладки и языкового сервера, — и проверяет, что нарисовалось
 * именно то, что задано: классы, цвета и геометрия. В конце — клики по полю значков и
 * полосе украшений: они должны доехать до обработчиков с правильной строкой.
 */
async function decorationsCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const send = (event) => win.webContents.sendInputEvent(event);

  const applied = await script(`(() => {
    const { view, buffer, decorations } = window.probe;
    const viewport = document.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0; viewport.scrollLeft = 0;
    decorations.setStrips([
      { line: 3, className: 'change-gutter is-added', tooltip: 'Добавлено' },
      { line: 4, className: 'change-gutter is-modified' },
      { line: 5, className: 'change-gutter is-deleted' },
    ]);
    decorations.setGlyphs([
      { line: 2, className: 'breakpoint-glyph', tooltip: 'Точка останова' },
      { line: 8, className: 'run-glyph', tooltip: 'Запустить файл' },
      { line: 9, className: 'run-glyph test-glyph is-passed', tooltip: 'Прошёл: тест' },
    ]);
    decorations.setLineBackgrounds([
      { line: 6, className: 'coverage-line' },
      { line: 9, className: 'debug-line' },
    ]);
    decorations.setAfterContents([{ line: 1, content: '  Иван, 3 дня назад', className: 'blame-inline' }]);
    decorations.setLenses([{ line: 2, content: '  3 ссылки', className: 'own-editor-lens', tooltip: '3 ссылки' }]);
    decorations.setSquiggles([{ line: 3, startColumn: 1, endColumn: 6, className: 'is-error' }]);
    view.setDecorations(decorations);
    return { пусто: decorations.isEmpty, строк: buffer.lineCount };
  })()`);

  const drawing = await script(`(() => {
    const root = document.querySelector('.own-editor');
    const glyphRows = [...root.querySelectorAll('.own-editor-glyph-row')];
    const значки = glyphRows
      .filter((row) => row.firstElementChild)
      .map((row) => ({ класс: row.firstElementChild.className, подсказка: row.firstElementChild.title }));
    const полоски = [...root.querySelectorAll('.own-editor-strip-row')]
      .map((row) => row.className)
      .filter((name) => name.includes('change-gutter'))
      .map((name) => name.split(' ').filter((c) => c !== 'own-editor-strip-row').join(' '));
    const фон = [...root.querySelectorAll('.own-editor-line-bg')].map((node) => ({
      класс: node.className.replace('own-editor-line-bg ', ''),
      высота: Math.round(node.getBoundingClientRect().height),
    }));
    const squiggly = root.querySelector('.own-editor-squiggly-rect');
    const подписи = [...root.querySelectorAll('.blame-inline')].map((node) => node.textContent);
    const линзы = [...root.querySelectorAll('.own-editor-lens')].map((node) => ({
      текст: node.textContent.trim(),
      класс: node.className,
    }));
    const glyphs = document.querySelector('.own-editor-glyphs');
    const strip = document.querySelector('.own-editor-strip');
    return {
      значки,
      полоски,
      фон,
      подчёркивание: squiggly
        ? {
            класс: squiggly.className,
            ширина: Math.round(parseFloat(squiggly.style.width)),
            transform: squiggly.style.transform,
            волна: getComputedStyle(squiggly).backgroundImage !== 'none',
          }
        : null,
      подписи,
      линзы,
      ширина_значков: Math.round(glyphs.getBoundingClientRect().width),
      ширина_полосы: Math.round(strip.getBoundingClientRect().width),
    };
  })()`);
  const shotDeco = await shot(win, '11-decorations');

  const targets = await script(`(() => {
    const { view } = window.probe;
    const viewport = document.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0;
    const viewportRect = viewport.getBoundingClientRect();
    const lineHeight = view.caretPoint(0).height;
    const yAt = (line) => Math.round(viewportRect.top + (line - 1) * lineHeight + lineHeight / 2);
    const glyphRect = document.querySelector('.own-editor-glyphs').getBoundingClientRect();
    const stripRect = document.querySelector('.own-editor-strip').getBoundingClientRect();
    return {
      glyphX: Math.round(glyphRect.left + glyphRect.width / 2),
      stripX: Math.round(stripRect.left + 1),
      y8: yAt(8),
      y4: yAt(4),
    };
  })()`);

  const click = async (x, y, button) => {
    send({ type: 'mouseDown', x, y, button, clickCount: 1 });
    send({ type: 'mouseUp', x, y, button, clickCount: 1 });
    await wait(80);
  };
  await click(targets.glyphX, targets.y8, 'left');
  await click(targets.stripX, targets.y4, 'left');
  await click(targets.glyphX, targets.y8, 'right');
  const clicks = await script('window.probe.decorationClicks');

  // Клик по код-линзе: подпись рисует представление, а что исполнить — решает хозяин.
  // Здесь хозяина нет, поэтому проверяем сам шов: клик зовёт `onLensClick` с номером строки,
  // а представление лишь сообщает — как у клика по полю значков и полосе изменений.
  const lensClick = await script(`(async () => {
    const root = document.querySelector('.own-editor');
    const node = root.querySelector('.own-editor-lens');
    const seen = [];
    window.probe.view.onLensClick = (line) => seen.push(line);
    node?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20)));
    window.probe.view.onLensClick = null;
    return { есть: node !== null, строка: seen[0] ?? null };
  })()`);

  const cleared = await script(`(() => {
    window.probe.view.setDecorations(null);
    const root = document.querySelector('.own-editor');
    return {
      значки: root.querySelectorAll('.own-editor-glyph-row > *').length,
      полоски: root.querySelectorAll('.own-editor-strip-row.change-gutter').length,
      фон: root.querySelectorAll('.own-editor-line-bg').length,
      подчёркивания: root.querySelectorAll('.own-editor-squiggly-rect').length,
      подписи: root.querySelectorAll('.blame-inline').length,
      линзы: root.querySelectorAll('.own-editor-lens').length,
    };
  })()`);

  return {
    набор: applied,
    рисунок: drawing,
    снимок: shotDeco,
    цели: targets,
    клики: clicks,
    линза: lensClick,
    после_снятия: cleared,
  };
}

/**
 * Рабочее место: две панели, активная панель, общий буфер и события курсора.
 * Проверяем то, чего нет у одной панели: разделение возвращает в панелях тот же файл,
 * правка в активной панели видна в соседней (буфер-то общий), а клик решает, какая
 * панель активна.
 */
async function workspaceCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  const opened = await script(`(() => {
    const { workspace, leftDoc } = window.probeWorkspace;
    return {
      активная: workspace.activePath,
      панелей: document.querySelectorAll('#probe-workspace .editor-pane').length,
      разделено: workspace.isSplit,
      курсор: workspace.cursor(),
    };
  })()`);

  // Ставим курсор в первом файле и запоминаем — при разделении вторая панель должна
  // открыть тот же файл.
  await script(`(() => {
    const { workspace } = window.probeWorkspace;
    workspace.reveal('/probe/left.ts', 2, 3);
    return true;
  })()`);

  const activeIndex = `[...document.querySelectorAll('#probe-workspace .editor-pane')].findIndex((pane) => pane.classList.contains('is-active'))`;
  // Панель на скрытом полотне: мышью по ней не щёлкнуть (она вне окна), поэтому
  // активную панель переключаем ФОКУСОМ — тем же путём, каким это делает клик
  // (узел панели слушает `focusin`). Так проверяется само правило активности.
  const focusPane = async (index) => {
    await script(
      `document.querySelectorAll('#probe-workspace .editor-pane')[${index}].querySelector('.own-editor-input').focus()`,
    );
    await wait(60);
  };

  const split = await script(`(() => {
    const { workspace } = window.probeWorkspace;
    workspace.splitEditor();
    const panes = [...document.querySelectorAll('#probe-workspace .editor-pane')];
    return {
      разделено: workspace.isSplit,
      панелей: panes.length,
      активных_панелей: panes.filter((pane) => pane.classList.contains('is-active')).length,
      активная: workspace.activePath,
      активный_индекс: ${activeIndex},
    };
  })()`);

  // После разделения активна правая панель; клик по левой делает активной её.
  await focusPane(0);
  const afterClick = await script(`(() => {
    const { workspace } = window.probeWorkspace;
    return { активная: workspace.activePath, индекс: ${activeIndex} };
  })()`);

  // Правка в левой панели: правая показывает тот же файл и должна перерисоваться сама.
  const typed = await script(`(() => {
    const { workspace, leftDoc } = window.probeWorkspace;
    workspace.reveal('/probe/left.ts', 1, 1);
    workspace.insertAtCursor('X');
    return { буфер: leftDoc.value.split('\\n')[0], документ_совпал: workspace.currentText(leftDoc.path) === leftDoc.value };
  })()`);
  await wait(80);
  const siblings = await script(`(() => {
    const panes = [...document.querySelectorAll('#probe-workspace .editor-pane')];
    const firstLine = (pane) => pane.querySelector('.own-editor-line')?.textContent ?? '';
    const expected = window.probeWorkspace.leftDoc.value.split('\\n')[0];
    return {
      левая: firstLine(panes[0]),
      правая: firstLine(panes[1]),
      ожидалось: expected,
      совпадают: firstLine(panes[0]) === expected && firstLine(panes[1]) === expected,
    };
  })()`);

  // Теперь клик по правой панели и другой файл в ней: пути панелей расходятся.
  await focusPane(1);
  const secondFile = await script(`(() => {
    const { workspace, rightDoc } = window.probeWorkspace;
    workspace.open(rightDoc);
    return {
      активная: workspace.activePath,
      индекс: ${activeIndex},
      видимые: workspace.visiblePaths().sort(),
      курсоры: Object.keys(workspace.cursorPositions()).sort(),
    };
  })()`);

  const closed = await script(`(() => {
    const { workspace } = window.probeWorkspace;
    workspace.closeSplit();
    return {
      разделено: workspace.isSplit,
      панелей: document.querySelectorAll('#probe-workspace .editor-pane').length,
      активная: workspace.activePath,
      активный_индекс: ${activeIndex},
    };
  })()`);

  const shotWorkspace = await shot(win, '12-split');
  return {
    открытие: opened,
    разделение: split,
    клик_по_левой: afterClick,
    правка: typed,
    соседняя_панель: siblings,
    второй_файл: secondFile,
    закрытие: closed,
    снимок: shotWorkspace,
  };
}

/**
 * Сравнение версий: выравнивание, два режима и кнопки у блоков. Проба ставит две
 * версии одной функции, читает нарисованные ряды и проверяет, что блоки находятся,
 * переход к блоку прокручивает, а кнопка зовёт обработчик со своим индексом.
 */
async function diffCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  const original = [
    'function sum(a, b) {',
    '  return a + b;',
    '}',
    '',
    ...Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`),
    'const x = sum(1, 2);',
    'console.log(x);',
  ].join('\n');
  const modified = [
    'function sum(a, b) {',
    '  // складываем',
    '  return a + b;',
    '}',
    '',
    ...Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`),
    'const x = sum(2, 3);',
    'console.log(x);',
    'console.log("готово");',
  ].join('\n');

  await script(`(() => {
    const { diff } = window.probeDiff;
    diff.set({ language: 'typescript', original: ${JSON.stringify(original)}, modified: ${JSON.stringify(modified)} });
    diff.setHunkActions(
      [{ index: 0, line: 2, label: 'Первый блок' }, { index: 1, line: 46, label: 'Второй блок' }],
      (index) => { window.__hunk = index; },
    );
    return true;
  })()`);

  const drawing = await script(`(() => {
    const root = document.querySelector('#probe-diff .own-diff');
    const rows = [...root.querySelectorAll('.own-diff-row')];
    const kindOf = (row) => row.className.split(' ').find((name) => name.startsWith('is-'))?.slice(3) ?? 'equal';
    const buttons = [...root.querySelectorAll('.diff-hunk-action')].map((node) => node.textContent);
    const firstRow = rows[0];
    const tokens = root.querySelectorAll('[class^="own-editor-token-"]').length;
    return {
      рядов: rows.length,
      виды: rows.map(kindOf),
      половин_в_ряду: firstRow ? firstRow.querySelectorAll('.own-diff-side').length : 0,
      кнопок: buttons,
      токенов: tokens,
    };
  })()`);
  const shotDiff = await shot(win, '13-diff');

  const inline = await script(`(() => {
    window.probeDiff.diff.setLayout(false);
    const root = document.querySelector('#probe-diff .own-diff');
    const firstSide = root.querySelector('.own-diff-side.is-original');
    return {
      класс: root.className,
      исходная_скрыта: firstSide ? getComputedStyle(firstSide).display === 'none' : null,
    };
  })()`);
  await script('window.probeDiff.diff.setLayout(true)');

  const navigation = await script(`(() => {
    const { diff, element } = window.probeDiff;
    const body = element.querySelector('.own-diff-body');
    body.scrollTop = 0;
    diff.goToChange(1);
    const first = body.scrollTop;
    diff.goToChange(1);
    const second = body.scrollTop;
    return { первый_блок: first, второй_блок: second };
  })()`);

  const clicking = await script(`(() => {
    const button = document.querySelector('#probe-diff .diff-hunk-action');
    button.click();
    return { индекс: window.__hunk ?? -1 };
  })()`);

  // Замечания ревью: метка у строки, переход к ней прокруткой и два клика по номеру —
  // по номеру с замечанием открывают тред, по чистому номеру заводят новый.
  const comments = await script(`(async () => {
    const { diff, element } = window.probeDiff;
    const events = [];
    diff.setComments({
      marks: [{ side: 'modified', line: 46, count: 2, resolved: false }],
      selected: { side: 'modified', line: 46 },
      onSelect: (side, line) => events.push(['select', side, line]),
      onRequest: (side, line) => events.push(['request', side, line]),
    });
    const root = element.querySelector('.own-diff');
    // Начинаем с начала сравнения: тогда видно, что переход к замечанию реально прокрутил.
    const body = element.querySelector('.own-diff-body');
    body.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
    const before = body.scrollTop;
    diff.revealComment('modified', 46);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));
    const marked = root.querySelector('.own-diff-side.has-comment');
    const badge = root.querySelector('.own-diff-comment');
    const active = root.querySelector('.own-diff-side.is-comment-active');
    const clickable = [...root.querySelectorAll('.own-diff-num.is-clickable')];
    const withMark = clickable.find((num) => num.parentElement?.classList.contains('has-comment'));
    const clean = clickable.find((num) => !num.parentElement?.classList.contains('has-comment'));
    withMark?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    clean?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const markedRows = root.querySelectorAll('.own-diff-side.has-comment').length;
    diff.setComments(null);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
    const afterClear = root.querySelectorAll('.own-diff-side.has-comment').length;
    return {
      прокрутка_до: before,
      прокрутка_после: body.scrollTop,
      метка_есть: Boolean(marked),
      числом_сообщений: badge ? badge.textContent || 'точка' : null,
      подсвечен_активный: Boolean(active),
      отметок_на_строке_видно: markedRows,
      событий: events,
      после_снятия_отметок: afterClear,
    };
  })()`);

  return {
    рисунок: drawing,
    снимок: shotDiff,
    встроенный_режим: inline,
    переходы: navigation,
    кнопка: clicking,
    замечания: comments,
  };
}

/**
 * Сниппеты: по триггеру в списке появляется заготовка, а вставка раскрывает её —
 * разметка `${1:…}` в текст не попадает, курсор встаёт на место подстановки.
 */
async function snippetCheck(win) {
  const send = (event) => win.webContents.sendInputEvent(event);
  const script = (expression) => win.webContents.executeJavaScript(expression);

  // Чистое место в конце файла: там нет соседних имён, которые спорили бы с триггером.
  await script(`(() => {
    const controller = window.probe.controller;
    const buffer = window.probe.buffer;
    const end = buffer.length;
    controller.selectRange(end, end);
    controller.applyEdit({ start: end, removed: '', inserted: '\\n' });
    window.probe.input.focus();
    return true;
  })()`);
  await wait(120);

  for (const char of 'clg') {
    send({ type: 'char', keyCode: char });
    await wait(70);
  }
  const list = await script(`(() => {
    const panel = document.querySelector('.own-editor-suggest');
    const rows = [...document.querySelectorAll('.own-editor-suggest-item')];
    const snippet = rows.find((row) => row.querySelector('.own-editor-suggest-label')?.textContent === 'clg');
    return {
      видно: Boolean(panel) && !panel.hidden,
      есть_сниппет: Boolean(snippet),
      пояснение: snippet?.querySelector('.own-editor-suggest-detail')?.textContent ?? null,
      диагностика: window.probe.assistant.diagnostics,
    };
  })()`);

  // Enter вставляет выбранное: триггер заменяется раскрытым телом.
  send({ type: 'keyDown', keyCode: 'Return' });
  send({ type: 'keyUp', keyCode: 'Return' });
  await wait(140);
  const inserted = await script(`(() => {
    const buffer = window.probe.buffer;
    const caret = window.probe.controller.caret;
    const line = buffer.lineAt(caret);
    const text = buffer.lineText(line);
    const column = caret - buffer.lineStart(line);
    return {
      строка: text,
      разметки_нет: text.indexOf('$' + '{') < 0,
      курсор_в_скобках: text.slice(0, column) === 'console.log(',
    };
  })()`);

  return { список: list, вставка: inserted };
}

/**
 * Команды редактора: список и выполнение по идентификатору. Проверяем, что палитра
 * получает полный список действий редактора, а запуск их по id действительно меняет
 * текст (undo/redo, отступ) и открывает панели.
 */
async function commandsCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  const list = await script(`(() => {
    const { workspace } = window.probeWorkspace;
    const actions = workspace.listActions();
    return {
      всего: actions.length,
      id: actions.map((item) => item.id),
      есть_подписи: actions.every((item) => item.label.length > 0),
    };
  })()`);

  // Отступ: indent прибавляет пробелы в начале строки с курсором.
  const indent = await script(`(() => {
    const { workspace, leftDoc } = window.probeWorkspace;
    workspace.reveal('/probe/left.ts', 1, 1);
    const before = leftDoc.value.split('\\n')[0];
    const ran = workspace.runAction('editor.indent');
    const after = leftDoc.value.split('\\n')[0];
    workspace.runAction('editor.undo');
    return { ran, before, after, отменено: leftDoc.value.split('\\n')[0] };
  })()`);

  // Отмена и повтор через команды.
  const undoRedo = await script(`(() => {
    const { workspace, leftDoc } = window.probeWorkspace;
    workspace.reveal('/probe/left.ts', 1, 1);
    workspace.insertAtCursor('#!');
    const changed = leftDoc.value.split('\\n')[0];
    workspace.runAction('editor.undo');
    const undone = leftDoc.value.split('\\n')[0];
    workspace.runAction('editor.redo');
    const redone = leftDoc.value.split('\\n')[0];
    workspace.runAction('editor.undo');
    return { changed, undone, redone };
  })()`);

  const unknown = await script(`window.probeWorkspace.workspace.runAction('editor.нетакого')`);
  const panels = await script(`(() => {
    const { workspace } = window.probeWorkspace;
    workspace.runAction('editor.find');
    const find = window.probeWorkspace.workspace.activePath && document.querySelector('#probe-workspace .own-editor-find')?.hidden === false;
    document.querySelector('#probe-workspace .own-editor-find').hidden = true;
    workspace.runAction('editor.gotoLine');
    const goto = document.querySelector('#probe-workspace .own-editor-goto')?.hidden === false;
    document.querySelector('#probe-workspace .own-editor-goto').hidden = true;
    return { поиск_открылся: Boolean(find), переход_открылся: Boolean(goto) };
  })()`);

  return { список: list, отступ: indent, отмена_повтор: undoRedo, неизвестная: unknown, панели: panels };
}

/**
 * Наведение от языкового сервера: подставной источник подставляет свой текст в карточку.
 */
async function languageHoverCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  // Прямой вызов наведения на слово: ответ «сервера» должен перекрыть локальный текст.
  const result = await script(`(async () => {
    const { view, buffer, hover } = window.probe;
    // Смещение первого слова в первой строке файла пробы.
    const offset = buffer.lineStart(1) + 3;
    const point = view.clientPoint(offset);
    hover.showAt(offset, point.left + 2, point.top + 8);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const panel = document.querySelector('.own-editor-hover');
    return {
      видно: !panel.hidden,
      заголовок: panel.querySelector('.own-editor-hover-title')?.textContent ?? null,
      строки: [...panel.querySelectorAll('.own-editor-hover-body div')].map((node) => node.textContent),
      от_сервера: window.probe.hover.diagnostics.fromLanguage,
    };
  })()`);

  return result;
}

/**
 * Переход к определению и ссылки: подставной «языковой сервер» отдаёт места, а рабочее
 * место решает, что с ними делать. Проверяем все три случая: одно место — прыжок сразу,
 * несколько — список, ни одного — весть без списка.
 */
async function foldCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const send = (event) => win.webContents.sendInputEvent(event);

  // Диапазоны задаём прямо виду: в пробах страницы сервера и отступов нет.
  const applied = await script(`(() => {
    try {
      const { view, buffer } = window.probe;
      // К началу файла: строки 8 и 12 должны быть на экране, иначе значков в жёлобе не будет.
      view.element.querySelector('.own-editor-viewport').scrollTop = 0;
      view.setFoldRanges([{ startLine: 8, endLine: 10 }, { startLine: 12, endLine: 15 }]);
      const lines = () => view.element.querySelectorAll('.own-editor-line').length;
      const before = {
        ряды: view.foldState().rows,
        строк_в_dom: lines(),
        верх_12: view.clientPoint(buffer.lineStart(12)).top,
      };
      view.toggleFold(8);
      const after = {
        ряды: view.foldState().rows,
        строк_в_dom: lines(),
        верх_12: view.clientPoint(buffer.lineStart(12)).top,
      };
      return {
        схлопнуто: view.foldState().collapsed,
        ряды_до: before.ряды,
        ряды_после: after.ряды,
        строк_в_dom_до: before.строк_в_dom,
        строк_в_dom_после: after.строк_в_dom,
        сдвиг_строки_12: before.верх_12 - after.верх_12,
        маркеров_в_жёлобе: view.element.querySelectorAll('.own-editor-fold.is-visible').length,
      };
    } catch (error) {
      return { ошибка: String(error) };
    }
  })()`);

  // Щелчок по значку в жёлобе раскрывает блок: он был сложен первым (строка 8).
  const clicked = await script(`(() => {
    try {
      const { view } = window.probe;
      view.element.querySelectorAll('.own-editor-fold.is-visible')[0]
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return { схлопнуто: view.foldState().collapsed, ряды: view.foldState().rows };
    } catch (error) {
      return { ошибка: String(error) };
    }
  })()`);

  // Живая клавиша Ctrl+Shift+[ сворачивает блок под курсором (строка 9 — внутри 8–10).
  // Со сдвигом браузер отдаёт знак «{» — раскладка меняет знак, а команда та же.
  await script(`(() => {
    const { controller, buffer } = window.probe;
    window.probe.input.focus();
    const offset = buffer.lineStart(9);
    controller.selectRange(offset, offset);
    return true;
  })()`).catch(() => undefined);
  send({ type: 'keyDown', keyCode: '[', modifiers: ['control', 'shift'] });
  send({ type: 'keyUp', keyCode: '[', modifiers: ['control', 'shift'] });
  await wait(60);
  const byKey = await script(`(() => {
    try {
      return {
        схлопнуто: window.probe.view.foldState().collapsed,
        курсор_строка: window.probe.controller.bufferRef.lineAt(window.probe.controller.caret),
      };
    } catch (error) {
      return { ошибка: String(error) };
    }
  })()`);

  // Свернуть всё и развернуть всё: рядов остаётся по одному на блок.
  const all = await script(`(() => {
    try {
      const { view } = window.probe;
      view.foldAll();
      const collapsed = view.foldState();
      const rowsCollapsed = view.foldState().rows;
      view.unfoldAll();
      const rowsExpanded = view.foldState().rows;
      view.setFoldRanges([]);
      return { сложено_всего: collapsed.collapsed, ряды_свёрнутые: rowsCollapsed, ряды_раскрытые: rowsExpanded };
    } catch (error) {
      return { ошибка: String(error) };
    }
  })()`);

  return { свёртка: applied, щелчок_по_значку: clicked, клавиша: byKey, всё: all };
}

/**
 * Закреплённые заголовки (sticky scroll): пока верх экрана внутри блока, его заголовок
 * остаётся виден «шапкой». Проверяем появление, вложенность (два заголовка), снятие вне
 * блока и переход по клику — заголовок уводит экран к своей строке.
 */
async function stickyCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const frame = `await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));`;

  // Диапазон есть, но верх экрана ВНЕ его — заголовков быть не должно.
  const outside = await script(`(async () => {
    const { view } = window.probe;
    const viewport = view.element.querySelector('.own-editor-viewport');
    view.setFoldRanges([{ startLine: 100, endLine: 200 }]);
    viewport.scrollTop = 0;
    ${frame}
    return { строк: view.element.querySelectorAll('.own-editor-sticky-row').length };
  })()`);

  // Верх экрана внутри внешнего и вложенного блоков — два заголовка, от внешнего к вложенному.
  const inside = await script(`(async () => {
    const { view, buffer } = window.probe;
    const viewport = view.element.querySelector('.own-editor-viewport');
    view.setFoldRanges([{ startLine: 1, endLine: 2000 }, { startLine: 100, endLine: 1500 }]);
    viewport.scrollTop = 6000;
    ${frame}
    const layer = view.element.querySelector('.own-editor-sticky');
    const rows = [...view.element.querySelectorAll('.own-editor-sticky-row')];
    return {
      видно: layer ? !layer.hidden : false,
      строк: rows.length,
      тексты: rows.map((row) => row.textContent),
      ожидались: [buffer.lineText(1).trimEnd(), buffer.lineText(100).trimEnd()],
      верх_слоя: layer ? Math.round(layer.getBoundingClientRect().top) : null,
    };
  })()`);

  // Клик по вложенному заголовку уводит экран к его строке (100).
  const click = await script(`(async () => {
    const { view } = window.probe;
    const viewport = view.element.querySelector('.own-editor-viewport');
    const rows = [...view.element.querySelectorAll('.own-editor-sticky-row')];
    const before = Math.round(viewport.scrollTop);
    rows[rows.length - 1]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    ${frame}
    const layer = view.element.querySelector('.own-editor-sticky');
    return { до: before, после: Math.round(viewport.scrollTop), скрыт_слоя: layer ? layer.hidden : true };
  })()`);

  // К началу файла: заголовок верхнего блока снова виден в самом тексте — слоя нет.
  const atTop = await script(`(async () => {
    const { view } = window.probe;
    const viewport = view.element.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0;
    ${frame}
    const layer = view.element.querySelector('.own-editor-sticky');
    const result = { строк: view.element.querySelectorAll('.own-editor-sticky-row').length, скрыт: layer ? layer.hidden : true };
    view.setFoldRanges([]);
    return result;
  })()`);

  return { вне_блока: outside, внутри_блока: inside, клик: click, в_начале: atTop };
}

/**
 * Радужные скобки: один уровень вложенности — один цвет. В тексте пробы есть строка
 * `if (value > 1) { handle(value); }`: в ней есть и внешние скобки, и вложенные.
 * Проверяем, что скобки раскрашены и цвета уровней различаются.
 */
async function rainbowCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const frame = `await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));`;

  return await script(`(async () => {
    const { view } = window.probe;
    const viewport = view.element.querySelector('.own-editor-viewport');
    viewport.scrollTop = 0;
    ${frame}
    const root = view.element;
    const nodes = [...root.querySelectorAll('.own-editor-bracket')];
    const по_классам = {};
    for (const node of nodes) {
      for (const cls of node.classList) {
        if (cls.startsWith('is-depth-')) по_классам[cls] = (по_классам[cls] ?? 0) + 1;
      }
    }
    const цвета = {};
    for (const cls of ['is-depth-0', 'is-depth-1', 'is-depth-2']) {
      const sample = root.querySelector('.own-editor-bracket.' + cls);
      цвета[cls] = sample ? getComputedStyle(sample).color : null;
    }
    return { всего: nodes.length, по_классам, цвета };
  })()`);
}

/** Направляющие столбцов (ruler): черт столько же, сколько столбцов, и стоят они на «столбец x ширина клетки». */
async function rulersCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  return await script(`(() => {
    const { view } = window.probe;
    const before = view.element.querySelectorAll('.own-editor-ruler').length;
    view.setRulers([40, 80]);
    const nodes = [...view.element.querySelectorAll('.own-editor-ruler')];
    const width = parseFloat(getComputedStyle(view.element).getPropertyValue('--own-editor-char-width')) || 0;
    const lefts = nodes.map((node) => Math.round(parseFloat(node.style.left)));
    view.setRulers([]);
    const after = view.element.querySelectorAll('.own-editor-ruler').length;
    return {
      до: before,
      черт: nodes.length,
      слева: lefts,
      ожидалось: [Math.round(40 * width), Math.round(80 * width)],
      ширина_клетки: width,
      после_снятия: after,
    };
  })()`);
}

/** Авто-импорт: у подсказки есть доп. правка (строка import) — при выборе добавляются и она, и имя. */
async function autoImportCheck(win) {
  const send = (event) => win.webContents.sendInputEvent(event);
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await script(`(() => {
    const c = window.probe.controller, b = window.probe.buffer, end = b.length;
    c.selectRange(end, end);
    c.applyEdit({ start: end, removed: '', inserted: '\\n' });
    window.probe.input.focus();
    return true;
  })()`);
  await wait(120);
  for (const char of 'Path') {
    send({ type: 'char', keyCode: char });
    await wait(60);
  }
  await wait(150);
  const показано = await script(
    `[...document.querySelectorAll('.own-editor-suggest-item')].some((r) => r.textContent.includes('Path'))`,
  );
  const до = await script('window.probe.buffer.lineText(1)');
  send({ type: 'keyDown', keyCode: 'Return' });
  send({ type: 'keyUp', keyCode: 'Return' });
  await wait(150);
  const после = await script(`(() => {
    const b = window.probe.buffer, caret = window.probe.controller.caret;
    return { первая: b.lineText(1), строка_курсора: b.lineText(b.lineAt(caret)).trim() };
  })()`);
  await script('window.probe.controller.undo()');
  await wait(80);
  const после_отмены = await script('window.probe.buffer.lineText(1)');
  return { показано, до, после, после_отмены };
}

/** Подсветка пометок TODO/FIXME в строках: слова-пометки получают свой класс. */
async function todoCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const frame = `await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));`;
  return await script(`(async () => {
    const { view } = window.probe;
    view.element.querySelector('.own-editor-viewport').scrollTop = 0;
    ${frame}
    const nodes = [...view.element.querySelectorAll('.own-editor-todo')];
    const node = nodes[0];
    return {
      штук: nodes.length,
      тексты: nodes.map((n) => n.textContent),
      фон: node ? getComputedStyle(node).backgroundColor : null,
    };
  })()`);
}

/** Подсказки-вставки (inlay hints): вставка рисуется в строке и сдвигает текст за собой. */
async function inlayCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const frame = `await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));`;
  return await script(`(async () => {
    const { view } = window.probe;
    view.element.querySelector('.own-editor-viewport').scrollTop = 0;
    ${frame}
    const leftOf = (selector) => {
      const node = view.element.querySelector(selector);
      return node ? Math.round(node.getBoundingClientRect().left) : null;
    };
    // Строку 3 («const ascii = "..."») вставка на столбце 12 сдвигает вправо: строка-
    // литерал после неё должна уехать ровно на ширину вставки.
    const stringBefore = leftOf('.own-editor-token-string');
    view.setInlayHints([{ line: 3, column: 12, label: ': string', kind: 'type' }]);
    ${frame}
    const nodes = [...view.element.querySelectorAll('.own-editor-inlay')];
    const node = nodes[0];
    const result = {
      штук: nodes.length,
      тексты: nodes.map((n) => n.textContent),
      класс: node ? node.className : null,
      курсив: node ? getComputedStyle(node).fontStyle : null,
      сдвиг_текста: stringBefore !== null ? leftOf('.own-editor-token-string') - stringBefore : null,
      ширина_вставки: node ? Math.round(node.getBoundingClientRect().width) : null,
    };
    view.setInlayHints([]);
    ${frame}
    return { ...result, после_снятия: view.element.querySelectorAll('.own-editor-inlay').length };
  })()`);
}

/**
 * Невидимые знаки: пробелы точками, табуляции стрелкой. Проба включает режим и
 * считает узлы; заодно проверяет, что точка нарисована фоном, а не знаком в тексте.
 */
async function whitespaceCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const frame = `await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));`;
  return await script(`(async () => {
    const { view } = window.probe;
    view.element.querySelector('.own-editor-viewport').scrollTop = 0;
    view.setWhitespace('all');
    ${frame}
    const spaces = [...view.element.querySelectorAll('.own-editor-ws.is-space')];
    const tabs = [...view.element.querySelectorAll('.own-editor-ws.is-tab')];
    const space = spaces[0];
    const all = {
      пробелов: spaces.length,
      табуляций: tabs.length,
      символ_пробела: space ? JSON.stringify(space.textContent) : null,
      фон_пробела: space ? getComputedStyle(space).backgroundImage.slice(0, 7) : null,
    };
    view.setWhitespace('trailing');
    ${frame}
    const trailing = view.element.querySelectorAll('.own-editor-ws').length;
    view.setWhitespace('none');
    ${frame}
    return {
      режим_all: all,
      хвостовых_узлов: trailing,
      после_снятия: view.element.querySelectorAll('.own-editor-ws').length,
    };
  })()`);
}

/** Лигатуры: включаются классом на корне, ширину знаков не меняют. */
async function ligaturesCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const frame = `await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));`;
  return await script(`(async () => {
    const { view } = window.probe;
    const root = view.element;
    const read = () => getComputedStyle(root).fontVariantLigatures;
    const before = read();
    view.setLigatures(true);
    ${frame}
    const on = { класс: root.classList.contains('is-ligatures'), лигатуры: read() };
    view.setLigatures(false);
    ${frame}
    return { до: before, включено: on, после: read() };
  })()`);
}

/** Миникарта: холст, ползунок видимой части и его сдвиг при прокрутке. */
async function minimapCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const frame = `await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));`;
  return await script(`(async () => {
    const { view } = window.probe;
    const minimap = view.element.querySelector('.own-editor-minimap');
    const canvas = view.element.querySelector('.own-editor-minimap-canvas');
    const slider = view.element.querySelector('.own-editor-minimap-slider');
    const topOf = () => Math.round(slider.getBoundingClientRect().top - minimap.getBoundingClientRect().top);
    const before = { скрыта: minimap.hidden };
    view.setMinimap(true);
    ${frame}
    const shown = {
      видна: !minimap.hidden,
      ширина_холста: canvas.width,
      высота_холста: canvas.height,
      ползунок_виден: !slider.hidden,
      ползунок_высота: Math.round(slider.getBoundingClientRect().height),
      ползунок_верх: topOf(),
    };
    const vp = view.element.querySelector('.own-editor-viewport');
    vp.scrollTop = vp.scrollHeight - vp.clientHeight;
    ${frame}
    const scrolled = { ползунок_верх: topOf(), прокрутка: vp.scrollTop };
    vp.scrollTop = 0;
    view.setMinimap(false);
    ${frame}
    return { до: before, показана: shown, после_прокрутки: scrolled, после_снятия_скрыта: minimap.hidden };
  })()`);
}

/**
 * Перенос длинных строк: самая длинная строка ломается на несколько рядов, каретка на
 * её конце переезжает на нижний ряд, а выделение всей строки даёт несколько заливок.
 * Число рядов полотна сверяем как высоту полотна, делённую на высоту строки.
 */
async function wordWrapCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const frame = `await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));`;
  return await script(`(async () => {
    const { view, buffer } = window.probe;
    const root = view.element;
    const content = root.querySelector('.own-editor-content');
    const viewport = root.querySelector('.own-editor-viewport');
    // Самая длинная строка файла — её перенос и смотрим.
    let target = 1;
    let longest = 0;
    for (let line = 1; line <= buffer.lineCount; line += 1) {
      const length = buffer.lineText(line).length;
      if (length > longest) { longest = length; target = line; }
    }
    const start = buffer.lineStart(target);
    const end = start + longest;

    view.setWordWrap(false);
    ${frame}
    const before = view.caretPoint(start);
    const rowsOff = Math.round(Number.parseFloat(content.style.height) / before.height);

    view.setWordWrap(true);
    ${frame}
    const on = view.caretPoint(start);
    const onEnd = view.caretPoint(end);
    const rowsOn = Math.round(Number.parseFloat(content.style.height) / on.height);
    const width = viewport.clientWidth;

    // Выделение всей длинной строки: перенос даёт по прямоугольнику на отрезок.
    view.setSelection({ anchor: start, active: end });
    ${frame}
    const shade = root.querySelectorAll('.own-editor-selection-rect').length;
    const carets = root.querySelectorAll('.own-editor-caret').length;

    // Клик в середину длинной строки должен дать смещение внутри неё.
    const probeOffset = start + Math.floor(longest / 2);
    const point = view.clientPoint(probeOffset);
    const back = view.offsetAt(point.left, point.top + point.height / 2);

    view.setSelection({ anchor: 0, active: 0 });
    view.setWordWrap(false);
    ${frame}
    const rowsAfter = Math.round(Number.parseFloat(content.style.height) / before.height);

    return {
      длинная_строка: target,
      знаков_в_строке: longest,
      ширина_поля: width,
      ряды_без_переноса: rowsOff,
      ряды_с_переносом: rowsOn,
      конец_на_ряду: Math.round(onEnd.top / on.height),
      перенос_есть: onEnd.top > on.top,
      каретка_конца_x: Math.round(onEnd.left),
      каретка_конца_в_ширине: onEnd.left <= width,
      заливок_выделения: shade,
      кареток: carets,
      клик_середина_строки: probeOffset,
      клик_дал_смещение: back,
      ряды_после_снятия: rowsAfter,
    };
  })()`);
}

async function codeActionsCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const send = (event) => win.webContents.sendInputEvent(event);

  // Курсор в панель хозяина: Ctrl+. должен дойти до шва приложения (там запрос к серверу).
  await script(`(() => {
    const { host, docA, codeActions } = window.probeHost;
    codeActions.length = 0;
    host.open(docA);
    host.reveal(docA.path, 2, 3);
    return true;
  })()`);

  send({ type: 'keyDown', keyCode: '.', modifiers: ['control'] });
  send({ type: 'keyUp', keyCode: '.', modifiers: ['control'] });
  await wait(60);

  return script(`(() => {
    const { codeActions, host } = window.probeHost;
    return {
      вызовов: codeActions.length,
      путь: codeActions[0]?.path ?? null,
      позиция: codeActions[0]?.position ?? null,
      курсор: host.cursorState,
    };
  })()`);
}

async function problemPanelCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  // Пометки ставим через шов панели: две в одном файле, одна в другом.
  const filled = await script(`(() => {
    const { setMarkers } = window.probeProblemPanel;
    setMarkers([
      { path: '/probe/a.ts', line: 2, column: 1, severity: 'error', message: 'тип не тот', source: 'ts' },
      { path: '/probe/a.ts', line: 7, column: 3, severity: 'warning', message: 'не используется', source: 'ts' },
      { path: '/probe/b.py', line: 1, column: 1, severity: 'error', message: 'неизвестное имя', source: 'import-check' },
    ]);
    const root = document.querySelector('#probe-problem-panel .problems-panel');
    return {
      заголовок: root.querySelector('.problems-summary').textContent,
      файлов: root.querySelectorAll('.problem-group-head').length,
      строк: root.querySelectorAll('.problem-row').length,
      первый_файл: root.querySelector('.problem-file').textContent,
      первое_сообщение: root.querySelector('.problem-row .problem-message').textContent,
      место: root.querySelector('.problem-row .problem-position').textContent,
    };
  })()`);

  // Нажатие на третью строку — переход именно к её месту.
  const clicked = await script(`(() => {
    const root = document.querySelector('#probe-problem-panel .problems-panel');
    root.querySelectorAll('.problem-row')[2].click();
    return { переходы: window.probeProblemPanel.clicks.slice() };
  })()`);

  // Фильтр: остаётся только файл с подходящим источником.
  const filtered = await script(`(() => {
    const filter = document.querySelector('#probe-problem-panel .problems-filter');
    filter.value = 'import-check';
    filter.dispatchEvent(new Event('input'));
    const root = document.querySelector('#probe-problem-panel .problems-panel');
    const result = {
      файлов: root.querySelectorAll('.problem-group-head').length,
      строк: root.querySelectorAll('.problem-row').length,
      заголовок: root.querySelector('.problems-summary').textContent,
    };
    // Пустой список: фильтр, под который ничего не подходит.
    filter.value = 'нет такого';
    filter.dispatchEvent(new Event('input'));
    result.пусто = root.querySelector('.problems-empty')?.textContent ?? null;
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    return result;
  })()`);

  // Без пометок панель говорит об этом прямо.
  const empty = await script(`(() => {
    window.probeProblemPanel.setMarkers([]);
    const root = document.querySelector('#probe-problem-panel .problems-panel');
    return {
      заголовок: root.querySelector('.problems-summary').textContent,
      пусто: root.querySelector('.problems-empty')?.textContent ?? null,
    };
  })()`);

  return { список: filled, клик: clicked, фильтр: filtered, без_пометок: empty };
}

async function signatureCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const send = (event) => win.webContents.sendInputEvent(event);

  // Файл и курсор: ввод должен попасть в панель хозяина, а не в видимый редактор пробы.
  await script(`(() => {
    const { host, docA } = window.probeHost;
    host.open(docA);
    host.reveal(docA.path, 1, 1);
    return true;
  })()`);

  // Печатаем живую клавишу `(` — карточка должна взяться из ответа «сервера».
  send({ type: 'char', keyCode: '(' });
  await wait(80);
  const opened = await script(`(() => {
    const card = document.querySelector('#probe-host .own-editor-signature');
    return {
      видно: card ? card.hidden === false : null,
      подпись: card?.querySelector('.own-editor-signature-label')?.textContent ?? null,
      активный: card?.querySelector('.own-editor-signature-label .is-active')?.textContent ?? null,
      счётчик: card?.querySelector('.own-editor-signature-count')?.textContent ?? null,
      документация: card?.querySelector('.own-editor-signature-doc')?.textContent ?? null,
    };
  })()`);

  // Стрелка вниз — следующая перегрузка: клавишу забирает попап, курсор не двигается.
  send({ type: 'keyDown', keyCode: 'Down' });
  send({ type: 'keyUp', keyCode: 'Down' });
  await wait(60);
  const turned = await script(`(() => {
    const card = document.querySelector('#probe-host .own-editor-signature');
    return {
      подпись: card?.querySelector('.own-editor-signature-label')?.textContent ?? null,
      счётчик: card?.querySelector('.own-editor-signature-count')?.textContent ?? null,
      строка_курсора: window.probeHost.host.cursorState.line,
    };
  })()`);

  send({ type: 'char', keyCode: ')' });
  await wait(60);
  const closed = await script(`(() => {
    const card = document.querySelector('#probe-host .own-editor-signature');
    return { видно: card ? card.hidden === false : null };
  })()`);

  return { после_скобки: opened, после_стрелки: turned, после_закрытия: closed };
}

async function symbolsCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  // Одно определение — прыжок сразу, без списка.
  const jump = await script(`(async () => {
    const { workspace, answers, revealed } = window.probeSymbols;
    answers.definition = [{ path: '/probe/def.ts', line: 4, column: 2 }];
    revealed.length = 0;
    workspace.reveal('/probe/sym.ts', 2, 1);
    const ran = workspace.runAction('editor.goToDefinition');
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      запустилось: ran,
      переходы: revealed.slice(),
      список_виден: document.querySelector('#probe-symbols .own-editor-locations')?.hidden === false,
    };
  })()`);

  // Несколько определений — тот же список.
  const list = await script(`(async () => {
    const { workspace, answers, revealed } = window.probeSymbols;
    answers.definition = [
      { path: '/probe/one.ts', line: 3, column: 5 },
      { path: '/probe/two.ts', line: 7, column: 1 },
    ];
    revealed.length = 0;
    workspace.reveal('/probe/sym.ts', 2, 1);
    workspace.runAction('editor.goToDefinition');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const panel = document.querySelector('#probe-symbols .own-editor-locations');
    return {
      виден: !panel.hidden,
      заголовок: panel.querySelector('.own-editor-locations-title')?.textContent ?? null,
      строки: [...panel.querySelectorAll('.own-editor-locations-item')].map((row) => ({
        файл: row.querySelector('.own-editor-locations-label')?.textContent ?? '',
        место: row.querySelector('.own-editor-locations-detail')?.textContent ?? '',
        выбран: row.classList.contains('is-active'),
      })),
      переходов_пока_нет: revealed.length,
    };
  })()`);

  // Выбор строки мышью — переход по ней, а список закрывается.
  const picked = await script(`(async () => {
    document
      .querySelector('#probe-symbols .own-editor-locations-item.is-active')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      переходы: window.probeSymbols.revealed.slice(),
      список_закрыт: document.querySelector('#probe-symbols .own-editor-locations').hidden,
    };
  })()`);

  // Ссылки — тот же попап с другим заголовком.
  const references = await script(`(async () => {
    const { workspace, answers } = window.probeSymbols;
    answers.references = [
      { path: '/probe/sym.ts', line: 2, column: 5 },
      { path: '/probe/other.ts', line: 9, column: 3 },
      { path: '/probe/third.ts', line: 1, column: 1 },
    ];
    workspace.reveal('/probe/sym.ts', 2, 7);
    workspace.runAction('editor.references');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const panel = document.querySelector('#probe-symbols .own-editor-locations');
    return {
      виден: !panel.hidden,
      заголовок: panel.querySelector('.own-editor-locations-title')?.textContent ?? null,
      мест: panel.querySelectorAll('.own-editor-locations-item').length,
    };
  })()`);

  // Пусто — списка нет, есть только весть.
  const empty = await script(`(async () => {
    const { workspace, answers, notices } = window.probeSymbols;
    document.querySelector('#probe-symbols .own-editor-locations').hidden = true;
    answers.references = [];
    notices.length = 0;
    workspace.runAction('editor.references');
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      вести: notices.slice(),
      список_виден: document.querySelector('#probe-symbols .own-editor-locations')?.hidden === false,
    };
  })()`);

  // Команды перехода появляются только когда есть источник мест.
  const availability = await script(`(() => ({
    с_источником: window.probeSymbols.workspace.listActions().some((item) => item.id === 'editor.goToDefinition'),
    без_источника: window.probeWorkspace.workspace.listActions().some((item) => item.id === 'editor.goToDefinition'),
  }))()`);

  return { прыжок: jump, список: list, выбор: picked, ссылки: references, пусто: empty, доступность: availability };
}

/**
 * Inline-подсказка «допиши за меня»: подставная «модель» отдаёт текст, а проба смотрит,
 * что он появляется призрачным, принимается по Tab и что выключенное не спрашивает вовсе.
 */
async function inlineCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const send = (event) => win.webContents.sendInputEvent(event);

  // Правка (вставка символа) заводит паузу; после неё рабочее место спрашивает «модель».
  await script(`(() => {
    const { workspace } = window.probeInline;
    workspace.reveal('/probe/inline.ts', 1, 13);
    workspace.insertAtCursor('x');
    return true;
  })()`);
  await wait(220);

  const shown = await script(`(() => {
    const ghost = document.querySelector('#probe-inline .own-editor-ghost');
    return {
      виден: Boolean(ghost),
      призрачный_текст: ghost?.textContent ?? null,
      вызовов: window.probeInline.calls.length,
      последний_запрос: window.probeInline.calls.at(-1) ?? null,
    };
  })()`);

  // Tab принимает подсказку: текст дописывается в документ, призрак пропадает.
  await script(`document.querySelector('#probe-inline .own-editor-input').focus()`);
  send({ type: 'keyDown', keyCode: 'Tab' });
  send({ type: 'keyUp', keyCode: 'Tab' });
  await wait(120);
  const accepted = await script(`(() => ({
    первая_строка: window.probeInline.doc.value.split('\\n')[0],
    призраков: document.querySelectorAll('#probe-inline .own-editor-ghost').length,
  }))()`);

  // Выключено — новый ввод молчит: ни запроса, ни призрачного текста.
  const off = await script(`(async () => {
    const { workspace, calls, control } = window.probeInline;
    control.enabled = false;
    const before = calls.length;
    workspace.reveal('/probe/inline.ts', 2, 1);
    workspace.insertAtCursor('y');
    await new Promise((resolve) => setTimeout(resolve, 220));
    const ghost = document.querySelector('#probe-inline .own-editor-ghost');
    return { было_вызовов: before, стало_вызовов: calls.length, призрак_виден: Boolean(ghost) };
  })()`);

  return { показ: shown, принятие: accepted, выключено: off };
}

/**
 * Переход по пометкам (F8/Shift+F8): пометки лежат в рабочем месте, а команда
 * ищет ближайшую и отдаёт переход наружу. Проверяем порядок, заворот по кругу и
 * сообщение, когда пометок нет.
 */
async function problemsCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  const counts = await script(`(() => ({
    счётчики: window.probeProblems.workspace.problemCounts(),
    список: window.probeProblems.workspace.markers().map((item) => 
      item.path + ':' + item.line + ':' + item.column + ':' + item.severity),
  }))()`);

  const forward = await script(`(() => {
    const { workspace, doc, spots } = window.probeProblems;
    spots.length = 0;
    workspace.reveal(doc.path, 1, 1);
    workspace.runAction('editor.nextProblem');
    const первый = spots.at(-1) ?? null;
    workspace.runAction('editor.nextProblem');
    const второй = spots.at(-1) ?? null;
    workspace.runAction('editor.nextProblem');
    const третий = spots.at(-1) ?? null;
    // Файл other.ts в панели не открыт: место лишь запоминается, и четвёртое нажатие
    // остаётся на нём же (в приложении revealLocation откроет файл и курсор сдвинется).
    workspace.runAction('editor.nextProblem');
    const на_неоткрытом = spots.at(-1) ?? null;
    return { первый, второй, третий, на_неоткрытом };
  })()`);

  const backward = await script(`(() => {
    const { workspace, doc, spots } = window.probeProblems;
    spots.length = 0;
    workspace.reveal(doc.path, 1, 1);
    workspace.runAction('editor.previousProblem');
    return { с_первой_строки: spots.at(-1) ?? null };
  })()`);

  const empty = await script(`(() => {
    const { workspace, doc, notices } = window.probeProblems;
    workspace.setExternalMarkers(doc.path, 'lsp', []);
    workspace.setExternalMarkers('/probe/other.ts', 'lsp', []);
    notices.length = 0;
    const счётчики = workspace.problemCounts();
    workspace.runAction('editor.nextProblem');
    return { счётчики, вести: notices.slice() };
  })()`);

  return { счётчики: counts, вперёд: forward, назад: backward, пусто: empty };
}

/**
 * Два шва на границе своего рабочего места: F1 открывает палитру (у Monaco это делало
 * его действие), и отладочная подсказка идёт раньше языковой.
 */
async function borderCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const send = (event) => win.webContents.sendInputEvent(event);

  await script(`document.querySelector('#probe-symbols .own-editor-input').focus()`);
  await wait(60);
  send({ type: 'keyDown', keyCode: 'F1' });
  send({ type: 'keyUp', keyCode: 'F1' });
  await wait(80);
  const palette = await script(`window.probeSymbols.paletteOpens.length`);

  // Отладочная подсказка: включаем первый источник — он должен перекрыть языковой.
  const hover = await script(`(async () => {
    const { view, buffer, hover, debugHoverControl } = window.probe;
    const offset = buffer.lineStart(1) + 3;
    const point = view.clientPoint(offset);
    debugHoverControl.on = true;
    hover.showAt(offset, point.left + 2, point.top + 8);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return document.querySelector('.own-editor-hover-title')?.textContent ?? null;
  })()`);

  // Выключаем первый — тот же показ даёт языковой источник.
  const hoverWithoutDebug = await script(`(async () => {
    const { view, buffer, hover, debugHoverControl } = window.probe;
    const offset = buffer.lineStart(1) + 3;
    const point = view.clientPoint(offset);
    debugHoverControl.on = false;
    hover.showAt(offset, point.left + 2, point.top + 8);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return document.querySelector('.own-editor-hover-title')?.textContent ?? null;
  })()`);

  return { F1_открыл_палитру: palette, наведение_отладчик: hover, наведение_без_отладчика: hoverWithoutDebug };
}

/**
 * Подсказки языкового сервера: подставной источник отдаёт элемент, которого в файле
 * нет ('valuableThing'). Если он появился в списке, ответ сервера доехал и подмешался.
 */
/**
 * Ссылки в коде (`documentLink`): подставной источник даёт одну ссылку —
 * проверяем, что участок нарисован и клик по нём доходит до приложения.
 */
async function documentLinksCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  const shown = await script(`(() => {
    const node = document.querySelector('#probe-symbols .own-editor-link');
    if (!node) return { найдена: false };
    return {
      найдена: true,
      строка: node.dataset.line,
      столбец: node.dataset.column,
      подпись: node.title,
      ширина: Math.round(node.getBoundingClientRect().width) > 0,
    };
  })()`);

  const clicked = await script(`(() => {
    const node = document.querySelector('#probe-symbols .own-editor-link');
    if (!node) return null;
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return window.probeSymbols.linkOpens.at(-1) ?? null;
  })()`);

  return { показ: shown, клик: clicked };
}

/**
 * Связанные участки (linkedEditing): подсветка участков (вид) и повтор правки (контроллер).
 * Подсветку смотрим на основном редакторе пробы (у него живой ввод), поставив на время
 * известный текст и вернув прежний; повтор правки — на отдельном редакторе с парными
 * тегами, чей подставной сервер считает связанными оба «div».
 */
async function linkedEditingCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  await script(`(() => {
    const { view, controller, buffer } = window.probe;
    window.__probeSavedText = buffer.getText();
    controller.applyEdits([{ start: 0, removed: window.__probeSavedText, inserted: '<div></div>\\n' }]);
    view.revealOffset(1);
    return true;
  })()`);
  // Вид рисует асинхронно: даём кадру пройти, иначе подсветка посчитается по старым строкам.
  await wait(80);

  const paint = await script(`(() => {
    const { view, controller } = window.probe;
    // Каретка — внутрь первого имени: подсветятся и вхождения слова, и связанные участки.
    controller.setSelection({ anchor: 1, active: 1 });
    view.setLinkedRanges([{ start: 1, end: 4 }, { start: 6, end: 9 }]);
    const rects = [...view.element.querySelectorAll('.own-editor-highlight-rect')];
    const result = {
      связано: rects.filter((node) => node.classList.contains('is-linked')).length,
      вхождений: rects.filter((node) => node.classList.contains('is-occurrence')).length,
    };
    view.setLinkedRanges([]);
    return result;
  })()`);

  await script(`(() => {
    const { controller, buffer } = window.probe;
    controller.applyEdits([{ start: 0, removed: buffer.getText(), inserted: window.__probeSavedText }]);
    return true;
  })()`);

  const before = await script(`window.probeLinked.doc.value`);
  const after = await script(`(() => {
    const { workspace, doc } = window.probeLinked;
    workspace.reveal(doc.path, 1, 2);
    workspace.insertAtCursor('x');
    return workspace.currentText(doc.path);
  })()`);

  return {
    подсветка: paint,
    было: before,
    стало: after,
    изменилось: (after.match(/xdiv/g) ?? []).length,
  };
}

/**
 * Семантическая подсветка (semanticTokens): роли от сервера перекрывают грамматику.
 * Ставим на основной редактор текст и семантические токены, где имя функции сервер
 * назвал типом, — тогда по классу спана видно, что семантика победила грамматику.
 */
async function semanticCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  await script(`(() => {
    const { view, controller, buffer } = window.probe;
    window.__probeSavedText = buffer.getText();
    controller.applyEdits([{ start: 0, removed: window.__probeSavedText, inserted: 'def f(): return 1\\n' }]);
    view.revealOffset(0);
    return true;
  })()`);
  await wait(80);

  const painted = await script(`(() => {
    const { view } = window.probe;
    // Грамматика красит «f» как функцию; сервер говорит, что это тип — его слово важнее.
    view.setSemanticTokens([
      { line: 1, startColumn: 1, endColumn: 4, type: 'keyword', modifiers: [] },
      { line: 1, startColumn: 5, endColumn: 6, type: 'type', modifiers: [] },
    ]);
    const texts = (role) => [...view.element.querySelectorAll('.own-editor-token-' + role)].map((n) => n.textContent);
    return { type: texts('type'), function: texts('function'), keyword: texts('keyword'), строка: view.element.querySelector('.own-editor-line')?.textContent ?? null };
  })()`);

  await script(`(() => {
    const { view, controller, buffer } = window.probe;
    view.setSemanticTokens([]);
    controller.applyEdits([{ start: 0, removed: buffer.getText(), inserted: window.__probeSavedText }]);
    return true;
  })()`);

  return painted;
}

/**
 * Значения отладчика в строках (`setInlineValues`): `x = 42` справа от имени. Проверяем,
 * что вставка появилась, стоит после имени и не сдвинула сам текст файла.
 */
async function inlineValuesCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  await script(`(() => {
    const { view, controller, buffer } = window.probe;
    window.__probeSavedText = buffer.getText();
    controller.applyEdits([{ start: 0, removed: window.__probeSavedText, inserted: 'count = 41\\ncount = 42\\n' }]);
    view.revealOffset(0);
    return true;
  })()`);
  await wait(80);

  const shown = await script(`(() => {
    const { view } = window.probe;
    view.setInlineValues([{ line: 1, column: 5, label: 'count = 41' }]);
    const node = view.element.querySelector('.own-editor-inline-value');
    const row = view.element.querySelector('.own-editor-line');
    return {
      есть: Boolean(node),
      подпись: node ? node.textContent : null,
      строка: row ? row.textContent : null,
    };
  })()`);

  await script(`(() => {
    const { view, controller, buffer } = window.probe;
    view.setInlineValues([]);
    controller.applyEdits([{ start: 0, removed: buffer.getText(), inserted: window.__probeSavedText }]);
    return true;
  })()`);

  return shown;
}

/**
 * Emmet: Tab раскрывает сокращение перед кареткой. Пишем сокращение в редактор разметки,
 * жмём Tab настоящим событием клавиатуры — и смотрим, что получилось в тексте.
 */
async function emmetCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  const after = await script(`(() => {
    const { workspace, doc } = window.probeEmmet;
    workspace.reveal(doc.path, 1, 1);
    workspace.insertAtCursor('ul>li*2');
    const input = document.querySelector('#probe-emmet .own-editor-input');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    return workspace.currentText(doc.path);
  })()`);

  // Повтор: Emmet не вмешивается в чужой язык (в этом редакторе язык разметки, но текст
  // уже без сокращения — Tab должен вести себя как обычный отступ).
  const plain = await script(`(() => {
    const { workspace, doc } = window.probeEmmet;
    document.querySelector('#probe-emmet .own-editor-input').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    return workspace.currentText(doc.path);
  })()`);

  return { после_Tab: after, после_второго_Tab: plain };
}

/**
 * Проверка орфографии: слово не из словаря подчёркнуто зелёной волной в комментарии,
 * а «Добавить в словарь» под курсором снимает отметку.
 */
/**
 * Заглянуть в определение: копия кода другого файла показывается на месте, с нужной
 * строкой внутри, счётчиком мест и кнопкой «Открыть». Проверяем и ход по местам:
 * у двух мест стрелка вперёд активна, у последнего — выключена.
 */
/**
 * Свёртка без языкового сервера: рабочее место само считает диапазоны — по грамматике
 * (скобки) и по отступам. Файл пробы свёрнут не по отступам (строки тела с нулевым
 * отступом), а по скобкам: значит, дошли именно грамматические диапазоны. Сворачиваем
 * всё и смотрим, что строк в разметке стало меньше.
 */
/**
 * Свёртка без языкового сервера: рабочее место само считает диапазоны — по грамматике
 * (скобки) и по отступам. Файл пробы свёрнут НЕ по отступам: строки тела с нулевым
 * отступом, как и строка со скобкой, — значит, дошли именно грамматические диапазоны.
 *
 * Проверяем обе стороны: щелчок по значку скрывает строки блока, повторный — возвращает
 * их. Второе важнее, чем кажется: одно время состояние менялось (значок ▾ → ▸), а строки
 * оставались на месте — у небольшого файла видимый отрезок тот же, и слой строк не
 * пересобирался (см. `rendered.folds` в `editor-view.ts`).
 */
/**
 * Обёртка выделения: Ctrl+Shift+T доходит до вызывающего (там список вариантов), а
 * выбранная пара ложится вокруг выделения. Проверяем и пустое выделение — тогда пара
 * вставляется с кареткой между знаками.
 */
/**
 * Обёртка выделения: сочетание Ctrl+Shift+T доходит до вызывающего (в приложении там
 * список вариантов), а выбранная пара ложится вокруг выделения. Выделение набираем
 * НАСТОЯЩИМИ клавишами (Shift+стрелка), а не подстановкой в модель: так проверяется и
 * то, что сочетание не перехвачено вводом.
 */
async function surroundCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  const send = (event) => win.webContents.sendInputEvent(event);

  await script(`(() => {
    const { workspace, doc } = window.probeSurround;
    // Встаём перед сложением — дальше выделяем стрелками.
    workspace.reveal(doc.path, 1, doc.value.indexOf('a + b') + 1);
    document.querySelector('#probe-surround .own-editor-input').focus();
    return true;
  })()`);
  await wait(60);

  // Shift+стрелка вправо пять раз: `a + b` — ровно пять знаков.
  for (let step = 0; step < 5; step += 1) {
    send({ type: 'keyDown', keyCode: 'Right', modifiers: ['shift'] });
    send({ type: 'keyUp', keyCode: 'Right', modifiers: ['shift'] });
  }
  await wait(80);

  const selected = await script(`(() => ({
    выделение: window.probeSurround.workspace.selectedText(),
    выделено: window.probeSurround.workspace.hasSelection(),
  }))()`);

  // Ctrl+Shift+T — обёртка: редактор зовёт вызывающего, тот показывает список.
  send({ type: 'keyDown', keyCode: 'T', modifiers: ['control', 'shift'] });
  send({ type: 'keyUp', keyCode: 'T', modifiers: ['control', 'shift'] });
  await wait(80);

  const requests = await script(`(() => window.probeSurround.requests.slice())()`);

  // Применяем выбранную пару тем же путём, что и модалка.
  const wrapped = await script(`(() => {
    const { workspace, doc } = window.probeSurround;
    workspace.surroundSelection({ id: 'paren', label: 'Круглые скобки', open: '(', close: ')' });
    return { текст: doc.value, выделено: workspace.hasSelection(), выделение: workspace.selectedText() };
  })()`);

  // Пустое выделение: пара вставляется, каретка встаёт между знаками.
  const empty = await script(`(() => {
    const { workspace, doc } = window.probeSurround;
    workspace.reveal(doc.path, 1, 1);
    workspace.surroundSelection({ id: 'brace', label: 'Фигурные скобки', open: '{', close: '}' });
    return { текст: doc.value, выделено: workspace.hasSelection() };
  })()`);

  return { выделено_перед: selected, запросы: requests, обёрнуто: wrapped, пустое: empty };
}

async function semanticFoldCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  await wait(200);

  const read = (expression) =>
    script(`(() => {
    const root = document.querySelector('#probe-folds .own-editor');
    if (!root) return { ошибка: 'нет редактора' };
    return {
      значки: [...root.querySelectorAll('.own-editor-fold.is-visible')].map((node) => node.textContent),
      строк_в_dom: root.querySelectorAll('.own-editor-line').length,
      тексты: [...root.querySelectorAll('.own-editor-line')].map((row) => row.textContent),
    };
  })()${expression}`);

  const before = await read('');

  const click = () =>
    script(`(() => {
    const root = document.querySelector('#probe-folds .own-editor');
    root.querySelector('.own-editor-fold.is-visible')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return true;
  })()`);

  await click();
  await wait(120);
  const collapsed = await read('');

  await click();
  await wait(120);
  const expanded = await read('');

  return { до: before, сложено: collapsed, раскрыто: expanded };
}

async function peekCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  // Готовим ответ сервера: два места в одном файле — видно и счётчик, и ход.
  await script(`(() => {
    const { answers, files } = window.probePeek;
    const lines = [];
    for (let i = 1; i <= 40; i += 1) lines.push(i === 3 ? 'export const value = 1;' : '// строка ' + i);
    files['/probe/def.ts'] = lines.join('\\n');
    answers.definition = [
      { path: '/probe/def.ts', line: 3, column: 14 },
      { path: '/probe/def.ts', line: 30, column: 1 },
    ];
    return true;
  })()`);

  await script(`(() => {
    window.probePeek.workspace.runAction('editor.peekDefinition');
    return true;
  })()`);
  await wait(150);

  const first = await script(`(() => {
    const root = document.querySelector('#probe-peek .own-editor-peek');
    if (!root || root.hidden) return { видна: false };
    const target = root.querySelector('.own-editor-peek-row.is-target');
    return {
      видна: true,
      заголовок: root.querySelector('.own-editor-peek-title')?.textContent ?? null,
      счётчик: root.querySelector('.own-editor-peek-counter')?.textContent ?? null,
      строк: root.querySelectorAll('.own-editor-peek-row').length,
      цель: target ? target.textContent : null,
      назад_выключена: root.querySelector('.own-editor-peek-btn.own-editor-peek-step')
        ? root.querySelectorAll('.own-editor-peek-step')[0].disabled
        : null,
      вперёд_активна: root.querySelectorAll('.own-editor-peek-step')[1]
        ? !root.querySelectorAll('.own-editor-peek-step')[1].disabled
        : null,
    };
  })()`);

  // Шаг вперёд: второе место — и стрелка вперёд гаснет (конец списка виден).
  const stepped = await script(`(() => {
    const { workspace } = window.probePeek;
    const root = document.querySelector('#probe-peek .own-editor-peek');
    root.querySelectorAll('.own-editor-peek-step')[1].click();
    return true;
  })()`);
  void stepped;
  await wait(150);

  const second = await script(`(() => {
    const root = document.querySelector('#probe-peek .own-editor-peek');
    if (!root || root.hidden) return { видна: false };
    const steps = root.querySelectorAll('.own-editor-peek-step');
    const target = root.querySelector('.own-editor-peek-row.is-target');
    return {
      видна: true,
      счётчик: root.querySelector('.own-editor-peek-counter')?.textContent ?? null,
      цель: target ? target.textContent : null,
      вперёд_выключена: steps[1] ? steps[1].disabled : null,
      назад_активна: steps[0] ? !steps[0].disabled : null,
    };
  })()`);

  // «Открыть» уводит насовсем: копия закрывается, вызывающий получает место.
  await script(`(() => {
    document.querySelector('#probe-peek .own-editor-peek-open').click();
    return true;
  })()`);
  await wait(100);

  const opened = await script(`(() => ({
    видна: !document.querySelector('#probe-peek .own-editor-peek').hidden,
    переходы: window.probePeek.revealed,
    чтения: window.probePeek.reads.length,
  }))()`);

  // Курсор сдвинулся — копия про прежнее место больше не нужна.
  await script(`(() => {
    const { workspace, doc } = window.probePeek;
    workspace.runAction('editor.peekDefinition');
    return true;
  })()`);
  await wait(150);
  await script(`(() => {
    const { workspace, doc } = window.probePeek;
    workspace.reveal(doc.path, 2, 1);
    return true;
  })()`);
  await wait(120);
  const afterMove = await script(
    `(() => ({ видна: !document.querySelector('#probe-peek .own-editor-peek').hidden }))()`,
  );

  return { первое_место: first, второе_место: second, после_открытия: opened, после_сдвига: afterMove };
}

async function spellcheckCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);
  await wait(60);

  const before = await script(`(() => {
    const { workspace, doc } = window.probeSpell;
    const root = document.querySelector('#probe-spell .own-editor');
    workspace.reveal(doc.path, 1, 4);
    return {
      слов_с_ошибками: root.querySelectorAll('.own-editor-squiggly-rect.is-spelling').length,
      слово_под_курсором: workspace.spellingWordAtCursor(),
    };
  })()`);

  const added = await script(`(() => window.probeSpell.workspace.addSpellingWordToDictionary())()`);
  await wait(60);

  const after = await script(`(() => {
    const root = document.querySelector('#probe-spell .own-editor');
    return { слов_с_ошибками: root.querySelectorAll('.own-editor-squiggly-rect.is-spelling').length };
  })()`);

  return { до: before, добавили: added, после: after };
}

async function lspCompletionCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  await script(`(() => {
    const { workspace, doc } = window.probeSymbols;
    workspace.reveal(doc.path, 1, 13);
    workspace.insertAtCursor('val');
    return true;
  })()`);
  // Дотягивание описания уходит отдельным запросом — даём ему дойти до строки списка.
  await wait(200);

  const panel = await script(`(() => {
    const root = document.querySelector('#probe-symbols .own-editor-suggest');
    return {
      виден: root ? !root.hidden : false,
      строки: root ? [...root.querySelectorAll('.own-editor-suggest-item')].map((row) => ({
        подпись: row.querySelector('.own-editor-suggest-label')?.textContent ?? '',
        вид: (row.querySelector('.own-editor-suggest-detail')?.className ?? '').split(' ').pop() ?? '',
        описание: row.querySelector('.own-editor-suggest-doc')?.textContent ?? '',
      })) : [],
      спрошено_описаний: window.probeSymbols.resolvedCompletions.length,
    };
  })()`);

  // Принимаем первую строку (это должен быть ответ сервера) и смотрим, что вставилось.
  const accepted = await script(`(() => {
    const { workspace, doc } = window.probeSymbols;
    const input = document.querySelector('#probe-symbols .own-editor-input');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return workspace.currentText(doc.path)?.split('\\n')[0] ?? null;
  })()`);

  return { список: panel, после_Enter: accepted };
}

/**
 * Ctrl+Click по слову: жест переходит к определению (у Monaco это делал его обработчик
 * открытия). Проверяем, что переход состоялся.
 */
async function ctrlClickCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  return script(`(async () => {
    const { workspace, answers, revealed } = window.probeSymbols;
    answers.definition = [{ path: '/probe/def.ts', line: 4, column: 2 }];
    revealed.length = 0;
    const viewport = document.querySelector('#probe-symbols .own-editor-viewport');
    const line = document.querySelector('#probe-symbols .own-editor-line');
    const rect = line.getBoundingClientRect();
    // Клик по первой строке, немного вправо от начала — там стоит слово.
    viewport.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, ctrlKey: true,
      clientX: Math.round(rect.left + 20), clientY: Math.round(rect.top + 8),
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { переходы: revealed.slice(), активный: workspace.activePath };
  })()`);
}

async function main() {
  const lines = [];
  const log = (text) => {
    lines.push(text);
    console.log(text);
  };

  const { dir, page } = await prepare();
  const win = new BrowserWindow({
    width: 1000,
    height: 640,
    show: true,
    backgroundColor: '#161618',
    // Скрытое окно Chromium тормозит анимации, а снимок ждёт кадр — окно показываем
    // и запрещаем торможение фонового рисования, иначе `capturePage` повиснет.
    webPreferences: { sandbox: false, backgroundThrottling: false },
  });

  const problems = [];
  win.webContents.on('console-message', (event, _level, message) => {
    const text = typeof message === 'string' ? message : (event?.message ?? '');
    // Место сообщения печатаем рядом: по одному тексту не видно, где искать.
    const where = event?.sourceId ? ` (${event.sourceId}:${event.lineNumber ?? 0})` : '';
    if (String(text).trim()) problems.push(`${String(text).trim()}${where}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    problems.push(`did-fail-load ${code} ${description} ${url}`);
  });

  await win.loadFile(page);
  await wait(1200);

  const run = (name) => win.webContents.executeJavaScript(CHECKS[name]).catch((error) => `ошибка: ${error.message}`);

  log(`# Проба своего редактора — ${new Date().toISOString()}`);
  log('');

  const geometry = await run('geometry');
  log('## Геометрия');
  log(JSON.stringify(geometry, null, 2));
  log(`снимок: ${await shot(win, '01-initial')}`);
  log('');

  const virtual = await run('virtual');
  log('## Виртуализация и содержимое');
  log(JSON.stringify(virtual, null, 2));
  log('');

  const layout = await run('layout');
  log('## Раскладка: табуляция и широкие знаки');
  log(JSON.stringify(layout, null, 2));
  log('');

  const alignment = await run('alignment');
  log('## Выравнивание текста и модели');
  log(JSON.stringify(alignment, null, 2));
  log('');

  const selection = await run('selection');
  log('## Каретка и выделение');
  log(JSON.stringify(selection, null, 2));
  log(`снимок: ${await shot(win, '02-selection')}`);
  log('');

  const scroll = await run('scroll');
  log('## Прокрутка');
  log(JSON.stringify(scroll, null, 2));
  log(`снимок: ${await shot(win, '03-scrolled')}`);
  log('');

  const gutter = await run('fixedGutter');
  log('## Номера строк при прокрутке вбок');
  log(JSON.stringify(gutter, null, 2));
  log(`снимок: ${await shot(win, '04-horizontal')}`);
  log('');

  const highlight = await run('highlight');
  log('## Подсветка: роли токенов и цвета');
  log(JSON.stringify(highlight, null, 2));
  log(`снимок: ${await shot(win, '06-highlight')}`);
  log('');

  const decorations = await decorationsCheck(win);
  log('## Украшения строк');
  log(JSON.stringify(decorations, null, 2));
  log('');

  const find = await findCheck(win);
  log('## Панель поиска и замены');
  log(JSON.stringify(find, null, 2));
  log('');

  const assist = await assistCheck(win);
  log('## Подсказки и наведение');
  log(JSON.stringify(assist, null, 2));
  log('');

  const snippet = await snippetCheck(win);
  log('## Сниппеты');
  log(JSON.stringify(snippet, null, 2));
  log('');

  const host = await hostCheck(win);
  log('## Хозяин редактора: открытие, правки, курсоры');
  log(JSON.stringify(host, null, 2));
  log('');

  const workspace = await workspaceCheck(win);
  log('## Рабочее место: две панели');
  log(JSON.stringify(workspace, null, 2));
  log('');

  const diff = await diffCheck(win);
  log('## Сравнение версий и замечания ревью');
  log(JSON.stringify(diff, null, 2));
  log('');

  const commands = await commandsCheck(win);
  log('## Команды редактора');
  log(JSON.stringify(commands, null, 2));
  log('');

  const languageHover = await languageHoverCheck(win);
  log('## Наведение от языкового сервера');
  log(JSON.stringify(languageHover, null, 2));
  log('');

  const symbols = await symbolsCheck(win);
  log('## Переход к определению и ссылки');
  log(JSON.stringify(symbols, null, 2));
  log('');

  const signature = await signatureCheck(win);
  log('## Подсказка о параметрах вызова');
  log(JSON.stringify(signature, null, 2));
  log('');

  const problemPanel = await problemPanelCheck(win);
  log('## Панель проблем');
  log(JSON.stringify(problemPanel, null, 2));
  log('');

  const fold = await foldCheck(win);
  log('## Свёртка блоков');
  log(JSON.stringify(fold, null, 2));
  log('');

  const rainbow = await rainbowCheck(win);
  log('## Радужные скобки');
  log(JSON.stringify(rainbow, null, 2));
  log('');

  const rulers = await rulersCheck(win);
  log('## Направляющие столбцов (ruler)');
  log(JSON.stringify(rulers, null, 2));
  log('');

  const autoImport = await autoImportCheck(win);
  log('## Авто-импорт при подсказке');
  log(JSON.stringify(autoImport, null, 2));
  log('');

  const todo = await todoCheck(win);
  log('## Подсветка TODO/FIXME');
  log(JSON.stringify(todo, null, 2));
  log('');

  const inlay = await inlayCheck(win);
  log('## Подсказки-вставки (inlay hints)');
  log(JSON.stringify(inlay, null, 2));
  log('');

  const sticky = await stickyCheck(win);
  log('## Закреплённые заголовки (sticky scroll)');
  log(JSON.stringify(sticky, null, 2));
  log('');

  const whitespace = await whitespaceCheck(win);
  log('## Невидимые знаки (пробелы и табуляции)');
  log(JSON.stringify(whitespace, null, 2));
  log('');

  const ligatures = await ligaturesCheck(win);
  log('## Лигатуры шрифта');
  log(JSON.stringify(ligatures, null, 2));
  log('');

  const minimap = await minimapCheck(win);
  log('## Миникарта');
  log(JSON.stringify(minimap, null, 2));
  log(`снимок: ${await shot(win, '07-minimap')}`);
  log('');

  const wordWrap = await wordWrapCheck(win);
  log('## Перенос длинных строк (word wrap)');
  log(JSON.stringify(wordWrap, null, 2));
  log(`снимок: ${await shot(win, '08-wordwrap')}`);
  log('');

  const codeActions = await codeActionsCheck(win);
  log('## Быстрые исправления: Ctrl+.');
  log(JSON.stringify(codeActions, null, 2));
  log('');

  const inline = await inlineCheck(win);
  log('## Призрачная подсказка (inline-AI)');
  log(JSON.stringify(inline, null, 2));
  log('');

  const problemNavigation = await problemsCheck(win);
  log('## Переход по пометкам (F8)');
  log(JSON.stringify(problemNavigation, null, 2));
  log('');

  const border = await borderCheck(win);
  log('## Граница замены: F1 и отладочная подсказка');
  log(JSON.stringify(border, null, 2));
  log('');

  const lspCompletion = await lspCompletionCheck(win);
  const documentLinks = await documentLinksCheck(win);
  log('## Ссылки в коде (documentLink)');
  log(JSON.stringify(documentLinks, null, 2));
  log('');

  const linkedEditing = await linkedEditingCheck(win);
  log('## Связанные участки (linkedEditing)');
  log(JSON.stringify(linkedEditing, null, 2));
  log('');

  const semantic = await semanticCheck(win);
  log('## Семантическая подсветка (semanticTokens)');
  log(JSON.stringify(semantic, null, 2));
  log('');

  const inlineValues = await inlineValuesCheck(win);
  log('## Значения отладчика в строках (inlineValue)');
  log(JSON.stringify(inlineValues, null, 2));
  log('');

  const emmet = await emmetCheck(win);
  log('## Emmet по Tab');
  log(JSON.stringify(emmet, null, 2));
  log('');

  const spell = await spellcheckCheck(win);
  log('## Проверка орфографии');
  log(JSON.stringify(spell, null, 2));
  log('');

  const peek = await peekCheck(win);
  log('## Заглянуть в определение');
  log(JSON.stringify(peek, null, 2));
  log('');

  const semanticFold = await semanticFoldCheck(win);
  log('## Свёртка по грамматике (без сервера)');
  log(JSON.stringify(semanticFold, null, 2));
  log('');

  const surround = await surroundCheck(win);
  log('## Обёртка выделения (surround with)');
  log(JSON.stringify(surround, null, 2));
  log('');

  log('## Подсказки языкового сервера');
  log(JSON.stringify(lspCompletion, null, 2));
  log('');

  const ctrlClick = await ctrlClickCheck(win);
  log('## Ctrl+Click по слову');
  log(JSON.stringify(ctrlClick, null, 2));
  log('');

  // 7. Ввод настоящими клавишами и мышью: то, чего юнит-тесты не видят — связку
  // DOM-события с контроллером. Клавиши идут через Chromium, как от человека.
  const multicursor = await multicursorCheck(win);
  log('## Мультикурсор');
  log(JSON.stringify(multicursor, null, 2));
  log('');

  const typing = await typingCheck(win);
  log('## Ввод: клавиши и мышь');
  log(JSON.stringify(typing, null, 2));
  log(`снимок: ${await shot(win, '05-typing')}`);
  log('');

  const pageErrors = await run('errors');
  if (problems.length > 0) {
    log('## Консоль страницы');
    for (const message of problems) log(`- ${message}`);
    log('');
  }
  if (Array.isArray(pageErrors) && pageErrors.length > 0) {
    log('## Ошибки страницы (со стеком)');
    for (const message of pageErrors) log(`- ${message}`);
    log('');
  }

  await fs.writeFile(REPORT, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\n[проба] отчёт: ${REPORT}`);
  console.log(`[проба] снимки: ${SHOTS}`);

  win.destroy();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
}

app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.error('[проба] не удалось выполнить пробу:', error);
    app.exit(1);
  });
