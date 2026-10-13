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

  /* Подсказки и доведение элемента (`completionItem/resolve`): первый ответ описания
     не несёт — его добывает отдельный запрос. */
  const completion = await lsp.request(sample, 'textDocument/completion', {
    textDocument: { uri: `file://${sample}` },
    position: { line: 0, character: 1 },
  });
  const items = Array.isArray(completion) ? completion : (completion?.items ?? []);
  ok('подсказки получены', items.length === 2, JSON.stringify(items.map((item) => item.label)));
  ok(
    'в первом ответе описания нет (его даёт resolve)',
    items.every((item) => item.documentation === undefined),
  );
  const resolved = await lsp.request(sample, 'completionItem/resolve', items[0]);
  ok(
    'resolve дописал подробность и описание',
    resolved?.detail === 'print(*args)' && String(resolved?.documentation?.value).includes('Печатает'),
    JSON.stringify(resolved),
  );

  /* Отмена устаревшего запроса: сервер отвечает на подсказки с задержкой, и пока он
     думает, приходит второй запрос того же вида — первый должен быть отменён, а не
     довисеть. Ровно это и нужно при быстром наборе текста. */
  const stale = lsp.request(sample, 'textDocument/completion', {
    textDocument: { uri: `file://${sample}` },
    position: { line: 0, character: 1 },
  });
  const fresh = lsp.request(sample, 'textDocument/completion', {
    textDocument: { uri: `file://${sample}` },
    position: { line: 0, character: 2 },
  });
  const [oldAnswer, newAnswer] = await Promise.all([stale, fresh]);
  const freshItems = Array.isArray(newAnswer) ? newAnswer : (newAnswer?.items ?? []);
  ok('устаревший запрос отменён', oldAnswer === null, JSON.stringify(oldAnswer));
  ok('свежий запрос ответил', freshItems.length === 2, JSON.stringify(freshItems.map((item) => item.label)));

  /* Иерархия типов: prepare даёт символ, supertypes — его надтипы.
     Проверяем, что цепочка из двух шагов доходит и `data` возвращается серверу. */
  const preparedType = await lsp.request(sample, 'textDocument/prepareTypeHierarchy', {
    textDocument: { uri: `file://${sample}` },
    position: { line: 1, character: 7 },
  });
  ok('подготовка иерархии типов отвечает', preparedType?.[0]?.name === 'Derived', JSON.stringify(preparedType));
  const supertypes = await lsp.request(sample, 'typeHierarchy/supertypes', { item: preparedType?.[0] });
  ok('надтипы получены', supertypes?.[0]?.name === 'Base', JSON.stringify(supertypes));

  /* Ссылки в коде: сервер отдаёт участок без адреса — его добывает resolve. */
  const links = await lsp.request(sample, 'textDocument/documentLink', {
    textDocument: { uri: `file://${sample}` },
  });
  ok('ссылки получены', Array.isArray(links) && links.length === 1, JSON.stringify(links));
  ok('в первом ответе адреса нет (его даёт resolve)', links?.[0]?.target === undefined);
  const resolvedLink = await lsp.request(sample, 'documentLink/resolve', links?.[0]);
  ok('resolve ссылки дал адрес', resolvedLink?.target === 'https://example.com/', JSON.stringify(resolvedLink));

  /* Inline-значения (`textDocument/inlineValue`): сервер помечает участки, значение берём
     у отладчика. Проверяем, что разбор отдаёт участок и вид «поиск переменной». */
  const inlineValues = await lsp.request(sample, 'textDocument/inlineValue', {
    textDocument: { uri: `file://${sample}` },
    range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } },
    context: {
      frameId: 1,
      stoppedLocation: {
        uri: `file://${sample}`,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      },
    },
  });
  ok(
    'inline-значение получено',
    Array.isArray(inlineValues) && inlineValues[0]?.caseSensitiveLookup === false,
    JSON.stringify(inlineValues),
  );

  /* Моникеры: устойчивое имя символа — связь с тем же символом в других инструментах. */
  const monikers = await lsp.request(sample, 'textDocument/moniker', {
    textDocument: { uri: `file://${sample}` },
    position: { line: 0, character: 1 },
  });
  ok('моникер получен', monikers?.[0]?.identifier === 'fake:/sample.py:fn', JSON.stringify(monikers));

  /* Семантические токены: сервер отдаёт плоский набор чисел — проверяем разбор в 1-based. */
  const semantic = await lsp.semanticTokens(sample);
  ok(
    'семантические токены разобраны',
    Array.isArray(semantic) && semantic.length === 2 && semantic[0].type === 'keyword',
    JSON.stringify(semantic),
  );
  ok('семантические координаты в 1-based', semantic?.[0]?.startColumn === 1 && semantic?.[1]?.startColumn === 5);

  /* Связанные участки (linkedEditingRange): сервер отдаёт два диапазона имени тега. */
  const linked = await lsp.request(sample, 'textDocument/linkedEditingRange', {
    textDocument: { uri: `file://${sample}` },
    position: { line: 0, character: 2 },
  });
  ok('связанные участки получены', Array.isArray(linked?.ranges) && linked.ranges.length === 2, JSON.stringify(linked));

  /* Форматирование УЧАСТКА (`textDocument/rangeFormatting`): сервер правит только
     запрошенный диапазон, а не файл целиком. Именно этим «форматировать выделение»
     и «форматировать при вставке» отличаются от инструмента проекта (ruff, prettier),
     который всегда переписывает весь файл. */
  const rangeEdits = await lsp.formatRange(sample, {
    startLine: 2,
    startColumn: 1,
    endLine: 2,
    endColumn: 6,
  });
  ok(
    'участок отформатирован: правки в 1-based',
    Array.isArray(rangeEdits) &&
      rangeEdits.length === 1 &&
      rangeEdits[0].startLine === 2 &&
      rangeEdits[0].startColumn === 1 &&
      rangeEdits[0].endLine === 2 &&
      rangeEdits[0].endColumn === 6,
    JSON.stringify(rangeEdits),
  );

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

  // Язык без сервера: тихо ничего не делаем, но причину запоминаем — она видна
  // человеку («почему тут нет подсказок»), а поиск сервера повторять незачем.
  await lsp.open(path.join(root, 'scripts', 'x.unknown'), 'unknown', '');
  ok('неизвестный язык игнорируется', !lsp.status().running.includes('unknown'));
  const unknownFailure = lsp.status().failed.find((item) => item.language === 'unknown');
  ok('причина отказа видна в состоянии', unknownFailure?.reason === 'сервер не найден', JSON.stringify(unknownFailure));
  // Состояние запущенных серверов говорит, что за сервер и откуда.
  const running = lsp.status().servers.find((item) => item.language === 'python');
  ok(
    'состояние называет сервер и его источник',
    Boolean(running?.label) && typeof running?.origin === 'string',
    JSON.stringify(running),
  );

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

  /* Ссылки и переход к определению (инструменты find_references/go_to_definition).
     Файл не открыт — сервис поднимает сервер и открывает документ сам. Координаты
     сервер шлёт 0-based, клиент обязан отдать 1-based; оба вида ответа (Location и
     LocationLink) разбираются в один список. */
  const references = await lsp.references(sample, 'python', 'print(1)\n', 10, 5, true);
  // Три, а не две: одну ссылку сервер прислал куском (partialResultToken) — она должна
  // была склеиться с основным ответом (см. `JsonRpcConnection.dispatch`).
  ok('ссылки получены и частичный результат склеен', references?.length === 3, JSON.stringify(references));
  const inSample = references?.find((item) => item.path === sample);
  ok(
    'координаты ссылок переведены в 1-based',
    inSample?.line === 10 && inSample.column === 5,
    JSON.stringify(inSample),
  );

  /* Прогресс (`$/progress`): запрос ссылок заставил сервер попросить индикатор и
     сообщить begin/report/end — проверяем, что эти уведомления дошли до окна. */
  const progress = events.filter((event) => event.topic === 'lsp:progress').map((event) => event.payload);
  ok(
    'прогресс дошёл: begin и report с процентами',
    progress.some((item) => item.kind === 'work' && item.phase === 'begin' && item.title === 'Ищу ссылки') &&
      progress.some((item) => item.phase === 'report' && item.percentage === 50),
    JSON.stringify(progress),
  );

  const definition = await lsp.definition(sample, 'python', 'print(1)\n', 10, 5);
  ok(
    'переход к определению понимает LocationLink',
    definition?.[0]?.line === 3 && definition[0].column === 7,
    JSON.stringify(definition?.[0]),
  );

  // Язык без сервера: `null` — «сервера нет», а не «мест нет».
  const noReferences = await lsp.references(path.join(root, 'scripts', 'x.unknown'), 'unknown', '', 1, 1, true);
  ok('без сервера ссылок нет (null)', noReferences === null, String(noReferences));

  /* Переименование (инструмент rename_symbol): правки в нескольких файлах одной
     формой `changes`, каждая — в нашем виде (позиции 1-based), сгруппированная по
     файлу. Это то, что применяет документная модель renderer. */
  const renameEdits = await lsp.rename(sample, 'python', 'print(1)\n', 3, 7, 'Renamed');
  ok(
    'правки переименования получены',
    Array.isArray(renameEdits) && renameEdits.length === 2,
    JSON.stringify(renameEdits),
  );
  ok(
    'правки сгруппированы по файлам с 1-based координатами',
    renameEdits?.[0]?.path.endsWith('other.py') &&
      renameEdits?.[1]?.edits[0]?.startLine === 3 &&
      renameEdits[1].edits[0].newText === 'Renamed',
    JSON.stringify(renameEdits),
  );

  /* Откат на запасной сервер: названный в настройках не поднялся (процесс выходит
     сразу), язык должен получить следующий по приоритету — иначе Python остаётся
     без подсказок (живой случай: сломанный pylsp из venv). */
  const broken = { language: 'python', command: process.execPath, args: ['-e', 'process.exit(1)'], enabled: true };
  const working = { language: 'python', command: process.execPath, args: [fakeServer], enabled: true };
  const fbEvents = [];
  const fallback = new LspService(
    () => root,
    () => ({ enabled: true, servers: [broken] }),
    (topic, payload) => fbEvents.push({ topic, payload }),
    () => null,
    async () => ({}),
    async (language) => (language === 'python' ? [working] : []),
  );
  await fallback.open(sample, 'python', 'print(1)\n');
  await wait(700);
  ok('нерабочий сервер не оставил язык без сервера', fallback.status().running.includes('python'));
  ok(
    'запасной сервер отвечает (диагностика)',
    fbEvents.some((event) => event.topic === LSP_DIAGNOSTICS && event.payload.diagnostics.length > 0),
  );
  fallback.dispose();

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
