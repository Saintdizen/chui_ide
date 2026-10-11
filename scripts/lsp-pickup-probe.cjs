/**
 * Проба подхвата языковых серверов: попадает ли в настройки сервер, который
 * появился в проекте ПОЗЖЕ — его поставили в окружение при работающем приложении.
 *
 *   npm run probe:lsp [путь-к-проекту]
 *
 * Сценарий ровно тот, на котором подхват и ломался: список серверов не пуст
 * (настроен TypeScript), а у Python сервер нашёлся только что — и старая проверка
 * «список непуст — выходим» его отбрасывала. Проба проходит две фазы:
 *
 * 1. Старт: в окружении проекта есть `python`, но нет `pylsp`. Список серверов
 *    должен остаться прежним — добавлять нечего.
 * 2. Пока приложение работает, кладём в окружение `pylsp` и дёргаем перезапуск
 *    подсказок так, как это делает интерфейс: выбором интерпретатора в попапе
 *    окружения. В списке серверов должен появиться Python — из этого окружения.
 *
 * Команды в окружении — заглушки: пробе важно, что `lsp.detect` их видит, а не
 * что они работают.
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
const { LspService } = require('../dist/main/lsp/lsp.js');
const { pythonInterpreterFor } = require('../dist/main/python/environments.js');
const { projectEnv } = require('../dist/main/project-env.js');

registerAppScheme();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Исполняемый файл-заглушка: `lsp.detect` смотрит только на бит запуска. */
const writeStub = async (file, body) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
  await fs.chmod(file, 0o755);
};

/** Что сейчас в настройках: серверы и их команды. */
const servers = (store) =>
  store.get().lsp.servers.map((server) => ({ language: server.language, command: server.command }));

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-probe-'));
  const project = process.argv[2] ?? path.join(dir, 'demo-project');
  const venvBin = path.join(project, '.venv', 'bin');

  if (!process.argv[2]) {
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'main.py'), 'print("привет")\n', 'utf8');
    await fs.writeFile(path.join(project, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
    // Окружение проекта: интерпретатор есть, сервера подсказок в нём пока нет.
    await writeStub(path.join(venvBin, 'python'), '#!/bin/sh\necho "Python 3.12.0"\n');
  }

  // Список серверов намеренно не пуст: именно на непустом списке подхват и не работал.
  const settingsFile = path.join(dir, 'settings.json');
  await fs.writeFile(
    settingsFile,
    `${JSON.stringify(
      {
        lsp: {
          enabled: true,
          servers: [
            { language: 'typescript', command: 'typescript-language-server', args: ['--stdio'], enabled: true },
          ],
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  serveRenderer();

  const settings = new SettingsStore(settingsFile);
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  const lsp = new LspService(
    () => workspace.rootPath(),
    () => settings.get().lsp,
    (topic, payload) => pushToRenderers(topic, payload),
    () => pythonInterpreterFor(workspace.rootPath(), settings.get().run.pythonPath),
    () => projectEnv(workspace.rootPath()),
  );
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient(), lsp });

  await workspace.open(project);
  console.log(`[проба] проект: ${project}`);

  const ide = openIdeWindow();
  await wait(7000);

  /* ── фаза 1: сервера в окружении нет, добавлять нечего ─────────────────── */

  console.log(`[проба] до: ${JSON.stringify(servers(settings))}`);

  /* ── фаза 2: сервер появился — перезапуск подсказок из интерфейса ──────── */

  await writeStub(path.join(venvBin, 'pylsp'), '#!/bin/sh\nexit 0\n');
  console.log('[проба] в окружении появился pylsp');

  const opened = await ask(
    ide,
    `(() => {
      const widget = document.querySelector('.status-env');
      if (!widget) return 'виджета окружения нет';
      widget.click();
      return 'попап открыт';
    })()`,
  );
  console.log(`[проба] попап окружения: ${JSON.stringify(opened)}`);
  await wait(1500);

  const chosen = await ask(
    ide,
    `(() => {
      const select = document.querySelector('.python-env .select');
      if (!select) return 'выбора интерпретатора нет';
      select.click();
      const item = [...document.querySelectorAll('.select-item')].find(
        (node) => node.querySelector('.select-item-hint')?.textContent === 'python3',
      );
      if (!item) return 'интерпретатор python3 не предложен';
      item.click();
      return 'выбран python3';
    })()`,
  );
  console.log(`[проба] выбор интерпретатора: ${JSON.stringify(chosen)}`);
  await wait(5000);

  console.log(`[проба] после: ${JSON.stringify(servers(settings))}`);
  console.log(`[проба] запущены: ${JSON.stringify(await lsp.status())}`);

  terminals.dispose();
  lsp.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
