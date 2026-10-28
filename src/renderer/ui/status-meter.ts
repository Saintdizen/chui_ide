/**
 * Одна полоса работы в строке состояния.
 *
 * Долгих работ у окна три — запуск языкового сервера, чтение проекта в карту символов
 * и проверка проекта, — и идут они разом. Раньше это были три полосы рядом, и две из
 * них обычно стояли на нуле, дожидаясь первой: «Initializing JS/TS language features»
 * и «читаю проект: 0 из 0» рядом читались как зависание, а не как две очереди.
 *
 * Теперь полоса одна, и на ней — та работа, которой ждут остальные: сервер, без
 * которого обход пропускает файлы; затем чтение проекта; проверка проекта — последней,
 * она самая длинная и самая необязательная.
 */
import type { CheckProgressInput } from './check-progress';
import { checkProgress } from './check-progress';

export interface MeterView {
  /** Работы нет — виджет скрыт. */
  hidden: boolean;
  /** Доля пройденного, 0..1. Ноль — либо начало, либо мерить нечего (тогда `busy`). */
  fill: number;
  /** Идёт работа: без бегущего штриха застывшая полоса читается как зависание. */
  busy: boolean;
  label: string;
  title: string;
}

const HIDDEN: MeterView = { hidden: true, fill: 0, busy: false, label: '', title: '' };

export function statusMeter(state: {
  progress: { label: string; percentage: number | null } | null;
  symbols: { text: string; title: string; progress: { done: number; total: number } | null } | null;
  check: CheckProgressInput | null;
}): MeterView {
  // 1. Сервер. Процент он называет сам ($/progress); без процента — бегущий штрих.
  const server = state.progress;
  if (server) {
    const percent = server.percentage;
    return {
      hidden: false,
      fill: (percent ?? 0) / 100,
      busy: percent === null,
      label: percent === null ? server.label : `${server.label} ${Math.round(percent)}%`,
      title: `Языковой сервер: ${server.label}`,
    };
  }

  // 2. Чтение проекта. Числа — файлы, а не проценты: обход идёт файл за файлом.
  const symbols = state.symbols;
  if (symbols) {
    const meter = symbols.progress;
    return {
      hidden: false,
      fill: meter ? meter.done / Math.max(1, meter.total) : 0,
      busy: true,
      label: symbols.text,
      title: symbols.title,
    };
  }

  // 3. Проверка проекта: правила шагов и цифр живут в `check-progress.ts`.
  const check = checkProgress(state.check);
  if (check.hidden) return HIDDEN;
  return { hidden: false, fill: check.fill, busy: check.busy, label: check.label, title: check.title };
}
