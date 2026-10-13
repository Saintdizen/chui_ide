import { expressionFor, inlineLabel, type InlineValue } from '../../shared/lsp-inline-value';
import type { DebugInlineValue } from '../editor/view/editor-view';

/** Значение переменной из отладчика: подпись (обычно `str(value)`), либо `null`. */
export interface EvaluatedValue {
  value: string;
}

/**
 * Собрать значения для показа из ответа языкового сервера и отладчика.
 *
 * Сервер (`textDocument/inlineValue`) помечает участки, где стоит показать значение, но
 * самих значений не знает — их даёт отладчик. Поэтому:
 *
 *   • участок с готовым текстом показываем как есть;
 *   • участок с переменной или выражением — вычисляем у отладчика; чего сервер не назвал,
 *     добираем из текста участка (имя `items` берётся прямо из кода);
 *   • не вычислилось (переменной нет в кадре, отладчик занят) — пропускаем: пустая
 *     подпись `x = undefined` была бы хуже, чем её отсутствие.
 *
 * Значение встаёт ПОСЛЕ участка, поэтому столбец — его конец (0-based, как ждёт вид).
 * Ошибка отладчика при одном выражении не срывает остальные: каждое спрашиваем отдельно.
 */
export async function resolveInlineValues(
  items: readonly InlineValue[],
  text: string,
  evaluate: (expression: string) => Promise<EvaluatedValue | null>,
): Promise<DebugInlineValue[]> {
  const lines = text.split('\n');
  const out: DebugInlineValue[] = [];
  for (const item of items) {
    if (item.action.kind === 'text') {
      out.push({ line: item.line, column: item.endColumn - 1, label: item.action.text });
      continue;
    }
    const source = (lines[item.line - 1] ?? '').slice(item.startColumn - 1, item.endColumn - 1);
    const expression = expressionFor(item, source);
    if (expression.length === 0) continue;
    const result = await evaluate(expression).catch(() => null);
    if (!result || result.value.length === 0) continue;
    out.push({ line: item.line, column: item.endColumn - 1, label: inlineLabel(expression, result.value) });
  }
  return out;
}
