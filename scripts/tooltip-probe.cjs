/**
 * Подсказки: свои вместо системных.
 *
 *   npm run probe:tooltip
 *
 * Поднимаем настоящее окно IDE и наводим курсор НАСТОЯЩИМ вводом (`sendInputEvent`),
 * а не синтетическим событием из скрипта: подсказка живёт на делегировании с
 * документа, и важно, как событие приходит на самом деле.
 *
 * Что проверяем:
 *
 *   1. при наведении на кнопку появляется НАШ слой `.app-tooltip` с текстом её
 *      подсказки, и он ровно один на окно;
 *   2. пока подсказка видна, у кнопки СНЯТ атрибут `title` — это и есть механизм,
 *      которым мы не даём вылезти системной подсказке;
 *   3. подсказка подключена ко ВСЕМ контролам сразу: вторую кнопку из другого
 *      модуля (панель проводника) никто к ней не привязывал, а подсказка есть;
 *   4. подсказка не перехватывает наведение (`pointer-events: none`) и лежит выше
 *      прочих всплывающих слоёв;
 *   5. уход курсора возвращает `title` и прячет слой;
 *   6. у края окна подсказка не уезжает за границу.
 */

const { app } = require('electron');
const { promises: fs, mkdtempSync } = require('node:fs');
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

// Свой профиль: проба не должна трогать настройки рабочего окна.
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'chui-tooltip-profile-')));

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (event, _level, message) => {
    const text = typeof message === 'string' ? message : (event?.message ?? '');
    if (String(text).trim()) console.log(`[подсказки][консоль] ${text}`);
  });
  contents.on('preload-error', (_e, file, error) => console.log(`[подсказки] preload ${file}: ${error.message}`));
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([
    window.webContents.executeJavaScript(expression).catch((error) => `ошибка: ${error.message}`),
    wait(timeoutMs).then(() => 'нет ответа'),
  ]);

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

/** Середина элемента по селектору: точка, куда ведём курсор. */
const centerOf = (selector) =>
  `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`;

/** Состояние слоя подсказки и того элемента, над которым курсор. */
const tipState = (selector) =>
  `(() => {
    const layers = [...document.querySelectorAll('.app-tooltip')];
    const node = layers[0] ?? null;
    const visible = Boolean(node && !node.hidden);
    const rect = visible ? node.getBoundingClientRect() : null;
    const target = document.querySelector(${JSON.stringify(selector)});
    const style = node ? getComputedStyle(node) : null;
    return {
      слоёв: layers.length,
      видна: visible,
      текст: visible ? node.textContent : null,
      title: target ? target.getAttribute('title') : null,
      наведения: style ? style.pointerEvents : null,
      слой: style ? Number(style.zIndex) : null,
      внутриОкна: rect
        ? rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1
        : null,
    };
  })()`;

/** Навести курсор как человек: несколькими шагами, потом дать задержку показа. */
async function hover(ide, point) {
  for (const step of [0.5, 0.8, 1]) {
    ide.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x * step), y: Math.round(point.y * step) });
    await wait(60);
  }
  // Задержка показа в модуле — 450 мс; берём с запасом.
  await wait(800);
}

app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-tooltip-probe-'));
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

  await workspace.open(project);
  const ide = openIdeWindow();
  await wait(6000);
  ide.webContents.setZoomLevel(0);
  await wait(300);

  const topButton = '.topbar-left .icon-btn:last-of-type';
  const topTitle = await ask(
    ide,
    `document.querySelector(${JSON.stringify(topButton)})?.getAttribute('title') ?? null`,
  );
  console.log(`[подсказки] кнопка шапки: ${JSON.stringify(topTitle)}`);

  /* --- 1. Своя подсказка вместо системной --------------------------------------- */
  const before = await ask(ide, tipState(topButton));
  check('до наведения слой подсказки не показан', before?.видна === false, before?.видна);
  check('слой подсказки в окне ровно один', before?.слоёв === 1, before?.слоёв);

  await hover(ide, await ask(ide, centerOf(topButton)));
  const shown = await ask(ide, tipState(topButton));
  check('при наведении подсказка появилась', shown?.видна === true, shown?.видна);
  check('текст подсказки — подпись кнопки', shown?.текст === topTitle, shown?.текст);
  check('на время показа у кнопки снят `title` (системной не будет)', shown?.title === null, shown?.title);
  check('подсказка не перехватывает наведение', shown?.наведения === 'none', shown?.наведения);
  check('подсказка выше прочих слоёв', typeof shown?.слой === 'number' && shown.слой >= 340, shown?.слой);
  check('подсказка целиком внутри окна', shown?.внутриОкна === true, shown?.внутриОкна);

  /* --- 2. Уход курсора: подсказка гаснет, `title` возвращается ------------------- */
  const editor = await ask(ide, centerOf('.editor-island'));
  if (editor && typeof editor === 'object') await hover(ide, editor);
  const gone = await ask(ide, tipState(topButton));
  check('после ухода подсказка скрыта', gone?.видна === false, gone?.видна);
  check('`title` кнопки вернулся', gone?.title === topTitle, gone?.title);

  /* --- 3. Подсказки у контролов, которых к модулю не подключали ------------------ */
  const treeButton = await ask(
    ide,
    `(() => {
      const node = [...document.querySelectorAll('.panel-actions button')].find(
        (item) => (item.getAttribute('title') ?? '').length > 0,
      );
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: node.getAttribute('title') };
    })()`,
  );
  if (treeButton && typeof treeButton === 'object') {
    await hover(ide, treeButton);
    const panel = await ask(
      ide,
      `(() => {
        const node = document.querySelector('.app-tooltip');
        return { видна: Boolean(node && !node.hidden), текст: node ? node.textContent : null };
      })()`,
    );
    check('подсказка есть и у кнопки проводника (проводки не требовалось)', panel?.видна === true, panel);
    check('и её текст — подпись той кнопки', panel?.текст === treeButton.title, panel?.текст);
    await hover(ide, editor);
  } else {
    check('кнопка проводника с подсказкой найдена', false, treeButton);
  }

  /* --- 4. Подсказка у самого края окна -------------------------------------------- */
  const corner = await ask(
    ide,
    `(() => {
      const node = document.querySelector('.window-controls .window-btn:last-of-type');
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: node.getAttribute('title') };
    })()`,
  );
  if (corner && typeof corner === 'object') {
    await hover(ide, corner);
    const edge = await ask(
      ide,
      `(() => {
        const node = document.querySelector('.app-tooltip');
        if (!node || node.hidden) return { видна: false };
        const r = node.getBoundingClientRect();
        return { видна: true, текст: node.textContent, слева: Math.round(r.left), справа: Math.round(r.right), ширина: Math.round(window.innerWidth) };
      })()`,
    );
    check('кнопка окна в углу объясняет себя своей подсказкой', edge?.видна === true, edge?.текст);
    check(
      'у правого края подсказка не вылезла из окна',
      edge?.справа !== undefined && edge.справа <= edge.ширина + 1,
      edge,
    );
  } else {
    console.log('[подсказки] кнопок окна нет — проверка края пропущена');
  }

  /* --- 5. Фон подсказки — тот же материал, что у прочих всплывающих слоёв -------- */
  // Подсказка лежит поверх разных поверхностей: то над деревом (панель), то над
  // полотном редактора, то над полосой вкладок. Плотная подложка без блюра на них
  // читалась по-разному — над светлым полотном как серая плашка, над тёмной панелью
  // почти сливалась с ней. Поэтому фон берётся из того же материала, что у меню и
  // поповеров (`--popup_material` + `--popup_filter`), и вид у слоя один на всё окно.
  await hover(ide, await ask(ide, centerOf(topButton)));
  const material = await ask(
    ide,
    `(() => {
      const tip = document.querySelector('.app-tooltip');
      if (!tip || tip.hidden) return null;
      const style = getComputedStyle(tip);
      const root = getComputedStyle(document.documentElement);
      // Для сравнения — другой всплывающий слой того же вида (меню редактора).
      const menu = document.querySelector('.context-menu');
      const menuStyle = menu ? getComputedStyle(menu) : null;
      return {
        фон: style.backgroundColor,
        блюр: style.backdropFilter || style.webkitBackdropFilter || 'none',
        материал: root.getPropertyValue('--popup_material').trim(),
        плотный: root.getPropertyValue('--popup_background').trim(),
        прозрачность: style.opacity,
        менюБлюр: menuStyle ? menuStyle.backdropFilter || menuStyle.webkitBackdropFilter || 'none' : null,
        цветТекста: style.color,
        текстПрозрачность: style.opacity,
      };
    })()`,
  );
  check('подсказка нашлась для замера фона', material !== null, material);
  // Материал — полупрозрачный: у плотной плашки альфа ровно 1. По альфе и различаем,
  // потому что `color-mix` в вычисленном стиле уже развёрнут в `rgba(...)`.
  // Chromium разворачивает `color-mix` либо в `rgba(...)`, либо в `color(srgb ... / a)`:
  // альфу берём по тому виду, который пришёл.
  const alpha = (value) => {
    const text = String(value);
    const modern = /\/\s*([\d.]+)\s*\)/.exec(text);
    if (modern) return Number(modern[1]);
    const legacy = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(text);
    return legacy ? Number(legacy[1]) : 1;
  };
  check(
    'фон подсказки полупрозрачный — материал слоёв, а не плотная плашка',
    material !== null && alpha(material.фон) < 1 && alpha(material.фон) > 0.6,
    material && { фон: material.фон, альфа: alpha(material.фон) },
  );
  check(
    'у подсказки тот же блюр фона, что у прочих слоёв',
    material !== null && material.блюр !== 'none',
    material?.блюр,
  );
  check('подсказка не полупрозрачна целиком', material?.прозрачность === '1', material?.прозрачность);

  // Снимок: вид подсказки над панелью глазами — фон, рамка, тень и как сидит текст.
  const shots = path.join(__dirname, '..', '.chui_ide', 'probe-shots');
  await fs.mkdir(shots, { recursive: true });
  const image = await ide.capturePage();
  const shotFile = path.join(shots, 'tooltip.png');
  await fs.writeFile(shotFile, image.toPNG());
  console.log(`  снимок подсказки: ${shotFile}`);

  // Тот же фон — над полотном редактора и над деревом: подсказка одна на окно, но
  // подложка под ней разная, и вид не должен от этого меняться.
  const editorPoint = await ask(ide, centerOf('.editor-island'));
  if (editorPoint && typeof editorPoint === 'object') await hover(ide, editorPoint);
  const overEditor = await ask(
    ide,
    `(() => {
      const tip = document.querySelector('.app-tooltip');
      if (!tip || tip.hidden) return { видна: false };
      return { видна: true, фон: getComputedStyle(tip).backgroundColor };
    })()`,
  );
  // Подсказка над полотном может не появиться (у полотна нет подписи) — тогда
  // сравнивать нечего, но это не провал: фон задан правилом, а не местом.
  if (overEditor?.видна) {
    check('над полотном фон подсказки тот же', overEditor.фон === material?.фон, {
      надПолотном: overEditor.фон,
      было: material?.фон,
    });
  }

  /* --- 6. Длинная подсказка: переносится, и фон покрывает весь текст --------------- */
  // Грех: у подсказки дерева длинный путь. Если строка не переносится, текст вылезает
  // за `max-width` и фон под ним кончается — читается как «подсказка без подложки».
  const row = await ask(
    ide,
    `(() => {
      const node = [...document.querySelectorAll('.tree-row')].find((item) => item.getAttribute('title'));
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: node.getAttribute('title') };
    })()`,
  );
  if (row && typeof row === 'object') {
    await hover(ide, row);
    const longTip = await ask(
      ide,
      `(() => {
        const node = document.querySelector('.app-tooltip');
        if (!node || node.hidden) return { видна: false };
        const r = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          видна: true,
          текст: node.textContent,
          слева: Math.round(r.left), справа: Math.round(r.right),
          сверху: Math.round(r.top), снизу: Math.round(r.bottom),
          ширина: Math.round(r.width), высота: Math.round(r.height),
          прокруткаШ: node.scrollWidth, клиентШ: node.clientWidth,
          прокруткаВ: node.scrollHeight, клиентВ: node.clientHeight,
          перенос: style.whiteSpace, переполнение: style.overflow,
          переносСлов: style.overflowWrap || style.wordBreak,
          фон: style.backgroundColor,
        };
      })()`,
    );
    console.log(`[подсказки] длинная: ${JSON.stringify(longTip)}`);
    check('длинная подсказка показалась', longTip?.видна === true, longTip?.текст?.slice(0, 40));
    check(
      'текст не вылезает за подложку по ширине',
      longTip?.прокруткаШ !== undefined && longTip.прокруткаШ <= longTip.клиентШ + 1,
      longTip && { прокруткаШ: longTip.прокруткаШ, клиентШ: longTip.клиентШ },
    );
    check(
      'текст не вылезает за подложку по высоте',
      longTip?.прокруткаВ !== undefined && longTip.прокруткаВ <= longTip.клиентВ + 1,
      longTip && { прокруткаВ: longTip.прокруткаВ, клиентВ: longTip.клиентВ },
    );
    check('подложка не шире 340 px', (longTip?.ширина ?? 999) <= 340, longTip?.ширина);
  } else {
    console.log('[подсказки] строк дерева с подсказкой нет — проверка длинной пропущена');
  }

  /* --- 7. Подсказка ровно с тем текстом, что на снимке --------------------------- */
  // Путь в дереве бывает почти во всю ширину подсказки. Такой случай проверяем
  // отдельно: элемент заводим сами, чтобы текст был известен дословно.
  const LONG = '/home/dethmond/PROJECTS/GITHUB/chui_ide/package.json — тронут 1 ч назад';
  const probeNode = await ask(
    ide,
    `(() => {
      const old = document.getElementById('probe-long-tip');
      if (old) old.remove();
      const node = document.createElement('button');
      node.id = 'probe-long-tip';
      node.type = 'button';
      node.textContent = 'кнопка';
      node.style.cssText = 'position:fixed;left:40px;top:300px;width:120px;height:24px;z-index:900;';
      node.setAttribute('title', ${JSON.stringify(LONG)});
      document.body.appendChild(node);
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`,
  );
  if (probeNode && typeof probeNode === 'object') {
    await hover(ide, probeNode);
    const exact = await ask(
      ide,
      `(() => {
        const node = document.querySelector('.app-tooltip');
        if (!node || node.hidden) return { видна: false };
        const r = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        // Сколько занимает сам текст: диапазон по содержимому.
        const range = document.createRange();
        range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        return {
          видна: true,
          текст: node.textContent,
          подложка: { слева: Math.round(r.left), справа: Math.round(r.right), ширина: Math.round(r.width), высота: Math.round(r.height) },
          текстРамка: { слева: Math.round(text.left), справа: Math.round(text.right), высота: Math.round(text.height) },
          прокруткаШ: node.scrollWidth, клиентШ: node.clientWidth,
          padding: style.padding, коробка: style.boxSizing,
          строк: Math.round(text.height / parseFloat(style.lineHeight || '18')),
        };
      })()`,
    );
    console.log(`[подсказки] точный текст: ${JSON.stringify(exact)}`);
    check('подсказка с длинным путём показалась', exact?.видна === true, exact?.текст?.slice(0, 30));
    check(
      'текст внутри подложки справа',
      exact?.текстРамка !== undefined && exact.текстРамка.справа <= exact.подложка.справа + 1,
      exact && { текст: exact.текстРамка.справа, подложка: exact.подложка.справа },
    );
    check(
      'текст внутри подложки слева',
      exact?.текстРамка !== undefined && exact.текстРамка.слева >= exact.подложка.слева - 1,
      exact && { текст: exact.текстРамка.слева, подложка: exact.подложка.слева },
    );
    check(
      'текст не выходит за подложку по ширине',
      exact?.прокруткаШ !== undefined && exact.прокруткаШ <= exact.клиентШ + 1,
      exact && { прокруткаШ: exact.прокруткаШ, клиентШ: exact.клиентШ },
    );
    await ask(ide, `document.getElementById('probe-long-tip')?.remove()`);
  }

  console.log(failures === 0 ? '[подсказки] всё сошлось' : `[подсказки] провалов: ${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
  app.quit();
});
