// Проба семантической подсветки по настоящему пути: вкладка -> документ -> LspService ->
// токены -> вид -> DOM.
//
//   npm run probe:semantics
//
// Зачем проба, когда есть тесты: tests/lsp-semantic-language.test.ts стережёт LspService,
// own-editor-probe - вид (setSemanticTokens рисует роли). А СЕРЕДИНУ не стерёг никто:
// доедут ли токены от сервера до карты вида через app.ts -> EditorWorkspace -> EditorHost.
// Баг 26.10 жил ровно там и был невидим: пустой список без ошибки и без признака в DOM.
//
// Поэтому здесь ничего не зовётся напрямую: файл открывается через ai.openFile -
// тот же путь, что у вкладок. Меряем ДВА конца:
//   - __chui.semanticLines() - карта вида (тихо пустая = проба провалилась);
//   - DOM - роли на строках (подсветка видна в пикселях).
//
// Нужны собранные main и renderer, и __chui есть только в Dev-сборке:
//   npm run build && npm run probe:semantics
const { app } = require("electron");
const { promises: fs } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AiService } = require("../dist/main/ai/service.js");
const { GitService } = require("../dist/main/git/git.js");
const { HostClient } = require("../dist/main/ipc/host.js");
const { registerIpc } = require("../dist/main/ipc/register.js");
const { pushToRenderers } = require("../dist/main/ipc/push.js");
const { LspService } = require("../dist/main/lsp/lsp.js");
const { pythonInterpreterFor } = require("../dist/main/python/environments.js");
const { projectEnv } = require("../dist/main/project-env.js");
const {
  registerAppScheme,
  serveRenderer,
} = require("../dist/main/protocol.js");
const { SettingsStore } = require("../dist/main/settings.js");
const { TerminalService } = require("../dist/main/terminal/terminal.js");
const { WorkspaceService } = require("../dist/main/workspace/workspace.js");
const { openIdeWindow } = require("../dist/main/window.js");

registerAppScheme();

let failed = false;
const check = (label, condition, extra) => {
  const tail = extra === undefined ? "" : ": " + JSON.stringify(extra);
  console.log("  " + (condition ? "ok  " : "FAIL") + " " + label + tail);
  if (!condition) failed = true;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents
      .executeJavaScript(expression)
      .catch((error) => "ошибка: " + error.message),
    wait(timeoutMs).then(() => "нет ответа"),
  ]);

// Ждём, пока условие в окне станет истинным: сервер поднимается не мгновенно.
async function until(window, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ask(window, expression)) === true) return true;
    await wait(300);
  }
  return false;
}

// Код для окна - строками, чтобы не городить шаблонные строки.
const PROBE_LINES = [
  "(() => {",
  "  const probe = window.__chui;",
  "  if (!probe || typeof probe.semanticLines !== 'function') return false;",
  "  return probe.semanticLines() > 0;",
  "})()",
];

// Второй конец — DOM. У редактора нет data-line на строках: строки — обычные
// <span> в контенте, а роль токена — класс `own-editor-token-<роль>`
// (см. drawPieces в editor-view.ts). Пробе незачем угадывать, она смотрит туда.
const PAINT_LINES = [
  "(() => {",
  '  const content = document.querySelector(".own-editor-content");',
  "  if (!content) return { rows: 0, roles: [], tokens: 0 };",
  "  const rows = Array.from(content.children);",
  "  const roles = new Set();",
  "  let tokens = 0;",
  '  for (const node of content.querySelectorAll("span")) {',
  "    const match = /own-editor-token-([a-z]+)/.exec(node.className);",
  "    if (!match) continue;",
  "    roles.add(match[1]);",
  "    tokens += 1;",
  "  }",
  "  return { rows: rows.length, roles: Array.from(roles).sort(), tokens };",
  "})()",
];

// Файл, на котором серверу точно есть что сказать: интерфейс, класс, функция, типы.
const SAMPLE = [
  "interface Point {",
  "  x: number;",
  "  y: number;",
  "}",
  "",
  "export class Shape {",
  '  private name: string = "s";',
  "  area(p: Point): number {",
  "    return p.x + p.y;",
  "  }",
  "}",
  "",
].join("\n");

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chui-semantics-"));
  const project = path.join(dir, "demo");
  await fs.mkdir(project, { recursive: true });
  const sample = path.join(project, "sample.ts");
  await fs.writeFile(sample, SAMPLE, "utf8");

  // Настройки: LSP включён. Пустой список серверов — значит «найти сам» (по PATH
  // и по node_modules), и typescript-language-server берётся встроенный.
  const settingsFile = path.join(dir, "settings.json");
  await fs.writeFile(
    settingsFile,
    `${JSON.stringify({ lsp: { enabled: true, servers: [] } }, null, 2)}\n`,
    "utf8",
  );

  serveRenderer();
  const settings = new SettingsStore(settingsFile);
  const workspace = new WorkspaceService((topic, payload) =>
    pushToRenderers(topic, payload),
  );
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) =>
    pushToRenderers(topic, payload),
  );
  const host = new HostClient();
  const lsp = new LspService(
    () => workspace.rootPath(),
    () => settings.get().lsp,
    (topic, payload) => pushToRenderers(topic, payload),
    () =>
      pythonInterpreterFor(workspace.rootPath(), settings.get().run.pythonPath),
    () => projectEnv(workspace.rootPath()),
  );
  registerIpc({ settings, workspace, ai, terminals, git, host, lsp });
  await workspace.open(project);

  const ide = openIdeWindow();
  // Мост для проб включается флагом в localStorage (см. main.ts). Ставим до
  // загрузки — после неё приложение флаг уже не увидит, поэтому перезагружаем.
  ide.webContents.once("did-finish-load", () => {
    ide.webContents
      .executeJavaScript("localStorage.setItem('chui:probe','1')")
      .then(() => ide.reload())
      .catch(() => undefined);
  });
  await wait(9000);

  // Настоящий путь: то же, что делает инструмент show -> openFile. Окно само
  // попросит у main открыть вкладку и тем самым отошлёт lsp.open.
  await host
    .request(ide.webContents, "ai.openFile", { path: sample })
    .catch((error) => console.log(`[проба] openFile: ${error.message}`));
  await wait(800);

  // Первый конец — карта вида. Второй — DOM (см. PAINT_LINES).
  const gotLines = await until(ide, PROBE_LINES.join("\n"));
  const lines = await ask(
    ide,
    "window.__chui && window.__chui.semanticLines ? window.__chui.semanticLines() : -1",
  );
  check("токены доехали до вида (карта не пуста)", gotLines === true, lines);

  // Второй конец — DOM. Без него «карта не пуста» может оказаться картой без краски.
  const painted = await ask(ide, PAINT_LINES.join("\n"));
  const isResult = painted !== null && typeof painted === "object";
  const rows = isResult ? painted.rows : painted;
  const roles = isResult && Array.isArray(painted.roles) ? painted.roles : [];
  check("строки в DOM есть", rows > 0, rows);
  check(
    "в строках есть роли подсветки",
    roles.length > 0,
    isResult ? { roles, tokens: painted.tokens } : roles,
  );

  // Сервер говорит ролями палитры, а не именами грамматики: type и function - его
  // работа. Только грамматические роли значили бы, что семантика не доехала.
  const own = roles.filter((role) => role === "type" || role === "function");
  check("роли - от сервера, а не только грамматика", own.length > 0, own);

  await lsp.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(
    failed
      ? "[проба] семантика не доехала до вида"
      : "[проба] подсветка от сервера доезжает до строк",
  );
  app.exit(failed ? 1 : 0);
});
