/**
 * Проба проверки подтверждений в живом окне: строка «разрешено проверкой»
 * и причина в карточке.
 *
 *   npm run probe:approval
 *
 * Юнит-тесты стерегут разбор ответа, smoke — провод запроса к модели. Здесь
 * проверяется стык с интерфейсом, которого не видно ни там, ни там:
 *
 *   1. событие `approval:review` (main разрешил команду сам) превращается в
 *      строку ленты со значком искры, командой и причиной;
 *   2. запрос подтверждения, к которому приложена причина проверки
 *      (`ai.confirmCommand` с полем `review`), показывает её в карточке — человек
 *      видит, что смутило модель, а не только саму команду;
 *   3. решение из карточки возвращается в main как раньше: отмена — `false`.
 *
 * Нужен собранный код (`npm run build`). Снимок — `.chui_ide/probe-shots/approval-review.png`.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');
const { PushTopic } = require('../dist/shared/api.js');

registerAppScheme();
app.on('window-all-closed', () => {});

let failed = 0;
const check = (label, condition, extra) => {
  if (!condition) failed += 1;
  const tail = extra !== undefined ? `: ${JSON.stringify(extra)}` : '';
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${tail}`);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

const SHOTS = path.join(__dirname, '..', '.chui_ide', 'probe-shots');

app
  .whenReady()
  .then(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-approval-probe-'));
    const project = path.join(dir, 'demo');
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');
    await fs.mkdir(SHOTS, { recursive: true });

    serveRenderer();
    const settings = new SettingsStore(path.join(dir, 'settings.json'));
    // Проверка включена — как у человека, который её завёл.
    settings.update({ ai: { enabled: true, approvalReview: true } });
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

    // Настройка переживает запись и чтение — иначе включать её было бы нечем.
    check('проверка команд включается настройкой', settings.get().ai.approvalReview === true);

    // Открываем панель ассистента: строке ленты нужно место, куда лечь.
    pushToRenderers(PushTopic.MenuCommand, { command: 'ai.newChat' });
    await wait(600);

    /* ── 1. строка «разрешено проверкой» ─────────────────────────────────── */

    pushToRenderers(PushTopic.ApprovalReview, {
      command: 'git status --short',
      reason: 'команда только читает состояние репозитория',
    });
    await wait(500);

    const note = await ask(
      ide,
      `(() => {
        const row = document.querySelector('.decision-line.is-review');
        if (!row) return null;
        return {
          текст: (row.textContent ?? '').replace(/\\s+/g, ' ').trim(),
          причина: (row.querySelector('.decision-status')?.textContent ?? '').trim(),
          знак: Boolean(row.querySelector('.icon')),
        };
      })()`,
    );

    check('строка о разрешении появилась в ленте', note !== null, note === null ? 'строки нет' : undefined);
    check('в строке названа команда', (note?.текст ?? '').includes('git status --short'), note?.текст);
    check('в строке стоит причина проверки', (note?.причина ?? '').length > 0, note?.причина);
    check('у строки есть значок', note?.знак === true, note?.знак);

    /* ── 2. причина проверки в карточке подтверждения ────────────────────── */

    const decision = host.request(
      ide.webContents,
      'ai.confirmCommand',
      { command: 'npm install left-pad', review: { decision: 'ask', reason: 'команда ставит пакеты в систему' } },
      new AbortController().signal,
    );

    await wait(900);

    const card = await ask(
      ide,
      `(() => {
        const box = document.querySelector('.approval');
        if (!box) return null;
        return {
          команда: (box.querySelector('.approval-command')?.textContent ?? '').trim(),
          причина: (box.querySelector('.approval-review-note')?.textContent ?? '').trim(),
          кнопок: box.querySelectorAll('.approval-actions .btn').length,
        };
      })()`,
    );

    check('карточка подтверждения открылась', card !== null, card === null ? 'карточки нет' : undefined);
    check('в карточке видна команда', (card?.команда ?? '').includes('npm install left-pad'), card?.команда);
    check('в карточке видна причина проверки', (card?.причина ?? '').includes('ставит пакеты'), card?.причина);
    check('решение по-прежнему за человеком: две кнопки', card?.кнопок === 2, card?.кнопок);

    const shot = path.join(SHOTS, 'approval-review.png');
    await fs.writeFile(shot, (await ide.capturePage()).toPNG());

    // Отмена в карточке возвращается в main как «не разрешено».
    await ask(
      ide,
      `(() => {
        const button = [...document.querySelectorAll('.approval .approval-actions .btn')].at(-1);
        if (!button) return 'нет кнопки';
        button.click();
        return 'нажато';
      })()`,
    );
    const answer = await Promise.race([decision, wait(3000).then(() => 'нет ответа')]);
    check('отмена в карточке вернула «не разрешено»', answer?.allowed === false, answer);

    const closed = await ask(
      ide,
      `(() => {
        const box = document.querySelector('.approval');
        return { ещёОткрыта: Boolean(box && !box.classList.contains('decision-done')), открытых: document.querySelectorAll('.approval').length };
      })()`,
    );
    check('после решения карточка свернулась в строку итога', closed?.ещёОткрыта === false, closed);

    /* ── 3. переключатель в настройках ─────────────────────────────────────── */

    pushToRenderers(PushTopic.MenuCommand, { command: 'settings.open' });
    await wait(1200);

    const settingsUi = await ask(
      ide,
      `(() => {
        const modal = document.querySelector('.settings-modal');
        if (!modal) return null;
        const text = (modal.textContent ?? '').replace(/\\s+/g, ' ');
        return {
          естьПереключатель: text.includes('Проверять команды моделью'),
          естьМодельПроверки: text.includes('Модель для проверки команд'),
          подсказка: text.includes('Необратимые команды проверка не трогает'),
        };
      })()`,
    );

    check('в настройках есть переключатель проверки', settingsUi?.естьПереключатель === true, settingsUi);
    check('и поле модели проверки', settingsUi?.естьМодельПроверки === true, settingsUi?.естьМодельПроверки);
    check('подсказка объясняет, что необратимое не проверяется', settingsUi?.подсказка === true);

    console.log(
      failed === 0 ? '\nпроверка подтверждений: лента, карточка и настройки на месте' : `\nпровалов: ${failed}`,
    );
    console.log(`Снимок: ${shot}`);

    terminals.dispose();
    workspace.dispose();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    app.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error('[проба] сбой:', error);
    app.exit(1);
  });
