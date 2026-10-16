/**
 * Собрать сравнительный кадр: варианты темы рядом, с подписями.
 *
 *   npx electron scripts/theme-montage.cjs
 *
 * Читает PNG из `.chui_ide/probe-shots` и кладёт два листа —
 * `theme-compare-dark.png` и `theme-compare-light.png`: удобно смотреть
 * ступени подъёма рядом, а не открывая файлы по одному.
 */
const { app, BrowserWindow } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PROJECT = path.join(__dirname, '..');
const SHOTS = path.join(PROJECT, '.chui_ide', 'probe-shots');

const SETS = {
  dark: [
    ['theme-variant-ramp-dark-0.png', 'БЫЛО   окно #161618 / полотно #1e1e1e'],
    ['theme-variant-ramp-dark-1.png', 'шаг 1  окно #19191c / полотно #212125'],
    ['theme-variant-ramp-dark-2.png', 'ВЫБРАНО окно #1d1d20 / полотно #252528'],
    ['theme-variant-ramp-dark-3.png', 'шаг 3  окно #202024 / полотно #28282d'],
    ['theme-variant-ramp-dark-4.png', 'плотнее окно #242429 / полотно #2c2c32'],
  ],
  light: [
    ['theme-variant-ramp-light-0.png', 'БЫЛО   окно #ececec / полотно #ffffff'],
    ['theme-variant-ramp-light-1.png', 'шаг 1  окно #e8e8eb / полотно #f9f9fb'],
    ['theme-variant-ramp-light-2.png', 'ВЫБРАНО окно #e4e4e7 / полотно #f5f5f7'],
    ['theme-variant-ramp-light-3.png', 'шаг 3  окно #e0e0e3 / полотно #f3f3f5'],
    ['theme-variant-ramp-light-4.png', 'плотнее окно #dcdce0 / полотно #f1f1f3'],
  ],
};

const html = (groups) => `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; background: #101014; font: 13px system-ui, sans-serif; color: #eee; }
  h2 { margin: 10px 10px 0; font: 600 15px system-ui, sans-serif; }
  .row { display: flex; gap: 8px; padding: 8px 10px; align-items: flex-start; }
  figure { margin: 0; flex: 0 0 auto; }
  img { width: 360px; display: block; border: 1px solid #444; }
  figcaption { padding: 4px 2px; }
</style>
<body>
${groups
  .map(
    ([title, tiles]) =>
      `<h2>${title}</h2><div class="row">${tiles
        .map(
          ([file, label]) =>
            `<figure><img src="${pathToFileURL(path.join(SHOTS, file)).href}"><figcaption>${label}</figcaption></figure>`,
        )
        .join('')}</div>`,
  )
  .join('')}
</body>`;

const GROUPS = [
  ['Тёмная', SETS.dark],
  ['Светлая', SETS.light],
];

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-theme-montage-'));
  const page = path.join(dir, 'theme.html');
  await fs.writeFile(page, html(GROUPS), 'utf8');

  const width = 380 * 5 + 40;
  const height = 2 * 300 + 120;
  const win = new BrowserWindow({ width, height, show: true, paintWhenInitiallyHidden: true });
  await win.loadFile(page).catch((error) => console.log(`[монт] загрузка: ${error.message}`));
  await win.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 300))))',
  );
  const image = await win.capturePage();
  const file = path.join(SHOTS, 'theme-compare.png');
  await fs.writeFile(file, image.toPNG());
  console.log(`[монт] снимок ${file}`);
  win.destroy();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
