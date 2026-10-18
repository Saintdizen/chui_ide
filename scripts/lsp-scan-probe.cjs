/**
 * Проба обхода проекта языковым сервером: поиск символов БЕЗ единой открытой вкладки.
 *
 *   npm run probe:lspscan
 *
 * Зачем отдельная проба. `prewarm` поднимал серверы и просил их обойти проект
 * (`workspace/symbol`), но у `tsserver` без единого открытого файла нет ни одного
 * проекта: он отвечает ошибкой «No Project.», обход тихо падал, и поиск символов
 * по проекту был пуст — до тех пор, пока человек не откроет подходящую вкладку.
 * Ошибка невидимая: сервер «поднялся», статус чистый, а индекс не собран.
 *
 * Поэтому проверяем ровно то, что видит человек: открыли проект — и символы из
 * файла, который НИ РАЗУ не открывали, находятся. Ни юнит-тест (нет процессов),
 * ни `probe:lspstart` (там про уведомления) этого не видят.
 *
 * Нужен собранный main (npm run build:main): серверы берутся из поставки IDE.
 * Отчёт — вывод в консоль.
 */
const { app } = require('electron');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LspService } = require('../dist/main/lsp/lsp.js');
const { detectLspSources } = require('../dist/main/lsp/detect.js');
const { createSeedProvider } = require('../dist/main/lsp/seed.js');
const { mergeByPriority } = require('../dist/shared/lsp-bundled.js');

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Проект-образец: `tsconfig.json` и два файла, где объявлена функция. Ни один файл
 * пробой не открывается — открывать их должен сам сервис, затравкой.
 */
async function demoProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lsp-scan-'));
  await fs.writeFile(path.join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n', 'utf8');
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'src', 'index.ts'),
    'import { projectWideSymbol } from "./lib";\nexport const entry = projectWideSymbol;\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'src', 'lib.ts'),
    '/** Объявление, которое видно только из индекса проекта. */\nexport function projectWideSymbol(): number {\n  return 42;\n}\n',
    'utf8',
  );
  return dir;
}

app.whenReady().then(async () => {
  const root = await demoProject();
  const sources = await detectLspSources(root, process.platform);
  const servers = mergeByPriority(sources).filter((server) => server.language === 'typescript');
  check(
    'сервер TypeScript нашёлся в поставке',
    servers.length > 0,
    servers.map((server) => server.language),
  );

  const lsp = new LspService(
    () => root,
    () => ({ enabled: true, trace: false, servers }),
    () => undefined,
    () => null,
    async () => ({}),
    async () => [],
    () => null,
    createSeedProvider(() => root),
  );

  const started = Date.now();
  await lsp.prewarm(['typescript']);
  check('сервер поднялся', lsp.status().running.includes('typescript'), lsp.status().running);

  // Индекс строится первыми запросами; ответ на первый может быть неполным —
  // повторяем, как это делает человек, набирая имя в поиске символов.
  let found = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    found = await lsp.projectSymbols('projectWideSymbol');
    if (found.some((symbol) => symbol.path.endsWith(path.join('src', 'lib.ts')))) break;
    await wait(300);
  }
  check(
    'символ из неоткрытого файла найден',
    found.some((symbol) => symbol.path.endsWith(path.join('src', 'lib.ts'))),
    found.map((symbol) => symbol.path),
  );
  console.log(`  поиск занял ${Date.now() - started} мс`);

  lsp.dispose();
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[проба] обход проекта: есть расхождения' : '[проба] сервер обошёл проект без открытых вкладок');
  app.exit(failed ? 1 : 0);
});
