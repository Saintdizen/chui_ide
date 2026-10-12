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
  virtual: `(() => {
    const view = window.probe.view;
    const buffer = window.probe.buffer;
    const rows = [...document.querySelectorAll('.own-editor-line')];
    const numbers = [...document.querySelectorAll('.own-editor-gutter-row')].map((n) => Number(n.textContent));
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
    const caret = root.querySelector('.own-editor-caret');
    const xAt = (line, column) => {
      const offset = buffer.lineStart(line) + column - 1;
      view.setSelection({ anchor: offset, active: offset });
      const matrix = caret.style.transform.match(/translate\\(([-\\d.]+)px/);
      return Number(matrix?.[1] ?? 'NaN');
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

  // 4. Каретка и выделение: каретка прячется при выделении, прямоугольники появляются.
  selection: `(() => {
    const view = window.probe.view;
    const root = document.querySelector('.own-editor');
    const caret = root.querySelector('.own-editor-caret');
    const rects = () => [...root.querySelectorAll('.own-editor-selection-rect')].map((node) => {
      const match = node.style.transform.match(/translate\\(([-\\d.]+)px,\\s*([-\\d.]+)px\\)/);
      return {
        x: Math.round(Number(match?.[1] ?? 'NaN')),
        y: Math.round(Number(match?.[2] ?? 'NaN')),
        w: Math.round(parseFloat(node.style.width)),
      };
    });
    view.setSelection({ anchor: 0, active: 0 });
    const пусто = { каретка: caret.style.display, прямоугольников: rects().length };
    // Выделение от конца третьей строки до столбца 6 четвёртой — две строки.
    view.setSelection({ anchor: 60, active: 140 });
    const итог = { каретка: caret.style.display, прямоугольников: rects().length, прямоугольники: rects() };
    return { пусто, выделение: итог };
  })()`,

  // 5. Прокрутка: вниз, к концу файла и вбок по длинной строке.
  // Событие `scroll` приходит асинхронно, поэтому после сдвига ждём кадр — иначе
  // прочтём ещё не перерисованный DOM и решим, что прокрутка не работает.
  scroll: `(async () => {
    const viewport = document.querySelector('.own-editor-viewport');
    const linesLayer = document.querySelector('.own-editor-lines');
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
    const numbers = () => [...document.querySelectorAll('.own-editor-gutter-row')].map((n) => Number(n.textContent));
    viewport.scrollTop = 4000;
    await frame();
    const вниз = { первая: numbers()[0], последняя: numbers().at(-1), прокрутка: viewport.scrollTop };
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
      полотно: Math.round(document.querySelector('.own-editor-content').getBoundingClientRect().width),
    };
    return { вниз, конец, вбок };
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
    const viewport = document.querySelector('.own-editor-viewport');
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
      return {
        видно: Boolean(panel) && !panel.hidden,
        заголовок: panel?.querySelector('.own-editor-hover-title')?.textContent ?? null,
        строки: [...(panel?.querySelectorAll('.own-editor-hover-body div') ?? [])].map((n) => n.textContent),
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
  await script(`(() => {
    const point = window.probe.view.clientPoint(6);
    window.probe.hover.showAt(6, point.left, point.top);
    return true;
  })()`);
  const afterDirect = await hoverState();

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
    движений_мыши: moves,
    наведение_координаты: hoverProbe,
    наведение_диагностика: await script('window.probe.hover.diagnostics'),
    наведение: afterHover,
    наведение_напрямую: afterDirect,
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

  const cleared = await script(`(() => {
    window.probe.view.setDecorations(null);
    const root = document.querySelector('.own-editor');
    return {
      значки: root.querySelectorAll('.own-editor-glyph-row > *').length,
      полоски: root.querySelectorAll('.own-editor-strip-row.change-gutter').length,
      фон: root.querySelectorAll('.own-editor-line-bg').length,
      подчёркивания: root.querySelectorAll('.own-editor-squiggly-rect').length,
      подписи: root.querySelectorAll('.blame-inline').length,
    };
  })()`);

  return { набор: applied, рисунок: drawing, снимок: shotDeco, цели: targets, клики: clicks, после_снятия: cleared };
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

  return { рисунок: drawing, снимок: shotDiff, встроенный_режим: inline, переходы: navigation, кнопка: clicking };
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
async function lspCompletionCheck(win) {
  const script = (expression) => win.webContents.executeJavaScript(expression);

  await script(`(() => {
    const { workspace, doc } = window.probeSymbols;
    workspace.reveal(doc.path, 1, 13);
    workspace.insertAtCursor('val');
    return true;
  })()`);
  await wait(120);

  const panel = await script(`(() => {
    const root = document.querySelector('#probe-symbols .own-editor-suggest');
    return {
      виден: root ? !root.hidden : false,
      строки: root ? [...root.querySelectorAll('.own-editor-suggest-item')].map((row) => ({
        подпись: row.querySelector('.own-editor-suggest-label')?.textContent ?? '',
        вид: (row.querySelector('.own-editor-suggest-detail')?.className ?? '').split(' ').pop() ?? '',
      })) : [],
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
  log('## Сравнение версий');
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
  log('## Подсказки языкового сервера');
  log(JSON.stringify(lspCompletion, null, 2));
  log('');

  const ctrlClick = await ctrlClickCheck(win);
  log('## Ctrl+Click по слову');
  log(JSON.stringify(ctrlClick, null, 2));
  log('');

  // 7. Ввод настоящими клавишами и мышью: то, чего юнит-тесты не видят — связку
  // DOM-события с контроллером. Клавиши идут через Chromium, как от человека.
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
