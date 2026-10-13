/**
 * Проба своего терминала: сетка, цвета, широкие знаки, лигатуры, курсор, выделение,
 * мышь и поиск.
 *
 *   npm run probe:own-terminal
 *
 * Проба гоняет НАСТОЯЩИЙ движок (`src/renderer/terminal`) в настоящем окне и меряет то,
 * чего не видно в юнит-тестах: что строки нарисованы, что цвет попал на знак, что
 * широкий знак занял две клетки, что курсор стоит в клетке курсора, что подсветка
 * выделения и поиска появляется, а события мыши уходят наружу. Заодно снимает PNG —
 * вид есть чем посмотреть глазами.
 *
 * Отчёт — `.chui_ide/probe-own-terminal.txt`, снимки — `.chui_ide/probe-shots/`.
 */
const { BrowserWindow, app } = require('electron');
const { promises: fs, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('rolldown');

const PROJECT = path.join(__dirname, '..');
const ENTRY = path.join(PROJECT, 'src/renderer/probe/terminal-probe.ts');
const OUT_DIR = path.join(PROJECT, '.chui_ide');
const SHOTS = path.join(OUT_DIR, 'probe-shots');
const REPORT = path.join(OUT_DIR, 'probe-own-terminal.txt');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Оформление страницы: настоящие токены темы, шрифт кода и стили терминала. */
function pageStyles() {
  const read = (relative) => readFileSync(path.join(PROJECT, relative), 'utf8');
  const fonts = read('src/renderer/styles/fonts.css').replace(/url\("([^"]+)"\)/g, (_match, href) => {
    const absolute = path.resolve(PROJECT, 'src/renderer/styles', href);
    return `url("${pathToFileURL(absolute).href}")`;
  });
  return [
    fonts,
    read('src/renderer/styles/theme.css'),
    read('src/renderer/styles/main.css'),
    read('src/renderer/styles/terminal.css'),
  ].join('\n');
}

function pageHtml(styles) {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="dark light" />
    <style>${styles}</style>
    <style>
      html, body { margin: 0; height: 100%; background: var(--surface_window); color: var(--text_color); }
      #probe-root { width: 720px; height: 320px; margin: 24px; }
    </style>
  </head>
  <body>
    <div id="probe-root"></div>
    <script src="./bundle.js"></script>
  </body>
</html>`;
}

async function prepare() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(SHOTS, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-ownterm-'));
  await build({
    input: ENTRY,
    platform: 'browser',
    output: { file: path.join(dir, 'bundle.js'), format: 'iife', sourcemap: false },
    logLevel: 'silent',
  });
  await fs.writeFile(path.join(dir, 'index.html'), pageHtml(pageStyles()), 'utf8');
  return { page: path.join(dir, 'index.html') };
}

/** Снять окно после отрисовки двух кадров (иначе `capturePage` вернёт прежний кадр). */
async function settle(win) {
  await win.webContents
    .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
    .catch(() => undefined);
}

async function shot(win, name) {
  await settle(win);
  const image = await Promise.race([win.capturePage(), wait(10000).then(() => null)]);
  if (!image) return 'кадр не получен';
  const file = path.join(SHOTS, `own-terminal-${name}.png`);
  await fs.writeFile(file, image.toPNG());
  return file;
}

/** Прогнать в окне выражение и вернуть его результат. */
function evaluate(win, expression) {
  return win.webContents.executeJavaScript(expression);
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    console.error('[проба] сбой:', error);
  } finally {
    app.exit(0);
  }
});

async function main() {
  const { page } = await prepare();
  // Окно показываем: в скрытом окне Chromium придерживает рендерер, и запросы к
  // странице (`executeJavaScript`) повисают — проба на этом и вставала бы.
  const win = new BrowserWindow({ width: 800, height: 420 });
  await win.loadFile(page);
  await wait(700);
  // Курсор виден только при фокусе (`renderCursor`) — фокус переносим на полотно.
  win.focus();
  win.webContents.focus();
  await evaluate(win, `(() => { document.querySelector('.own-term')?.focus(); return true; })()`);
  await wait(80);

  const report = {};

  // ── сетка, цвета, метрики, курсор ─────────────────────────────────────────────
  Object.assign(
    report,
    await evaluate(
      win,
      `(() => {
        const root = document.querySelector('.own-term');
        const rows = [...document.querySelectorAll('.own-term-row')];
        const ordered = rows
          .map((node) => ({ text: node.textContent, top: parseFloat(getComputedStyle(node).transform.split(',')[5]) || 0 }))
          .sort((a, b) => a.top - b.top)
          .map((item) => item.text);

        const firstRow = rows[0];
        const spans = firstRow ? [...firstRow.querySelectorAll('span')] : [];
        const colored = spans.find((span) => getComputedStyle(span).color && span.textContent.trim().length > 0);
        const bold = spans.find((span) => span.classList.contains('is-bold'));
        const underline = document.querySelector('.own-term-row .is-underline');
        const colorVar1 = getComputedStyle(root).getPropertyValue('--own-term-c1').trim();
        const colorVarBg = getComputedStyle(root).getPropertyValue('--own-term-bg').trim();
        const charWidth = parseFloat(getComputedStyle(root).getPropertyValue('--own-term-char-width'));
        const lineHeight = parseFloat(getComputedStyle(root).getPropertyValue('--own-term-line-height'));

        const cursor = document.querySelector('.own-term-cursor');
        const cursorBox = cursor ? cursor.getBoundingClientRect() : null;
        const rootBox = root ? root.getBoundingClientRect() : null;
        const model = window.probeTerm.term;
        const cursorVisible = cursor ? getComputedStyle(cursor).display !== 'none' : false;

        return {
          строк_нарисовано: rows.length,
          строки: ordered.filter((text) => text.trim().length > 0),
          ширина_клетки: charWidth,
          высота_строки: lineHeight,
          цвет_знака: colored ? getComputedStyle(colored).color : null,
          есть_жирный: Boolean(bold),
          есть_подчёркивание: Boolean(underline),
          var_c1: colorVar1,
          var_bg: colorVarBg,
          фон_полотна: getComputedStyle(root).backgroundColor,
          модель_курсор: model.cursor,
          курсор_виден: cursorVisible,
          курсор_сдвиг_x: cursorBox && rootBox ? Math.round(cursorBox.left - rootBox.left) : null,
          курсор_сдвиг_y: cursorBox && rootBox ? Math.round(cursorBox.top - rootBox.top) : null,
          курсор_ожидание_x: Math.round(model.cursor.x * charWidth),
          курсор_ожидание_y: Math.round(model.cursor.y * lineHeight),
          лигатуры_включены: root.classList.contains('is-ligatures'),
        };
      })()`,
    ),
  );

  report.снимок = await shot(win, 'grid');

  // ── лигатуры ──────────────────────────────────────────────────────────────────
  await evaluate(win, `(() => { window.probeTerm.setLigatures(true); return true; })()`);
  await wait(80);
  report.лигатуры_после_включения = await evaluate(
    win,
    `document.querySelector('.own-term').classList.contains('is-ligatures')`,
  );
  report.снимок_лигатур = await shot(win, 'ligatures');

  // ── светлая схема ─────────────────────────────────────────────────────────────
  await evaluate(win, `(() => { window.probeTerm.setScheme('light'); return true; })()`);
  await wait(80);
  report.светлая_схема_фон = await evaluate(
    win,
    `getComputedStyle(document.querySelector('.own-term')).backgroundColor`,
  );
  await evaluate(win, `(() => { window.probeTerm.setScheme('dark'); return true; })()`);

  // ── выделение: настоящая протяжка мышью ───────────────────────────────────────
  report.выделение = await evaluate(
    win,
    `(() => {
      const root = document.querySelector('.own-term');
      const box = root.getBoundingClientRect();
      const fire = (type, cx, cy) => {
        const buttons = type === 'mouseup' ? 0 : 1;
        root.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: cx, clientY: cy, button: 0, buttons }));
      };
      fire('mousedown', box.left + 2, box.top + 2);
      fire('mousemove', box.left + 60, box.top + 42);
      fire('mouseup', box.left + 60, box.top + 42);
      const rects = document.querySelectorAll('.own-term-selection-rect').length;
      return { прямоугольников: rects, текст: window.probeTerm.view.selectedText() };
    })()`,
  );
  report.снимок_выделения = await shot(win, 'selection');

  // ── поиск: подсветка совпадений и шаг по ним ──────────────────────────────────
  report.поиск = await evaluate(
    win,
    `(() => {
      const found = window.probeTerm.find('готово');
      const rects = document.querySelectorAll('.own-term-search-rect').length;
      const current = document.querySelectorAll('.own-term-search-rect.is-current').length;
      const step = window.probeTerm.findStep(1);
      return { найдено: found.count, прямоугольников: rects, текущий: current, шаг: step };
    })()`,
  );
  report.снимок_поиска = await shot(win, 'search');
  await evaluate(win, `(() => { window.probeTerm.clearFind(); return true; })()`);

  // ── reflow: сжимаем полотно и повторяем то, что делает панель при resize ──
  report.reflow = await evaluate(
    win,
    `(() => {
      const view = window.probeTerm.view;
      const term = window.probeTerm.term;
      const snapshot = () => {
        let letters = 0;
        for (let row = 0; row < view.bufferRows(); row += 1) {
          letters += view.lineText(row).split(' ').join('').length;
        }
        return { letters, cols: term.cols };
      };
      const before = snapshot();
      const host = document.querySelector('.own-term').parentElement;
      host.style.width = '260px';
      const size = view.fit();
      if (size) term.resize(size.cols, size.rows);
      view.render();
      const after = snapshot();
      host.style.width = '100%';
      const back = view.fit();
      if (back) term.resize(back.cols, back.rows);
      view.render();
      return {
        ширина_до: before.cols,
        ширина_после: after.cols,
        знаков_до: before.letters,
        знаков_после: after.letters,
        содержимое_сбережено: before.letters === after.letters,
      };
    })()`,
  );
  report.снимок_reflow = await shot(win, 'reflow');

  // ── мышь для программы: событие должно уйти наружу ────────────────────────────
  report.мышь_программе = await evaluate(
    win,
    `(() => {
      const term = window.probeTerm.term;
      term.write('\\x1b[?1000h\\x1b[?1006h');
      const root = document.querySelector('.own-term');
      const box = root.getBoundingClientRect();
      root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: box.left + 30, clientY: box.top + 30, button: 0, buttons: 1 }));
      return {
        режим: term.mouseTracking,
        sgr: term.mouseSgr,
        событий: window.probeTerm.mouseEvents.length,
        последнее: window.probeTerm.mouseEvents.at(-1),
      };
    })()`,
  );

  await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[проба] отчёт: ${REPORT}`);
  console.log(`[проба] снимок: ${report.снимок}`);
}
