/**
 * Проба раздела «Внешние инструменты (MCP)» в настройках.
 *
 *   npm run probe:mcp
 *
 * Открываем окно IDE, открываем настройки, переходим в раздел MCP и проверяем,
 * что он есть и что в нём: список серверов, кнопка проверки и итог проверки.
 * Живой сервер MCP поднимает сама кнопка — в пробе он фейковый
 * (`scripts/fake-mcp.cjs`), поэтому проверка не зависит от сети и npx.
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

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-mcp-ui-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  // Сервер задаём через настройки — тем же путём, каким это делает человек:
  // тогда проверяется и связь «настройки → сервис», а не только интерфейс.
  // Команда — фейковый сервер вместо настоящего: сеть и npx в проверке не нужны.
  settings.update({
    ai: {
      mcpServers: [
        { id: 'fake', command: process.execPath, args: [path.join(__dirname, 'fake-mcp.cjs')], enabled: true },
      ],
    },
  });
  const mcp = new McpService(
    () => settings.get().ai.mcpServers,
    () => workspace.rootPath(),
  );
  registerIpc({ settings, workspace, ai, terminals, git, mcp, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  /* Открываем настройки и переходим в раздел MCP. */
  const opened = await ask(
    ide,
    `(async () => {
      const settingsButton = [...document.querySelectorAll('*')].find(
        (node) => node.getAttribute && node.getAttribute('title') === 'Настройки',
      );
      if (!settingsButton) return 'кнопки настроек нет';
      settingsButton.click();
      await new Promise((resolve) => setTimeout(resolve, 600));

      const item = [...document.querySelectorAll('.modal-nav *')].find(
        (node) => (node.textContent || '').includes('Внешние инструменты'),
      );
      if (!item) return 'раздела MCP нет';
      (item.closest('button') || item).click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      return 'открыт';
    })()`,
  );
  check('раздел MCP открывается из настроек', opened === 'открыт', opened);

  const view = await ask(
    ide,
    `(() => {
      const pane = document.querySelector('.modal-pane');
      const area = pane ? pane.querySelector('textarea') : null;
      const button = [...(pane ? pane.querySelectorAll('button') : [])].find((node) =>
        (node.textContent || '').includes('Проверить серверы'),
      );
      return {
        заголовок: document.querySelector('.modal-title')?.textContent ?? null,
        поле: area ? area.value.slice(0, 120) : null,
        кнопка: Boolean(button),
        подсказка: (pane ? pane.textContent : '').includes('mcp__'),
      };
    })()`,
  );
  check('поле со списком серверов на месте', typeof view.поле === 'string' && view.поле.includes('fake'), view.поле);
  check('кнопка проверки на месте', view.кнопка === true);
  check('в подсказке объяснено имя инструмента', view.подсказка === true);

  /* Кнопка проверки: поднимает сервер и показывает его инструменты. */
  const checked = await ask(
    ide,
    `(async () => {
      const pane = document.querySelector('.modal-pane');
      const button = [...pane.querySelectorAll('button')].find((node) =>
        (node.textContent || '').includes('Проверить серверы'),
      );
      button.click();
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const text = pane.textContent || '';
        if (text.includes('инструментов')) return text.slice(text.indexOf('fake:'), text.indexOf('fake:') + 160);
      }
      return 'итог проверки не появился';
    })()`,
  );
  check('проверка показывает инструменты сервера', /инструментов 3/.test(checked), checked);
  check('изменяющий инструмент помечен', /спросит подтверждение/.test(checked), checked);

  mcp.dispose();
  workspace.dispose();
  terminals.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[chui] раздел MCP: есть расхождения' : '[chui] раздел MCP работает');
  app.exit(failed ? 1 : 0);
});
