/**
 * Проба поиска в настройках.
 *
 *   npm run probe:settings
 *
 * В настройках много разделов и ещё больше полей: нужное ищут по названию, а не
 * обходом разделов. Проба проверяет живой поиск: выдача сгруппирована по разделам,
 * у разделов без находок подпись блёкнет, Esc снимает запрос (а не закрывает окно),
 * заголовок группы ведёт в раздел. Пустой ответ говорит словами, а не пустотой.
 *
 * Нужен собранный main и renderer (npm run build).
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { McpService } = require('../dist/main/mcp/mcp.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Набрать запрос в поиске: значение и событие — как при живом вводе. */
const typeQuery = (value) => `(async () => {
  const search = document.querySelector('.modal-search');
  if (!search) return 'поля поиска нет';
  search.value = ${JSON.stringify(value)};
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  return 'набрано';
})()`;

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-settings-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'index.js'), 'console.log(1);\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  const mcp = new McpService(
    () => settings.get().ai.mcpServers,
    () => workspace.rootPath(),
  );
  registerIpc({ settings, workspace, ai, terminals, git, mcp, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  const opened = await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('*')].find(
        (node) => node.getAttribute && node.getAttribute('title') === 'Настройки',
      );
      if (!button) return 'кнопки настроек нет';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      return document.querySelector('.modal-search') ? 'открыт' : 'поля поиска нет';
    })()`,
  );
  check('поиск есть в окне настроек', opened === 'открыт', opened);

  /* Поиск по подписи поля: одна находка, раздел «Редактор». */
  const typed = await ask(ide, typeQuery('шрифта'));
  check('запрос набран', typed === 'набрано', typed);

  const found = await ask(
    ide,
    `(() => {
      const pane = document.querySelector('.modal-pane');
      const groups = [...document.querySelectorAll('.settings-search-group')];
      const counts = [...document.querySelectorAll('.modal-nav-count')].map((node) => node.textContent);
      const dimmed = document.querySelectorAll('.modal-nav-item.is-dimmed').length;
      const active = document.querySelectorAll('.modal-nav-item.is-active').length;
      return {
        группы: groups.map((node) => (node.textContent || '').trim()),
        счётчики: counts,
        полей: pane ? pane.querySelectorAll('.field').length : 0,
        приглушено: dimmed,
        активных: active,
        заголовок: document.querySelector('.modal-title')?.textContent ?? null,
      };
    })()`,
  );
  check('выдача сгруппирована по разделу', Array.isArray(found.группы) && found.группы.length === 1, found.группы);
  check('в группе назван раздел «Редактор»', (found.группы?.[0] ?? '').includes('Редактор'), found.группы);
  check('найдено хотя бы одно поле', found.полей >= 1, found.полей);
  check('у раздела с находкой стоит счётчик', (found.счётчики ?? []).length === 1, found.счётчики);
  check('разделы без находок приглушены', found.приглушено > 0, found.приглушено);
  check('активный раздел при поиске не подсвечен', found.активных === 0, found.активных);
  check('заголовок говорит о поиске', (found.заголовок ?? '').includes('поиск'), found.заголовок);

  /* Esc снимает запрос, а окно остаётся: закрывать теряя набранное — не то, о чём просили. */
  const escaped = await ask(
    ide,
    `(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const modal = document.querySelector('.modal-backdrop');
      return {
        открыто: modal ? !modal.hidden : false,
        запрос: document.querySelector('.modal-search')?.value ?? null,
        выдача: document.querySelectorAll('.settings-search-group').length,
        заголовок: document.querySelector('.modal-title')?.textContent ?? null,
      };
    })()`,
  );
  check('Esc не закрывает окно, пока есть запрос', escaped.открыто === true, escaped.открыто);
  check('Esc очищает поиск', escaped.запрос === '' && escaped.выдача === 0, escaped);
  check('заголовок вернулся к разделу', (escaped.заголовок ?? '').includes('AI'), escaped.заголовок);

  /* Ссылка из выдачи ведёт в раздел целиком. */
  await ask(ide, typeQuery('шрифта'));
  const jumped = await ask(
    ide,
    `(async () => {
      const group = document.querySelector('.settings-search-group');
      if (!group) return 'группы нет';
      group.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const labels = [...document.querySelectorAll('.modal-pane .field-label')].map((node) => node.textContent);
      return {
        выдача: document.querySelectorAll('.settings-search-group').length,
        метки: labels,
        запрос: document.querySelector('.modal-search')?.value ?? null,
      };
    })()`,
  );
  check('ссылка открывает раздел целиком', jumped.выдача === 0 && jumped.запрос === '', jumped);
  check('в разделе видны группы настроек', (jumped.метки ?? []).includes('Отступы и строки'), jumped.метки);

  /* Пустой ответ назван словами. */
  await ask(ide, typeQuery('щщщ'));
  const empty = await ask(
    ide,
    `(() => {
      const pane = document.querySelector('.modal-pane');
      return {
        текст: (pane ? pane.textContent : '').trim(),
        приглушено: document.querySelectorAll('.modal-nav-item.is-dimmed').length,
      };
    })()`,
  );
  check('пустой ответ объяснён', (empty.текст ?? '').includes('Ничего не найдено'), empty.текст);
  check('при пустом ответе приглушены все разделы', empty.приглушено === 8, empty.приглушено);

  workspace.dispose();
  terminals.dispose();
  mcp.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[chui] поиск по настройкам: есть расхождения' : '[chui] поиск по настройкам работает');
  app.exit(failed ? 1 : 0);
});
