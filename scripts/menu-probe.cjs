/**
 * Диагностика меню приложения: поднимаем окно IDE в настоящем Electron и жмём
 * по кнопке «☰» так же, как это делает человек. Нужно, чтобы отличить проблему
 * самого меню от среды браузерной проверки.
 *
 *   ./node_modules/.bin/electron scripts/menu-probe.cjs
 */
const { app } = require('electron');
const { promises: fs, mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AiService } = require('../dist/main/ai/service.js');
const { GitService } = require('../dist/main/git/git.js');
const { HostClient } = require('../dist/main/ipc/host.js');
const { createApplicationMenu } = require('../dist/main/menu.js');
const { registerIpc } = require('../dist/main/ipc/register.js');
const { pushToRenderers } = require('../dist/main/ipc/push.js');
const { registerAppScheme, serveRenderer } = require('../dist/main/protocol.js');
const { SettingsStore } = require('../dist/main/settings.js');
const { TerminalService } = require('../dist/main/terminal/terminal.js');
const { WorkspaceService } = require('../dist/main/workspace/workspace.js');
const { openIdeWindow } = require('../dist/main/window.js');

registerAppScheme();

// Свой профиль: иначе пробник пишет в общий userData — масштаб страницы, который
// он же и меняет, остаётся и влияет на следующие запуски (координаты ввода
// в пикселях окна, а разметка в CSS-пикселях, при масштабе ≠ 1 они разъезжаются).
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'chui-menu-profile-')));

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event, level, message) => {
    const text = typeof message === 'string' ? message : (event?.message ?? '');
    if (String(text).trim()) console.log(`[меню][консоль] ${text}`);
  });
  contents.on('preload-error', (_e, file, error) => console.log(`[меню] preload ${file}: ${error.message}`));
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

/** Состояние открытых панелей меню: сколько уровней и что подсвечено. */
const MENU_STATE = `(() => {
  const levels = [...document.querySelectorAll('.context-menu')];
  return {
    levels: levels.length,
    top: [...document.querySelectorAll('.context-menu')].map((m) =>
      [...m.querySelectorAll('.context-item')].map((i) => i.textContent.trim())),
    highlighted: levels[levels.length - 1]?.querySelector('.context-item.is-highlighted')?.textContent.trim() ?? null,
    button: document.querySelector('.topbar-left .icon-btn')?.className ?? null,
  };
})()`;

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-menu-probe-'));
  const project = path.join(dir, 'demo-project');
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
  registerIpc({ settings, workspace, ai, terminals, git, host: new HostClient() });
  // Системное меню ставим так же, как приложение: оно тоже может влиять на ввод.
  createApplicationMenu();

  await workspace.open(project);
  const ide = openIdeWindow();
  await wait(5000);
  // Масштаб страницы — ровно 1: иначе координаты кликов смысла не имеют.
  ide.webContents.setZoomLevel(0);
  await wait(300);

  console.log(
    `[меню] одно окно отрисовалось: ${JSON.stringify(await ask(ide, `Boolean(document.querySelector('.app'))`))}`,
  );
  console.log(
    `[меню] кнопка есть: ${JSON.stringify(await ask(ide, `document.querySelector('.topbar-left .icon-btn')?.title ?? null`))}`,
  );

  // 1. Клик по кнопке: меню должно появиться.
  await ask(ide, `document.querySelector('.topbar-left .icon-btn').click(); 'нажали'`);
  await wait(600);
  console.log(`[меню] после клика: ${JSON.stringify(await ask(ide, MENU_STATE))}`);

  // 2. Настоящее наведение мышью: подменю должно открываться от ТОГО пункта,
  //    над которым курсор. Синтетический mouseenter из скрипта такую ошибку
  //    не ловит — обработчики ходят через свой уровень, и важно, как событие
  //    приходит на самом деле.
  for (const label of ['Файл', 'Правка', 'Вид', 'AI']) {
    const point = await ask(
      ide,
      `(() => {
        const item = [...document.querySelectorAll('.context-menu [role="menuitem"]')]
          .find((node) => node.textContent.trim().startsWith(${JSON.stringify(label)}));
        if (!item) return null;
        const r = item.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`,
    );
    if (!point || typeof point !== 'object') {
      console.log(`[меню] наведение «${label}»: пункт не найден`);
      continue;
    }
    for (const step of [0.5, 0.8, 1]) {
      ide.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(point.x * step),
        y: Math.round(point.y * step),
      });
      await wait(60);
    }
    await wait(350);
    const state = await ask(
      ide,
      `(() => {
        const levels = [...document.querySelectorAll('.context-menu')];
        return {
          levels: levels.length,
          highlighted: levels[levels.length - 1]?.querySelector('.context-item.is-highlighted')?.textContent.trim() ?? null,
          submenu: levels[1]?.querySelector('.context-item')?.textContent.trim() ?? null,
        };
      })()`,
    );
    console.log(`[меню] наведение «${label}»: ${JSON.stringify(state)}`);
  }

  // Закрываем меню Esc: дальше идут проверки с чистого листа.
  await ask(ide, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  await wait(300);

  // 3. Клик по пункту-команде «Обновить дерево»: меню закрывается, команда идёт в реестр.
  await ask(
    ide,
    `(() => {
      const item = [...document.querySelectorAll('.context-menu [role="menuitem"]')]
        .find((node) => node.textContent.trim().startsWith('Обновить дерево'));
      item?.click();
      return Boolean(item);
    })()`,
  );
  await wait(800);
  console.log(`[меню] после выбора пункта: ${JSON.stringify(await ask(ide, MENU_STATE))}`);

  // 4. Пункт-роль: масштаб должен измениться ровно на шаг.
  const before = ide.webContents.getZoomLevel();
  await ask(ide, `document.querySelector('.topbar-left .icon-btn').click(); 'нажали'`);
  await wait(500);
  await ask(
    ide,
    `(() => {
      const view = [...document.querySelectorAll('.context-menu [role="menuitem"]')]
        .find((node) => node.textContent.trim().startsWith('Вид'));
      view?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      return Boolean(view);
    })()`,
  );
  await wait(500);
  await ask(
    ide,
    `(() => {
      const item = [...document.querySelectorAll('.context-menu [role="menuitem"]')]
        .find((node) => node.textContent.trim().startsWith('Крупнее'));
      item?.click();
      return Boolean(item);
    })()`,
  );
  await wait(800);
  const after = ide.webContents.getZoomLevel();
  console.log(
    `[меню] масштаб: ${before} → ${after} (${after === before + 0.5 ? 'роль сработала' : 'роль НЕ сработала'})`,
  );

  // 5. Настоящий ввод, а не вызов из скрипта: клик мышью по кнопке и Alt+F10.
  //    Так видно, доходит ли событие до renderer'а через оконный менеджер.
  ide.focus();
  const point = await ask(
    ide,
    `(() => {
      const rect = document.querySelector('.topbar-left .icon-btn').getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`,
  );
  await ask(ide, `document.querySelectorAll('.context-menu').forEach((m) => m.remove()); 1`);
  ide.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  ide.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await wait(700);
  const byMouse = await ask(ide, MENU_STATE);
  console.log(`[меню] реальный клик мышью: ${JSON.stringify(byMouse)}`);

  // Снимок окна с открытым меню: видно ли его вообще и где он лежит.
  const shot = path.join(process.env.TMPDIR ?? '/tmp', 'chui-menu-probe.png');
  await fs.writeFile(shot, (await ide.capturePage()).toPNG());
  console.log(`[меню] снимок: ${shot}`);

  // 6. Настоящий клик по ПУНКТУ меню: именно так делает человек. Ниже — эффект,
  //    который видно снаружи: «Боковая панель» переключает класс на корне приложения.
  const clickText = async (text) => {
    const rect = await ask(
      ide,
      `(() => {
        const items = [...document.querySelectorAll('.context-menu [role="menuitem"]')];
        const item = items.find((node) => node.textContent.trim().startsWith(${JSON.stringify(text)}));
        if (!item) return null;
        const r = item.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`,
    );
    if (!rect || typeof rect !== 'object') return `пункт «${text}» не найден`;
    for (const type of ['mouseDown', 'mouseUp']) {
      ide.webContents.sendInputEvent({ type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    }
    await wait(600);
    return 'нажали';
  };

  const sidebarHidden = () => ask(ide, `document.querySelector('.app').classList.contains('is-sidebar-hidden')`);

  const beforeToggle = await sidebarHidden();
  console.log(`[меню] клик по «Вид»: ${await clickText('Вид')}`);
  console.log(`[меню] уровней после «Вид»: ${JSON.stringify(await ask(ide, MENU_STATE))}`);
  console.log(`[меню] клик по «Боковая панель»: ${await clickText('Боковая панель')}`);
  const afterToggle = await sidebarHidden();
  console.log(
    `[меню] панель: было скрыто=${beforeToggle} стало скрыто=${afterToggle} (${
      beforeToggle !== afterToggle ? 'команда сработала' : 'команда НЕ сработала'
    })`,
  );
  console.log(`[меню] меню закрылось: ${JSON.stringify(await ask(ide, MENU_STATE))}`);

  await ask(ide, `document.querySelectorAll('.context-menu').forEach((m) => m.remove()); 1`);
  ide.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F10', modifiers: ['alt'] });
  ide.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F10', modifiers: ['alt'] });
  await wait(700);
  const byKey = await ask(ide, MENU_STATE);
  console.log(`[меню] реальный Alt+F10: ${JSON.stringify(byKey)}`);

  // 7. Диагностика попадания: куда реально пришёл клик и как соотносятся
  //    CSS-пиксели с пикселями окна (масштаб страницы их разводит).
  console.log(
    `[меню] масштаб страницы: level=${ide.webContents.getZoomLevel()} factor=${ide.webContents.getZoomFactor()} dpr=${await ask(
      ide,
      'devicePixelRatio',
    )}`,
  );
  await ask(
    ide,
    `(() => {
      window.__hits = [];
      if (!window.__hitHook) {
        window.__hitHook = true;
        document.addEventListener(
          'click',
          (event) => {
            const node = event.target;
            window.__hits.push({ text: (node?.textContent ?? '').trim().slice(0, 14), cls: node?.className ?? null });
          },
          true,
        );
      }
      return true;
    })()`,
  );

  for (const label of ['Файл', 'Правка', 'Вид', 'AI']) {
    await ask(ide, `document.querySelectorAll('.context-menu').forEach((m) => m.remove()); 1`);
    await ask(ide, `document.querySelector('.topbar-left .icon-btn').click(); 'открыли'`);
    await wait(400);
    const answer = await clickText(label);
    const hits = await ask(ide, 'JSON.stringify(window.__hits.splice(0))');
    console.log(`[меню] цель «${label}»: ${answer}, получили клик по ${hits}`);
  }

  terminals.dispose();
  workspace.dispose();
  app.exit(0);
});
