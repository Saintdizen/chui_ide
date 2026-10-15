/**
 * Автосохранение файлов: когда правка уходит на диск сама, без Ctrl+S.
 *
 * Настройка есть и у больших редакторов, и смысл у неё простой: одни не хотят
 * жать «Сохранить» после каждой мелочи, другие боятся потерять работу при
 * падении. По умолчанию выключено: файл — это то, что человек написал осознанно,
 * и «само записалось» застаёт врасплох (запуск, git, чужая программа видят
 * промежуточный текст).
 *
 * Здесь — только РЕШЕНИЕ: по режиму и событию говорим, писать ли сейчас, через
 * паузу или не писать вовсе. Таймер и запись живут в renderer
 * (`core/auto-save.ts`): там документы, диск через RPC и «грязность» файла.
 * Поэтому решение проверяется тестами без окна и без ожидания.
 */

export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';

/** Режимы в порядке показа: от выключенного к самому настойчивому. */
export const AUTO_SAVE_MODES: readonly AutoSaveMode[] = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'];

export const AUTO_SAVE_LABELS: Record<AutoSaveMode, string> = {
  off: 'Выключено',
  afterDelay: 'Через паузу после правки',
  onFocusChange: 'При переходе к другому файлу',
  onWindowChange: 'При потере фокуса окна',
};

/** Что произошло: правка текста, переход к другому файлу, окно потеряло фокус. */
export type AutoSaveTrigger = 'typing' | 'focus-change' | 'window-blur';

/** Что делать по этому событию. */
export type AutoSaveAction = 'now' | 'delay' | 'none';

/** Задержка автосохранения: секунда по умолчанию и рамки, за которыми она бессмысленна. */
export const AUTO_SAVE_DELAY_MS = 1000;
const MIN_DELAY_MS = 200;
const MAX_DELAY_MS = 60_000;

/** Разбор режима из настроек: неизвестное значение читаем как «выключено». */
export function normalizeAutoSaveMode(value: unknown): AutoSaveMode {
  return AUTO_SAVE_MODES.includes(value as AutoSaveMode) ? (value as AutoSaveMode) : 'off';
}

/** Задержка из настроек: целое в разумных рамках, иначе — значение по умолчанию. */
export function normalizeAutoSaveDelay(value: unknown): number {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded)) return AUTO_SAVE_DELAY_MS;
  return Math.min(Math.max(rounded, MIN_DELAY_MS), MAX_DELAY_MS);
}

/**
 * Что делать по событию.
 *
 * «Через паузу» пишет только после правки: смена файла и потеря фокуса окна для
 * неё не повод — иначе человек, оставив окно, получил бы запись прямо посреди
 * раздумий. «При переходе» и «при потере фокуса» пишут сразу: именно на этом
 * событии можно потерять окно или файл.
 */
export function autoSaveAction(mode: AutoSaveMode, trigger: AutoSaveTrigger): AutoSaveAction {
  switch (mode) {
    case 'afterDelay':
      return trigger === 'typing' ? 'delay' : 'none';
    case 'onFocusChange':
      return trigger === 'focus-change' ? 'now' : 'none';
    case 'onWindowChange':
      return trigger === 'window-blur' ? 'now' : 'none';
    default:
      return 'none';
  }
}
