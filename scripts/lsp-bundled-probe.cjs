/**
 * Проба «серверы из поставки»: что нашлось рядом с IDE и поднимается ли оно.
 *
 *   npm run build:main && ./node_modules/.bin/electron scripts/lsp-bundled-probe.cjs
 *
 * Проверяет главный риск шага «из коробки»: бандл-серверы — это JS-скрипты, и
 * запускаем мы их самим Electron в режиме Node (`ELECTRON_RUN_AS_NODE`), потому
 * что системного `node` на машине может не быть. Не ошибись тут — и «из коробки»
 * заработает, но на чужой машине не поднимется ничего.
 *
 * Проба печатает состояние, а не `ok`/`FAIL`, как и остальные «пробники».
 */
const { app } = require('electron');
const { LspService } = require('../dist/main/lsp/lsp.js');
const { detectBundledServers } = require('../dist/main/lsp/bundled.js');

const ROOT = process.cwd();

async function main() {
  const bundled = await detectBundledServers();
  console.log(`найдено серверов в поставке: ${bundled.length}`);
  for (const server of bundled) {
    console.log(
      `  ${server.language.padEnd(14)} ${server.command === process.execPath ? '(Electron/Node)' : server.command}`,
    );
    console.log(`     args: ${server.args.map((arg) => (arg === ROOT ? '.' : arg)).join(' ')}`);
  }
  if (bundled.length === 0) {
    console.log('нечего поднимать: сборка без серверов');
    return;
  }

  // Поднимаем сервис ровно теми серверами, что нашлись, и просим по файлу каждого языка.
  const lsp = new LspService(
    () => ROOT,
    () => ({ enabled: true, servers: bundled }),
    () => {},
    () => null,
    async () => ({}),
  );

  for (const server of bundled) {
    const file = sampleFile(server.language);
    if (!file) {
      console.log(`${server.language.padEnd(14)} — файла-образца нет, пропуск`);
      continue;
    }
    const text = require('node:fs').readFileSync(file, 'utf8');
    await lsp.open(file, server.language, text);
    // Спрашиваем то, ради чего всё и делается, — объявления символов. Позиция тут
    // не нужна, поэтому ответ «0» значит «сервер не понял язык», а не «мимо курсора».
    const symbols = await lsp.projectSymbols('config');
    const status = lsp.status().running;
    console.log(
      `${server.language.padEnd(14)} поднялся: ${status.includes(server.language) ? 'да' : 'НЕТ'}` +
        `, объявлений по запросу «config»: ${symbols.length}`,
    );
  }
  lsp.dispose();
}

/** Файл-образец языка: по нему проверяем, что сервер действительно отвечает. */
function sampleFile(language) {
  const path = require('node:path');
  const candidates = {
    typescript: 'src/shared/lsp-bundled.ts',
    javascript: 'scripts/dev.mjs',
    python: 'scripts/_cov4.py',
    json: 'package.json',
    yaml: '.github/workflows/ci.yml',
  };
  const relative = candidates[language];
  if (!relative) return null;
  const full = path.join(ROOT, relative);
  return require('node:fs').existsSync(full) ? full : null;
}

app.whenReady().then(() =>
  main()
    .catch((error) => console.error('ошибка пробы:', error))
    .finally(() => app.exit(0)),
);
