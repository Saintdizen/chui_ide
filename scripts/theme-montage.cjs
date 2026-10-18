/**
 * Собрать сравнительный кадр: варианты темы рядом, с подписями.
 *
 *   npx electron scripts/theme-montage.cjs
 *
 * Читает PNG из `.chui_ide/probe-shots` и кладёт лист `theme-compare.png`:
 * варианты перекраски рядом — удобно выбирать оттенок, а не открывать файлы по
 * одному.
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
    ['theme-variant-dark-base.png', 'сейчас — серый и VS Code Dark+'],
    ['theme-variant-dark-neon.png', 'неон — фиолетовый мрак, розовый код'],
    ['theme-variant-dark-ocean.png', 'океан — бирюза, аква и песок'],
    ['theme-variant-dark-sunset.png', 'закат — вино и янтарь'],
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

const GROUPS = [['Тёмная', SETS.dark]];

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-theme-montage-'));
  const page = path.join(dir, 'theme.html');
  await fs.writeFile(page, html(GROUPS), 'utf8');

  const width = 380 * 4 + 40;
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
