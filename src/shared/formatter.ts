/**
 * Кто форматирует документ: языковой сервер или отдельный инструмент проекта.
 *
 * Два источника бывают одновременно: сервер (tsserver, pylsp) умеет
 * `textDocument/formatting`, а рядом стоит prettier или ruff. Кто из них получит
 * файл — сейчас решалось порядком вызовов, и это и есть то, что пункт 46 просил
 * прекратить: «форматирует тот, кто первым ответил». Здесь выбор явный.
 *
 * `auto` — прежнее поведение: сперва сервер, а если он не умеет/не ответил,
 * инструмент проекта. Остальные режимы — только один источник, без тихой подмены:
 * человек сказал, кем форматировать, и если тот недоступен, редактор об этом скажет,
 * а не подставит другого.
 */

export type FormatterChoice = 'auto' | 'lsp' | 'tool';

export const FORMATTER_CHOICES: readonly FormatterChoice[] = ['auto', 'lsp', 'tool'];

export const FORMATTER_LABELS: Record<FormatterChoice, string> = {
  auto: 'Автоматически (сервер, иначе инструмент проекта)',
  lsp: 'Только языковой сервер',
  tool: 'Только инструмент проекта',
};

/** Разбор настройки: незнакомое значение читаем как `auto`. */
export function normalizeFormatterChoice(value: unknown): FormatterChoice {
  return value === 'lsp' || value === 'tool' || value === 'auto' ? value : 'auto';
}

/** Что реально применилось (для отчёта и строки состояния). */
export type FormatterApplied = 'lsp' | 'tool';

export interface FormatterPlanInput {
  readonly choice: FormatterChoice;
  /** Сервер подключён и умеет `textDocument/formatting`. */
  readonly lspAvailable: boolean;
  /** Инструмент проекта нашёлся (prettier/ruff/black в окружении). */
  readonly toolAvailable: boolean;
}

export interface FormatterPlan {
  /** Кого пробуем первым. `null` — никого: остаётся сказать человеку почему. */
  readonly first: FormatterApplied | null;
  /** Кого пробуем, если первый не дал правок. `null` — второго нет. */
  readonly fallback: FormatterApplied | null;
  /**
   * Человек выбрал НЕДОСТУПНЫЙ источник и подмены не хочет — сообщение для
   * строки состояния. `null` — всё в порядке.
   */
  readonly complaint: string | null;
}

/**
 * Порядок источников по настройке.
 *
 * В `auto` второй пробуется, только если первый кончился пустым результатом
 * (сервер умеет, но не ответил) — это не «несколько форматтеров сразу», так
 * файл не переписывается дважды.
 */
export function planFormatting(input: FormatterPlanInput): FormatterPlan {
  const { choice, lspAvailable, toolAvailable } = input;

  if (choice === 'lsp') {
    if (lspAvailable) return { first: 'lsp', fallback: null, complaint: null };
    if (toolAvailable) {
      return {
        first: null,
        fallback: null,
        complaint:
          'Языковой сервер этого файла не умеет форматировать — выберите «Автоматически» или инструмент проекта',
      };
    }
    return { first: null, fallback: null, complaint: 'Форматировать нечем: сервер этого файла не умеет форматировать' };
  }

  if (choice === 'tool') {
    if (toolAvailable) return { first: 'tool', fallback: null, complaint: null };
    if (lspAvailable) {
      return {
        first: null,
        fallback: null,
        complaint: 'Инструмент проекта не найден — выберите «Автоматически» или языковой сервер',
      };
    }
    return { first: null, fallback: null, complaint: 'Форматировать нечем: инструмент проекта не найден' };
  }

  // auto: сервер, иначе инструмент.
  if (lspAvailable && toolAvailable) return { first: 'lsp', fallback: 'tool', complaint: null };
  if (lspAvailable) return { first: 'lsp', fallback: null, complaint: null };
  if (toolAvailable) return { first: 'tool', fallback: null, complaint: null };
  return { first: null, fallback: null, complaint: null };
}
