/**
 * Проба: подсказка после точки у НАЗВАННОГО класса в настоящем Chromium.
 * Случай живого проекта: `self.Elements.ba` должен дать `back_to_old_design`.
 *
 *   npm run probe:namedmembers
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-named-'));
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

  await script(`(() => {
    const { controller, buffer } = window.probe;
    const text = ['class MosMain:', '    class Elements:', '        back_to_old_design = 1', '        lk_button = 2', '', '    def enter_lk(self):', '        '].join('\\n');
    controller.applyEdits([{ start: 0, removed: buffer.getText(), inserted: text }]);
    const end = buffer.length;
    controller.selectRange(end, end);
    controller.type('self.Elements.ba');
    window.probe.input.focus();
    return true;
  })()`);
  await wait(400);

  const state = await script(`(() => {
    const panel = document.querySelector('.own-editor-suggest');
    const rows = [...document.querySelectorAll('.own-editor-suggest-item')];
    const caret = window.probe.controller.caret;
    const buffer = window.probe.buffer;
    const line = buffer.lineAt(caret);
    return {
      видно: Boolean(panel) && !panel.hidden,
      подписи: rows.map((row) => row.querySelector('.own-editor-suggest-label').textContent),
      строка: buffer.lineText(line),
      диаг: window.probe.assistant ? window.probe.assistant.diagnostics : null,
    };
  })()`);

  console.log(`[попап видно] ${state.видно}`);
  console.log(`[строка] ${JSON.stringify(state.строка)}`);
  console.log(`[диагностика] ${JSON.stringify(state.диаг)}`);
  console.log(`[подписи] ${JSON.stringify(state.подписи)}`);
  const ok = state.видно && state.подписи.includes('back_to_old_design');
  console.log(ok ? '  ok   back_to_old_design в списке' : '  ПЛОХО back_to_old_design НЕ найден');

  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(ok ? '[chui] члены названного класса работают' : '[chui] ошибка');
  app.exit(ok ? 0 : 1);
});
