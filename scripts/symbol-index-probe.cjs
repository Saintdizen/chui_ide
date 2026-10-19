/**
 * Проба карты символов: поиск и наследование БЕЗ языкового сервера.
 *
 *   npm run probe:symbols
 *
 * Зачем отдельная проба. Карта собирается из ответов сервера, но её смысл — работать
 * тогда, когда сервера нет: он ещё поднимается, не установлен или упал. Юнит-тесты
 * это видят на поддельном скелете, а здесь проверяется вся цепочка целиком и на двух
 * языках сразу (Python и TypeScript):
 *
 *   1. карта собирается по проекту и ложится на диск;
 *   2. новый сборщик поверх старого кэша находит символы, НИ РАЗУ не спросив сервер;
 *   3. сервис без единого сервера (тот самый «глупый режим») отвечает на поиск символа
 *      из карты;
 *   4. по карте видно, от кого класс наследует и что он от этого получает.
 *
 * Нужен собранный main (`npm run build:main`): серверы берутся из поставки IDE.
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
const { SymbolIndexer } = require('../dist/main/symbols/indexer.js');
const { SymbolStore } = require('../dist/main/symbols/store.js');
const { ancestorsOf, inheritedMembers } = require('../dist/shared/symbol-index.js');

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

/** Проект-образец: Python с наследованием и TypeScript с классом. Ни один файл не открыт. */
async function demoProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-symbols-'));
  await fs.writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
  await fs.writeFile(
    path.join(dir, 'base.py'),
    'class Base:\n    def run(self):\n        return 1\n\n    def reset(self):\n        return 2\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'app.py'),
    'from base import Base\n\n\nclass Parser(Base):\n    def run(self):\n        return 3\n\n\ndef index_symbol_probe():\n    return Parser()\n',
    'utf8',
  );
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n', 'utf8');
  await fs.writeFile(
    path.join(dir, 'src', 'page.ts'),
    'export class PageView {\n  render(): string {\n    return "x";\n  }\n}\n',
    'utf8',
  );
  return dir;
}

function serverSources(root) {
  return detectLspSources(root, process.platform);
}

app.whenReady().then(async () => {
  const root = await demoProject();
  const servers = mergeByPriority(await serverSources(root));
  check(
    'серверы Python и TypeScript нашлись в поставке',
    servers.some((server) => server.language === 'python') &&
      servers.some((server) => server.language === 'typescript'),
    [...new Set(servers.map((server) => server.language))],
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
  await lsp.prewarm(['python', 'typescript']);

  const dir = path.join(root, '.chui_ide', 'symbol-index');
  const store = new SymbolStore(dir);
  const index = new SymbolIndexer({
    root: () => root,
    outline: (target, languageId, text) => lsp.outline(target, languageId, text),
    store,
  });

  const started = Date.now();
  index.refresh();
  await index.settled();
  const status = index.status();
  console.log(`  сборка карты заняла ${Date.now() - started} мс`);
  check('карта собрана по обоим языкам', status.phase === 'ready' && status.files >= 3 && status.decls >= 4, status);
  check(
    'объявления Python и TypeScript в карте',
    index.find('Parser').length > 0 && index.find('PageView').length > 0,
    {
      parser: index.find('Parser').length,
      page: index.find('PageView').length,
    },
  );

  // Следующая сессия: сервер молчит (не поднялся, не установлен) — карта отвечает сама.
  const silent = new SymbolIndexer({
    root: () => root,
    outline: async () => null,
    store,
  });
  silent.refresh();
  await silent.settled();
  check('новый сборщик прочитал карту с диска', silent.status().files === status.files, silent.status());
  check(
    'объявления нашлись без единого запроса к серверу',
    silent.find('Parser').length > 0 && silent.find('PageView').length > 0,
  );

  // Он же через сервис без серверов: та самая выдача «перейти к символу».
  const noServers = new LspService(
    () => root,
    () => ({ enabled: true, trace: false, servers: [] }),
    () => undefined,
  );
  noServers.attachIndex(silent);
  const found = await noServers.projectSymbols('Parser');
  check(
    'сервис без серверов отдаёт символ из карты',
    found.some((symbol) => symbol.path.endsWith('app.py') && symbol.line === 4),
    found.map((symbol) => `${symbol.path}:${symbol.line}`),
  );

  // Наследование по карте: сервер для этого не нужен вовсе.
  const cached = await store.load(root);
  check('прямой предок найден', ancestorsOf(cached, 'Parser').includes('Base'), ancestorsOf(cached, 'Parser'));
  const members = inheritedMembers(cached, 'Parser').map((member) => `${member.from}:${member.name}`);
  check(
    'свой метод перекрывает родительский, унаследованный — на месте',
    members.includes('Parser:run') && members.includes('Base:reset') && !members.includes('Base:run'),
    members,
  );

  // Сохранение файла: карта должна догнать код без пересборки проекта. Пересобирает
  // тот сборщик, у которого есть сервер: у «молчащего» из прошлого раздела скелета не будет.
  const savedFile = path.join(root, 'app.py');
  await fs.writeFile(
    savedFile,
    'from base import Base\n\n\nclass Parser(Base):\n    def run(self):\n        return 3\n\n\nclass AppAfterSave(Base):\n    pass\n',
    'utf8',
  );
  silent.noteChanged(savedFile);
  index.noteChanged(savedFile);
  // Заодно проверяем то, на чём это спотыкалось: файл был открыт серверу затравкой, и
  // без `didChange` сервер отвечал по СТАРОМУ тексту — нового класса в скелете не было.
  const fresh = await lsp.outline(savedFile, 'python', await fs.readFile(savedFile, 'utf8'));
  check(
    'сервер отвечает по актуальному тексту, а не по открытому раньше',
    (fresh ?? []).some((symbol) => symbol.name === 'AppAfterSave'),
    (fresh ?? []).map((symbol) => symbol.name),
  );
  let saved = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    saved = index.find('AppAfterSave');
    if (saved.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(
    'сохранённый файл виден в карте без пересборки проекта',
    saved.length === 1,
    saved.map((hit) => hit.path),
  );

  noServers.dispose();
  lsp.dispose();
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  console.log(failed ? '[проба] карта символов: есть расхождения' : '[проба] карта символов работает без сервера');
  app.exit(failed ? 1 : 0);
});
