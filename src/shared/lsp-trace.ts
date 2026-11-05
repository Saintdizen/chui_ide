/**
 * Журнал обмена с языковым сервером — для чтения человеком.
 *
 * main пишет журнал построчно (см. `LspService.trace`): JSON с временем,
 * направлением и самим сообщением. Здесь — перевод в строки панели и хвост:
 * журнал смотрят, когда что-то пошло не так, и смотрят с конца.
 */

export interface LspTraceLine {
  /** Время сообщения, ISO — как записал main. */
  at: string;
  direction: 'client' | 'server';
  /** Метод или `notify`/`response` — по чему искать в журнале. */
  kind: string;
  /** Одна строка текста: JSON сообщения без переносов. */
  text: string;
}

/** Запись журнала как пришла из main: JSON одной строкой. */
interface RawTraceLine {
  at?: unknown;
  direction?: unknown;
  message?: unknown;
}

/**
 * Разобрать хвост журнала.
 *
 * Битые строки пропускаем, а не падаем: журнал дописывается параллельно
 * чтению, и последняя строка может быть недописанной. `limit` — сколько
 * последних строк отдать: в панели нужен конец, а не начало.
 */
export function parseTrace(raw: string, limit = 200): LspTraceLine[] {
  const out: LspTraceLine[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = safeParse(trimmed);
    if (!parsed) continue;
    const direction = parsed.direction === 'server' ? 'server' : 'client';
    const message = parsed.message;
    out.push({
      at: typeof parsed.at === 'string' ? parsed.at : '',
      direction,
      kind: describeKind(message),
      text: describeMessage(message),
    });
  }
  return limit > 0 ? out.slice(-limit) : out;
}

/**
 * Как назвать сообщение: метод запроса/уведомления или вид ответа.
 * По этому имени человек ищет в журнале («где мой `textDocument/hover`»).
 */
export function describeKind(message: unknown): string {
  const record = message as { method?: unknown; id?: unknown; result?: unknown; error?: unknown } | null;
  if (record && typeof record.method === 'string') return record.method;
  if (record && record.error !== undefined) return 'error';
  if (record && 'result' in record) return 'result';
  return 'message';
}

/** Текст сообщения в одну строку: JSON без переносов, длинное обрезаем. */
export function describeMessage(message: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(message) ?? String(message);
  } catch {
    text = String(message);
  }
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

function safeParse(line: string): RawTraceLine | null {
  try {
    const value = JSON.parse(line) as RawTraceLine | null;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
