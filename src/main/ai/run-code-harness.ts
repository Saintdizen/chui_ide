/**
 * Исходник обвязки для программы агента (`run_code`).
 *
 * Обвязка исполняется отдельным процессом: программа может упасть, зависнуть или
 * напечатать что угодно, а беседа и окно продолжают работать. В самом процессе
 * нет ничего, кроме канала к родителю: инструменты живут в main, и каждый вызов
 * уходит туда сообщением, а назад приходит ответ.
 *
 * Почему строкой, а не файлом: файл пришлось бы класть рядом с приложением, а в
 * собранном виде код лежит в asar — оттуда чужой процесс запустить нельзя.
 * Строка пишется в папку запуска и исполняется оттуда; так же она видна в тестах
 * ровно в том виде, в каком работает.
 *
 * Правки этого текста — обычный JavaScript: типов, импортов и шаблонных строк
 * здесь нет намеренно (шаблон внутри шаблона читать невозможно).
 */
export const HARNESS_SOURCE = `// Обвязка run_code: инструменты по каналу к main, вывод программы — пачкой.
import { pathToFileURL } from 'node:url';

const MAX_LOGS = 400;
const MAX_LOG_CHARS = 20000;

const logs = [];
let logChars = 0;

function asText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function record(level, args) {
  if (logChars >= MAX_LOG_CHARS || logs.length >= MAX_LOGS) return;
  const text = Array.prototype.map.call(args, asText).join(' ');
  const line = level === 'log' ? text : '[' + level + '] ' + text;
  logs.push(line);
  logChars += line.length;
}

// Вывод программы забираем себе, а не пускаем в stdout: stdout принадлежит
// обвязке, и смешивать с ним текст программы значило бы разбирать кашу.
const silent = () => {};
console.log = (...args) => record('log', args);
console.info = (...args) => record('log', args);
console.warn = (...args) => record('warn', args);
console.error = (...args) => record('error', args);
console.debug = silent;
console.trace = silent;

let seq = 0;
const pending = new Map();

process.on('message', (message) => {
  if (!message || message.kind !== 'reply') return;
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(message.value);
});

function send(message) {
  return new Promise((resolve) => {
    if (!process.send) {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });
}

function callTool(name, args) {
  const id = ++seq;
  const promise = new Promise((resolve) => pending.set(id, resolve));
  void send({ kind: 'call', id, name, args: args === undefined ? {} : args });
  return promise;
}

// tools.<имя>(args) — любой инструмент сессии. Прокси, а не готовый объект:
// список инструментов зависит от настроек, и знать его здесь незачем.
const tools = new Proxy(
  {},
  {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then' || name === 'toJSON') return undefined;
      return (args) => callTool(name, args);
    },
    has(_target, name) {
      return typeof name === 'string';
    },
  },
);

function describeError(error) {
  if (error instanceof Error) {
    return { message: error.message || String(error), stack: error.stack };
  }
  return { message: asText(error), stack: undefined };
}

let finished = false;

async function finish(message) {
  if (finished) return;
  finished = true;
  await send(message);
  process.exit(0);
}

process.on('uncaughtException', (error) => {
  const described = describeError(error);
  void finish({ kind: 'error', message: described.message, stack: described.stack });
});

process.on('unhandledRejection', (reason) => {
  const described = describeError(reason);
  void finish({ kind: 'error', message: described.message, stack: described.stack });
});

async function main() {
  const programPath = process.argv[2];
  const module = await import(pathToFileURL(programPath).href);
  const run = module.default;
  if (typeof run !== 'function') {
    await finish({ kind: 'error', message: 'Программа не экспортирует функцию: обёртка ожидает её тело.' });
    return;
  }
  const value = await run(tools);
  await finish({ kind: 'done', value: asText(value), logs });
}

main().catch((error) => {
  const described = describeError(error);
  void finish({ kind: 'error', message: described.message, stack: described.stack, logs });
});
`;
