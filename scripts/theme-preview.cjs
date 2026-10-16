/**
 * Проба вида темы: поднимаем НАСТОЯЩЕЕ окно IDE и снимаем кадр в тёмной
 * и светлой схеме.
 *
 *   npx electron scripts/theme-preview.cjs
 *
 * Зачем: цвета правятся вслепую, а «как это выглядит вместе» видно только на
 * живом окне — лестница поверхностей, подсветка кода, значки файлов, панели.
 * Проба открывает демонстрационный проект (маленький, но с кодом), переключает
 * схему через `nativeTheme.themeSource` (её читает `prefers-color-scheme` в CSS)
 * и кладёт два PNG.
 *
 * Снимки — `.chui_ide/probe-shots/theme-<схема>.png`, отчёт — `.chui_ide/probe-theme.txt`.
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
const OUT_DIR = path.join(PROJECT, '.chui_ide');
const SHOTS = path.join(OUT_DIR, 'probe-shots');
const REPORT = path.join(OUT_DIR, 'probe-theme.txt');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`[проба] ${text}`);

// Схему `app://` нужно объявить ДО `app.ready` — иначе Electron откажет.
registerAppScheme();

/** Токены, которые печатаем в отчёт: по ним видно, что применилось. */
const TOKENS = [
  'surface_window',
  'surface_content',
  'surface_popup',
  'main_background',
  'element_background_2',
  'editor_background',
  'text_color',
  'text_color_secondary',
  'text_color_tertiary',
  'border_color',
  'separator_color',
  'blue_prime_background',
  'git_added',
  'git_modified',
  'git_deleted',
];

/** Демонстрационный проект: маленький, но с кодом, деревом и разными видами файлов. */
async function writeDemoProject(dir) {
  const files = {
    'README.md': '# Демонстрация\n\nПроект для съёмки темы.\n',
    'src/main.ts': `/** Точка входа демонстрации. */
import { helper } from './helper';

const GREETING: string = 'привет';
const MAX_COUNT = 42;

export function greet(name: string): string {
  // Собираем приветствие из частей.
  const parts = [GREETING, name, String(MAX_COUNT)];
  if (name.length > 3) {
    return helper(parts.join(', '));
  }
  return parts[0];
}

export class Demo {
  private readonly items: string[] = [];

  add(item: string): void {
    this.items.push(item);
  }
}
`,
    'src/helper.ts': `export function helper(value: string): string {
  return value.toUpperCase();
}
`,
    'src/styles.css': `:root {
  --accent: #0091ff;
}

.button {
  color: var(--accent);
  border-radius: 4px;
}
`,
    'index.html': `<!doctype html>
<html>
  <head><title>Демо</title></head>
  <body>
    <h1>Привет</h1>
  </body>
</html>
`,
    'data.json': `{ "name": "демо", "version": 1 }\n`,
    'script.sh': `#!/bin/sh\necho "привет"\n`,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, contents, 'utf8');
  }
}

/** Токены темы в том виде, как их видит CSS прямо сейчас. */
const READ_TOKENS = `(() => {
  const style = getComputedStyle(document.documentElement);
  const names = ${JSON.stringify(TOKENS)};
  const out = {};
  for (const name of names) out[name] = style.getPropertyValue('--' + name).trim();
  return out;
})()`;

async function capture(ide, scheme) {
  nativeTheme.themeSource = scheme;
  // Смена схемы перекрашивает через media-query — даём ей отрисоваться.
  await wait(1200);
  await ide.webContents
    .executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    )
    .catch(() => undefined);
  step('кадр отрисован');
  const image = await ide.capturePage();
  const file = path.join(SHOTS, `theme-${scheme}.png`);
  await fs.writeFile(file, image.toPNG());
  const tokens = await ide.webContents.executeJavaScript(READ_TOKENS).catch(() => null);
  return { file, tokens };
}

app.whenReady().then(async () => {
  await fs.mkdir(SHOTS, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-theme-preview-'));
  const project = path.join(dir, 'demo');
  await writeDemoProject(project);

  serveRenderer();
  step('сервер renderer поднят');

  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  step('ipc зарегистрирован');

  await workspace.open(project);
  step('проект открыт');

  const ide = openIdeWindow();
  step('окно создано');
  await wait(3500);
  step('ждём отрисовку');

  const lines = [];
  for (const scheme of ['dark', 'light']) {
    step(`снимаем ${scheme}`);
    const { file, tokens } = await capture(ide, scheme);
    lines.push(`\n[${scheme}] снимок: ${file}`);
    if (tokens) for (const name of TOKENS) lines.push(`  --${name} = ${tokens[name]}`);
  }

  await fs.writeFile(REPORT, lines.join('\n') + '\n', 'utf8');
  console.log(lines.join('\n'));
  console.log(`\nОтчёт: ${REPORT}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
