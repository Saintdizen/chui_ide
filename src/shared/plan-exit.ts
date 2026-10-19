/**
 * «Утвердить план» (`exit_plan_mode`).
 *
 * Режим «План» — обещание: агент читает проект и ничего не меняет. Обещание
 * ломалось с другой стороны: выйти из режима можно было только руками, сдвинув
 * переключатель в композере, а составленный план «согласен» никуда не шло.
 * Инструмент делает выход явным: агент показывает план, человек отвечает
 * «утвердить» или «продолжить планировать с замечанием», и ответ уезжает модели
 * результатом вызова — ровно так же, как у `ask`.
 *
 * Разбор аргументов и текст ответа живут здесь, а не в main: их проверяют
 * юнит-тесты, и они не зависят ни от окна, ни от провайдера.
 */

/** Потолок текста плана: это «что собираюсь сделать», а не пересказ прочитанного. */
export const MAX_PLAN_CHARS = 2000;

/** Потолок замечания человека: это подпись к решению, а не второй план. */
export const MAX_PLAN_NOTE_CHARS = 600;

/** Решение человека по плану: утверждён или отправлен на доработку. */
export interface PlanExitDecision {
  approved: boolean;
  /** Замечание при отказе. Пусто — человек просто не согласился. */
  note: string;
}

/**
 * Текст плана из недоверенного источника (аргумент инструмента, ответ renderer).
 * Пустое — плана словами нет, человек увидит только чек-лист `update_plan`.
 */
export function clipPlanText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (text.length <= MAX_PLAN_CHARS) return text;
  const cut = text.slice(0, MAX_PLAN_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_PLAN_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Замечание человека — тоже с потолком: оно едет модели в результат вызова. */
export function clipPlanNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/\r\n/g, '\n').trim();
  return text.length <= MAX_PLAN_NOTE_CHARS ? text : `${text.slice(0, MAX_PLAN_NOTE_CHARS).trimEnd()}…`;
}

/** Разбор аргументов вызова: план словами (необязательный). */
export function parsePlanExitArgs(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return '';
  }
  if (typeof value !== 'object' || value === null) return '';
  return clipPlanText((value as { plan?: unknown }).plan);
}

/**
 * Решение renderer'а в безопасном виде: `approved` — только явное `true`.
 * Так же ведёт себя `sanitizePermission`: непонятный ответ читается как «нет».
 */
export function sanitizePlanExitDecision(raw: unknown): PlanExitDecision {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as { approved?: unknown; note?: unknown };
  return { approved: value.approved === true, note: clipPlanNote(value.note) };
}

/**
 * Ответ модели на вызов.
 *
 * Утверждение — не разрешение на один шаг, а смена режима: с этого места проект
 * можно менять, и вызов повторять не надо. Отказ — это задание: замечание
 * человека надо выполнить в самом плане, а не спорить с ним.
 */
export function planExitResult(decision: PlanExitDecision): string {
  if (decision.approved) {
    return (
      'План утверждён человеком. Режим переключён на «Агент»: изменения в проекте разрешены — ' +
      'выполняй план, повторно этот инструмент не вызывай.'
    );
  }
  const note = clipPlanNote(decision.note);
  if (!note) {
    return (
      'План не утверждён, замечаний нет. Пересмотри план и снова вызови exit_plan_mode — ' +
      'или уточни через ask, что именно не так.'
    );
  }
  return `План не утверждён. Замечание человека: ${note}\nУчти замечание в плане и снова вызови exit_plan_mode.`;
}
