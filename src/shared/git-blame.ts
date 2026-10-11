/**
 * Разбор `git blame --line-porcelain`: кто и когда менял каждую строку.
 *
 * Нужно, чтобы ответить на вопрос «откуда эта строка» — автором, коммитом и его
 * сообщением. Формат porcelain machine-readable: блок на строку, поля строками,
 * сам текст — после табуляции. Разбираем его здесь чисто (без процессов), поэтому
 * проверяется без git и Electron.
 *
 * Дата приходит как unix-время; показываем её как `ГГГГ-ММ-ДД` в UTC — для «когда»
 * этого достаточно, а часовой пояс автора к делу не относится.
 */

/** Одна строка файла и её происхождение. Номер строки — 1-based, как в файле. */
export interface BlameLine {
  line: number;
  /** Короткий хеш коммита (7 символов). */
  hash: string;
  author: string;
  /** Дата коммита, `ГГГГ-ММ-ДД`. */
  date: string;
  /** Заголовок сообщения коммита. */
  summary: string;
  /** Содержимое строки без перевода строки. */
  text: string;
}

/** Разобрать вывод `git blame --line-porcelain`. Непонятные блоки просто пропускаем. */
export function parseBlamePorcelain(output: string): BlameLine[] {
  const lines = output.split('\n');
  const result: BlameLine[] = [];

  // Поля текущего блока; начинается он заголовком с хешем и номерами строк.
  let current: Partial<BlameLine> | null = null;

  for (const raw of lines) {
    // Windows-версия git заканчивает строки `\r\n`: возврат каретки ломал бы и
    // заголовок блока, и текст строки (он бы приходил с лишним `\r` в конце).
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      current = { hash: header[1]!.slice(0, 7), line: Number(header[2]) };
      continue;
    }
    if (current === null) continue;

    // Текст строки: porcelain отделяет его ведущей табуляцией.
    if (line.startsWith('\t')) {
      current.text = line.slice(1);
      // Блок закрыт — собираем. Автор и дата должны быть; их отсутствие значит
      // битый ответ, такое лучше пропустить, чем показать «неизвестно».
      if (current.author !== undefined && current.date !== undefined) {
        result.push({
          line: current.line ?? 0,
          hash: current.hash ?? '',
          author: current.author,
          date: current.date,
          summary: current.summary ?? '',
          text: current.text,
        });
      }
      current = null;
      continue;
    }

    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'author') current.author = value;
    else if (key === 'summary') current.summary = value;
    else if (key === 'author-time') current.date = formatDate(Number(value));
  }

  return result;
}

/** Unix-время → `ГГГГ-ММ-ДД` (UTC). Мусор даёт пустую строку, а не «Invalid Date». */
function formatDate(seconds: number): string {
  if (!Number.isFinite(seconds)) return '';
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** Предел строк в ответе: длинный файл целиком не нужен, агенту важен фрагмент. */
const MAX_BLAME_LINES = 200;

/**
 * Отчёт по blame: подряд идущие строки одного коммита собираются в блок — так
 * видно «вот эту правку внёс такой-то», а не повторяется одно и то же на каждой
 * строке. Номера строк и текст — внутри блока: по ним агент видит, что именно.
 */
export function formatBlame(file: string, lines: readonly BlameLine[]): { summary: string; detail: string } {
  if (lines.length === 0) {
    return {
      summary: `${file}: blame пуст`,
      detail: 'git не вернул происхождение строк: файл не отслеживается или пуст.',
    };
  }

  const shown = lines.slice(0, MAX_BLAME_LINES);
  const out: string[] = [];
  // Подряд идущие строки одного коммита — один блок.
  let block: BlameLine[] = [];
  const flush = (): void => {
    if (block.length === 0) return;
    const first = block[0]!;
    out.push(`${first.hash} ${first.author} ${first.date} — ${first.summary || '(без сообщения)'}`);
    for (const entry of block) out.push(`  ${entry.line}: ${entry.text}`);
    block = [];
  };

  for (const line of shown) {
    if (block.length > 0 && block[block.length - 1]!.hash !== line.hash) flush();
    block.push(line);
  }
  flush();

  if (lines.length > shown.length) out.push(`… ещё строк: ${lines.length - shown.length}`);

  const authors = new Set(lines.map((line) => line.author));
  return {
    summary: `${file}: строк ${lines.length}, авторов ${authors.size}`,
    detail: out.join('\n'),
  };
}
