/**
 * Проба вида темы: поднимаем НАСТОЯЩЕЕ окно IDE и снимаем кадр.
 *
 *   npx electron scripts/theme-preview.cjs
 *
 * Зачем: цвета правятся вслепую, а «как это выглядит вместе» видно только на
 * живом окне — лестница поверхностей, подсветка кода, значки файлов, панели.
 * Проба открывает демонстрационный проект (маленький, но с кодом) и кладёт PNG.
 *
 * Снимок — `.chui_ide/probe-shots/theme-dark.png`, отчёт — `.chui_ide/probe-theme.txt`.
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
  'panel_background',
  'tab_active_background',
  'text_color',
  'text_color_secondary',
  'text_color_tertiary',
  'placeholder_text_color',
  'text_color_disabled',
  'border_color',
  'separator_color',
  'blue_prime_background',
  'accent_fill',
  'selection_background',
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

/**
 * Как выкрашены ключевые места. Токена в `:root` мало: правило могло не взяться,
 * и тогда панель или активная вкладка остаются того же тона, что полотно.
 */
const READ_PAINT = `(() => {
  const paint = (selector) => {
    const node = document.querySelector(selector);
    return node ? getComputedStyle(node).backgroundColor : 'нет узла';
  };
  // Цвета подсветки редактор ставит переменными на свой корень.
  const editor = document.querySelector('.own-editor');
  const token = (name) => (editor ? getComputedStyle(editor).getPropertyValue(name).trim() : 'нет редактора');
  return {
    'боковая панель': paint('.sidebar'),
    'полотно редактора': paint('.editor-host'),
    'полоса вкладок': paint('.tabs-host'),
    'активная вкладка': paint('.tab.is-active'),
    'комментарий': token('--own-token-comment'),
    'ключевое слово': token('--own-token-keyword'),
  };
})()`;

/** Открыть файл из дерева: без открытой вкладки её заливку не с чем сверить. */
const openFile = (ide, name) =>
  ide.webContents
    .executeJavaScript(
      `(async () => {
        const row = [...document.querySelectorAll('.tree-row')].find(
          (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
        );
        if (!row) return 'нет строки';
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 900));
        return 'открыт';
      })()`,
    )
    .catch((error) => `ошибка: ${error.message}`);

async function capture(ide) {
  await ide.webContents
    .executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
    )
    .catch(() => undefined);
  step('кадр отрисован');
  const image = await ide.capturePage();
  const file = path.join(SHOTS, 'theme-dark.png');
  await fs.writeFile(file, image.toPNG());
  const tokens = await ide.webContents.executeJavaScript(READ_TOKENS).catch(() => null);
  const paint = await ide.webContents.executeJavaScript(READ_PAINT).catch(() => null);
  return { file, tokens, paint };
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

  step('открываю README.md — иначе полосы вкладок на снимке нет');
  step(`файл: ${await openFile(ide, 'README.md')}`);
  await wait(600);

  const lines = [];
  const { file, tokens, paint } = await capture(ide);
  lines.push(`снимок: ${file}`);
  if (tokens) for (const name of TOKENS) lines.push(`  --${name} = ${tokens[name]}`);
  if (paint) for (const [name, value] of Object.entries(paint)) lines.push(`  ${name} = ${value}`);

  await fs.writeFile(REPORT, `${lines.join('\n')}\n`, 'utf8');
  console.log(lines.join('\n'));
  console.log(`\nОтчёт: ${REPORT}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
