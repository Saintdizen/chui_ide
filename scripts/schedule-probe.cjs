/**
 * Проба расписания задач: окно, файл в проекте и срабатывание по часам.
 *
 *   npm run probe:schedule
 *
 * Расписание — единственная часть ассистента, которая начинает ход САМА. Юнит-тесты
 * проверяют арифметику времени и тик сервиса, но не видят главного стыка: «main
 * решил, что пора» → «окно начало ход». Поэтому проверяем в живом окне:
 *
 *   1. окно расписания открывается из меню и разложено по шапке, телу и подвалу;
 *   2. форма заводит задачу, и она ложится в `.chui/schedules.json` проекта с
 *      рассчитанным временем следующего срабатывания;
 *   3. приостановка и удаление работают через тот же файл;
 *   4. задача с прошедшим временем, отданная часами, доходит до окна и отмечает
 *      итог в файле — то есть путь «тик → push → ход в чате» цел.
 *
 * Ответ модели не проверяем: провайдера в пробе нет, и задача честно кончается
 * ошибкой настроек — именно это и видно в файле (`lastResult: failed`).
 *
 * Нужен собранный код (`npm run build`). Снимок — `.chui_ide/probe-shots/schedule.png`.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { ChatStore } = require('../dist/main/ai/chat-store.js');
const { GitService } = require('../dist/main/git/git.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { PushTopic } = require('../dist/shared/api.js');
const { ScheduleService } = require('../dist/main/schedules/schedules.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-schedule-probe-'));
    const project = path.join(dir, 'demo');
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');
    await fs.mkdir(SHOTS, { recursive: true });

    serveRenderer();
    const settings = new SettingsStore(path.join(dir, 'settings.json'));
    const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
    const git = new GitService(
      () => workspace.rootPath(),
      (topic, payload) => pushToRenderers(topic, payload),
    );
    const ai = new AiService(settings, workspace);
    const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
    // Часы — те же, что в приложении: корень проекта, «есть кому передать», «ассистент включён».
    const schedules = new ScheduleService({
      root: () => workspace.rootPath(),
      notify: (schedule) => pushToRenderers(PushTopic.ScheduleDue, { schedule }),
      canRun: () => true,
      aiEnabled: () => true,
    });
    registerIpc({
      settings,
      workspace,
      ai,
      terminals,
      git,
      schedules,
      chatStore: new ChatStore(path.join(dir, 'chats')),
      host: new HostClient(),
    });
    await workspace.open(project);

    const ide = openIdeWindow();
    await wait(6000);

    const file = path.join(project, '.chui', 'schedules.json');
    const readFile = async () => {
      try {
        return JSON.parse(await fs.readFile(file, 'utf8')).schedules;
      } catch {
        return null;
      }
    };

    /* ── 1. окно открывается и разложено ──────────────────────────────────── */

    await ask(ide, `(() => { window.chui.__probe = true; return true; })()`);
    pushToRenderers(PushTopic.MenuCommand, { command: 'ai.schedules' });
    await wait(900);

    const opened = await ask(
      ide,
      `(() => {
      const modal = document.querySelector('.schedule-modal');
      if (!modal) return null;
      const box = (node) => {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), h: Math.round(rect.height) };
      };
      // Само окно и есть .schedule-modal: класс добавляется к .modal.
      return {
        окно: box(modal),
        шапка: box(modal.querySelector('.modal-header')),
        тело: box(modal.querySelector('.modal-body')),
        подвал: box(modal.querySelector('.modal-footer')),
        форма: box(modal.querySelector('.schedule-form')),
        подвалВиден: !modal.querySelector('.modal-footer').hidden,
        пусто: (modal.querySelector('.schedule-empty')?.textContent ?? '').trim(),
      };
    })()`,
    );

    check('окно расписания открылось из меню', opened !== null, opened === null ? 'окна нет' : undefined);
    check(
      'окно разложено по шапке, телу и подвалу',
      Boolean(opened?.шапка && opened?.тело && opened?.подвал),
      opened && { шапка: Boolean(opened.шапка), тело: Boolean(opened.тело), подвал: Boolean(opened.подвал) },
    );
    check(
      'подвал прижат к низу окна',
      Boolean(opened && Math.abs(opened.подвал.bottom - opened.окно.bottom) <= 1),
      opened && { подвал: opened.подвал.bottom, окно: opened.окно.bottom },
    );
    check('список пока пуст и говорит об этом', (opened?.пусто ?? '').length > 0, opened?.пусто);
    check('форма задачи спрятана', opened?.форма?.h === 0 && opened?.подвалВиден === true, opened?.форма);

    /* ── 2. форма заводит задачу ──────────────────────────────────────────── */

    await ask(
      ide,
      `(() => {
      const modal = document.querySelector('.schedule-modal');
      const press = (label) =>
        [...modal.querySelectorAll('button')].find((node) => (node.textContent ?? '').trim() === label);
      press('Новая задача').click();
      return true;
    })()`,
    );
    await wait(400);

    const formState = await ask(
      ide,
      `(() => {
      const modal = document.querySelector('.schedule-modal');
      const form = modal.querySelector('.schedule-form');
      return {
        видна: form && !form.hidden,
        подвалСпрятан: modal.querySelector('.modal-footer').hidden,
        дниВидны: !form.querySelector('.schedule-weekdays').closest('.field-row').hidden,
        датаСкрыта: form.querySelector('.schedule-date').closest('.field-row').hidden,
        подпись: form.querySelector('.field-label').textContent,
      };
    })()`,
    );

    check('нажатие «Новая задача» открывает форму', formState?.видна === true, formState);
    check('пока форма открыта, подвал спрятан целиком', formState?.подвалСпрятан === true, formState?.подвалСпрятан);
    check(
      'по умолчанию правило — по дням недели',
      formState?.дниВидны === true && formState?.датаСкрыта === true,
      formState,
    );

    // Заполняем как человек: название, запрос, время; день недели — среда.
    const filled = await ask(
      ide,
      `(() => {
      const form = document.querySelector('.schedule-modal .schedule-form');
      const inputs = form.querySelectorAll('input');
      const set = (node, value) => {
        node.value = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(form.querySelector('input[type=text]'), 'Недельный отчёт');
      set(form.querySelector('textarea'), 'Собери отчёт по заметкам проекта');
      set(form.querySelector('input[type=time]'), '17:30');
      const wed = [...form.querySelectorAll('.schedule-weekday')].find((node) => (node.textContent ?? '').includes('ср'));
      const box = wed?.querySelector('input');
      if (!box) return 'нет среды';
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return inputs.length;
    })()`,
    );
    check('поля формы нашлись', typeof filled === 'number', filled);

    await ask(
      ide,
      `(() => {
      const modal = document.querySelector('.schedule-modal');
      [...modal.querySelectorAll('button')].find((node) => (node.textContent ?? '').trim() === 'Добавить').click();
      return true;
    })()`,
    );
    await wait(900);

    const createdRows = await ask(
      ide,
      `(() => {
      const modal = document.querySelector('.schedule-modal');
      const rows = [...modal.querySelectorAll('.schedule-item')];
      return {
        задач: rows.length,
        название: rows[0]?.querySelector('.schedule-title')?.textContent ?? '',
        правило: rows[0]?.querySelector('.schedule-meta')?.textContent ?? '',
        следующий: rows[0]?.querySelector('.schedule-when')?.textContent ?? '',
        подвалВиден: !modal.querySelector('.modal-footer').hidden,
      };
    })()`,
    );

    check('задача появилась в списке', createdRows?.задач === 1, createdRows?.задач);
    check('в строке видно название', createdRows?.название === 'Недельный отчёт', createdRows?.название);
    check(
      'в строке видно правило и день',
      (createdRows?.правило ?? '').includes('ср') && (createdRows?.правило ?? '').includes('17:30'),
      createdRows?.правило,
    );
    check(
      'в строке видно время следующего запуска',
      (createdRows?.следующий ?? '').includes('следующий запуск'),
      createdRows?.следующий,
    );
    check('подвал вернулся, когда форма закрылась', createdRows?.подвалВиден === true, createdRows?.подвалВиден);

    const stored = await readFile();
    check('задача легла в файл проекта', Array.isArray(stored) && stored.length === 1, stored);
    check(
      'в файле рассчитано время следующего срабатывания',
      Boolean(stored?.[0]?.nextRunAt > Date.now()),
      stored?.[0]?.nextRunAt,
    );
    check(
      'в файле сохранены правило и пояс',
      stored?.[0]?.time === '17:30' && typeof stored?.[0]?.timezone === 'string',
      {
        time: stored?.[0]?.time,
        timezone: stored?.[0]?.timezone,
      },
    );

    /* ── 3. приостановка и удаление идут через файл ───────────────────────── */

    await ask(
      ide,
      `(() => {
      const row = document.querySelector('.schedule-modal .schedule-item');
      const box = row.querySelector('.schedule-check input');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    );
    await wait(700);

    const paused = await ask(
      ide,
      `(() => {
      const row = document.querySelector('.schedule-modal .schedule-item');
      return { погашена: row.classList.contains('is-off'), когда: row.querySelector('.schedule-when')?.textContent ?? '' };
    })()`,
    );
    check('приостановленная задача гаснет в списке', paused?.погашена === true, paused);
    check('и говорит «приостановлена»', (paused?.когда ?? '').includes('приостановлена'), paused?.когда);
    check('в файле она выключена', (await readFile())?.[0]?.enabled === false, (await readFile())?.[0]?.enabled);

    pushToRenderers(PushTopic.MenuCommand, { command: 'ai.schedules' });
    await wait(700);
    await ide.webContents
      .executeJavaScript(
        `[...document.querySelectorAll('.schedule-modal .schedule-item .icon-btn')].at(-1)?.click() ?? null`,
      )
      .catch(() => undefined);
    await wait(700);

    const afterRemove = await ask(
      ide,
      `(() => {
      const modal = document.querySelector('.schedule-modal');
      return { задач: modal.querySelectorAll('.schedule-item').length, пусто: Boolean(modal.querySelector('.schedule-empty')) };
    })()`,
    );
    check('удаление убирает задачу из списка', afterRemove?.задач === 0 && afterRemove?.пусто === true, afterRemove);
    check('и из файла', (await readFile())?.length === 0, await readFile());

    /* ── 4. часы отдают задачу окну ───────────────────────────────────────── */

    const due = Date.now() - 60_000;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        schedules: [
          {
            id: 'probe-due',
            title: 'Проба часов',
            prompt: 'Проба расписания: ответь одной строкой',
            repeat: 'daily',
            time: '09:00',
            timezone: 'UTC',
            enabled: true,
            createdAt: due - 3_600_000,
            nextRunAt: due,
          },
        ],
      }),
      'utf8',
    );

    await schedules.tick(Date.now());
    await wait(1500);

    const fired = await readFile();
    check('часы отдали задачу окну', typeof fired?.[0]?.lastRunAt === 'number', fired?.[0]?.lastRunAt);
    check(
      'окно ответило итогом запуска',
      fired?.[0]?.lastResult === 'failed' || fired?.[0]?.lastResult === 'ok',
      fired?.[0]?.lastResult,
    );
    check(
      'следующее срабатывание уехало в будущее',
      fired?.[0]?.nextRunAt > Date.now() - 60_000,
      fired?.[0]?.nextRunAt,
    );

    const chatTab = await ask(
      ide,
      `(() => {
      const labels = [...document.querySelectorAll('.tab-label, .chat-tabs .chat-tab-label')].map((node) => (node.textContent ?? '').trim());
      const asked = [...document.querySelectorAll('.msg-user, .msg')].map((node) => (node.textContent ?? '').trim());
      return {
        вкладок: labels.length,
        вопросЗадан: asked.some((text) => text.includes('Проба расписания')),
      };
    })()`,
    );
    check('в чате появилась беседа задачи (вкладка есть)', (chatTab?.вкладок ?? 0) > 0, chatTab?.вкладок);

    const shot = path.join(SHOTS, 'schedule.png');
    await fs.writeFile(shot, (await ide.capturePage()).toPNG());

    console.log(failed === 0 ? '\nрасписание: окно, файл и часы согласованы' : `\nпровалов: ${failed}`);
    console.log(`Снимок: ${shot}`);

    schedules.dispose();
    terminals.dispose();
    workspace.dispose();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    app.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    // Без этого проба молча висела бы: обещание отверглось, окно закрывать некому.
    console.error('[проба] сбой:', error);
    app.exit(1);
  });
