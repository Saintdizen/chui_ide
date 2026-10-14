/**
 * Проба: карточка наведения показывает ТЕКСТ пометки языка, а не только волну.
 * Случай, из-за которого проба и появилась: под словом волна, а что не так — не видно.
 *
 *   npm run probe:hoverproblems
 */
const { app, BrowserWindow } = require('electron');
const { promises: fs, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('rolldown');

const PROJECT = path.join(__dirname, '..');
const ENTRY = path.join(PROJECT, 'src/renderer/probe/editor-probe.ts');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageStyles() {
  const read = (relative) => readFileSync(path.join(PROJECT, relative), 'utf8');
  const fonts = read('src/renderer/styles/fonts.css').replace(
    /url\("([^"]+)"\)/g,
    (_m, href) => `url("${pathToFileURL(path.resolve(PROJECT, 'src/renderer/styles', href)).href}")`,
  );
  return [fonts, read('src/renderer/styles/theme.css'), read('src/renderer/styles/editor.css')].join('\n');
}

const pageHtml = (styles) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8" />
<style>${styles}</style>
<style>html, body { margin: 0; height: 100%; background: var(--surface_window); } #probe-root { height: 100%; }</style>
</head><body><div id="probe-root"></div><script src="./bundle.js"></script></body></html>`;

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-hoverprob-'));
  const bundle = path.join(dir, 'bundle.js');
  await build({
    input: ENTRY,
    platform: 'browser',
    output: { file: bundle, format: 'iife', sourcemap: false },
    logLevel: 'silent',
  });
  await fs.writeFile(path.join(dir, 'index.html'), pageHtml(pageStyles()), 'utf8');

  const win = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { sandbox: true } });
  await win.loadFile(path.join(dir, 'index.html'));
  await wait(3000);

  const script = (expression) => win.webContents.executeJavaScript(expression);

  // Кладём одну пометку на первый знак первой строки и наводим туда карточку напрямую
  // (то же, что делает мышь, но без ожидания паузы и без координат события).
  await script(`(() => {
    const { hover, buffer, hoverProblems } = window.probe;
    hoverProblems.length = 0;
    hoverProblems.push({ line: 1, column: 1, endColumn: 3, severity: 'error', message: 'текст ошибки из пометки', source: 'pyright' });
    hover.showAt(buffer.lineStart(1), 40, 40);
    return true;
  })()`);
  // Ждём ответ внешнего источника: он приходит асинхронно и раньше ЗАТИРАЛ текст ошибки.
  await wait(600);

  const state = await script(`(() => {
    const panel = document.querySelector('.own-editor-hover');
    return {
      видно: Boolean(panel) && !panel.hidden,
      заголовок: panel?.querySelector('.own-editor-hover-title')?.textContent ?? null,
      строки: [...(panel?.querySelectorAll('.own-editor-hover-body div') ?? [])].map((n) => n.textContent),
    };
  })()`);

  console.log(`[карточка видно] ${state.видно}`);
  console.log(`[заголовок] ${JSON.stringify(state.заголовок)}`);
  console.log(`[строки] ${JSON.stringify(state.строки)}`);
  const ok =
    state.видно &&
    String(state.заголовок).includes('Ошибка') &&
    state.строки.some((line) => line.includes('текст ошибки из пометки'));
  console.log(ok ? '  ok   текст пометки показан' : '  ПЛОХО текст пометки не показан');

  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(ok ? '[chui] текст пометки виден в карточке' : '[chui] ошибка');
  app.exit(ok ? 0 : 1);
});
