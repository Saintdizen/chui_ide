/**
 * Разбор уведомлений `$/progress`: чем сервер занят и что он успел прислать.
 *
 * Уведомление одно на два случая, и различаются они по форме `value`:
 *
 *   • «идёт работа» (work done progress) — `value.kind` равен `begin`, `report` или `end`;
 *     так сервер говорит, что занят (индексация, поиск ссылок), и как далеко зашёл;
 *   • «частичный результат» (partial result) — `value` несёт `items`: сервер отдаёт ответ
 *     по кускам, чтобы не ждать конца долгого поиска. Токен здесь — тот, что клиент сам
 *     положил в запрос (`partialResultToken`).
 *
 * Модуль чистый: разбор ответа проверяется без окна и без сервера. Координат тут нет —
 * только текст, проценты и признак, чем именно это уведомление оказалось.
 */

/** Токен прогресса: сервер вправе назвать его числом или строкой. */
export type ProgressToken = string | number;

/** «Идёт работа»: состояние и текст, которым сервер описывает занятие. */
export interface WorkProgress {
  readonly kind: 'work';
  readonly token: ProgressToken;
  readonly phase: 'begin' | 'report' | 'end';
  /** Заголовок занятия («Индексирую файлы»). Приходит в `begin`. */
  readonly title?: string;
  /** Уточнение текущего шага. Приходит в `report`. */
  readonly message?: string;
  /** Прогресс в процентах, 0..100; не задан — полосы не рисуем. */
  readonly percentage?: number;
}

/** Частичный результат: сервер прислал часть элементов по своему же токену. */
export interface PartialProgress {
  readonly kind: 'partial';
  readonly token: ProgressToken;
  readonly items: readonly unknown[];
}

export type LspProgress = WorkProgress | PartialProgress;

/**
 * Разобрать `params` уведомления `$/progress`. Непонятное или чужое (`value` не той формы)
 * пропускаем: уведомление приходит и для чужих токенов, и разбирать его нечем — это не ошибка.
 */
export function parseProgress(params: unknown): LspProgress | null {
  if (!params || typeof params !== 'object') return null;
  const { token, value } = params as { token?: unknown; value?: unknown };
  if (typeof token !== 'string' && typeof token !== 'number') return null;

  if (Array.isArray(value)) {
    // Массив состояний приходит в `begin` при составном прогрессе: берём первое понятное.
    for (const item of value) {
      const parsed = parseValue(token, item);
      if (parsed) return parsed;
    }
    return null;
  }
  return parseValue(token, value);
}

function parseValue(token: ProgressToken, value: unknown): LspProgress | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as { kind?: unknown; title?: unknown; message?: unknown; percentage?: unknown; items?: unknown };

  if (source.kind === 'begin' || source.kind === 'report' || source.kind === 'end') {
    return {
      kind: 'work',
      token,
      phase: source.kind,
      ...(typeof source.title === 'string' && source.title ? { title: source.title } : {}),
      ...(typeof source.message === 'string' && source.message ? { message: source.message } : {}),
      ...(typeof source.percentage === 'number' && Number.isFinite(source.percentage)
        ? { percentage: source.percentage }
        : {}),
    };
  }

  // Без `kind` и с `items` — это частичный результат долгого запроса.
  if (Array.isArray(source.items)) return { kind: 'partial', token, items: source.items };
  return null;
}

/** Текст для интерфейса: уточнение, если есть, иначе заголовок, иначе пусто. */
export function progressLabel(progress: WorkProgress): string {
  return progress.message ?? progress.title ?? 'Идёт работа';
}
