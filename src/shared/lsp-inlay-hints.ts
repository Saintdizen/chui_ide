/**
 * Разбор ответа `textDocument/inlayHint`: короткие подсказки прямо в коде.
 *
 * Inlay hint — это вставка, которой нет в тексте файла: тип переменной после её имени
 * (`x : int`) или имя аргумента перед ним (`name: value`). Присылает их языковой сервер
 * по запросу `textDocument/inlayHint`; здесь мы приводим ответ к одной простой форме,
 * а как их показать — решает представление.
 *
 * Разбор — чистое правило: ни сети, ни DOM. Поэтому его видно в тестах без окна, и он
 * общий с тем, что мог бы читать агент, — как остальные `shared/lsp-*.ts`.
 */

/** Что за подсказка: тип, имя параметра или иное (сервер не сказал). */
export type InlayHintKind = 'type' | 'parameter' | 'other';

/** Одна подсказка: место (1-based, как у нас) и текст. */
export interface InlayHint {
  readonly line: number;
  readonly column: number;
  readonly label: string;
  readonly kind: InlayHintKind;
}

/** Подсказки из ответа сервера. Битые записи и пустые подписи пропускаем. */
export function toInlayHints(raw: unknown): InlayHint[] {
  if (!Array.isArray(raw)) return [];
  const hints: InlayHint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as { position?: unknown; label?: unknown; kind?: unknown };
    const position = value.position as { line?: unknown; character?: unknown } | undefined;
    if (!position || typeof position.line !== 'number' || typeof position.character !== 'number') continue;
    const label = labelText(value.label);
    if (label === '') continue;
    hints.push({
      line: position.line + 1,
      column: position.character + 1,
      label,
      kind: kindOf(value.kind),
    });
  }
  return hints;
}

/** Подпись подсказки: строка или список частей (`InlayHintLabelPart`). */
function labelText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  const parts: string[] = [];
  for (const part of raw) {
    if (typeof part === 'string') parts.push(part);
    else if (part && typeof part === 'object' && typeof (part as { value?: unknown }).value === 'string') {
      parts.push((part as { value: string }).value);
    }
  }
  return parts.join('');
}

/** Вид подсказки: 1 — тип, 2 — параметр (так велит LSP), иначе неизвестно. */
function kindOf(raw: unknown): InlayHintKind {
  if (raw === 1) return 'type';
  if (raw === 2) return 'parameter';
  return 'other';
}
