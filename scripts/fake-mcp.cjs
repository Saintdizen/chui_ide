/*
 * Мини-сервер MCP для смоука: говорит по stdio JSON-сообщениями (по одному на
 * строку), как настоящий сервер. Объявляет три инструмента, включая два «только
 * чтение», и один, который всегда возвращает ошибку, — проверке нужны все случаи.
 *
 * Отдельная деталь: сразу после рукопожатия сервер шлёт запрос КЛИЕНТУ
 * (roots/list). Настоящие серверы так делают, и клиент обязан ответить: иначе
 * сервер ждёт ответа вечно, и агент встаёт. Ответ виден в stderr.
 */
let buffer = '';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Вернуть переданный текст',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: 'Записать заметку',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
  },
  {
    name: 'boom',
    description: 'Всегда заканчивается ошибкой',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
];

/** Ответил ли клиент на наш запрос. Пока нет — список инструментов не отдаём:
 *  молчание клиента в настоящем протоколе означает зависший сервер, и проверка
 *  обязана это заметить, а не пройти «на удачу». */
let clientReplied = false;

function handle(message) {
  // Ответ клиента на наш запрос: id есть, метода нет.
  if (message.id !== undefined && message.method === undefined) {
    clientReplied = true;
    process.stderr.write(`[fake-mcp] ответ на запрос сервера: ${JSON.stringify(message.error ?? message.result)}\n`);
    return;
  }

  switch (message.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '1.0.0' },
        },
      });
      send({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list' });
      return;

    case 'notifications/initialized':
      return;

    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
      return;

    case 'tools/call': {
      // К этому моменту обмен уже состоялся (список инструментов сходил и вернулся),
      // поэтому отсутствие ответа — точно поломка клиента, а не порядок чтения
      // канала: запрос `roots/list` ушёл раньше, чем клиент успел отправить
      // `tools/list`, и гонку здесь устроить нельзя.
      if (!clientReplied) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'клиент не ответил на запрос сервера roots/list' },
        });
        return;
      }

      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (name === 'echo') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `эхо: ${args.text ?? ''}` }] },
        });
        return;
      }
      if (name === 'write_note') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `записано: ${args.note ?? ''}` }] },
        });
        return;
      }
      if (name === 'boom') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { isError: true, content: [{ type: 'text', text: 'не вышло' }] },
        });
        return;
      }
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `нет инструмента ${name}` } });
      return;
    }

    default:
      if (message.id !== undefined) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `метод ${message.method} неизвестен` },
        });
      }
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf('\n');
  while (at >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) handle(JSON.parse(line));
    at = buffer.indexOf('\n');
  }
});
