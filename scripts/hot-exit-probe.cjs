/**
 * Проба «hot exit»: несохранённые правки переживают перезапуск.
 *
 *   npm run probe:hot-exit
 *
 * Запускается ДВУМЯ процессами — в одном окно второго раза не поднять (регистрация
 * обработчиков IPC повторной быть не может). Общий каталог проекта и сессий между
 * запусками передаётся переменными окружения.
 *
 * Проверяем две половины отдельно:
 *
 * 1. `edit` — открыть файл, напечатать текст, НЕ сохраняя, и убедиться, что правка
 *    попала в сессию, а файл на диске остался прежним.
 * 2. `check` — положить несохранённую правку в сессию ДО запуска и убедиться, что
 *    редактор показал именно её: вкладка открыта, помечена «не сохранён», а текст
 *    на экране — правленый. Файл на диске при этом не тронут.
 *
 * Правку во втором случае задаём файлом сессии, а не клавишами: ввод зависит от
 * того, отдан ли окну фокус системой, и проверка вышла бы не про то, что видит человек.
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
const { SessionStore } = require('../dist/main/session-store.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

/** Что печатаем в правке — по этой строке и узнаём, вернулась ли работа. */
const UNSAVED_LINE = '// несохранённая правка';
const ORIGINAL = 'const value = 1;\nconsole.log(value);\n';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Открыть файл из дерева: папка раскрывается одним кликом, файл — двойным. */
const openInTree = (window, name) =>
  ask(
    window,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
      );
      if (!row) return 'нет узла';
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return 'кликнут';
    })()`,
  );

/** Состояние редактора: строки текста и пометка «не сохранён» на активной вкладке. */
const editorState = (window) =>
  ask(
    window,
    `(() => ({
      вкладка: document.querySelector('.tab.is-active .tab-label')?.textContent ?? null,
      не_сохранён: Boolean(document.querySelector('.tab.is-active .tab-dirty')),
      строки: [...document.querySelectorAll('.own-editor-line')].map((node) => node.textContent),
    }))()`,
  );

/** Напечатать строку в редакторе живыми клавишами — как человек. */
async function typeText(ide, text) {
  for (const char of text) {
    ide.webContents.sendInputEvent({ type: 'char', keyCode: char });
    await wait(30);
  }
  ide.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  ide.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await wait(300);
}

app.whenReady().then(async () => {
  const mode = process.env.CHUI_PROBE_MODE ?? 'edit';
  const dir = process.env.CHUI_PROBE_DIR ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'chui-hot-exit-')));
  const project = path.join(dir, 'demo-project');
  const sessionDir = path.join(dir, 'sessions');
  const settingsFile = path.join(dir, 'settings.json');
  const file = path.join(project, 'demo.ts');

  if (mode === 'edit') {
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(file, ORIGINAL, 'utf8');
  }
  serveRenderer();

  const settings = new SettingsStore(settingsFile);
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  const sessions = new SessionStore(sessionDir);

  // В проверке возврата несохранённую правку кладём в сессию ДО запуска окна: так
  // проверяем именно возврат работы, а не ввод клавишами.
  if (mode === 'check') {
    sessions.save(project, {
      tabs: [file],
      activeTab: file,
      expanded: [project],
      unsaved: [{ path: file, text: `${ORIGINAL}${UNSAVED_LINE}\n` }],
    });
    console.log(`[hot-exit] в сессию записана несохранённая правка: ${UNSAVED_LINE}`);
  }

  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient(), sessions });
  await workspace.open(project);
  console.log(`[hot-exit] проект: ${project}`);

  const ide = openIdeWindow();
  await wait(7000);

  if (mode === 'edit') {
    console.log(`[hot-exit] открыть файл: ${JSON.stringify(await openInTree(ide, 'demo.ts'))}`);
    await wait(2000);
    // Печатаем в конце файла: курсор ставим клавишами в самый конец.
    ide.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['control'] });
    ide.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['control'] });
    await wait(200);
    await typeText(ide, UNSAVED_LINE);
    console.log(`[hot-exit] после набора: ${JSON.stringify(await editorState(ide))}`);
    // Сессию пишут с задержкой (она длиннее, чем у вкладок): ждём, пока осядет.
    await wait(4000);
    const saved = sessions.load(project);
    console.log(
      `[hot-exit] в сессии: ${JSON.stringify({
        вкладки: saved.tabs.map((item) => path.basename(item)),
        несохранённых: (saved.unsaved ?? []).map((item) => ({
          файл: path.basename(item.path),
          строки: item.text.split('\n').length,
        })),
        правка_в_сессии: (saved.unsaved ?? []).some((item) => item.text.includes(UNSAVED_LINE)),
      })}`,
    );
    const onDisk = await fs.readFile(file, 'utf8');
    console.log(`[hot-exit] файл на диске не тронут: ${onDisk === ORIGINAL}`);
  } else {
    await wait(1500);
    const state = await editorState(ide);
    console.log(
      `[hot-exit] редактор после перезапуска: ${JSON.stringify({
        вкладка: state.вкладка,
        не_сохранён: state.не_сохранён,
        правка_на_экране: state.строки.some((line) => line.includes(UNSAVED_LINE)),
      })}`,
    );
    const onDisk = await fs.readFile(file, 'utf8');
    console.log(`[hot-exit] файл на диске по-прежнему исходный: ${onDisk === ORIGINAL}`);
  }

  terminals.dispose();
  workspace.dispose();
  // Каталог не убираем: он общий для двух запусков, его чистит внешний скрипт.
  app.exit(0);
});
