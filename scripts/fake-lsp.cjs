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
      result: { capabilities: { textDocumentSync: 1, documentSymbolProvider: true } },
    });
    // Запрос сервер→клиент: клиент обязан ответить, иначе протокол ломается.
    send({ jsonrpc: '2.0', id: 'srv-1', method: 'window/workDoneProgress/create', params: { token: 'x' } });
    return;
  }
  if (message.method === 'initialized') return;

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
