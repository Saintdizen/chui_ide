/**
 * Подсказки языка из ответа LSP.
 *
 * `textDocument/completion` отвечает либо списком `CompletionItem`, либо обёрткой
 * `CompletionList` с тем же списком внутри. У элемента подпись (`label`) может
 * отличаться от того, что вставляется (`insertText` или `textEdit.newText`) — у
 * функций сервер часто подставляет вызов со скобками. Здесь это сводится к одному
 * виду, которым пользуется подсказка своего редактора.
 *
 * Разбор — чистое правило: ни сети, ни DOM, ни буфера. Поэтому его видно в тестах,
 * и он общий с тем, что читает агент, — как и остальные `shared/lsp-*.ts`.
 *
 * Про сниппеты: при `insertTextFormat: 2` сервер присылает разметку (`${1:имя}`,
 * `$0`). Мы отдаём её отдельным полем — раскрывает её редактор своим `expandSnippet`,
 * а не сервер.
 */

/** Одна подсказка языка в общем виде: что показать и что вставить. */
export interface CompletionEntry {
  /** Подпись в списке. */
  readonly label: string;
  /** Что вставится: у сервера бывает не равно подписи (например, вызов функции). */
  readonly insert: string;
  /** Пояснение справа: вид символа от сервера. */
  readonly detail: string;
  /** Разметка сниппета, если сервер просил вставить как сниппет (`insertTextFormat: 2`). */
  readonly snippet?: string;
}

/**
 * Виды подсказок LSP → короткое пояснение. Номера у LSP фиксированы (1..25), и это
 * единственное место, где они переводятся в текст: держать таблицу в двух местах
 * значило бы однажды их развести.
 */
const KIND_LABELS: Record<number, string> = {
  1: 'текст',
  2: 'метод',
  3: 'функция',
  4: 'конструктор',
  5: 'поле',
  6: 'переменная',
  7: 'класс',
  8: 'интерфейс',
  9: 'модуль',
  10: 'свойство',
  11: 'единица',
  12: 'значение',
  13: 'перечисление',
  14: 'ключевое слово',
  15: 'сниппет',
  16: 'цвет',
  17: 'файл',
  18: 'ссылка',
  19: 'папка',
  20: 'элемент перечисления',
  21: 'константа',
  22: 'структура',
  23: 'событие',
  24: 'оператор',
  25: 'параметр типа',
};

/**
 * Разобрать ответ сервера в список подсказок. Битые элементы пропускаем, повторные
 * подписи убираем (серверы любят отдавать одно и то же дважды — из разных модулей).
 */
export function toCompletions(raw: unknown): CompletionEntry[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : (raw as { items?: unknown }).items;
  if (!Array.isArray(list)) return [];

  const out: CompletionEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const entry = toEntry(item);
    if (!entry || seen.has(entry.label)) continue;
    seen.add(entry.label);
    out.push(entry);
  }
  return out;
}

function toEntry(raw: unknown): CompletionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    label?: unknown;
    kind?: unknown;
    insertText?: unknown;
    textEdit?: { newText?: unknown };
    detail?: unknown;
    insertTextFormat?: unknown;
  };

  const label = typeof value.label === 'string' ? value.label : null;
  if (!label) return null;

  // `textEdit.newText` точнее `insertText`: он задаёт и участок замены, и текст.
  const editText = value.textEdit && typeof value.textEdit.newText === 'string' ? value.textEdit.newText : null;
  const insert = editText ?? (typeof value.insertText === 'string' ? value.insertText : label);
  const detail = typeof value.detail === 'string' && value.detail ? value.detail : kindLabel(value.kind);
  // `insertTextFormat: 2` — вставка как сниппет: разметку раскрывает редактор.
  const snippet = value.insertTextFormat === 2 ? insert : undefined;

  return snippet ? { label, insert, detail, snippet } : { label, insert, detail };
}

function kindLabel(kind: unknown): string {
  return typeof kind === 'number' ? (KIND_LABELS[kind] ?? '') : '';
}
