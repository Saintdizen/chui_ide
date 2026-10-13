/**
 * Проба сравнения двух папок.
 *
 *   npm run probe:folders
 *
 * Две папки в рабочей области с заранее известными различиями: файл только слева,
 * только справа и различающийся по содержимому. Проба выделяет папки в дереве,
 * открывает сравнение из меню и проверяет список — что статусы верные и что клик
 * по строке открывает сравнение файла.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([window.webContents.executeJavaScript(expression), wait(timeoutMs).then(() => 'нет ответа')]);

let failed = false;
const check = (label, condition, extra) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-folders-probe-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'dirA'), { recursive: true });
  await fs.mkdir(path.join(project, 'dirB'), { recursive: true });

  // same.ts — одинаковый; onlyA.ts — только слева; onlyB.ts — только справа;
  // diff.ts — разный по содержимому при равной длине (проверяет сравнение текста,
  // а не только размера).
  await fs.writeFile(path.join(project, 'dirA', 'same.ts'), 'const same = 1;\n', 'utf8');
  await fs.writeFile(path.join(project, 'dirB', 'same.ts'), 'const same = 1;\n', 'utf8');
  await fs.writeFile(path.join(project, 'dirA', 'onlyA.ts'), 'const a = 1;\n', 'utf8');
  await fs.writeFile(path.join(project, 'dirB', 'onlyB.ts'), 'const b = 1;\n', 'utf8');
  await fs.writeFile(path.join(project, 'dirA', 'diff.ts'), 'const x = 1;\n', 'utf8');
  await fs.writeFile(path.join(project, 'dirB', 'diff.ts'), 'const x = 2;\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const gitService = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git: gitService, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Выделяем две папки: обычный клик по первой, Ctrl+клик по второй.
  const clickDir = (name, ctrl) =>
    ask(
      ide,
      `(() => {
        const row = [...document.querySelectorAll('.explorer .tree-rows .tree-row')].find(
          (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
        );
        if (!row) return 'нет строки';
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${ctrl ? 'true' : 'false'} }));
        return 'ok';
      })()`,
    );
  await clickDir('dirA', false);
  await wait(300);
  await clickDir('dirB', true);
  await wait(500);

  // Правый клик по одной из выделенных папок — меню должно предложить сравнение папок.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.explorer .tree-rows .tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'dirB',
      );
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8 }));
      return 'ok';
    })()`,
  );
  await wait(600);
  const menu = await ask(
    ide,
    `[...document.querySelectorAll('.context-menu .context-item')].map((node) => node.textContent.trim())`,
  );
  console.log(`[folders] пункты меню: ${JSON.stringify(menu)}`);
  check(
    'меню предлагает сравнить папки',
    Array.isArray(menu) && menu.some((item) => typeof item === 'string' && item.startsWith('Сравнить папки:')),
    menu,
  );

  await ask(
    ide,
    `(async () => {
      const item = [...document.querySelectorAll('.context-menu .context-item')].find((node) =>
        (node.textContent ?? '').startsWith('Сравнить папки:'),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return 'нажато';
    })()`,
  );
  await wait(1500);

  const rows = await ask(
    ide,
    `[...document.querySelectorAll('.refdiff-modal .refdiff-row')].map((row) => ({
      статус: row.querySelector('.refdiff-status')?.textContent ?? '',
      путь: row.querySelector('.refdiff-path')?.textContent ?? '',
      класс: [...row.classList].find((item) => item.startsWith('is-')) ?? '',
    }))`,
  );
  console.log(`[folders] список различий: ${JSON.stringify(rows)}`);
  const byPath = Object.fromEntries((Array.isArray(rows) ? rows : []).map((row) => [row.путь, row]));
  check('файл только слева помечен D', byPath['onlyA.ts']?.статус === 'D', byPath['onlyA.ts']);
  check('файл только справа помечен A', byPath['onlyB.ts']?.статус === 'A', byPath['onlyB.ts']);
  check('различающийся файл помечен M', byPath['diff.ts']?.статус === 'M', byPath['diff.ts']);
  check('совпавший файл в список не попал', byPath['same.ts'] === undefined, byPath['same.ts']);

  // Клик по строке открывает сравнение самого файла.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.refdiff-modal .refdiff-row')].find(
        (item) => item.querySelector('.refdiff-path')?.textContent === 'diff.ts',
      );
      row?.click();
      return Boolean(row);
    })()`,
  );
  await wait(1500);
  const diffState = await ask(
    ide,
    `(() => {
      const view = document.querySelector('.diff-view');
      return { открыто: view ? !view.hidden : false, подпись: document.querySelector('.diff-subtitle')?.textContent ?? null };
    })()`,
  );
  console.log(`[folders] сравнение файла: ${JSON.stringify(diffState)}`);
  check('клик по файлу открывает его сравнение', diffState?.открыто === true, diffState);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[folders] ЕСТЬ ПАДЕНИЯ' : '[folders] всё сошлось');
  app.exit(failed ? 1 : 0);
});
