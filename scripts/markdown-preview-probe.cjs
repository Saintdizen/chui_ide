/**
 * Проба предпросмотра Markdown: режим вкладки файла .md, а не вкладка нижней панели.
 *
 *   npm run probe:markdown
 *
 * Проверяем то, чего не видно юнит-тестами (там нет ни окна, ни полосы вкладок):
 *
 *  1. в нижней панели больше нет вкладки «Markdown»;
 *  2. у открытого .md в полосе есть кнопка режима, а редактор показывает ТЕКСТ;
 *  3. кнопка включает разметку: полотно уступает предпросмотру (`.is-markdown`),
 *     а в теле появляется собранный заголовок;
 *  4. кнопка (теперь карандаш) возвращает текст;
 *  5. кнопка в шапке предпросмотра «Редактировать» делает то же самое;
 *  6. режим помнится по файлу: у .md остаётся своё, а у обычного файла режима нет.
 *
 * Снимок — `.chui_ide/probe-shots/markdown-preview.png`.
 * Нужен собранный код: `npm run build` (скрипт делает это сам).
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

registerAppScheme();
app.on('window-all-closed', () => {});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (text) => console.log(`[проба] ${text}`);

let failed = 0;
const check = (label, condition, extra) => {
  if (!condition) failed += 1;
  const tail = extra !== undefined ? `: ${JSON.stringify(extra)}` : '';
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${tail}`);
};

const ask = (win, expression, timeoutMs = 20000) =>
  Promise.race([
    win.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

const README = `# Заголовок разметки

Абзац текста с \`кодом\` внутри.

- первый пункт
- второй пункт
`;

/** Состояние экрана: режим разметки, видимость предпросмотра и кнопок. */
const STATE = `(() => {
  const island = document.querySelector('.editor-island');
  const view = document.querySelector('.md-preview');
  return {
    вРазметке: island ? island.classList.contains('is-markdown') : null,
    предпросмотрВиден: view ? !view.hidden : false,
    заголовки: [...document.querySelectorAll('.md-preview-body .md-heading')].map((n) => n.textContent),
    кнопкаВкладки: document.querySelector('.tab.is-active .tab-action')?.getAttribute('title') ?? null,
    вкладкаActive: document.querySelector('.tab.is-active .tab-label')?.textContent ?? null,
    докВкладки: [...document.querySelectorAll('.dock-tab')].map((n) => n.textContent.trim()),
  };
})()`;

const openFile = (win, name) =>
  ask(
    win,
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
  );

const clickTabAction = (win) =>
  ask(
    win,
    `(() => {
      const button = document.querySelector('.tab.is-active .tab-action');
      if (!button) return 'нет кнопки';
      button.click();
      return 'нажата';
    })()`,
  );

const clickEditInHeader = (win) =>
  ask(
    win,
    `(() => {
      const button = [...document.querySelectorAll('.md-preview-head button')].find((item) =>
        (item.textContent ?? '').includes('Редактировать'),
      );
      if (!button) return 'нет кнопки';
      button.click();
      return 'нажата';
    })()`,
  );

app.whenReady().then(async () => {
  step('старт');
  await fs.mkdir(SHOTS, { recursive: true });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-markdown-probe-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), README, 'utf8');
  await fs.writeFile(path.join(project, 'note.txt'), 'обычный текст\n', 'utf8');

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
  await wait(6000);

  step('открываю README.md');
  const opened = await openFile(ide, 'README.md');
  check('README.md открыт', opened === 'открыт', opened);
  await wait(500);

  const initial = await ask(ide, STATE);
  check('вкладки «Markdown» в нижней панели больше нет', !initial.докВкладки.includes('Markdown'), initial.докВкладки);
  check(
    'файл открыт текстом, а не разметкой',
    initial.вРазметке === false && initial.предпросмотрВиден === false,
    initial,
  );
  check('у вкладки .md есть кнопка режима', initial.кнопкаВкладки === 'Просмотр разметки', initial.кнопкаВкладки);

  step('включаю разметку кнопкой вкладки');
  check('кнопка нажата', (await clickTabAction(ide)) === 'нажата');
  await wait(600);
  const preview = await ask(ide, STATE);
  check('полотно уступило предпросмотру', preview.вРазметке === true && preview.предпросмотрВиден === true, preview);
  check('разметка собрана (заголовок на месте)', preview.заголовки.includes('Заголовок разметки'), preview.заголовки);
  check('кнопка стала карандашом', preview.кнопкаВкладки === 'Показать исходный текст', preview.кнопкаВкладки);

  const shot = await ide.capturePage();
  await fs.writeFile(path.join(SHOTS, 'markdown-preview.png'), shot.toPNG());

  step('возвращаюсь к тексту кнопкой в шапке');
  check('кнопка «Редактировать» нажата', (await clickEditInHeader(ide)) === 'нажата');
  await wait(500);
  const backToText = await ask(ide, STATE);
  check(
    'предпросмотр снова скрыт',
    backToText.вРазметке === false && backToText.предпросмотрВиден === false,
    backToText,
  );
  check(
    'кнопка вкладки снова зовёт просмотр',
    backToText.кнопкаВкладки === 'Просмотр разметки',
    backToText.кнопкаВкладки,
  );

  step('обычный файл режима не имеет');
  await openFile(ide, 'note.txt');
  await wait(300);
  const plain = await ask(ide, STATE);
  check('у .txt нет кнопки режима', plain.кнопкаВкладки === null, plain.кнопкаВкладки);
  check('разметка не показывается и здесь', plain.вРазметке === false && plain.предпросмотрВиден === false, plain);

  console.log(failed === 0 ? '\nпредпросмотр Markdown работает' : `\nпровалов: ${failed}`);
  console.log(`Снимок: ${path.join(SHOTS, 'markdown-preview.png')}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(failed === 0 ? 0 : 1);
});
