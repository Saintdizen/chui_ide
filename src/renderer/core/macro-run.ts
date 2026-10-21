/**
 * Макрос: что сказать после записи, отказа и выполнения.
 *
 * Правила маленькие, но у каждого своя причина, и все три ошибались по очереди:
 *
 * - записали ноль действий — это не «макрос записан», а пустой макрос: повторять
 *   нечего, и человек должен узнать об этом сразу, а не при выполнении;
 * - выполнять без файла нельзя: макрос состоит из действий редактора, а редактора
 *   нет — и «шагов 0» звучит как «макрос пустой», хотя он полный;
 * - повторов больше одного — в ответе нужны и число повторов, и сумма шагов, иначе
 *   непонятно, отработал ли он столько раз, сколько просили.
 */

/** Сколько раз просить в диалоге по умолчанию. */
export const DEFAULT_MACRO_TIMES = 5;

/** Верхняя граница повторов: 1000 шагов по файлу — это уже минуты работы. */
export const MAX_MACRO_TIMES = 1000;

export type MacroCheck =
  /** Всё в порядке, можно выполнять. */
  | { kind: 'ok'; times: number }
  /** Отказ с готовым текстом. */
  | { kind: 'refused'; message: string };

/** Проверка «сколько раз выполнять», как её ввёл человек. */
export function checkMacroTimes(raw: string): MacroCheck {
  const times = Number(raw.trim());
  if (!Number.isInteger(times) || times < 1 || times > MAX_MACRO_TIMES) {
    return { kind: 'refused', message: `Число повторов — целое от 1 до ${MAX_MACRO_TIMES}` };
  }
  return { kind: 'ok', times };
}

/** Текст после остановки записи. */
export function macroRecordedNotice(steps: number): string {
  return steps > 0 ? `Макрос записан: действий ${steps}` : 'Макрос пуст: ни одного действия';
}

/**
 * Можно ли выполнять макрос. Порядок важен: сначала «пустой», потом «нет файла» —
 * пустой макрос не станет выполнимым от открытия файла, и говорить про файл первым
 * значит отправить человека открывать вкладку впустую.
 */
export function macroPlayCheck(steps: number, hasDocument: boolean): MacroCheck {
  if (steps === 0) return { kind: 'refused', message: 'Макрос не записан' };
  if (!hasDocument) return { kind: 'refused', message: 'Откройте файл: макрос выполняется в редакторе' };
  return { kind: 'ok', times: 1 };
}

/** Текст после выполнения: сколько раз и сколько шагов всего. */
export function macroPlayedNotice(times: number, steps: number): string {
  return times > 1 ? `Макрос выполнен ${times} раз (шагов: ${steps})` : `Макрос выполнен: шагов ${steps}`;
}
