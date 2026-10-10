/*
 * LSP без внешних зависимостей: роль сервера играет scripts/fake-lsp.cjs.
 * Проверяем жизненный цикл целиком — запуск, initialize, didOpen → диагностика,
 * didChange гасит пометки, статус и перезапуск.
 */
const path = require('node:path');

const { LspService } = require('../dist/main/lsp/lsp.js');
const { formatOutline } = require('../dist/shared/lsp-symbols.js');

const LSP_DIAGNOSTICS = 'lsp:diagnostics';

let failures = 0;
function ok(name, condition, extra) {
  if (condition) console.log(`  ok   ${name}${extra ? `: ${extra}` : ''}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${extra ? `: ${extra}` : ''}`);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = process.cwd();
  const fakeServer = path.join(__dirname, 'fake-lsp.cjs');
  const settings = {
    enabled: true,
    servers: [{ language: 'python', command: process.execPath, args: [fakeServer], enabled: true }],
  };

  const events = [];
  const lsp = new LspService(
    () => root,
    () => settings,
    (topic, payload) => events.push({ topic, payload }),
  );

  const sample = path.join(root, 'scripts', 'sample-lsp.py');
  await lsp.open(sample, 'python', 'print(1)\n');
  await wait(700);

  const published = events.find((event) => event.topic === LSP_DIAGNOSTICS && event.payload.diagnostics.length > 0);
  ok(
    'сервер запустился и прислал диагностику',
    Boolean(published),
    published ? `${published.payload.diagnostics.length} шт.` : 'нет',
  );
  if (published) {
    const [error, warning] = published.payload.diagnostics;
    ok('severity error/warning разобраны', error.severity === 'error' && warning.severity === 'warning');
    ok('строка 1-based (было 0)', error.line === 1, String(error.line));
    ok('message и source сохранены', error.message === 'fake error' && error.source === 'fake');
  }

  ok('статус содержит python', lsp.status().running.includes('python'), lsp.status().running.join(','));

  // Изменение документа: сервер гасит пометки, а мы их публикуем пустыми.
  events.length = 0;
  lsp.change(sample, 'print(2)\n');
  await wait(300);
  const cleared = events.find((event) => event.topic === LSP_DIAGNOSTICS);
  ok('смена текста гасит пометки', Boolean(cleared) && cleared.payload.diagnostics.length === 0);

  // didClose тоже.
  events.length = 0;
  lsp.close(sample);
  await wait(300);
  const closed = events.find((event) => event.topic === LSP_DIAGNOSTICS);
  ok('закрытие гасит пометки', Boolean(closed) && closed.payload.diagnostics.length === 0);

  // Язык без сервера: тихо ничего не делаем.
  await lsp.open(path.join(root, 'scripts', 'x.unknown'), 'unknown', '');
  ok('неизвестный язык игнорируется', !lsp.status().running.includes('unknown'));

  /* Скелет файла (инструмент file_outline): объявления с номерами строк.
     Файл в редакторе НЕ открыт — сервис должен поднять сервер сам, спросить
     документ и закрыть его: агент спрашивает скелет ровно затем, чтобы не
     читать файл целиком, и ждать открытия вкладки не может. */
  const outline = await lsp.outline(sample, 'python', 'class Parser:\n    pass\n');
  ok('скелет файла получен без открытой вкладки', outline.length === 2, String(outline.length));
  ok(
    'вложенный метод сохранён',
    outline[0]?.children.length === 1 && outline[0].children[0].name === 'parse',
    JSON.stringify(outline[0]),
  );
  ok('строки переведены в 1-based', outline[0]?.line === 3 && outline[1]?.line === 44, JSON.stringify(outline));
  ok('вид символа назван по-русски', outline[0]?.kind === 'класс' && outline[0].children[0].kind === 'метод');
  const formatted = formatOutline(sample, outline, { totalLines: 60 });
  ok(
    'скелет напечатан с диапазонами',
    formatted.detail.includes('3–40: класс Parser') && formatted.detail.includes('  5–9: метод parse'),
    formatted.detail.split('\n').slice(0, 4).join(' | '),
  );
  ok('сводка называет файл и число объявлений', formatted.summary === 'sample-lsp.py: 3 объявления', formatted.summary);

  // Файл уже открыт в редакторе — сервис обязан спрашивать документ, а не
  // открывать второй: иначе у сервера разъедется версия текста.
  await lsp.open(sample, 'python', 'print(1)\n');
  const twice = await lsp.outline(sample, 'python', 'print(1)\n');
  ok('для открытой вкладки скелет спрашивается у того же сервера', twice.length === 2, String(twice.length));
  lsp.close(sample);
  await wait(200);

  // Язык без сервера: скелета нет, но и падения нет. `null` — именно «сервера
  // нет», а не «объявлений нет»: агенту это разные подсказки.
  const unknown = await lsp.outline(path.join(root, 'scripts', 'x.unknown'), 'unknown', '');
  ok('неизвестный язык скелета не даёт', unknown === null, String(unknown));

  const restarted = lsp.restart();
  ok('restart останавливает серверы', restarted.running.length === 0 && lsp.status().running.length === 0);

  lsp.dispose();
  console.log(failures === 0 ? '\n[chui] LSP-клиент работает' : `\n[chui] ошибок: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
