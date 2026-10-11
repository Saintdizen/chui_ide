/**
 * Проверка песочницы: команды агента выполняются в настоящем контейнере.
 *
 * Нужны собранный main (npm run build:main) и Docker (или podman) в PATH с
 * образом. Движка нет — проверка честно говорит об этом и выходит без ошибки:
 * это не поломка кода, а другое окружение.
 *
 * Проверяем:
 *  1. движок находится по PATH, и контейнер действительно поднимается;
 *  2. рабочая папка внутри контейнера — заданная, а проект виден смонтированным;
 *  3. файл, созданный внутри контейнера, появляется в проекте на хосте;
 *  4. владелец файла — тот же пользователь, что и снаружи (не root);
 *  5. домашний каталог и переменные окружения хоста в контейнер не пробрасываются;
 *  6. код выхода и вывод команды доезжают до инструмента как есть;
 *  7. выключенная сеть оставляет контейнер без сети;
 *  8. без движка команда НЕ выполняется на хосте — отказ, а не тихий откат.
 *
 *   npm run smoke:sandbox
 */
const path = require('node:path');
const os = require('node:os');
const { promises: fs, existsSync } = require('node:fs');

const { SandboxService, findSandboxEngine } = require('../dist/main/sandbox/sandbox.js');

let failed = false;
const check = (label, condition, extra) => {
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

const IMAGE = process.env.CHUI_SANDBOX_IMAGE || 'python:3.12-slim';
const MARKER = 'chui-sandbox-marker';

async function main() {
  const engine = findSandboxEngine();
  if (!engine) {
    console.log('[chui] движок контейнеров не найден в PATH — проверку песочницы пропускаю');
    console.log('[chui] установите docker или podman и повторите npm run smoke:sandbox');
    return;
  }
  console.log(`  ok   движок найден: ${engine}`);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-sandbox-'));
  await fs.writeFile(path.join(dir, 'notes.txt'), `${MARKER}\n`, 'utf8');

  const config = { enabled: true, image: IMAGE, workdir: '/workspace', network: true };
  const sandbox = new SandboxService(() => config);

  try {
    check('песочница считает себя доступной', sandbox.available === true);

    /* 1. команда выполняется, вывод и код возврата доезжают */
    const echoed = await sandbox.run(`echo ${MARKER}`, dir);
    check(
      'команда выполнилась в контейнере',
      echoed.code === 0 && echoed.output.includes(MARKER),
      echoed.output.trim(),
    );

    const failedCommand = await sandbox.run('exit 3', dir);
    check('код выхода доезжает как есть', failedCommand.code === 3, failedCommand.code);

    /* 2. рабочий каталог — заданный, проект смонтирован */
    const pwd = await sandbox.run('pwd', dir);
    check('рабочий каталог внутри контейнера задан настройкой', pwd.output.trim() === '/workspace', pwd.output.trim());

    const listed = await sandbox.run('ls', dir);
    check('файлы проекта видны в контейнере', listed.output.includes('notes.txt'), listed.output.trim());

    const read = await sandbox.run('cat notes.txt', dir);
    check('содержимое файла проекта читается', read.output.includes(MARKER), read.output.trim());

    /* 3. файл, созданный внутри, появляется на хосте */
    await sandbox.run('echo сделано > created-by-sandbox.txt', dir);
    const created = path.join(dir, 'created-by-sandbox.txt');
    check('файл из контейнера появился в проекте на хосте', existsSync(created), created);
    if (existsSync(created)) {
      // 4. владелец — пользователь хоста, а не root: иначе проект «засорился» бы
      //    файлами, которые можно править только через sudo.
      const stats = await fs.stat(created);
      const hostUid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
      check('владелец созданного файла — пользователь хоста', stats.uid === hostUid, {
        uid: stats.uid,
        hostUid,
      });
    }

    /* 5. хостовое окружение в контейнер не уезжает */
    const home = await sandbox.run('echo "HOME=$HOME"', dir);
    const hostHome = os.homedir();
    check(
      'домашний каталог хоста в контейнер не проброшен',
      !home.output.includes(`HOME=${hostHome}`),
      home.output.trim(),
    );

    // Переменная, выставленная в хостовом процессе, контейнеру не видна: наружу
    // отдаём только свои NO_COLOR и TERM, а не весь process.env с ключами.
    process.env.CHUI_SANDBOX_SECRET = 'секрет-хоста';
    const secret = await sandbox.run('echo "SECRET=$CHUI_SANDBOX_SECRET"', dir);
    check(
      'переменные хоста в контейнер не пробрасываются',
      !secret.output.includes('секрет-хоста'),
      secret.output.trim(),
    );
    delete process.env.CHUI_SANDBOX_SECRET;

    /* 6. выключенная сеть действительно выключает сеть */
    const offline = new SandboxService(() => ({ ...config, network: false }));
    const noNet = await offline.run(
      'python3 -c "import socket;socket.create_connection((\'1.1.1.1\', 80), 3)" && echo СЕТЬ_ЕСТЬ || echo СЕТИ_НЕТ',
      dir,
    );
    check('с выключенной сетью наружу не выйти', noNet.output.includes('СЕТИ_НЕТ'), noNet.output.trim());

    /* 7. без движка — отказ, а не тихий запуск на хосте */
    const withoutEngine = new SandboxService(() => config, null);
    check('без движка песочница недоступна', withoutEngine.available === false);
    let refused = '';
    try {
      await withoutEngine.run(`echo ${MARKER}`, dir);
    } catch (error) {
      refused = String(error.message);
    }
    check('без движка команда отклонена словами', /не найден/.test(refused) && /на хост/.test(refused), refused);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log(failed ? '[chui] песочница НЕ прошла' : '[chui] песочница работает');
    process.exit(failed ? 1 : 0);
  })
  .catch((error) => {
    console.error('[chui] исключение:', error);
    process.exit(1);
  });
