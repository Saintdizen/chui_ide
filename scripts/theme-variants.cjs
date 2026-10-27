/**
 * Проба-меню перекрасок темы: одно живое окно IDE, а в нём по очереди — несколько
 * вариантов палитры, и на каждый свой снимок.
 *
 *   npx electron scripts/theme-variants.cjs
 *
 * Так «на глаз» видно, какой оттенок поверхностей и акцента комфортнее, без правки
 * исходников и пересборки: токены подставляются на корень документа (`:root`) прямо
 * в окне — компоненты берут их переменными и перекрашиваются сами.
 *
 * Снимки — `.chui_ide/probe-shots/theme-variant-<имя>.png`, сводка — в консоль.
 */
const { app } = require('electron');
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

/**
 * Перекраски: не «чуть холоднее / чуть теплее», а своя краска у всего сразу.
 * Поверхности получают оттенок, акцент едет вместе с ними, и подсветка кода
 * переезжает в ту же гамму: код занимает большую часть кадра, и если оставить
 * его прежним, перекраска видна только в углу окна.
 *
 * Роли токенов те же, что в `core/theme.ts`: comment, string, number, keyword,
 * keywordControl, identifier, function, type, constant, tag, attribute. Цвета здесь
 * уже итоговые (в исходниках их дополнительно поднимает `vivid()`), поэтому
 * контраст каждой пары «токен на полотне» считается тут же и идёт в сводку.
 *
 * `base` — то, что в исходниках сейчас: поверхности и код без правок, для сравнения.
 */
const VARIANTS = [
  {
    name: 'dark-base',
    label: 'сейчас — установленная версия',
    window: '#252526',
    content: '#1e1e1e',
    popup: '#2d2d30',
    accent: '#0a84ff',
    link: '#0098ff',
    fill: '#0a6edc',
  },
  {
    // Фиолетово-чёрное полотно, код — розовый, сиреневый и циан: цвет не
    // «тонирует серое», а заменяет его.
    name: 'dark-neon',
    label: 'неон — фиолетовый мрак, розовый код',
    window: '#120e1c',
    content: '#1a1526',
    popup: '#241d33',
    accent: '#ff5ec4',
    link: '#ff8ad8',
    fill: '#b02a83',
    code: {
      comment: '#8f89bb',
      string: '#ff9ed2',
      number: '#ffcf7a',
      keyword: '#c39bff',
      keywordControl: '#ff7ad1',
      identifier: '#b9d7ff',
      function: '#6ee7ff',
      type: '#7cf0c3',
      constant: '#ffa96b',
      tag: '#f0a0ff',
      attribute: '#ffc4a3',
    },
  },
  {
    // Морская глубина: бирюзовые поверхности, код — аква, мята и песок.
    name: 'dark-ocean',
    label: 'океан — бирюзовые поверхности, аква и песок',
    window: '#0d1a1c',
    content: '#142529',
    popup: '#1c3136',
    accent: '#22d3c5',
    link: '#6ce9df',
    fill: '#0b7d75',
    code: {
      comment: '#86a9a3',
      string: '#ffd79a',
      number: '#a9e5b0',
      keyword: '#58d6f0',
      keywordControl: '#7fe3ff',
      identifier: '#cfe9e4',
      function: '#63e6c9',
      type: '#8fd0ff',
      constant: '#ffb98a',
      tag: '#7fe3ff',
      attribute: '#d7f2ea',
    },
  },
  {
    // Вино и янтарь: тёплое полотно, но не «бежевая бумага», а насыщенный тон.
    name: 'dark-sunset',
    label: 'закат — вино и янтарь',
    window: '#1a1013',
    content: '#241519',
    popup: '#301e23',
    accent: '#ff8a5c',
    link: '#ffb197',
    fill: '#c04a24',
    code: {
      comment: '#b08a92',
      string: '#ffb08f',
      number: '#ffd27a',
      keyword: '#ff7f9e',
      keywordControl: '#ff98b8',
      identifier: '#ffd9c9',
      function: '#ffc46b',
      type: '#d9a2ff',
      constant: '#a8f0c0',
      tag: '#ff98b8',
      attribute: '#ffd9c9',
    },
  },
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
  '--surface_popup': v.popup,
  '--main_background': v.window,
  '--element_background_2': v.content,
  '--panel_background': v.content,
  '--editor_background': v.content,
  '--editor_terminal_background': v.content,
  // Акцент вместе с поверхностями: `--selection_background` и кольцо фокуса
  // считаются от него через `color-mix`, поэтому едут за ним сами.
  '--blue_prime_background': v.accent,
  '--link_color': v.link,
  '--accent_fill': v.fill,
});

/**
 * Краска токенов живёт не в переменных темы, а на корне редактора: вид ставит
 * `--own-token-<роль>` инлайном (`editor-view.ts`, `applyTheme`). Поэтому ищем узлы,
 * у которых эти переменные уже стоят, и переписываем их — иначе перекрасились бы
 * одни панели.
 */
const SET_CODE = (code) => `(() => {
  const t = ${JSON.stringify(code)};
  let nodes = 0;
  for (const node of document.querySelectorAll('div')) {
    if (!node.style.getPropertyValue('--own-token-comment')) continue;
    for (const [role, color] of Object.entries(t)) node.style.setProperty('--own-token-' + role, color);
    nodes += 1;
  }
  return nodes;
})()`;

const hex = (r, g, b) => `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;

/** Каналы цвета, относительная яркость и контраст по WCAG: токен обязан читаться на полотне. */
const channelsOf = (value) => [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
const linear = (channel) =>
  channel / 255 <= 0.03928 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4;
const luminanceOf = (value) => {
  const [r, g, b] = channelsOf(value);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};
const contrastOf = (one, other) => {
  const [lighter, darker] = [luminanceOf(one), luminanceOf(other)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};

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
  for (const variant of VARIANTS) {
    await wait(500);
    await ide.webContents.executeJavaScript(SET_TOKENS(TOKENS_FOR(variant))).catch(() => undefined);
    if (variant.code) {
      const nodes = await ide.webContents.executeJavaScript(SET_CODE(variant.code)).catch(() => 0);
      if (!nodes) step(`${variant.name}: корень редактора не найден — код остался прежним`);
    }
    await ide.webContents
      .executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
      .catch(() => undefined);
    const image = await ide.capturePage();
    const file = path.join(SHOTS, `theme-variant-${variant.name}.png`);
    await fs.writeFile(file, image.toPNG());
    const { width, height } = image.getSize();
    const bmp = image.toBitmap();
    rows.push({
      name: variant.name,
      label: variant.label,
      окно: variant.window,
      полотно: variant.content,
      шапка: zone(bmp, width, 0, 0, width, 36),
      панель: zone(bmp, width, 0, 40, 260, height - 30),
      редактор: zone(bmp, width, 280, 60, width - 20, height - 60),
      контраст: variant.code
        ? Math.min(...Object.values(variant.code).map((color) => contrastOf(color, variant.content)))
        : null,
      провалы: variant.code
        ? Object.entries(variant.code)
            .map(([role, color]) => [role, contrastOf(color, variant.content)])
            .filter(([, ratio]) => ratio < 4.5)
            .map(([role, ratio]) => `${role} ${ratio.toFixed(2)}`)
        : [],
      file,
    });
    step(`${variant.name} снят`);
  }

  console.log('\nвариант        окно      полотно   шапка     панель    редактор  контраст  подпись');
  for (const r of rows) {
    const ratio = r.контраст === null ? '—       ' : `${r.контраст.toFixed(2)}     `;
    console.log(
      `${r.name.padEnd(14)} ${r.окно}  ${r.полотно}  ${r.шапка}  ${r.панель}  ${r.редактор}  ${ratio} ${r.label}`,
    );
  }

  // Токен ниже 4.5:1 на полотне — не вкусовщина, а провал чтения: такой вариант
  // в исходники не идёт, краску надо поднимать.
  const failures = rows.filter((r) => r.провалы.length > 0);
  if (failures.length > 0) {
    console.log('\nниже 4.5:1:');
    for (const r of failures) console.log(`  ${r.name}: ${r.провалы.join(', ')}`);
  }
  console.log(`\nСнимки: ${SHOTS}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
