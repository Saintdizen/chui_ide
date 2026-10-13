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
    // Семантическая подсветка: у части серверов её нет — тогда 0 токенов, и это не сбой.
    const semantic = await lsp.semanticTokens(file);
    const status = lsp.status().running;
    console.log(
      `${server.language.padEnd(14)} поднялся: ${status.includes(server.language) ? 'да' : 'НЕТ'}` +
        `, объявлений по запросу «config»: ${symbols.length}` +
        `, семантических токенов: ${semantic.length}`,
    );
  }
  lsp.dispose();
}

/**
 * Файл-образец языка: по нему проверяем, что сервер действительно отвечает.
 *
 * Сперва пробуем файл из репозитория (он живой и настоящий), а если его нет —
 * пишем свой образец во временный каталог. Так проба не ломается, когда файл
 * нужного языка из репозитория убрали: раньше образцом питона служил случайный
 * рабочий скрипт, и его удаление обрывало проверку языка.
 */
function sampleFile(language) {
  const path = require('node:path');
  const fs = require('node:fs');
  const candidates = {
    typescript: 'src/shared/lsp-bundled.ts',
    javascript: 'scripts/dev.mjs',
    json: 'package.json',
    yaml: '.github/workflows/ci.yml',
  };
  const relative = candidates[language];
  if (relative) {
    const full = path.join(ROOT, relative);
    if (fs.existsSync(full)) return full;
  }

  // Запасной путь: свой образец. Значок `config` — под него проба и спрашивает символы.
  const samples = {
    python: 'def config() -> int:\n    return 1\n',
    typescript: 'export function config(): number {\n  return 1;\n}\n',
    javascript: 'export function config() {\n  return 1;\n}\n',
    json: '{"config": 1}\n',
    yaml: 'config: 1\n',
    html: '<div class="config"></div>\n',
    css: '.config { color: red; }\n',
    scss: '$gap: 4px;\n.config { margin: $gap; }\n',
    less: '@gap: 4px;\n.config { margin: @gap; }\n',
  };
  const text = samples[language];
  if (!text) return null;
  const extensions = {
    python: 'py',
    typescript: 'ts',
    javascript: 'js',
    json: 'json',
    yaml: 'yml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
  };
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lsp-sample-'));
  const file = path.join(dir, `sample.${extensions[language] ?? 'txt'}`);
  fs.writeFileSync(file, text);
  return file;
}

app.whenReady().then(() =>
  main()
    .catch((error) => console.error('ошибка пробы:', error))
    .finally(() => app.exit(0)),
);
