/**
 * Проба-меню вариантов темы: одно живое окно IDE, а в нём по очереди — несколько
 * наборов поверхностей, и на каждый свой снимок.
 *
 *   npx electron scripts/theme-variants.cjs
 *
 * Так «на глаз» видно, какая ступень подъёма комфортнее, без правки исходников
 * и пересборки: токены подставляются на корень документа (`:root`) прямо в окне —
 * компоненты берут их переменными и перекрашиваются сами.
 *
 * Снимки — `.chui_ide/probe-shots/theme-variant-<имя>.png`, сводка — в консоль.
 */
const { app, nativeTheme } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

const PROJECT = path.join(__dirname, '..');
const SHOTS = path.join(PROJECT, '.chui_ide', 'probe-shots');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`[проба] ${text}`);

registerAppScheme();

/** Лестница высоты: окно → содержимое/полотно → попап. */
const VARIANTS = [
  ['ramp-dark-0', 'dark', { window: '#161618', content: '#1e1e1e' }],
  ['ramp-dark-1', 'dark', { window: '#19191c', content: '#212125' }],
  ['ramp-dark-2', 'dark', { window: '#1d1d20', content: '#252528' }],
  ['ramp-dark-3', 'dark', { window: '#202024', content: '#28282d' }],
  ['ramp-dark-4', 'dark', { window: '#242429', content: '#2c2c32' }],
  ['ramp-light-0', 'light', { window: '#ececec', content: '#ffffff' }],
  ['ramp-light-1', 'light', { window: '#e8e8eb', content: '#f9f9fb' }],
  ['ramp-light-2', 'light', { window: '#e4e4e7', content: '#f5f5f7' }],
  ['ramp-light-3', 'light', { window: '#e0e0e3', content: '#f3f3f5' }],
  ['ramp-light-4', 'light', { window: '#dcdce0', content: '#f1f1f3' }],
];

async function writeDemoProject(dir) {
  const files = {
    'src/main.ts': `/** Точка входа демонстрации. */
import { helper } from './helper';

const GREETING: string = 'привет';
const MAX_COUNT = 42;

export function greet(name: string): string {
  // Собираем приветствие из частей.
  const parts = [GREETING, name, String(MAX_COUNT)];
  if (name.length > 3) return helper(parts.join(', '));
  return parts[0];
}
`,
    'src/helper.ts': `export function helper(value: string): string {\n  return value.toUpperCase();\n}\n`,
    'README.md': '# Демонстрация\n\nПроект для съёмки темы.\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, contents, 'utf8');
  }
}

const SET_TOKENS = (tokens) => `(() => {
  const root = document.documentElement.style;
  const t = ${JSON.stringify(tokens)};
  for (const [name, value] of Object.entries(t)) root.setProperty(name, value);
  return Object.fromEntries(Object.entries(t));
})()`;

const TOKENS_FOR = (v) => ({
  '--surface_window': v.window,
  '--surface_content': v.content,
  '--main_background': v.window,
  '--element_background_2': v.content,
  '--editor_background': v.content,
  '--editor_terminal_background': v.content,
});

const hex = (r, g, b) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Средняя яркость и цвет зоны кадра. */
function zone(bitmap, width, x0, y0, x1, y1) {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let y = y0; y < y1; y += 3) {
    for (let x = x0; x < x1; x += 3) {
      const o = (y * width + x) * 4;
      r += bitmap[o + 2];
      g += bitmap[o + 1];
      b += bitmap[o];
      n += 1;
    }
  }
  return hex(Math.round(r / n), Math.round(g / n), Math.round(b / n));
}

app.whenReady().then(async () => {
  await fs.mkdir(SHOTS, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-theme-variants-'));
  const project = path.join(dir, 'demo');
  await writeDemoProject(project);

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(3500);

  const rows = [];
  for (const [name, scheme, surf] of VARIANTS) {
    nativeTheme.themeSource = scheme;
    await wait(500);
    await ide.webContents.executeJavaScript(SET_TOKENS(TOKENS_FOR(surf))).catch(() => undefined);
    await ide.webContents
      .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
      .catch(() => undefined);
    const image = await ide.capturePage();
    const file = path.join(SHOTS, `theme-variant-${name}.png`);
    await fs.writeFile(file, image.toPNG());
    const { width, height } = image.getSize();
    const bmp = image.toBitmap();
    rows.push({
      name,
      scheme,
      окно: surf.window,
      полотно: surf.content,
      шапка: zone(bmp, width, 0, 0, width, 36),
      панель: zone(bmp, width, 0, 40, 260, height - 30),
      редактор: zone(bmp, width, 280, 60, width - 20, height - 60),
      file,
    });
    step(`${name} снят`);
  }

  console.log('\nвариант   схема  окно      полотно   шапка     панель    редактор');
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(9)} ${r.scheme.padEnd(6)} ${r.окно}  ${r.полотно}  ${r.шапка}  ${r.панель}  ${r.редактор}`,
    );
  }
  console.log(`\nСнимки: ${SHOTS}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
