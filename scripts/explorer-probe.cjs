/**
 * Проба проводника: множественное выделение и перенос перетаскиванием.
 *
 *   npm run probe:explorer
 *
 * Дерево — настоящее (реальные папки и файлы на диске), окно — настоящее: клики
 * с `Ctrl`/`Shift` и перетаскивание отправляются живыми событиями, а результат
 * переноса проверяется по файловой системе, а не по разметке: дерево могло
 * покраситься правильно, а файл остаться на месте.
 */
const { app, dialog } = require('electron');
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ask = (window, expression, timeoutMs = 20000) =>
  Promise.race([window.webContents.executeJavaScript(expression), wait(timeoutMs).then(() => 'нет ответа')]);

const exists = async (target) => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

app.whenReady().then(async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chui-explorer-probe-')));
  const project = path.join(dir, 'demo');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  // Символические ссылки трёх родов: на папку, на файл и битая. Создаём до открытия
  // окна — дерево читает папку на старте. На Windows ссылка может не создаться без
  // прав: тогда раздел пропускаем, но пробу не роняем.
  let linksOk = true;
  try {
    await fs.symlink('src', path.join(project, 'link-src'), 'dir');
    await fs.symlink('note.txt', path.join(project, 'link-note'), 'file');
    await fs.symlink('нет-такого', path.join(project, 'link-dead'));
  } catch (error) {
    linksOk = false;
    console.log(`[explorer] ссылки не создались: ${error.message}`);
  }
  await fs.mkdir(path.join(project, 'lib'), { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# demo\n', 'utf8');
  await fs.writeFile(path.join(project, 'note.txt'), 'перенос\n', 'utf8');
  await fs.writeFile(path.join(project, 'src', 'a.ts'), 'const a = 1;\n', 'utf8');
  // Скрытый файл — для проверки настроек НА КОРЕНЬ (см. ниже): общая настройка его
  // показывает, а своя настройка папки прячет.
  await fs.writeFile(path.join(project, '.secret.txt'), 'скрытое\n', 'utf8');
  // Вторая папка рабочей области: строки корней и «Настройки папки…» видны только
  // в многообласти.
  await fs.mkdir(path.join(dir, 'extra'), { recursive: true });
  // Файлы для проверки вложения: спутники рядом с родителем.
  await fs.mkdir(path.join(project, 'ui'), { recursive: true });
  await fs.writeFile(path.join(project, 'ui', 'Button.tsx'), 'export const Button = () => null;\n', 'utf8');
  await fs.writeFile(path.join(project, 'ui', 'Button.module.css'), '.btn {}\n', 'utf8');

  // Диалог выбора папки — свой: проба добавляет вторую папку рабочей области тем же
  // путём, что и человек (кнопка «+» в шапке проводника), а системное окно выбора
  // в прогоне не показать. Возвращаем подготовленный каталог.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(dir, 'extra')] });

  serveRenderer();
  const settings = new SettingsStore(path.join(dir, 'settings.json'));
  // Вложение включаем до открытия окна: дерево читает настройки на старте.
  settings.update({ explorer: { fileNesting: true } });
  const workspace = new WorkspaceService((topic, payload) => pushToRenderers(topic, payload));
  const gitService = new GitService(
    () => workspace.rootPath(),
    (topic, payload) => pushToRenderers(topic, payload),
  );
  const ai = new AiService(settings, workspace);
  const terminals = new TerminalService((topic, payload) => pushToRenderers(topic, payload));
  registerIpc({ settings, workspace, ai, terminals, git: gitService, host: new HostClient() });
  await workspace.open(project);

  const ide = openIdeWindow();
  await wait(6000);

  // Счётчик выделенного и имена — по ним видно, сработали ли `Ctrl` и `Shift`.
  const selected = () =>
    ask(
      ide,
      `[...document.querySelectorAll('.tree-row.is-selected')].map((row) => row.querySelector('.tree-name')?.textContent ?? '')`,
    );

  const click = (name, modifiers) =>
    ask(
      ide,
      `(() => {
        const row = [...document.querySelectorAll('.tree-row')].find(
          (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
        );
        if (!row) return 'нет строки ${name}';
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, ...${JSON.stringify(modifiers)} }));
        return 'ok';
      })()`,
    );

  console.log(`[explorer] один клик: ${JSON.stringify(await click('README.md', {}))}`);
  await wait(300);
  console.log(`[explorer] выделено: ${JSON.stringify(await selected())}`);

  console.log(`[explorer] Ctrl+клик: ${JSON.stringify(await click('note.txt', { ctrlKey: true }))}`);
  await wait(300);
  console.log(`[explorer] выделено после Ctrl: ${JSON.stringify(await selected())}`);

  console.log(`[explorer] Ctrl+клик по тому же — снять: ${JSON.stringify(await click('note.txt', { ctrlKey: true }))}`);
  await wait(300);
  console.log(`[explorer] выделено после снятия: ${JSON.stringify(await selected())}`);

  /* ── создание и переименование из дерева ─────────────────────────────── */

  // Регрессия: инлайн-поле ввода имени открывалось и тут же закрывалось само,
  // потому что `paint` заводил НОВЫЙ наблюдатель за высотой дерева, не снимая
  // прежний. Прежний следил за уже отброшенным узлом (высота ноль) и пересобирал
  // строки ещё раз — поле теряло фокус, `blur` отменял ввод. Проверяем не только
  // итог (файл на диске), но и что поле ЖИВО во времени: иначе гонка проскочила бы.
  const openTreeMenu = (name) =>
    ask(
      ide,
      `(() => {
        const row = [...document.querySelectorAll('.tree-row')].find(
          (item) => item.querySelector('.tree-name')?.textContent === ${JSON.stringify(name)},
        );
        if (!row) return 'нет строки';
        const rect = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8 }));
        return 'ok';
      })()`,
    );
  const clickTreeMenu = (label) =>
    ask(
      ide,
      `(async () => {
        const item = [...document.querySelectorAll('.context-menu .context-item')].find((node) =>
          (node.textContent ?? '').includes(${JSON.stringify(label)}),
        );
        if (!item) return 'пункта нет';
        item.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'нажато';
      })()`,
    );
  const typeName = (value) =>
    ask(
      ide,
      `(async () => {
        const input = document.querySelector('.tree-input');
        if (!input) return 'нет поля ввода';
        input.focus();
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 80));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 900));
        return 'введено';
      })()`,
    );
  // Поле обязано пережить несколько кадров: если его гасит лишняя пересборка строк,
  // это видно уже на 300–400 мс, а не только по отсутствию файла.
  const inputAlive = () =>
    ask(
      ide,
      `(async () => {
        const seen = [];
        for (let i = 0; i < 5; i += 1) {
          seen.push(Boolean(document.querySelector('.tree-input')));
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return seen;
      })()`,
    );

  console.log(`[explorer] меню на строке src: ${JSON.stringify(await openTreeMenu('src'))}`);
  await wait(400);
  console.log(`[explorer] «Новый файл…» нажато: ${JSON.stringify(await clickTreeMenu('Новый файл…'))}`);
  const createdField = await inputAlive();
  console.log(`[explorer] поле создания живо (по кадрам): ${JSON.stringify(createdField)}`);
  // У поля своя рамка в цвете фокуса, поэтому глобальный `outline` (`:focus-visible`)
  // давал ВТОРУЮ рамку — двойной контур. Индикатор фокуса должен быть один.
  console.log(
    `[explorer] обводка поля ввода (одна): ${JSON.stringify(
      await ask(
        ide,
        `(() => {
          const input = document.querySelector('.tree-input');
          if (!input) return null;
          const s = getComputedStyle(input);
          return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, borderColor: s.borderTopColor };
        })()`,
      ),
    )}`,
  );
  console.log(`[explorer] ввод имени файла: ${JSON.stringify(await typeName('created-in-tree.ts'))}`);
  console.log(`[explorer] файл появился на диске: ${await exists(path.join(project, 'src', 'created-in-tree.ts'))}`);

  console.log(`[explorer] меню на новом файле: ${JSON.stringify(await openTreeMenu('created-in-tree.ts'))}`);
  await wait(400);
  console.log(`[explorer] «Переименовать…» нажато: ${JSON.stringify(await clickTreeMenu('Переименовать…'))}`);
  const renameField = await inputAlive();
  console.log(`[explorer] поле переименования живо (по кадрам): ${JSON.stringify(renameField)}`);
  console.log(`[explorer] ввод нового имени: ${JSON.stringify(await typeName('renamed-in-tree.ts'))}`);
  console.log(
    `[explorer] переименование: новый=${await exists(path.join(project, 'src', 'renamed-in-tree.ts'))} старый=${await exists(path.join(project, 'src', 'created-in-tree.ts'))}`,
  );

  // Escape отменяет создание: ни файла, ни поля.
  await openTreeMenu('src');
  await wait(300);
  await clickTreeMenu('Новый файл…');
  await wait(400);
  await ask(
    ide,
    `(() => {
      const input = document.querySelector('.tree-input');
      if (!input) return 'нет поля';
      input.value = 'mut.txt';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'esc';
    })()`,
  );
  await wait(400);
  console.log(
    `[explorer] Escape отменяет создание: файла нет=${!(await exists(path.join(project, 'src', 'mut.txt')))} поле закрыто=${!(await ask(ide, `Boolean(document.querySelector('.tree-input'))`))}`,
  );

  if (linksOk) {
    // Как выглядят ссылки: класс, значок-стрелка и подсказка с целью.
    console.log(
      `[explorer] ссылки: ${JSON.stringify(
        await ask(
          ide,
          `[...document.querySelectorAll('.tree-row')]
            .filter((row) => (row.querySelector('.tree-name')?.textContent ?? '').startsWith('link-'))
            .map((row) => ({
              имя: row.querySelector('.tree-name').textContent,
              ссылка: row.classList.contains('is-symlink'),
              битая: row.classList.contains('is-broken-link'),
              значок: row.querySelector('.tree-badge.is-symlink')?.textContent ?? null,
              подсказка: row.getAttribute('title'),
            }))`,
        ),
      )}`,
    );

    // Ссылка на папку раскрывается: под ней появляется файл из цели.
    console.log(
      `[explorer] раскрытие ссылки на папку: ${JSON.stringify(
        await ask(
          ide,
          `(async () => {
            const row = [...document.querySelectorAll('.tree-row')].find(
              (item) => item.querySelector('.tree-name')?.textContent === 'link-src',
            );
            if (!row) return 'нет строки link-src';
            row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 900));
            const names = [...document.querySelectorAll('.tree-row .tree-name')].map((node) => node.textContent);
            // Строку перерисовали: берём её заново, чтобы прочитать раскрытый жёлоб.
            const again = [...document.querySelectorAll('.tree-row')].find(
              (item) => item.querySelector('.tree-name')?.textContent === 'link-src',
            );
            return {
              раскрыта: again?.querySelector('.tree-twisty')?.classList.contains('is-open') ?? false,
              дочерний: names.includes('a.ts'),
            };
          })()`,
        ),
      )}`,
    );

    // Ссылка на файл открывается двойным кликом — как обычный файл.
    console.log(
      `[explorer] открытие ссылки на файл: ${JSON.stringify(
        await ask(
          ide,
          `(async () => {
            const row = [...document.querySelectorAll('.tree-row')].find(
              (item) => item.querySelector('.tree-name')?.textContent === 'link-note',
            );
            if (!row) return 'нет строки link-note';
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 900));
            return { вкладка: document.querySelector('.tab.is-active .tab-label')?.textContent ?? null };
          })()`,
        ),
      )}`,
    );

    // Битая ссылка: клик ничего не открывает — вкладка остаётся прежней.
    console.log(
      `[explorer] битая ссылка: ${JSON.stringify(
        await ask(
          ide,
          `(async () => {
            const before = document.querySelector('.tab.is-active .tab-label')?.textContent ?? null;
            const row = [...document.querySelectorAll('.tree-row')].find(
              (item) => item.querySelector('.tree-name')?.textContent === 'link-dead',
            );
            if (!row) return 'нет строки link-dead';
            row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            await new Promise((resolve) => setTimeout(resolve, 700));
            return {
              битая_в_разметке: row.classList.contains('is-broken-link'),
              было: before,
              стало: document.querySelector('.tab.is-active .tab-label')?.textContent ?? null,
            };
          })()`,
        ),
      )}`,
    );
  }

  // Закрепление: правый клик по файлу → «Закрепить сверху»; строка появляется
  // в отдельном блоке над деревом, а повторное действие её убирает.
  await click('README.md', {});
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'README.md',
      );
      if (!row) return 'нет строки';
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8 }));
      return 'ok';
    })()`,
  );
  await wait(500);
  await ask(
    ide,
    `(async () => {
      const item = [...document.querySelectorAll('.context-menu .context-item')].find((node) =>
        (node.textContent ?? '').includes('Закрепить сверху'),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 'нажато';
    })()`,
  );
  await wait(600);
  console.log(
    `[explorer] закреплено: ${JSON.stringify(
      await ask(
        ide,
        `[...document.querySelectorAll('.tree-pins .tree-row.is-pinned')].map((row) =>
          row.querySelector('.tree-name')?.textContent ?? '')`,
      ),
    )}`,
  );
  await ask(ide, `document.querySelector('.tree-pins .tree-unpin')?.click()`);
  await wait(600);
  console.log(
    `[explorer] после открепления блоков: ${await ask(ide, `document.querySelectorAll('.tree-pins').length`)}`,
  );

  // Сравнение двух файлов: выделяем два файла и смотрим, что экран различий
  // открылся с обоими текстами. Блоки без кнопок — это просмотр, а не git.
  await click('note.txt', {});
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'README.md',
      );
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      return Boolean(row);
    })()`,
  );
  await wait(400);
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'README.md',
      );
      if (!row) return 'нет строки';
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8 }));
      return 'ok';
    })()`,
  );
  await wait(600);
  console.log(
    `[explorer] меню для двух файлов: ${JSON.stringify(
      await ask(ide, `[...document.querySelectorAll('.context-menu .context-item')].map((n) => n.textContent.trim())`),
    )}`,
  );
  await ask(
    ide,
    `(async () => {
      const item = [...document.querySelectorAll('.context-menu .context-item')].find((node) =>
        (node.textContent ?? '').startsWith('Сравнить:'),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return 'нажато';
    })()`,
  );
  await wait(1200);
  console.log(
    `[explorer] сравнение: ${JSON.stringify(
      await ask(
        ide,
        `(() => {
          const view = document.querySelector('.diff-view');
          return {
            открыто: view ? !view.hidden : false,
            заголовок: document.querySelector('.diff-title')?.textContent ?? null,
            подпись: document.querySelector('.diff-subtitle')?.textContent ?? null,
          };
        })()`,
      ),
    )}`,
  );
  await ask(ide, `document.querySelector('.diff-view .icon-btn')?.click()`);
  await wait(500);

  // Открытие вне IDE: меню предлагает системный проводник, внешнюю программу и
  // терминал в папке. Терминал проверяем по рабочему каталогу созданной сессии.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'src',
      );
      if (!row) return 'нет строки src';
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8 }));
      return 'ok';
    })()`,
  );
  await wait(600);
  const menu = await ask(
    ide,
    `[...document.querySelectorAll('.context-menu .context-item')].map((node) => node.textContent.trim())`,
  );
  console.log(`[explorer] пункты меню: ${JSON.stringify(menu)}`);

  await ask(
    ide,
    `(async () => {
      const item = [...document.querySelectorAll('.context-menu .context-item')].find((node) =>
        (node.textContent ?? '').includes('Открыть терминал в папке'),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return 'нажато';
    })()`,
  );
  await wait(1800);
  console.log(`[explorer] сессии терминала: ${JSON.stringify(terminals.list().map((item) => item.cwd))}`);

  // Перенос: тащим `note.txt` (уже выделен) на папку `src`.
  const dragged = await ask(
    ide,
    `(() => {
      const rows = [...document.querySelectorAll('.tree-row')];
      const from = rows.find((item) => item.querySelector('.tree-name')?.textContent === 'note.txt');
      const to = rows.find((item) => item.querySelector('.tree-name')?.textContent === 'src');
      if (!from || !to) return 'нет строк';
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
      const marked = to.classList.contains('is-drop-target');
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      return { подсвечена: marked };
    })()`,
  );
  console.log(`[explorer] перетаскивание: ${JSON.stringify(dragged)}`);
  await wait(1500);

  const movedInto = await exists(path.join(project, 'src', 'note.txt'));
  const stayedPut = await exists(path.join(project, 'note.txt'));
  console.log(`[explorer] note.txt переехал в src: ${movedInto}; остался на месте: ${stayedPut}`);

  // Второй перенос: тащим README.md на папку lib.
  await ask(
    ide,
    `(() => {
      const rows = [...document.querySelectorAll('.tree-row')];
      const from = rows.find((item) => item.querySelector('.tree-name')?.textContent === 'README.md');
      const to = rows.find((item) => item.querySelector('.tree-name')?.textContent === 'lib');
      if (!from || !to) return 'нет строк';
      from.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
      return 'ok';
    })()`,
  );
  await wait(1500);
  console.log(`[explorer] README.md в lib: ${await exists(path.join(project, 'lib', 'README.md'))}`);

  // Ctrl-протяжка — копирование: файл появляется в цели И остаётся на месте.
  // Папку src сперва раскрываем: её файл не нарисован, пока она свёрнута.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'src',
      );
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(row);
    })()`,
  );
  await wait(900);
  await ask(
    ide,
    `(() => {
      const rows = [...document.querySelectorAll('.tree-row')];
      const from = rows.find((item) => item.querySelector('.tree-name')?.textContent === 'a.ts');
      const to = rows.find((item) => item.querySelector('.tree-name')?.textContent === 'lib');
      if (!from || !to) return 'нет строк';
      from.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, ctrlKey: true }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, ctrlKey: true }));
      return 'ok';
    })()`,
  );
  await wait(1500);
  console.log(
    `[explorer] a.ts скопирован в lib: ${await exists(path.join(project, 'lib', 'a.ts'))}; ` +
      `остался в src: ${await exists(path.join(project, 'src', 'a.ts'))}`,
  );

  // Вложение: Button.module.css спрятан под Button.tsx (класс is-nested).
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'ui',
      );
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return Boolean(row);
    })()`,
  );
  await wait(800);
  console.log(
    `[explorer] вложение: ${JSON.stringify(
      await ask(
        ide,
        `[...document.querySelectorAll('.tree-row')]
          .filter((row) => ['Button.tsx', 'Button.module.css'].includes(row.querySelector('.tree-name')?.textContent ?? ''))
          .map((row) => ({
            имя: row.querySelector('.tree-name').textContent,
            вложен: row.classList.contains('is-nested'),
          }))`,
      ),
    )}`,
  );

  // Свежесть правки: только что записанный файл помечен точкой `is-recent`, а файл
  // со временем недельной давности (ставим utimes) — нет. Так проверка отличает
  // отметку о ВРЕМЕНИ от git-пометки о правках с коммита.
  await fs.writeFile(path.join(project, 'fresh.txt'), 'только что\n', 'utf8');
  await fs.writeFile(path.join(project, 'old.txt'), 'давно\n', 'utf8');
  const longAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(project, 'old.txt'), longAgo, longAgo);
  await wait(1500);

  console.log(
    `[explorer] свежесть правки: ${JSON.stringify(
      await ask(
        ide,
        `[...document.querySelectorAll('.tree-row')]
          .filter((row) => ['fresh.txt', 'old.txt'].includes(row.querySelector('.tree-name')?.textContent ?? ''))
          .map((row) => ({
            имя: row.querySelector('.tree-name').textContent,
            свежий: row.classList.contains('is-recent'),
            точка: Boolean(row.querySelector('.tree-dot.is-recent')),
          }))`,
      ),
    )}`,
  );

  /* ── автосохранение ─────────────────────────────────────────────────────── */

  // Режим «через паузу»: правим открытый файл и ждём — запись на диск должна случиться
  // сама, без Ctrl+S. Проверяем ФАЙЛ на диске, а не разметку: вкладка могла погасить
  // пометку «не сохранён» и от другого события.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'fresh.txt',
      );
      if (!row) return 'нет строки';
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return 'ok';
    })()`,
  );
  await wait(1500);
  settings.update({ editor: { autoSave: 'afterDelay', autoSaveDelayMs: 400 } });
  await wait(900);
  const autoTarget = path.join(project, 'fresh.txt');
  const autoBefore = await fs.readFile(autoTarget, 'utf8');
  await ask(ide, `document.querySelector('.own-editor-input')?.focus(); 'ok'`);
  ide.webContents.sendInputEvent({ type: 'char', keyCode: 'Z' });
  await wait(2500);
  const autoAfter = await fs.readFile(autoTarget, 'utf8');
  console.log(
    `[explorer] автосохранение: активная вкладка=${JSON.stringify(
      await ask(ide, `document.querySelector('.tab.is-active .tab-label')?.textContent ?? null`),
    )} записалось=${autoAfter !== autoBefore} стало=${JSON.stringify(autoAfter.trim())}`,
  );
  settings.update({ editor: { autoSave: 'off' } });
  await wait(400);

  /* ── избранное ─────────────────────────────────────────────────────────── */

  // Постоянный список мест: пункт «В избранное» в меню дерева кладёт путь в блок над
  // деревом, крестик его убирает. Список живёт в настройках IDE, а не в сессии проекта
  // (`workspace.favorites`) — поэтому проверяем и настройки, и разметку.
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'old.txt',
      );
      if (!row) return 'нет строки';
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8 }));
      return 'ok';
    })()`,
  );
  await wait(500);
  await ask(
    ide,
    `(async () => {
      const item = [...document.querySelectorAll('.context-menu .context-item')].find((node) =>
        (node.textContent ?? '').includes('В избранное'),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 'нажато';
    })()`,
  );
  await wait(700);
  console.log(
    `[explorer] избранное в блоке: ${JSON.stringify(
      await ask(
        ide,
        `[...document.querySelectorAll('.tree-favorites .tree-row.is-favorite')].map((row) => row.querySelector('.tree-name')?.textContent ?? '')`,
      ),
    )}`,
  );
  console.log(`[explorer] избранное в настройках: ${JSON.stringify(settings.get().workspace.favorites)}`);
  await ask(ide, `document.querySelector('.tree-favorites .tree-unfavorite')?.click()`);
  await wait(700);
  console.log(
    `[explorer] блоков избранного после снятия: ${await ask(ide, `document.querySelectorAll('.tree-favorites').length`)}`,
  );

  /* ── сторонние значки дерева ────────────────────────────────────────────── */

  // Правила «маска → подпись и цвет» приходят из настроек `explorer.badges` (их же
  // кладёт импорт набора файлом). Проверяем, что значок встал в строку с подписью,
  // цветом роли и подсказкой правила.
  settings.update({ explorer: { badges: [{ pattern: '*.txt', badge: 'txt', color: 'blue', title: 'черновик' }] } });
  await wait(1000);
  console.log(
    `[explorer] значок правила: ${JSON.stringify(
      await ask(
        ide,
        `(() => {
          const row = [...document.querySelectorAll('.tree-row')].find(
            (item) => item.querySelector('.tree-name')?.textContent === 'old.txt',
          );
          const badge = row?.querySelector('.tree-badge.is-custom');
          return badge
            ? {
                подпись: badge.textContent,
                цвет: badge.classList.contains('is-blue'),
                подсказка: badge.getAttribute('title'),
              }
            : 'значка нет';
        })()`,
      ),
    )}`,
  );
  settings.update({ explorer: { badges: [] } });
  await wait(600);

  /* ── настройки на каждый корень ─────────────────────────────────────────── */

  // Отличия для одной папки области: общая настройка скрытое показывает, а своя
  // настройка корня — прячет. Проверяем обе стороны: файл пропал из строк, а общее
  // значение осталось нетронутым.
  const hiddenRows = `[...document.querySelectorAll('.tree-row .tree-name')].map((node) => node.textContent).filter((name) => name === '.secret.txt')`;
  console.log(`[explorer] скрытый файл до своих настроек: ${JSON.stringify(await ask(ide, hiddenRows))}`);
  settings.update({ explorer: { byRoot: { [project]: { showHidden: false } } } });
  await wait(1000);
  console.log(`[explorer] скрытый файл при своих настройках папки: ${JSON.stringify(await ask(ide, hiddenRows))}`);
  console.log(`[explorer] общая настройка скрытого: ${settings.get().explorer.showHidden}`);

  // «Настройки папки…» — пункт меню строки КОРНЯ, а строки корней видны в многообласти.
  // Вторую папку добавляем кнопкой «+» в шапке проводника — через диалог, который
  // подменён выше, — а не вызовом сервиса: так проверяется и путь человека.
  await ask(
    ide,
    `(() => {
      const button = document.querySelector('.panel-actions .icon-btn[title="Добавить папку в рабочую область"]');
      if (!button) return 'кнопки нет';
      button.click();
      return 'нажато';
    })()`,
  );
  await wait(2200);
  console.log(`[explorer] строк корней: ${await ask(ide, `document.querySelectorAll('.tree-row.is-root').length`)}`);
  await ask(
    ide,
    `(() => {
      const row = [...document.querySelectorAll('.tree-row.is-root')].find(
        (item) => item.querySelector('.tree-name')?.textContent === 'demo',
      );
      if (!row) return 'нет строки корня';
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8 }));
      return 'ok';
    })()`,
  );
  await wait(600);
  console.log(
    `[explorer] меню корня: ${JSON.stringify(
      await ask(ide, `[...document.querySelectorAll('.context-menu .context-item')].map((n) => n.textContent.trim())`),
    )}`,
  );
  await ask(
    ide,
    `(async () => {
      const item = [...document.querySelectorAll('.context-menu .context-item')].find((node) =>
        (node.textContent ?? '').includes('Настройки папки'),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      return 'нажато';
    })()`,
  );
  await wait(800);
  console.log(
    `[explorer] окно настроек папки: ${JSON.stringify(
      await ask(
        ide,
        `(() => {
          const modal = document.querySelector('.root-settings-modal');
          return {
            открыто: Boolean(modal && !modal.closest('.modal-backdrop').hidden),
            заголовок: modal?.querySelector('.modal-title')?.textContent ?? null,
            строк: modal?.querySelectorAll('.root-settings-row').length ?? 0,
            // Свои отличия папки форма показывает не «как в области», а значением.
            настроено: [...(modal?.querySelectorAll('.root-settings-row') ?? [])]
              .filter((row) => row.dataset.state !== 'inherit')
              .map((row) => row.dataset.flag + ':' + row.dataset.state),
          };
        })()`,
      ),
    )}`,
  );
  await ask(ide, `document.querySelector('.root-settings-modal .modal-header .icon-btn')?.click()`);
  await wait(500);

  /* ── удалённые файловые системы ─────────────────────────────────────────── */

  // Настоящего ssh-хоста в пробе нет, поэтому проверяем главное: блок рисуется,
  // недоступная папка НЕ роняет дерево и говорит об этом словами, а проверка адреса
  // отвечает отказом, а не «подключено». Домен `.invalid` не разрешается по стандарту.
  settings.update({ workspace: { remoteRoots: ['ssh://нет-такого.invalid/srv/app'] } });
  await wait(1200);
  console.log(
    `[explorer] блок удалённых: ${JSON.stringify(
      await ask(
        ide,
        `[...document.querySelectorAll('.tree-remote .tree-row.is-remote .tree-name')].map((node) => node.textContent)`,
      ),
    )}`,
  );
  console.log(
    `[explorer] проверка недоступного адреса: ${JSON.stringify(
      await ask(
        ide,
        `window.chui.call({ id: 'probe-remote', method: 'remote.check', params: { address: 'ssh://нет-такого.invalid/srv/app' } })`,
        40000,
      ),
    )}`,
  );
  // Раскрытие в момент чтения: строка обязана сказать «Читаю…», а не «папка пуста».
  // Читаем сразу после клика — обработчик до первого `await` успевает перерисовать
  // дерево, поэтому слово видно ещё до того, как ответит (или не ответит) клиент.
  console.log(
    `[explorer] удалённая папка в момент чтения: ${JSON.stringify(
      await ask(
        ide,
        `(() => {
          const row = document.querySelector('.tree-remote .tree-row.is-remote');
          if (!row) return 'нет строки';
          row.click();
          return document.querySelector('.tree-remote .tree-empty-note')?.textContent ?? null;
        })()`,
      ),
    )}`,
  );
  await wait(12000);
  console.log(
    `[explorer] недоступная удалённая папка: ${JSON.stringify(
      await ask(
        ide,
        `(() => {
          const note = document.querySelector('.tree-remote .tree-empty-note');
          return {
            заметка: note?.textContent ?? null,
            отказ_помечен: note?.classList.contains('is-error') ?? false,
            дерево_живо: Boolean(document.querySelector('.tree-rows .tree-row')),
          };
        })()`,
      ),
    )}`,
  );
  await ask(
    ide,
    `(() => {
      const row = document.querySelector('.tree-remote .tree-row.is-remote');
      if (!row) return 'нет строки';
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8 }));
      return 'ok';
    })()`,
  );
  await wait(600);
  await ask(
    ide,
    `(async () => {
      const item = [...document.querySelectorAll('.context-menu .context-item')].find((node) =>
        (node.textContent ?? '').includes('Убрать из списка'),
      );
      if (!item) return 'пункта нет';
      item.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return 'нажато';
    })()`,
  );
  await wait(900);
  console.log(`[explorer] удалённых папок в настройках: ${JSON.stringify(settings.get().workspace.remoteRoots)}`);

  const finalTree = await ask(
    ide,
    `[...document.querySelectorAll('.tree-row .tree-name')].map((node) => node.textContent)`,
  );
  console.log(`[explorer] дерево в конце: ${JSON.stringify(finalTree)}`);

  terminals.dispose();
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  app.exit(0);
});
