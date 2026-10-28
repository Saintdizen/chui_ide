/*
 * Проба места попапа подсказок: совпадает ли РАСЧЁТ якоря с тем, что нарисовано.
 *
 *   npx electron scripts/suggest-place-probe.cjs
 *
 * Юнит-тесты верят переданному якорю. А якорь считает вид (`clientPoint`) — и врёт,
 * если строка каретки ещё не разложена: X берётся из замеров строки (`offsetsFor`),
 * а у неразложенной строки массив пуст → X схлопывается в 0, и попап встаёт к левому
 * краю полотна, а не к каретке. Здесь это видно числом: расчёт против прямоугольника
 * настоящего узла `.own-editor-carets > *` в живом Chromium.
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
const REPORT = path.join(OUT_DIR, 'probe-suggest-place.txt');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageStyles() {
  const read = (relative) => readFileSync(path.join(PROJECT, relative), 'utf8');
  const fonts = read('src/renderer/styles/fonts.css').replace(/url\("([^"]+)"\)/g, (_match, href) => {
    const absolute = path.resolve(PROJECT, 'src/renderer/styles', href);
    return `url("${pathToFileURL(absolute).href}")`;
  });
  const theme = read('src/renderer/styles/theme.css');
  const editor = read('src/renderer/styles/editor.css');
  const chrome = read('src/renderer/styles/chrome.css');
  return [fonts, theme, editor, chrome].join('\n');
}

function pageHtml(styles) {
  return `<!doctype html>
<html lang="ru">
  <head><meta charset="utf-8" /><style>${styles}</style>
  <style>html, body { margin: 0; height: 100vh; overflow: hidden; }
  #probe-root { height: 100vh; overflow: hidden; position: relative; }</style></head>
  <body><div class="app"><div class="editor-panes"><div class="editor-pane" id="probe-root"></div></div></div><script src="./bundle.js"></script></body>
</html>`;
}

async function prepare() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-suggest-probe-'));
  const bundle = path.join(dir, 'bundle.js');
  await build({
    input: ENTRY,
    platform: 'browser',
    output: { file: bundle, format: 'iife', sourcemap: false },
    logLevel: 'silent',
  });
  await fs.writeFile(path.join(dir, 'index.html'), pageHtml(pageStyles()), 'utf8');
  return path.join(dir, 'index.html');
}

/**
 * Замер: расчётная точка каретки против нарисованного прямоугольника.
 * Прокрутку и место задаём снаружи — сценарий бага живёт на прокрутке.
 */
const MEASURE = (scrollTop, line, column) => `(async () => {
  const view = window.probe.view;
  const buffer = window.probe.buffer;
  const root = view.element;
  const viewport = root.querySelector('.own-editor-viewport');
  viewport.scrollTop = ${scrollTop};
  const offset = buffer.lineStart(${line}) + ${column};
  view.setSelection({ anchor: offset, active: offset });
  // Слой кареток пересобирается на каждое движение — берём узел ПОСЛЕ выделения.
  // Каретка едет переходом (transition: transform 70ms) — сразу после выделения её
  // прямоугольник ещё старый. Ждём, пока доедет, иначе меряем прошлое место.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const node = root.querySelector('.own-editor-carets > *');
  const rect = node ? node.getBoundingClientRect() : null;
  const point = view.clientPoint(offset);
  // Теперь ровно то, что делает виджет: якорь — та же точка, показ — через тот же API.
  window.probe.suggest.show([{ label: 'self', detail: 'класс', kind: 7 }], point, 1);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const popup = document.querySelector('.own-editor-suggest');
  const popupRect = popup ? popup.getBoundingClientRect() : null;
  // Кто виноват, если попап не там: ближайший предок с собственной системой координат.
  const ловушки = [];
  for (let node = popup?.parentElement; node; node = node.parentElement) {
    const css = getComputedStyle(node);
    if (css.transform !== 'none' || css.filter !== 'none' || css.contain !== 'none' || css.willChange !== 'auto') {
      const rect = node.getBoundingClientRect();
      ловушки.push({ узел: node.className || node.tagName, contain: css.contain, transform: css.transform,
        фильтр: css.filter, willChange: css.willChange, лево: Math.round(rect.left), верх: Math.round(rect.top) });
    }
  }
  return {
    прокрутка: viewport.scrollTop,
    строка: ${line},
    столбец: ${column},
    вид: { left: Math.round(point.left), top: Math.round(point.top) },
    каретка: rect ? { left: Math.round(rect.left), top: Math.round(rect.top) } : null,
    разница: rect ? { left: Math.round(point.left - rect.left), top: Math.round(point.top - rect.top) } : null,
    попап: popupRect ? { left: Math.round(popupRect.left), top: Math.round(popupRect.top) } : null,
    попапСдвиг: popupRect ? { left: Math.round(popupRect.left - point.left), top: Math.round(popupRect.top - point.bottom) } : null,
    ловушки,
  };
})()`;

async function main() {
  const page = await prepare();
  const win = new BrowserWindow({
    width: 1000,
    height: 640,
    show: true,
    backgroundColor: '#161618',
    webPreferences: { sandbox: false, backgroundThrottling: false },
  });
  const problems = [];
  win.webContents.on('console-message', (event, _level, message) => {
    const text = typeof message === 'string' ? message : (event?.message ?? '');
    if (String(text).trim()) problems.push(String(text).trim());
  });
  await win.loadFile(page);
  await wait(1200);

  const run = (code) => win.webContents.executeJavaScript(code).catch((error) => ({ ошибка: String(error) }));
  // Без прокрутки — заведомо верный случай; с прокруткой — тот, что видит человек.
  const безПрокрутки = await run(MEASURE(0, 5, 10));
  const сПрокруткой = await run(MEASURE(400, 40, 10));
  const внеЭкрана = await run(MEASURE(4000, 40, 10));

  const явка = [
    ['без прокрутки', безПрокрутки],
    ['прокрутка 400', сПрокруткой],
  ];
  const беды = [];
  for (const [имя, замер] of явка) {
    if (замер.разница === null) беды.push(`${имя}: каретка не нарисована`);
    else if (Math.abs(замер.разница.left) > 1 || Math.abs(замер.разница.top) > 1) {
      беды.push(`${имя}: якорь мимо каретки на ${JSON.stringify(замер.разница)}`);
    }
    if (замер.попапСдвиг === null) беды.push(`${имя}: попап не показан`);
    else if (Math.abs(замер.попапСдвиг.left) > 1 || Math.abs(замер.попапСдвиг.top - 2) > 1) {
      беды.push(`${имя}: попап не под кареткой: ${JSON.stringify(замер.попапСдвиг)}`);
    }
  }

  const lines = [
    'Проба места попапа подсказок: расчёт якоря против нарисованной каретки.',
    '',
    `без прокрутки: ${JSON.stringify(безПрокрутки)}`,
    `прокрутка 400: ${JSON.stringify(сПрокруткой)}`,
    `прокрутка 4000 (каретка вне экрана): ${JSON.stringify(внеЭкрана)}`,
    '',
    беды.length === 0 ? 'итог: якорь и попап на месте.' : `итог: беды —\n${беды.join('\n')}`,
    problems.length > 0 ? `\nсообщения страницы:\n${problems.join('\n')}` : '',
  ];
  await fs.writeFile(REPORT, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  win.destroy();
  app.exit(беды.length === 0 ? 0 : 1);
}

app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.error('[проба] сорвалась:', error);
    app.exit(1);
  });
