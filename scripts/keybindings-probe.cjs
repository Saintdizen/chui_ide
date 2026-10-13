/**
 * Проба клавиш меню: переопределения меняют акселераторы системного меню Electron.
 *
 * Проверяем без окна: собираем системное меню тем же путём, что и приложение
 * (`createApplicationMenu`), и читаем акселераторы прямо из него. Так видно то, чего
 * не видно тестами без Electron: меню строится, пункты находятся по подписи, а
 * подменённая клавиша действительно доходит до меню.
 *
 *   ./node_modules/.bin/electron scripts/keybindings-probe.cjs
 */
const { app, Menu } = require('electron');
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApplicationMenu } = require('../dist/main/menu.js');

app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'chui-keys-profile-')));

/** Акселератор пункта меню по пути подписей: `['Файл', 'Сохранить']`. */
function acceleratorAt(pathLabels) {
  let items = Menu.getApplicationMenu()?.items ?? [];
  let found = null;
  for (const label of pathLabels) {
    found = items.find((item) => item.label === label) ?? null;
    if (!found) return null;
    items = found.submenu?.items ?? [];
  }
  return found ? (found.accelerator ?? null) : null;
}

/** Акселераторы всех пунктов-команд: подпись → клавиша. Роли не берём — у них нет команд. */
function accelerators() {
  const result = {};
  const walk = (items) => {
    for (const item of items) {
      if (item.submenu) walk(item.submenu.items);
      else if (item.label) result[item.label] = item.accelerator ?? null;
    }
  };
  walk(Menu.getApplicationMenu()?.items ?? []);
  return result;
}

let failures = 0;
const check = (title, expected, actual) => {
  const ok = expected === actual;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${title}: ${JSON.stringify(actual)}${ok ? '' : ` (ждали ${JSON.stringify(expected)})`}`,
  );
};

app.whenReady().then(() => {
  // По умолчанию: клавиша из шаблона.
  createApplicationMenu();
  check('Файл → Сохранить по умолчанию', 'Ctrl+S', acceleratorAt(['Файл', 'Сохранить']));
  check('Вид → Палитра команд по умолчанию', 'Ctrl+Shift+P', acceleratorAt(['Вид', 'Палитра команд…']));

  // Переопределение: клавиша пункта заменена.
  createApplicationMenu([{ command: 'menu:file.save', combo: 'Ctrl+Alt+S' }]);
  check('Файл → Сохранить после переопределения', 'Ctrl+Alt+S', acceleratorAt(['Файл', 'Сохранить']));
  // Чужая клавиша (renderer) меню не трогает.
  check(
    'Вид → Палитра команд не тронута чужим переопределением',
    'Ctrl+Shift+P',
    acceleratorAt(['Вид', 'Палитра команд…']),
  );

  // Снятие: пустое сочетание убирает клавишу.
  createApplicationMenu([{ command: 'menu:file.save', combo: '' }]);
  check('Файл → Сохранить после снятия', null, acceleratorAt(['Файл', 'Сохранить']));

  // Пункт без клавиши получает её от переопределения.
  createApplicationMenu([{ command: 'menu:view.showOutline', combo: 'Ctrl+Alt+O' }]);
  check('Вид → Структура файла с новой клавишей', 'Ctrl+Alt+O', acceleratorAt(['Вид', 'Структура файла']));

  // Роли остаются со своими клавишами шаблона.
  createApplicationMenu([{ command: 'menu:file.save', combo: 'Ctrl+Alt+S' }]);
  check('Правка → Отменить (роль) не тронута', 'Ctrl+Z', acceleratorAt(['Правка', 'Отменить']));

  console.log(failures === 0 ? '\nвсе проверки прошли' : `\nпровалов: ${failures}`);
  app.exit(failures === 0 ? 0 : 1);
});
