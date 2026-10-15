import type { ApplyEditsHostResult } from '../../shared/api';
import type { ApplyFailure } from '../../shared/edits';

/**
 * Свод ответа о правках по якорю.
 *
 * Применение идёт общим путём с `apply_edit` (см. `applyAgentPatches` в
 * `chat.ts`), а несведённые якоря остаются на стороне разбора: они не доходят
 * до применения вовсе. Свести оба набора надо в один ответ — и не потерять при
 * этом оговорку «осталось в буфере».
 *
 * Терять её нельзя: main читает файлы с диска, поэтому без оговорки агент считает
 * правку применённой, а следующее чтение возвращает старый текст — и ошибка
 * выглядит как промах чтения, а не как незаписанный файл (подробнее —
 * `readEditsOutcome` в `main/ai/agent-tools.ts`).
 */
export function mergePatchResult(outcome: ApplyEditsHostResult, failed: readonly ApplyFailure[]): ApplyEditsHostResult {
  const reports = outcome.result?.reports ?? [];
  const failures = [...(outcome.result?.failed ?? []), ...failed];
  const unwritten = outcome.unwritten ?? [];

  return {
    rejected: false,
    result: { reports, failed: failures },
    ...(unwritten.length > 0 ? { unwritten } : {}),
  };
}
