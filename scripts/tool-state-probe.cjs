/**
 * Проба состояния вызова инструмента: чем помечен итог в ленте действий.
 *
 *   npm run probe:toolstate
 *
 * Раньше состояние было словом («готово» / «ошибка» / «выполняется»). Теперь это
 * значки: галочка в круге, крест в круге и вращающийся круг. Проба проверяет ровно
 * то, что не видно в юнит-тестах, — что значок нарисован, покрашен по смыслу и
 * крутится у «в работе»; и снимает PNG, чтобы вид было чем посмотреть глазами.
 *
 * Отчёт — `.chui_ide/probe-toolstate.txt`, снимки — `.chui_ide/probe-shots/`.
 */
const { BrowserWindow } = require('electron');
const { promises: fs, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');
const { build } = require('rolldown');

const PROJECT = path.join(__dirname, '..');
const ENTRY = path.join(PROJECT, 'src/renderer/probe/tool-state-probe.ts');
const OUT_DIR = path.join(PROJECT, '.chui_ide');
const SHOTS = path.join(OUT_DIR, 'probe-shots');
const REPORT = path.join(OUT_DIR, 'probe-toolstate.txt');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Оформление страницы: настоящие токены темы и настоящий шрифт интерфейса. */
function pageStyles() {
  const read = (relative) => readFileSync(path.join(PROJECT, relative), 'utf8');
  const fonts = read('src/renderer/styles/fonts.css').replace(/url\("([^"]+)"\)/g, (_match, href) => {
    const absolute = path.resolve(PROJECT, 'src/renderer/styles', href);
    return `url("${pathToFileURL(absolute).href}")`;
  });
  return [fonts, read('src/renderer/styles/theme.css'), read('src/renderer/styles/main.css')].join('\n');
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
      #probe-root { padding: 24px; }
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-toolstate-'));
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
  const file = path.join(SHOTS, `toolstate-${name}.png`);
  await fs.writeFile(file, image.toPNG());
  return file;
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
  // странице (`executeJavaScript`) повисают — проба на этом и вставала.
  const win = new BrowserWindow({ width: 760, height: 420 });
  await win.loadFile(page);
  await wait(600);

  const state = (selector) =>
    win.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('${selector}');
      if (!node) return null;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const icon = node.querySelector('.icon');
      return {
        текст: node.textContent,
        значок: icon ? icon.tagName.toLowerCase() : null,
        цвет: style.color,
        анимация: getComputedStyle(icon ?? node).animationName,
        ширина: Math.round(box.width),
        высота: Math.round(box.height),
        подсказка: node.title,
        озвучка: node.getAttribute('aria-label'),
      };
    })()`);

  // Состояния строк берём по классам: две отработали, одна ещё идёт. Группу
  // раскрывает сама страница пробы — пробнику кликать не нужно.
  const report = {
    строка_готово: await state('.tool-state.is-ok'),
    строка_ошибка: await state('.tool-state.is-fail'),
    строка_выполняется: await state('.tool-state.is-running'),
    // Пока один вызов идёт, у всей группы состояние «в работе» — это верно.
    группа_во_время: await state('.tool-group-state'),
    снимок_строк: await shot(win, 'rows'),
  };

  // Завершаем оставшийся вызов: группа должна стать «готово» (ошибок нет — есть
  // крест у одной строки, но это отдельный вызов, а не итог группы).
  await win.webContents.executeJavaScript(`(() => {
    window.probeTools.running.finish({ id: 'run', name: 'search', ok: true, summary: 'готово', detail: 'found' });
    return true;
  })()`);
  await wait(120);
  report.группа_после = await state('.tool-group-state');
  report.счётчик_в_шапке = await win.webContents.executeJavaScript(
    `document.querySelector('.tool-group-tools').textContent`,
  );
  report.снимок_группы = await shot(win, 'group');
  report.текст_найден_в_разметке = await win.webContents.executeJavaScript(
    `document.body.textContent.includes('готово') || document.body.textContent.includes('ошибка')`,
  );

  await fs.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[проба] отчёт: ${REPORT}`);
  console.log(`[проба] снимок: ${report.снимок_группы}`);
}
