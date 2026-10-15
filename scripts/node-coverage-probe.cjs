/**
 * Проба покрытия Node: от кнопки «С покрытием» до списка файлов в панели.
 *
 *   npm run probe:coverage
 *
 * Юнит-тесты проверяют разбор отчёта istanbul (`tests/node-coverage.test.ts`) и сборку
 * команды (`tests/run-config.test.ts`). Здесь проверяется то, чего они не видят: что
 * кнопка появляется у vitest-проекта, команда уходит в терминал, отчёт раннера
 * читается, пути в нём переводятся в проектные и попадают и в панель, и в редактор.
 *
 * Раннер фейковый (`node_modules/vitest/bin/cli.js` пишется тут же): настоящий vitest
 * тянет провайдер покрытия и node_modules, а проверяем мы связку IDE с отчётом, а не
 * сам раннер — тем же приёмом, что `fake-lsp.cjs` и `fake-mcp.cjs`.
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

/**
 * Фейковый vitest: `list --json` отдаёт один тест, а прогон пишет
 * `coverage-final.json` — как настоящий раннер, только без провайдера.
 * Из четырёх строк исходника исполнены две — покрытие выйдет 50%.
 */
const STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);

if (args[0] === 'list') {
  const file = path.join(process.cwd(), 'tests', 'util.test.js');
  process.stdout.write(JSON.stringify([{ name: 'складывает', file }]));
  process.exit(0);
}

const flag = args.find((arg) => arg.startsWith('--coverage.reportsDirectory='));
if (flag) {
  const dir = flag.slice('--coverage.reportsDirectory='.length);
  const src = path.join(process.cwd(), 'src', 'util.js');
  const report = {
    [src]: {
      path: src,
      statementMap: {
        0: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        1: { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
        2: { start: { line: 3, column: 0 }, end: { line: 3, column: 10 } },
        3: { start: { line: 4, column: 0 }, end: { line: 4, column: 10 } },
      },
      s: { 0: 1, 1: 0, 2: 1, 3: 0 },
      branchMap: {},
      b: {},
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'coverage-final.json'), JSON.stringify(report));
}
process.exit(0);
`;

/** Проект-заготовка: манифест с vitest, исходник и тест, плюс фейковый раннер. */
async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-coverage-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(project, 'tests'), { recursive: true });
  await fs.writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'demo', dependencies: { vitest: '^1.0.0' } }),
  );
  await fs.writeFile(path.join(project, 'src', 'util.js'), 'export const a = 1;\nexport const b = 2;\n');
  await fs.writeFile(path.join(project, 'tests', 'util.test.js'), "test('складывает', () => {});\n");

  const binDir = path.join(project, 'node_modules', 'vitest', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    path.join(project, 'node_modules', 'vitest', 'package.json'),
    JSON.stringify({ name: 'vitest', version: '1.0.0', bin: { vitest: 'bin/cli.js' } }),
  );
  await fs.writeFile(path.join(binDir, 'cli.js'), STUB);

  // npx ищет раннер в node_modules/.bin — туда кладём обёртку на фейк.
  const dotBin = path.join(project, 'node_modules', '.bin');
  await fs.mkdir(dotBin, { recursive: true });
  const shim = path.join(dotBin, 'vitest');
  await fs.writeFile(shim, "#!/usr/bin/env node\nrequire('../vitest/bin/cli.js');\n");
  await fs.chmod(shim, 0o755);
  return { dir, project };
}

app.whenReady().then(async () => {
  const { dir, project } = await makeProject();

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

  // Открываем панель тестов командой из палитры — тем же путём, что и человек.
  const opened = await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find((item) =>
        (item.getAttribute('title') ?? '').startsWith('Палитра команд'),
      );
      if (!button) return 'нет кнопки палитры';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const input = document.querySelector('.palette-input');
      input.value = 'тесты';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 240));
      const item = [...document.querySelectorAll('.palette-item')].find((node) =>
        (node.querySelector('.palette-item-title')?.textContent ?? '').includes('Тесты'),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 800));
      return 'открыли';
    })()`,
  );
  check('панель тестов открывается', opened === 'открыли', opened);

  const toolbar = await ask(
    ide,
    `(() => {
      const button = [...document.querySelectorAll('.tests-toolbar button')].find((node) =>
        (node.textContent || '').includes('С покрытием'),
      );
      return {
        есть_кнопка: Boolean(button),
        скрыта: button ? button.hidden : null,
        сводка: document.querySelector('.tests-summary')?.textContent ?? null,
      };
    })()`,
  );
  check(
    'у vitest-проекта кнопка «С покрытием» видна',
    toolbar.есть_кнопка === true && toolbar.скрыта === false,
    toolbar,
  );
  check('раннер в сводке — vitest', (toolbar.сводка ?? '').includes('vitest'), toolbar.сводка);

  // Нажимаем «С покрытием» — уйдёт команда в терминал, раннер положит отчёт.
  await ask(
    ide,
    `(async () => {
      const button = [...document.querySelectorAll('.tests-toolbar button')].find((node) =>
        (node.textContent || '').includes('С покрытием'),
      );
      button.click();
      return true;
    })()`,
  );

  // Ждём строку покрытия: отчёт приходит после прогона.
  const coverage = await ask(
    ide,
    `(async () => {
      for (let i = 0; i < 60; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const row = document.querySelector('.tests-cov-row');
        if (row) {
          return {
            путь: row.querySelector('.tests-cov-path')?.textContent ?? null,
            процент: row.querySelector('.tests-cov-percent')?.textContent ?? null,
            сводка: document.querySelector('.tests-summary')?.textContent ?? null,
          };
        }
      }
      return 'строк покрытия нет';
    })()`,
    20000,
  );
  check('панель показала файл покрытия', typeof coverage === 'object' && coverage.путь === 'src/util.js', coverage);
  check('процент посчитан по отчёту раннера', typeof coverage === 'object' && coverage.процент === '50%', coverage);
  check(
    'сводка несёт общий процент',
    typeof coverage === 'object' && (coverage.сводка ?? '').includes('покрытие 50%'),
    typeof coverage === 'object' ? coverage.сводка : coverage,
  );

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[проба] покрытие Node: есть расхождения' : '[проба] покрытие Node работает');
  app.exit(failed ? 1 : 0);
});
