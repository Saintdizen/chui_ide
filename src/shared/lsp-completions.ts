import type { TextEdit } from './edits';
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
  /** Правки вместе со вставкой (авто-импорт). */
  readonly additionalEdits?: TextEdit[];
  /**
   * По чему сервер советует СОПОСТАВЛЯТЬ набранное: у CamelCase-серверов `filterText`
   * часто не равен подписи. Фильтровать по подписи значило бы терять верные ответы.
   */
  readonly filterText?: string;
  /** Ключ сортировки сервера (`sortText`): меньше — выше. Пусто — сортируем по подписи. */
  readonly sortText?: string;
  /** Сервер советует выделить эту подсказку сразу (обычно единственно верную). */
  readonly preselect?: boolean;
  /** Подсказка помечена как устаревшая (`tags: [Deprecated]` или `deprecated`). */
  readonly deprecated?: boolean;
  /**
   * Исходный элемент сервера: его отправляем назад в `completionItem/resolve`, когда
   * человек выделил строку. Серверы, умеющие доводить элемент, в первом ответе часто
   * опускают описание и подробность — именно поэтому без resolve попап выглядит голым.
   */
  readonly source?: unknown;
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
  return sortByServer(out);
}

/**
 * Порядок подсказок задаёт сервер (`sortText`, иначе — подпись): переупорядочивать его
 * выдачу значило бы отодвинуть то, что он считает самым нужным. Своей сортировки нет.
 */
function sortByServer(entries: CompletionEntry[]): CompletionEntry[] {
  return entries.sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
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
    additionalTextEdits?: unknown;
    filterText?: unknown;
    sortText?: unknown;
    preselect?: unknown;
    deprecated?: unknown;
    tags?: unknown;
  };

  const label = typeof value.label === 'string' ? value.label : null;
  if (!label) return null;

  // `textEdit.newText` точнее `insertText`: он задаёт и участок замены, и текст.
  const editText = value.textEdit && typeof value.textEdit.newText === 'string' ? value.textEdit.newText : null;
  const insert = editText ?? (typeof value.insertText === 'string' ? value.insertText : label);
  // Пустой вид бывает чаще, чем кажется: сервер вправе не прислать `kind`, а новый вид
  // из будущей версии протокола в таблице отсутствует. Без подписи в списке остаётся
  // пустое место, и `fitsExpectation` теряет единственный признак «это тип».
  const detail = typeof value.detail === 'string' && value.detail ? value.detail : kindLabel(value.kind) || 'символ';
  // `insertTextFormat: 2` — вставка как сниппет: разметку раскрывает редактор.
  const snippet = value.insertTextFormat === 2 ? insert : undefined;
  const additionalEdits = toAdditionalEdits(value.additionalTextEdits);
  const base = {
    label,
    insert,
    detail,
    // Исходный элемент — для `completionItem/resolve` (см. `CompletionEntry.source`).
    source: raw,
    ...(additionalEdits ? { additionalEdits } : {}),
    ...(typeof value.filterText === 'string' ? { filterText: value.filterText } : {}),
    ...(typeof value.sortText === 'string' ? { sortText: value.sortText } : {}),
    ...(value.preselect === true ? { preselect: true } : {}),
    // «Устарело» в новой форме — `tags: [1]`, в старой — флаг `deprecated`.
    ...(isDeprecated(value) ? { deprecated: true } : {}),
  };
  return snippet ? { ...base, snippet } : base;
}

/** Пометка «устарело»: `tags` содержит `1` (Deprecated) или выставлен старый флаг. */
function isDeprecated(value: { deprecated?: unknown; tags?: unknown }): boolean {
  if (value.deprecated === true) return true;
  return Array.isArray(value.tags) && value.tags.includes(1);
}

/**
 * Дополнительные правки подсказки из ответа LSP (авто-импорт). Позиции в них 0-based,
 * как везде в LSP, — приводим к нашему 1-based виду. Битые записи пропускаем.
 */
function toAdditionalEdits(raw: unknown): TextEdit[] | null {
  if (!Array.isArray(raw)) return null;
  const edits: TextEdit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as { range?: { start?: unknown; end?: unknown }; newText?: unknown };
    const start = value.range?.start as { line?: unknown; character?: unknown } | undefined;
    const end = value.range?.end as { line?: unknown; character?: unknown } | undefined;
    if (typeof value.newText !== 'string' || !start || !end) continue;
    if (typeof start.line !== 'number' || typeof start.character !== 'number') continue;
    if (typeof end.line !== 'number' || typeof end.character !== 'number') continue;
    edits.push({
      startLine: start.line + 1,
      startColumn: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
      newText: value.newText,
    });
  }
  return edits.length > 0 ? edits : null;
}

function kindLabel(kind: unknown): string {
  return typeof kind === 'number' ? (KIND_LABELS[kind] ?? '') : '';
}

/** Что дал `completionItem/resolve`: описание и уточнённое пояснение. */
export interface ResolvedCompletion {
  /** Уточнённое пояснение (если сервер его дал). Пусто — оставляем прежнее. */
  readonly detail?: string;
  /** Описание символа: строкой или разметкой сервера. */
  readonly documentation?: string;
}

/**
 * Разбор ответа `completionItem/resolve`. Сервер возвращает тот же элемент с дописанными
 * полями; нам нужны `detail` и `documentation`. Описание бывает строкой, `MarkupContent`
 * (`{kind, value}`) или их массивом — сводим к одному тексту (пустые части отбрасываем).
 * Ничего нет — `null`: показывать пустое описание хуже, чем не трогать строку списка.
 */
export function toResolvedCompletion(raw: unknown): ResolvedCompletion | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { detail?: unknown; documentation?: unknown };
  const detail = typeof value.detail === 'string' && value.detail.trim() ? value.detail : undefined;
  const documentation = documentationText(value.documentation);
  if (detail === undefined && documentation === undefined) return null;
  return { ...(detail !== undefined ? { detail } : {}), ...(documentation !== undefined ? { documentation } : {}) };
}

/** Текст описания из любой формы, в которой его шлёт сервер (строка/маркировка/массив). */
function documentationText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim() ? raw : undefined;
  if (Array.isArray(raw)) {
    const parts = raw
      .map((part) => (typeof part === 'string' ? part : documentationText(part)))
      .filter((part): part is string => typeof part === 'string' && part.length > 0);
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }
  if (raw && typeof raw === 'object') {
    const value = (raw as { value?: unknown }).value;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}
