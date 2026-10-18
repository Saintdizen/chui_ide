/**
 * Проба создания окружения ВНЕ проекта: в своей папке на диске.
 *
 *   npm run probe:venv
 *
 * Что проверяем и почему именно так. Окружение можно создать в проекте (обычный
 * случай — `.venv` рядом с кодом), а можно вне его: `~/.venvs` или своя папка.
 * Внешнее окружение поиск в проекте не находит никогда, поэтому после создания его
 * назначают интерпретатором проекта — иначе человек создал бы окружение, которым
 * ничего не пользуется. Это и есть главное, что видно только в живом окне:
 * создали → каталог появился вне проекта → проект получил его питон.
 *
 * Проверка идёт через настоящий интерфейс: команда из палитры открывает окно
 * окружений, место и путь выбираются в нём, кнопка «Создать окружение» запускает
 * `python -m venv`. Серверу pypi интернет не нужен: уровень пакетов — «пустое».
 *
 * Базовый интерпретатор ищется честно: годится только тот, у которого есть модуль
 * `venv` (у системного питона его часто нет — тогда `python -m venv` падает на
 * ensurepip). Проба перебирает найденные и берёт первый рабочий.
 *
 * Нужен собранный renderer (npm run build). Отчёт — вывод в консоль.
 */
const { app } = require('electron');
const { spawnSync } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { findInterpreters } = require('../dist/main/python/interpreters.js');
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
const ask = (window, expression, timeoutMs = 60000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Команда из палитры — тем же путём, что у человека. */
const runCommand = (title) =>
  `(async () => {
      const button = [...document.querySelectorAll('.icon-btn')].find((item) =>
        (item.getAttribute('title') ?? '').startsWith('Палитра команд'),
      );
      if (!button) return 'нет кнопки палитры';
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const input = document.querySelector('.palette-input');
      if (!input) return 'нет поля палитры';
      input.value = ${JSON.stringify(title)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const item = [...document.querySelectorAll('.palette-item')].find((node) =>
        (node.textContent ?? '').includes(${JSON.stringify(title)}),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return 'выполнено';
    })()`;

/** Выбрать значение в нашем списке выбора (он не `<select>`, а кнопка со списком). */
const pickInRow = (rowLabel, optionLabel) =>
  `(async () => {
      const row = [...document.querySelectorAll('.venv-modal .venv-field')].find(
        (node) => (node.querySelector('.venv-label')?.textContent ?? '') === ${JSON.stringify(rowLabel)},
      );
      const select = row?.querySelector('.select');
      if (!select) return 'нет списка';
      select.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const item = [...document.querySelectorAll('.select-popup .select-item')].find(
        (node) => (node.querySelector('.select-item-label')?.textContent ?? '') === ${JSON.stringify(optionLabel)},
      );
      if (!item) return 'нет пункта ' + ${JSON.stringify(optionLabel)};
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return 'выбрано';
    })()`;

/** Первый интерпретатор, который действительно умеет создавать окружения. */
async function workingInterpreter() {
  // Переменная окружения — крайний случай: на машине без рабочего питона пробу
  // всё равно можно прогнать, указав его руками.
  const forced = process.env.CHUI_PROBE_PYTHON;
  const candidates = forced ? [{ command: forced }] : await findInterpreters(process.platform);
  for (const interpreter of candidates) {
    const probe = path.join(os.tmpdir(), `chui-venv-check-${process.pid}`);
    const result = spawnSync(interpreter.command, ['-m', 'venv', probe], { encoding: 'utf8' });
    const ok = result.status === 0;
    await fs.rm(probe, { recursive: true, force: true }).catch(() => undefined);
    if (ok) return interpreter.command;
  }
  return null;
}

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-venv-probe-')));
  const project = path.join(dir, 'demo');
  const outside = path.join(dir, 'venvs', 'shared-demo');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'main.py'), 'print(1)\n', 'utf8');
  await fs.writeFile(path.join(project, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');

  const base = await workingInterpreter();
  check('нашёлся интерпретатор с модулем venv', base !== null, base);

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const git = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai: new AiService(settings, workspace), terminals, git, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  const opened = await ask(ide, runCommand('Python: виртуальные окружения'));
  check('окно окружений открылось командой', opened === 'выполнено', opened);

  const form = await ask(
    ide,
    `(() => {
      const modal = document.querySelector('.venv-modal');
      if (!modal) return { открыто: false };
      const labels = [...modal.querySelectorAll('.venv-label')].map((node) => node.textContent ?? '');
      const pathRow = modal.querySelector('.venv-path-row');
      return {
        открыто: true,
        поля: labels,
        путь_скрыт: pathRow?.closest('.venv-field')?.hidden ?? null,
      };
    })()`,
  );
  check('в окне есть выбор места и поле каталога', form.открыто && form.поля.includes('Где'), form.поля);
  check('поле своего пути скрыто, пока место — проект', form.путь_скрыт === true, form.путь_скрыт);

  const picked = await ask(ide, pickInRow('Где', 'Своя папка'));
  check('место «Своя папка» выбирается', picked === 'выбрано', picked);

  const revealed = await ask(
    ide,
    `(() => {
      const row = document.querySelector('.venv-modal .venv-path-row')?.closest('.venv-field');
      const nameRow = [...document.querySelectorAll('.venv-modal .venv-field')].find(
        (node) => (node.querySelector('.venv-label')?.textContent ?? '') === 'Каталог',
      );
      return { путь_виден: row?.hidden === false, имя_скрыто: nameRow?.hidden === true };
    })()`,
  );
  check('для своей папки показывается путь, а поле имени скрыто', revealed.путь_виден && revealed.имя_скрыто, revealed);

  if (base) {
    // В списке интерпретаторов подпись — версия («Python 3.9»), а команда лежит
    // подсказкой пункта (`.select-item-hint`): по ней и выбираем.
    const basePicked = await ask(
      ide,
      `(async () => {
          const row = [...document.querySelectorAll('.venv-modal .venv-field')].find(
            (node) => (node.querySelector('.venv-label')?.textContent ?? '') === 'Интерпретатор',
          );
          const select = row?.querySelector('.select');
          if (!select) return 'нет списка';
          select.click();
          await new Promise((resolve) => setTimeout(resolve, 200));
          const item = [...document.querySelectorAll('.select-popup .select-item')].find(
            (node) => (node.querySelector('.select-item-hint')?.textContent ?? '') === ${JSON.stringify(base)},
          );
          if (!item) return 'нет пункта с командой ' + ${JSON.stringify(base)};
          item.click();
          await new Promise((resolve) => setTimeout(resolve, 200));
          return 'выбрано';
        })()`,
    );
    check('базовый интерпретатор выбран', basePicked === 'выбрано', basePicked);
  }
  const preset = await ask(ide, pickInRow('Пакеты', 'Пустое окружение'));
  check('уровень пакетов — пустое окружение (без сети)', preset === 'выбрано', preset);

  const created = await ask(
    ide,
    `(async () => {
      const input = document.querySelector('.venv-modal .venv-path-row .field-input');
      if (!input) return { запуск: 'нет поля пути' };
      input.value = ${JSON.stringify(outside)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const button = [...document.querySelectorAll('.venv-modal .btn')].find(
        (node) => (node.textContent ?? '').includes('Создать окружение'),
      );
      if (!button) return { запуск: 'нет кнопки' };
      button.click();
      // Создание — процесс: ждём, пока окно закроется (оно закрывается на успехе).
      for (let step = 0; step < 120; step += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!document.querySelector('.venv-modal')?.closest('.modal-backdrop, .overlay')?.hidden) continue;
        const toast = [...document.querySelectorAll('.toast-text')].map((node) => node.textContent ?? '');
        return { запуск: 'выполнено', уведомления: toast };
      }
      const log = document.querySelector('.venv-log')?.textContent ?? '';
      return { запуск: 'окно не закрылось', журнал: log.slice(-400) };
    })()`,
    120000,
  );
  check('окружение создано через окно', created.запуск === 'выполнено', created);

  const onDisk = await fs
    .stat(path.join(outside, 'bin', 'python'))
    .then(() => true)
    .catch(() => false);
  check('каталог окружения появился ВНЕ проекта', onDisk, outside);
  const insideProject = await fs
    .stat(path.join(project, '.venv'))
    .then(() => true)
    .catch(() => false);
  check('в проекте ничего не создалось', insideProject === false);

  // Главное следствие: внешнее окружение назначено интерпретатором проекта —
  // иначе оно создано зря: поиск окружений в проекте его не видит.
  const saved = settings.get().run.pythonByRoot[project] ?? '';
  check('внешнее окружение стало интерпретатором проекта', saved === path.join(outside, 'bin', 'python'), {
    записано: saved,
  });

  // И запуск с тестами видит именно его: чип окружения в статусбаре показывает
  // окружение рабочего интерпретатора. Обновление идёт через push настроек —
  // поэтому ждём его, а не читаем чип один раз (первый кадр ещё старый).
  let chip = null;
  for (let step = 0; step < 40; step += 1) {
    chip = await ask(
      ide,
      `(() => {
          const node = document.querySelector('.status-env');
          return node && !node.hidden ? node.textContent ?? '' : null;
        })()`,
    );
    if (typeof chip === 'string' && chip.includes('shared-demo')) break;
    await wait(250);
  }
  check(
    'интерпретатор проекта — из внешнего окружения',
    typeof chip === 'string' && chip.includes('shared-demo'),
    chip,
  );

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  console.log(
    failed
      ? '[проба] окружение вне проекта: есть расхождения'
      : '[проба] окружение создаётся вне проекта и назначается проекту',
  );
  app.exit(failed ? 1 : 0);
});
