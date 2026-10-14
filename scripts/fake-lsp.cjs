/*
 * Мини-сервер LSP для смоука: отвечает на initialize, шлёт диагностику при didOpen
 * и запрос серверу→клиенту (проверяем, что клиент на него отвечает), гасит
 * пометки при didChange/didClose. Формат — тот же Content-Length фрейминг.
 */
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          documentSymbolProvider: true,
          referencesProvider: true,
          definitionProvider: true,
          renameProvider: true,
          foldingRangeProvider: true,
          selectionRangeProvider: true,
          // Форматирование участка: по нему проверяем и «форматировать выделение», и
          // форматирование на вставке (см. scripts/lsp-smoke.cjs).
          documentRangeFormattingProvider: true,
          typeHierarchyProvider: true,
          documentLinkProvider: { resolveProvider: true },
          linkedEditingRangeProvider: true,
          monikerProvider: true,
          inlineValueProvider: true,
          semanticTokensProvider: {
            legend: {
              tokenTypes: [
                'namespace',
                'type',
                'class',
                'function',
                'variable',
                'keyword',
                'comment',
                'string',
                'number',
              ],
              tokenModifiers: ['declaration', 'readonly', 'static'],
            },
            full: true,
          },
          // Подсказки: триггер по точке и доведение элемента (resolve) — оба пути
          // проверяет смоук (см. scripts/lsp-smoke.cjs).
          completionProvider: { triggerCharacters: ['.'], resolveProvider: true },
          // Рефакторинги: сервер заявляет виды, которые умеет, — по ним редактор и
          // показывает «Извлечь…» и «Развернуть (inline)…».
          codeActionProvider: { codeActionKinds: ['refactor.extract', 'refactor.inline'] },
        },
      },
    });
    // Запрос сервер→клиент: клиент обязан ответить, иначе протокол ломается.
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'window/workDoneProgress/create', params: { token: 'x' } });
    return;
  }
  if (message.method === 'initialized') {
    // Динамическую регистрацию мы не заявляли, значит сервер вправе её не слать; но если
    // пришлёт — клиент обязан ответить MethodNotFound, а не «успехом» (см. `onRequest`).
    send({
      jsonrpc: '2.0',
      id: 'srv-2',
      method: 'client/registerCapability',
      params: { registrations: [{ id: 'r1', method: 'textDocument/hover' }] },
    });
    return;
  }

  if (message.method === 'textDocument/didOpen') {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: message.params.textDocument.uri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 1,
            message: 'fake error',
            source: 'fake',
          },
          {
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } },
            severity: 2,
            message: 'fake warning',
          },
        ],
      },
    });
    return;
  }

  if (message.method === 'textDocument/didChange') {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: message.params.textDocument.uri, diagnostics: [] },
    });
    return;
  }

  if (message.method === 'textDocument/didClose') {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: message.params.textDocument.uri, diagnostics: [] },
    });
    return;
  }

  // Форматирование участка: сервер отдаёт правки только для запрошенного диапазона и
  // приводит его к «как надо» — на этом видно, что мы просим именно участок, а не файл.
  if (message.method === 'textDocument/rangeFormatting') {
    const range = message.params.range;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          range,
          // Правка заменяет участок на строку с двумя пробелами отступа: заметно и узнаваемо.
          newText: '  formatted',
        },
      ],
    });
    return;
  }

  // Действия языка (`textDocument/codeAction`): отдаём ДВА рефакторинга разного вида —
  // по ним видно, что «извлечение» и «разворачивание» (свои команды редактора) отбираются
  // по виду действия, а не по заголовку. Извлечение несёт правки, разворачивание — нет.
  if (message.method === 'textDocument/codeAction') {
    const uri = message.params.textDocument.uri;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          title: 'Извлечь в константу',
          kind: 'refactor.extract.constant',
          edit: {
            changes: {
              [uri]: [
                { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'VALUE' },
              ],
            },
          },
        },
        { title: 'Развернуть', kind: 'refactor.inline' },
      ],
    });
    return;
  }

  // Скелет файла: класс с методом и функция — вложенность проверяется вместе
  // с номерами строк. Строки здесь нулевые, как их шлёт настоящий сервер.
  if (message.method === 'textDocument/documentSymbol') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          name: 'Parser',
          kind: 5,
          range: { start: { line: 2, character: 0 }, end: { line: 40, character: 0 } },
          selectionRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 12 } },
          children: [
            { name: 'parse', kind: 6, range: { start: { line: 4, character: 4 }, end: { line: 9, character: 0 } } },
          ],
        },
        { name: 'read_file', kind: 12, range: { start: { line: 43, character: 0 }, end: { line: 43, character: 0 } } },
      ],
    });
    return;
  }

  // Ссылки на символ: два места в разных файлах — проверяем и разбор, и перевод
  // координат (сервер шлёт 0-based, клиент отдаёт 1-based).
  if (message.method === 'textDocument/references') {
    const uri = message.params.textDocument.uri;
    // Заодно проверяем прогресс и частичные результаты: сервер просит создать индикатор
    // (work done progress), шлёт begin/report, а часть ссылок отдаёт куском (partial).
    send({ jsonrpc: '2.0', id: 'wd-refs', method: 'window/workDoneProgress/create', params: { token: 'refs' } });
    send({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'refs', value: { kind: 'begin', title: 'Ищу ссылки' } },
    });
    send({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'refs', value: { kind: 'report', message: 'половина', percentage: 50 } },
    });
    send({ jsonrpc: '2.0', method: '$/progress', params: { token: 'refs', value: { kind: 'end' } } });
    // Частичный результат: часть ссылок отдаём куском по токену из запроса — клиент
    // обязан склеить их с остальным ответом.
    const partialToken = message.params.partialResultToken;
    if (partialToken !== undefined) {
      send({
        jsonrpc: '2.0',
        method: '$/progress',
        params: {
          token: partialToken,
          value: {
            items: [
              {
                uri: `file://${process.cwd()}/scripts/first.py`,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              },
            ],
          },
        },
      });
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        { uri, range: { start: { line: 9, character: 4 }, end: { line: 9, character: 16 } } },
        {
          uri: `file://${process.cwd()}/scripts/other.py`,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        },
      ],
    });
    return;
  }

  // Переход к определению: LocationLink — вторая форма ответа, её тоже понимаем.
  if (message.method === 'textDocument/definition') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          targetUri: message.params.textDocument.uri,
          targetSelectionRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 12 } },
        },
      ],
    });
    return;
  }

  // Переименование: правки в двух файлах, форма `changes` — проверяем и разбор,
  // и перевод координат (сервер шлёт 0-based, клиент отдаёт 1-based).
  if (message.method === 'textDocument/rename') {
    const uri = message.params.textDocument.uri;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        documentChanges: [
          // Операция с файлами вперемешку с правками: разбор обязан её не потерять и не
          // спутать с правкой (см. `shared/lsp-workspace-edit.ts`).
          { kind: 'create', uri: `file://${process.cwd()}/scripts/new-file.py` },
          {
            textDocument: { uri },
            edits: [
              {
                range: { start: { line: 2, character: 6 }, end: { line: 2, character: 12 } },
                newText: message.params.newName,
              },
            ],
          },
          {
            textDocument: { uri: `file://${process.cwd()}/scripts/other.py` },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                newText: message.params.newName,
              },
            ],
          },
        ],
      },
    });
    return;
  }

  // Подсказки: отвечаем с ЗАДЕРЖКОЙ — так проверяется отмена устаревшего запроса
  // (клиент шлёт $/cancelRequest и не ждёт ответа). Описание в первом ответе НЕ даём:
  // его должен добыть `completionItem/resolve`, как делают настоящие серверы.
  if (message.method === 'textDocument/completion') {
    const items = [
      { label: 'print', kind: 3, insertText: 'print', data: { id: 'print' } },
      { label: 'property', kind: 10, insertText: 'property', data: { id: 'property' } },
    ];
    setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result: { isIncomplete: false, items } }), 250);
    return;
  }

  // Доведение подсказки: к тому же элементу дописываем описание и подробность.
  if (message.method === 'completionItem/resolve') {
    const item = message.params ?? {};
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        ...item,
        detail: 'print(*args)',
        documentation: { kind: 'markdown', value: 'Печатает объекты в поток вывода.' },
      },
    });
    return;
  }

  // Иерархия типов: prepare даёт символ, supertypes — его надтип.
  if (message.method === 'textDocument/prepareTypeHierarchy') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          name: 'Derived',
          kind: 5,
          uri: message.params.textDocument.uri,
          range: { start: { line: 1, character: 0 }, end: { line: 5, character: 0 } },
          selectionRange: { start: { line: 1, character: 6 }, end: { line: 1, character: 13 } },
          data: { id: 'derived' },
        },
      ],
    });
    return;
  }

  if (message.method === 'typeHierarchy/supertypes') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          name: 'Base',
          kind: 5,
          uri: message.params.item.uri,
          range: { start: { line: 8, character: 0 }, end: { line: 10, character: 0 } },
          selectionRange: { start: { line: 8, character: 6 }, end: { line: 8, character: 10 } },
        },
      ],
    });
    return;
  }

  if (message.method === 'typeHierarchy/subtypes') {
    send({ jsonrpc: '2.0', id: message.id, result: [] });
    return;
  }

  // Ссылки в коде: одна БЕЗ адреса — его добывает resolve.
  if (message.method === 'textDocument/documentLink') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, data: { id: 'l1' } }],
    });
    return;
  }

  if (message.method === 'documentLink/resolve') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { ...message.params, target: 'https://example.com/', tooltip: 'Открыть пример' },
    });
    return;
  }

  // Inline-значения: сервер помечает участок и просит найти переменную у отладчика.
  if (message.method === 'textDocument/inlineValue') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, caseSensitiveLookup: false },
      ],
    });
    return;
  }

  if (message.method === 'textDocument/moniker') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [{ scheme: 'fake', identifier: 'fake:/sample.py:fn', unique: 'project' }],
    });
    return;
  }

  // Семантические токены: первая строка — «def» как ключевое слово и «f» как функция.
  // Формат — сдвиги (deltaLine, deltaStartChar, length, тип, модификаторы).
  if (message.method === 'textDocument/semanticTokens/full') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        data: [
          0,
          0,
          3,
          5,
          0, // «def» — keyword (индекс 5)
          0,
          4,
          1,
          3,
          0, // «f» — function (индекс 3)
        ],
      },
    });
    return;
  }

  // Связанные участки: два диапазона в первой строке — имена парного тега.
  if (message.method === 'textDocument/linkedEditingRange') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        ranges: [
          { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
          { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
        ],
      },
    });
    return;
  }

  // Выделение по структуре: цепочка участков вокруг места (слово → выражение → строка).
  if (message.method === 'textDocument/selectionRange') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
          parent: {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
            parent: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 24 } } },
          },
        },
      ],
    });
    return;
  }

  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }

  if (message.method === 'exit') {
    process.exit(0);
  }

  // Прочие запросы клиента (их у нас нет) — отвечаем null, чтобы не висеть.
  if (message.id !== undefined && message.method !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: null });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    const start = headerEnd + 4;
    if (!match) {
      buffer = buffer.slice(start);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < start + length) return;
    const body = buffer.slice(start, start + length).toString('utf8');
    buffer = buffer.slice(start + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }
    handle(message);
  }
});
