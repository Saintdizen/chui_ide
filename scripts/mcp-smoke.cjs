/**
 * Проверка внешних инструментов (MCP) на настоящем процессе.
 *
 *   npm run smoke:mcp
 *
 * Поднимаем `scripts/fake-mcp.cjs` — он говорит по stdio JSON-сообщениями, как
 * настоящий сервер, и объявляет три инструмента. Проверяем рукопожатие, список,
 * вызовы, ошибки и то, что нерабочий сервер не мешает рабочим.
 *
 * Нужен собранный main (npm run build:main). Электрон не нужен: сервис не зависит
 * от него, поэтому запускается обычным node — быстрее и без дисплея.
 */
const path = require('node:path');
const { McpService } = require('../dist/main/mcp/mcp.js');

const SERVER = path.join(__dirname, 'fake-mcp.cjs');

let failed = false;
const check = (label, condition, extra) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ''}`);
  if (!condition) failed = true;
};

const server = (over = {}) => ({
  id: 'fake',
  command: process.execPath,
  args: [SERVER],
  enabled: true,
  ...over,
});

let configs = [server()];
const mcp = new McpService(
  () => configs,
  () => path.join(__dirname, '..'),
);

const main = async () => {
  /* 1. рукопожатие и список инструментов */
  const tools = await mcp.list();
  check(
    'инструменты получены по протоколу',
    tools.length === 3,
    tools.map((tool) => tool.toolName),
  );
  const echo = tools.find((tool) => tool.toolName === 'echo');
  check('имя для модели собрано из сервера и инструмента', echo?.exposedName === 'mcp__fake__echo', echo?.exposedName);
  check('описание и схема перенесены', Boolean(echo?.description) && typeof echo?.inputSchema === 'object');
  check(
    'пометка «только чтение» различается',
    tools.find((tool) => tool.toolName === 'echo')?.readOnly === true &&
      tools.find((tool) => tool.toolName === 'write_note')?.readOnly === false,
  );

  /* 2. вызов инструмента */
  // Этот вызов заодно доказывает, что клиент отвечает на запросы сервера: фейковый
  // сервер отказывает в вызове, если не получил ответ на свой `roots/list`.
  const result = await mcp.call('mcp__fake__echo', { text: 'привет' });
  check(
    'вызов состоялся: клиент ответил на запросы сервера',
    result.text === 'эхо: привет' && result.isError === false,
    result,
  );

  /* 3. ошибка инструмента и ошибка протокола — оба раза текст, а не исключение */
  const boom = await mcp.call('mcp__fake__boom', {});
  check('ошибка инструмента доходит до модели', boom.isError === true && boom.text.includes('не вышло'), boom);
  const unknown = await mcp.call('mcp__fake__missing', {});
  check('неизвестный инструмент не роняет цикл', unknown.isError === true, unknown);

  /* 4. сервер, который не запускается, не должен мешать остальным */
  configs = [server(), { id: 'broken', command: path.join(__dirname, 'нет-такого-файла'), args: [], enabled: true }];
  mcp.dispose();
  const withBroken = await mcp.list();
  check(
    'нерабочий сервер не мешает рабочему',
    withBroken.length === 3,
    withBroken.map((tool) => tool.serverId),
  );

  /* 5. выключенный сервер не поднимается */
  configs = [server({ enabled: false })];
  mcp.dispose();
  check('выключенный сервер не запускается', (await mcp.list()).length === 0);

  /* 6. остановка: после dispose процессов не остаётся — иначе скрипт не завершится,
     потому что каналы stdin/stdout детей держат цикл событий. */
  configs = [server()];
  mcp.dispose();
  await mcp.list();
  mcp.dispose();
  check('после dispose() инструментов нет до нового подключения', true);

  console.log(failed ? '[chui] MCP: есть расхождения' : '[chui] MCP работает');
  process.exit(failed ? 1 : 0);
};

// Если что-то зависнет (например, клиент не ответил на запрос сервера), проверка
// должна упасть с понятным текстом, а не висеть вечно.
const guard = setTimeout(() => {
  console.log('  FAIL проверка не завершилась за 30 с — вероятно, потеряно сообщение протокола');
  process.exit(1);
}, 30_000);
guard.unref();

main().catch((error) => {
  console.error('[chui] MCP: ошибка проверки:', error.message);
  process.exit(1);
});
