/**
 * Проба записи правок ассистента: полный доступ пишет на диск сразу, ограниченный —
 * оставляет в буфере.
 *
 *   npm run probe:agentedits
 *
 * Зачем проба, а не юнит-тест: решение принимает renderer (`ui/chat.ts`,
 * `applyAgentEdits`) — там, где живут документы, ревью и панель изменений. В
 * node-окружении этого нет вовсе. Проверяем в настоящем окне и меряем по ФАЙЛУ
 * НА ДИСКЕ, а не по ответу: ответ может сказать «применено», пока файл старый.
 *
 * Два случая — два файла:
 *   • полный доступ (`autoApprove: true`) — ревью не показывается, файл на диске
 *     меняется сразу, ответ не несёт оговорки `unwritten`;
 *   • ограниченный доступ — сначала карточка ревью, после «Применить» текст живёт
 *     ТОЛЬКО в буфере: диск прежний, вкладка помечена «не сохранён», в ответе есть
 *     `unwritten` (main читает файлы с диска, и агент должен об этом знать).
 *
 * Нужен собранный main и renderer (npm run build).
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

/** Правка одной строки: строка 1 целиком заменяется на `text`. */
const edit = (target, text) => ({
  edits: [
    {
      path: target,
      edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 999, newText: text }],
    },
  ],
});

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-agent-edits-'));
  const project = path.join(dir, 'demo');
  await fs.mkdir(project, { recursive: true });
  const autoFile = path.join(project, 'auto.ts');
  const manualFile = path.join(project, 'manual.ts');
  await fs.writeFile(autoFile, 'const auto = 1;\n', 'utf8');
  await fs.writeFile(manualFile, 'const manual = 1;\n', 'utf8');

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  const host = new HostClient();
  registerIpc({ settings, workspace, ai, terminals, git, host });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Оба файла открываем вкладками: пометку «не сохранён» рисует вкладка, и без неё
  // второй случай нечем измерить.
  for (const target of [autoFile, manualFile]) {
    await host.request(ide.webContents, 'ai.openFile', { path: target }).catch(() => undefined);
  }
  await wait(600);

  /* ── полный доступ: сразу на диск ───────────────────────────────────────── */

  const autoResult = await host
    .request(ide.webContents, 'ai.applyEdits', { ...edit(autoFile, 'const auto = 42;'), autoApprove: true })
    .catch((error) => ({ error: String(error) }));
  await wait(400);

  const autoOnDisk = await fs.readFile(autoFile, 'utf8').catch(() => '');
  check(
    'полный доступ: ревью не показывалось',
    (await ask(ide, `document.querySelector('.review') === null`)) === true,
  );
  check('полный доступ: ответ не ошибка', autoResult.error === undefined, autoResult.error);
  check('полный доступ: правка применена', autoResult.rejected === false, autoResult);
  check('полный доступ: файл на диске изменён', autoOnDisk.includes('42'), autoOnDisk.trim());
  check('полный доступ: оговорки «осталось в буфере» нет', autoResult.unwritten === undefined, autoResult.unwritten);
  check(
    'полный доступ: вкладка не помечена «не сохранён»',
    (await ask(
      ide,
      `(() => {
        const tab = [...document.querySelectorAll('.tab')].find((node) =>
          (node.textContent ?? '').includes('auto.ts'),
        );
        return tab ? tab.querySelector('.tab-dirty') === null : 'нет вкладки';
      })()`,
    )) === true,
  );

  /* ── ограниченный доступ: в буфер ───────────────────────────────────────── */

  // Запрос ждёт решения человека: не ждём его сами, а сперва нажимаем «Применить».
  const manualRequest = host
    .request(ide.webContents, 'ai.applyEdits', { ...edit(manualFile, 'const manual = 42;'), autoApprove: false })
    .catch((error) => ({ error: String(error) }));

  await wait(600);
  const reviewShown = await ask(ide, `document.querySelector('.review') !== null`);
  check('ограниченный доступ: показана карточка ревью', reviewShown === true, reviewShown);

  const clicked = await ask(
    ide,
    `(() => {
      const buttons = [...document.querySelectorAll('.review .btn')];
      const button = buttons.find((node) => (node.textContent ?? '').trim().startsWith('Применить'));
      if (!button) return buttons.map((node) => node.textContent);
      button.click();
      return 'нажато';
    })()`,
  );
  check('ограниченный доступ: карточка подтверждена', clicked === 'нажато', clicked);

  const manualResult = await manualRequest;
  await wait(400);

  const manualOnDisk = await fs.readFile(manualFile, 'utf8').catch(() => '');
  check('ограниченный доступ: ответ не ошибка', manualResult.error === undefined, manualResult.error);
  check('ограниченный доступ: правка применена', manualResult.rejected === false, manualResult);
  check('ограниченный доступ: файл на диске прежний', manualOnDisk.includes('manual = 1'), manualOnDisk.trim());
  check(
    'ограниченный доступ: в ответе сказано «не записано на диск»',
    Array.isArray(manualResult.unwritten) && manualResult.unwritten.length === 1,
    manualResult.unwritten,
  );
  check(
    'ограниченный доступ: вкладка помечена «не сохранён»',
    (await ask(
      ide,
      `(() => {
        const tab = [...document.querySelectorAll('.tab')].find((node) =>
          (node.textContent ?? '').includes('manual.ts'),
        );
        return tab ? tab.querySelector('.tab-dirty') !== null : 'нет вкладки';
      })()`,
    )) === true,
  );

  /* ── «Сохранить» в панели изменений дописывает на диск ──────────────────── */

  const saved = await ask(
    ide,
    `(() => {
      const toggle = document.querySelector('.changes-toggle');
      if (!toggle) return 'нет сводки изменений';
      toggle.click();
      return 'открыть';
    })()`,
  );
  check('панель изменений открывается', saved === 'открыть', saved);
  await wait(300);

  const saveClicked = await ask(
    ide,
    `(() => {
      const buttons = [...document.querySelectorAll('.changes-popover .btn')];
      const button = buttons.find((node) => (node.textContent ?? '').trim().startsWith('Сохранить'));
      if (!button) return buttons.map((node) => node.textContent);
      button.click();
      return 'нажато';
    })()`,
  );
  check('кнопка «Сохранить» найдена и нажата', saveClicked === 'нажато', saveClicked);
  await wait(600);

  const manualAfterSave = await fs.readFile(manualFile, 'utf8').catch(() => '');
  check('ограниченный доступ: «Сохранить» пишет файл', manualAfterSave.includes('42'), manualAfterSave.trim());

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(
    failed
      ? '[проба] правки ассистента: есть расхождения'
      : '[проба] полный доступ пишет сразу, ограниченный — в буфер',
  );
  app.exit(failed ? 1 : 0);
});
