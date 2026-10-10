/**
 * Проверка запуска с папкой в командной строке.
 *
 *   npm run smoke:folder
 *
 * Поднимаем настоящее приложение с путём проекта в аргументах и с отдельным
 * каталогом данных. Признак успеха — открытый проект в истории (`settings.json`
 * того каталога): его пишет только переход в IDE, то есть путь в аргументах
 * действительно открылся, а не остался стартовым окном.
 *
 * Нужен собранный main и renderer (npm run build) и рабочий дисплей.
 */
const { spawn } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appRoot = path.join(__dirname, '..');
const electron = require('electron');

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Запустить приложение с аргументами и своим каталогом данных. */
async function run(args, userData) {
  const child = spawn(electron, [appRoot, ...args, `--user-data-dir=${userData}`], {
    cwd: appRoot,
    env: { ...process.env, CHUI_SMOKE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => (output += chunk.toString('utf8')));

  // Приложение работает, пока его не остановят: ждём запись истории и гасим.
  await wait(9000);
  child.kill();
  await wait(500);
  return output;
}

/** Открытые проекты из settings.json каталога данных. */
async function recentOf(userData) {
  const file = path.join(userData, 'settings.json');
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text).workspace?.recent ?? [];
  } catch {
    return null;
  }
}

const main = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-folder-'));
  const project = path.join(base, 'my-project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'README.md'), '# проект\n', 'utf8');

  /* 1. Путь в аргументах открывает проект. */
  const userData1 = path.join(base, 'data1');
  await run([project], userData1);
  const recent1 = await recentOf(userData1);
  check('каталог данных создан', recent1 !== null, recent1);
  check('проект из аргументов попал в историю', (recent1 ?? []).includes(project), recent1);
  check('стартовое окно не помешало открытию', (recent1 ?? []).length === 1, recent1);

  /* 2. Переключатели Electron перед путём не мешают: их ставит сам Chromium. */
  const userData2 = path.join(base, 'data2');
  await run(['--force-color-profile=srgb', project], userData2);
  check('путь найден и после переключателя', ((await recentOf(userData2)) ?? []).includes(project));

  /* 3. Без пути проекта в истории не появляется: открывается стартовое окно. */
  const userData3 = path.join(base, 'data3');
  await run([], userData3);
  const recent3 = await recentOf(userData3);
  check('без аргументов проект не открывается', recent3 === null || (recent3 ?? []).length === 0, recent3);

  /* 4. Несуществующий путь не ломает запуск: приложение остаётся живым. */
  const userData4 = path.join(base, 'data4');
  const output = await run([path.join(base, 'нет-такой-папки')], userData4);
  check('несуществующий путь не открывает проект', ((await recentOf(userData4)) ?? []).length === 0);
  // Свою строку ищем по всему выводу: после неё Electron пишет про GPU и Wayland,
  // и её терял бы любой «хвост» вывода.
  const ourLine = /\[chui\] папка не найдена[^\n]*/.exec(output)?.[0];
  check('о неудаче сказано в консоли', Boolean(ourLine), ourLine ?? output.slice(0, 200));

  await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[chui] запуск с папкой: есть расхождения' : '[chui] запуск с папкой работает');
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error('[chui] ошибка проверки:', error.message);
  process.exit(1);
});
