/**
 * Серые подсказки вперёд от языкового сервера (`textDocument/inlineCompletion`).
 *
 * Ответ LSP бывает двух видов: голый список предметов либо обёртка `{ items }`.
 * Сам предмет несёт `insertText`, и он тоже двоякий: строка или `{ value }`
 * (`StringValue`). Мелочи на вид, но пропустишь — и подсказка молча исчезает.
 */

/** Текст вставки из `insertText`: строка или `StringValue`. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const text = (value as { value?: unknown } | null)?.value;
  return typeof text === 'string' ? text : '';
}

/**
 * Строки, которые можно показать серым после курсора. Пустые и повторяющиеся
 * отбрасываем: сервер иногда присылает несколько вариантов одного текста, а
 * на экране они слились бы в один.
 */
export function toInlineSnippets(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const items = Array.isArray(result)
    ? result
    : (((result as { items?: unknown }).items as unknown[] | undefined) ?? []);
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  for (const item of items) {
    const text = textOf((item as { insertText?: unknown } | null)?.insertText);
    if (text) seen.add(text);
  }
  return [...seen];
}
