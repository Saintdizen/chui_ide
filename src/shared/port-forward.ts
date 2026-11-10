/**
 * Порты, слушающие на машине, и их привязка к процессам и терминалам редактора.
 *
 * Разбор — чистая функция `shared`: ss/lsof/netstat есть не везде, вывод у них
 * разный, а привязать найденный порт к сессии терминала без дерева процессов
 * нельзя. Всё это проверяется тестами без запуска команды, поэтому здесь
 * только текст → структура, а запуск живёт в `main/terminal/ports.ts`.
 */

/** Один слушающий порт. */
export interface ListeningPort {
  port: number;
  pid: number;
  /** Имя процесса из вывода (`node`, `python3`) — без пути: он бывает длиной с экран. */
  command: string;
}

/** Порт вместе с сессией терминала, которой он принадлежит (или без неё). */
export interface PortEntry extends ListeningPort {
  /** id сессии терминала, если порт слушают её потомки; иначе `undefined`. */
  terminalId?: string;
  /** Адрес для браузера: `127.0.0.1`, а не `0.0.0.0` — вторая не открывается. */
  url: string;
}

const LOOPBACK = '127.0.0.1';

function urlFor(port: number): string {
  return `http://${LOOPBACK}:${port}/`;
}

/**
 * Порт из lsof: имя и pid идут колонками, адрес — в конце строки, в скобках —
 * состояние. Живьём lsof пишет `node 1 a 2u IPv4 ... TCP *:8080 (LISTEN)`.
 */
function parseLsof(text: string): ListeningPort[] {
  const found: ListeningPort[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    // Состояние — единственный надёжный признак: остальная строка похожа у всех.
    if (!/\s\(LISTEN\)\s*$/.test(line)) continue;
    const columns = line.trim().split(/\s+/);
    const command = columns[0] ?? '';
    const pid = Number(columns[1]);
    // Адрес — последний кусок перед «(LISTEN)». Формат `127.0.0.1:8080`, `*:8080`, `[::1]:8080`.
    const address = columns[columns.length - 2] ?? '';
    const match = /:([0-9]+)$/.exec(address);
    if (!match) continue;
    const port = Number(match[1]);
    if (!Number.isFinite(pid) || port <= 0) continue;
    // Один процесс может слушать на нескольких адресах — порт нужен один раз.
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ port, pid, command });
  }
  return found;
}

/**
 * Порт из ss — запасной путь для систем без lsof. Резолвер по pid передаётся
 * снаружи: `ss` пишет `users:(("node",pid=1234,fd=21))`, но только пока
 * хватает прав; без pid имени процесса не узнать, и такой порт всё равно нужен.
 */
function parseSs(text: string): ListeningPort[] {
  const found: ListeningPort[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('LISTEN')) continue;
    const address = line.trim().split(/\s+/)[3] ?? '';
    const match = /:([0-9]+)$/.exec(address);
    if (!match) continue;
    const port = Number(match[1]);
    if (port <= 0) continue;
    // Скобок в `users:(("node",pid=777,fd=21))` несколько: берём всё после
    // `users:(` как есть — имя в кавычках и pid ищутся отдельно. Резать до
    // первой `)` нельзя: там закрывается лишь одна из вложенных скобок.
    const inner = line.slice(line.indexOf('users:('));
    const command = /\("([^"]+)"/.exec(inner)?.[1] ?? '';
    const pid = Number(/pid=([0-9]+)/.exec(inner)?.[1] ?? 0);
    // Без pid порт знать полезно (его вообще кто-то слушает), но привязать
    // к процессу нельзя — такая запись не притворяется, что знает процесс.
    found.push({ port, pid: Number.isFinite(pid) ? pid : 0, command });
  }
  return found;
}

/** Выбрать разборщик по тексту: ss и lsof слишком разные, угадываем по заголовку. */
export function parseListings(text: string): ListeningPort[] {
  if (/^COMMAND\s+PID/m.test(text.trim())) return parseLsof(text);
  if (/^State\s+Recv-Q/m.test(text.trim())) return parseSs(text);
  return [...parseLsof(text), ...parseSs(text)];
}

/**
 * Родители из `ps -eo pid=,ppid=`: цепочка предков нужна, потому что порт
 * слушает обычно не сам шелл, а `node`/`vite` через несколько поколений.
 */
export function parsePsTree(text: string): Map<number, number> {
  const tree = new Map<number, number>();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/).map(Number);
    const pid = parts[0];
    const ppid = parts[1];
    if (pid === undefined || ppid === undefined) continue;
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    tree.set(pid, ppid);
  }
  return tree;
}

/**
 * Чья это сессия: идём вверх по предкам, пока не упрёмся в pid терминала.
 *
 * Защита от цикла и от мусора в дереве — не формальность: `ps` на Linux может
 * отдать строку с пустыми полями при удалении процесса, и без предела такой
 * поиск крутился бы вечно.
 */
export function ownerSession(
  pid: number,
  sessions: ReadonlyMap<number, string>,
  tree: ReadonlyMap<number, number>,
): string | undefined {
  let current: number | undefined = pid;
  for (let step = 0; step < 64 && current !== undefined && current > 0; step++) {
    const session = sessions.get(current);
    if (session) return session;
    current = tree.get(current);
  }
  return undefined;
}

/**
 * Собрать список для панели: порты терминалов — первыми, дальше остальные
 * слушатели по возрастанию номера. Один порт — одна строка, даже если его
 * держат два процесса: для «открыть в браузере» это один и тот же адрес.
 */
export function portEntries(
  listing: readonly ListeningPort[],
  sessions: ReadonlyMap<number, string>,
  tree: ReadonlyMap<number, number>,
): PortEntry[] {
  const byPort = new Map<number, PortEntry>();
  for (const item of listing) {
    const terminalId = item.pid > 0 ? ownerSession(item.pid, sessions, tree) : undefined;
    const existing = byPort.get(item.port);
    // Уже есть строка с этим портом: терминал важнее «ничей», имя — первое известное.
    if (existing && (existing.terminalId || !terminalId)) continue;
    byPort.set(item.port, {
      port: item.port,
      pid: item.pid,
      command: item.command || existing?.command || '',
      ...(terminalId ? { terminalId } : {}),
      url: urlFor(item.port),
    });
  }
  return [...byPort.values()].sort((a, b) => {
    if (!!a.terminalId !== !!b.terminalId) return a.terminalId ? -1 : 1;
    return a.port - b.port;
  });
}
