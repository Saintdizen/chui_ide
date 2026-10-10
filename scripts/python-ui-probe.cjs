/**
 * Проба Python-панелей: поднимаем окно IDE против собранного renderer'а и читаем,
 * что показывают панель тестов и попап окружения.
 *
 *   ./node_modules/.bin/electron scripts/python-ui-probe.cjs [путь-к-проекту]
 *
 * Нужна, потому что панели — это DOM и события: типы и тесты чистой логики их не
 * покрывают. Проект без pytest — тоже полезный случай: важно, что панель
 * объясняет сбой сбора, а не молчит.
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

registerAppScheme();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (window, expression, timeoutMs = 30000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-python-probe-'));
  const project = process.argv[2] ?? path.join(dir, 'demo-project');

  // Без аргумента делаем проект с тестом: панель должна увидеть хотя бы файл.
  // requirements.txt кладём специально: попап должен сказать, чего из него не хватает.
  if (!process.argv[2]) {
    await fs.mkdir(path.join(project, 'tests'), { recursive: true });
    await fs.writeFile(path.join(project, 'tests', 'test_demo.py'), 'def test_ok():\n    assert True\n', 'utf8');
    await fs.writeFile(path.join(project, 'requirements.txt'), 'pytest==7\nrequests>=2.31\n', 'utf8');
  }

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
  console.log(`[проба] проект: ${project}`);

  const ide = openIdeWindow();
  await wait(6000);

  // ── панель тестов: открываем кликом по вкладке дока ──────────────────────
  const opened = await ask(
    ide,
    `(() => {
      const tab = [...document.querySelectorAll('.dock-tab')].find((node) => node.textContent === 'Тесты');
      if (!tab) return 'вкладки нет';
      tab.click();
      return 'кликнут';
    })()`,
    15000,
  );
  console.log(`[проба] панель тестов: ${JSON.stringify(opened)}`);
  await wait(8000);

  const tests = await ask(
    ide,
    `({
      summary: document.querySelector('.tests-summary')?.textContent ?? null,
      errorTitle: document.querySelector('.tests-error-title')?.textContent ?? null,
      errorLines: [...document.querySelectorAll('.tests-error-line')].map((node) => node.textContent).slice(0, 2),
      files: [...document.querySelectorAll('.tests-file .tests-label')].map((node) => node.textContent),
      tests: [...document.querySelectorAll('.tests-test .tests-label')].map((node) => node.textContent),
    })`,
    20000,
  );
  console.log(`[проба] тесты: ${JSON.stringify(tests, null, 2)}`);

  // ── попап окружения: клик по виджету в статусбаре ────────────────────────
  const envOpened = await ask(
    ide,
    `(() => {
      const widget = document.querySelector('.status-env');
      if (!widget) return 'виджета нет';
      widget.click();
      return widget.textContent;
    })()`,
    15000,
  );
  console.log(`[проба] виджет окружения: ${JSON.stringify(envOpened)}`);
  await wait(4000);

  const env = await ask(
    ide,
    `({
      title: document.querySelector('.python-env-title')?.textContent ?? null,
      rows: [...document.querySelectorAll('.python-env-row')].map((node) => node.textContent),
      sections: [...document.querySelectorAll('.python-env-heading')].map((node) => node.textContent),
      note: document.querySelector('.python-env-note')?.textContent ?? null,
      requirements: document.querySelector('.python-env-requirements')?.textContent ?? null,
      issues: [...document.querySelectorAll('.python-env-issue')].map((node) => node.textContent),
      environments: [...document.querySelectorAll('.python-env-item .python-env-name')].map((node) => node.textContent),
    })`,
    20000,
  );
  console.log(`[проба] попап: ${JSON.stringify(env, null, 2)}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
