/**
 * Вид полосы проверки проекта в строке состояния — без DOM, чтобы проверяться тестами.
 *
 * Главное правило: числа на полосе — это шаги прохода, а не «проценты работы».
 * Середину шага не знает никто (линтер и tsc — один процесс и молчат до конца),
 * поэтому у неделимого прохода чисел нет совсем: бежит полоса без цифр.
 */
import type { ProjectStage } from '../../shared/project-analysis';

/** Что пришло из проверки: сколько шагов сделано и какие ещё идут. */
export interface CheckProgressInput {
  done: number;
  total: number;
  running: readonly ProjectStage[];
}

export interface CheckProgressView {
  /** Нечего показывать: проход не идёт. */
  hidden: boolean;
  /** Доля завершённых шагов, 0..1. */
  fill: number;
  /** Идёт работа: полоса пульсирует, иначе застывшая читается как зависание. */
  busy: boolean;
  /** Шагов не видно — числа были бы выдуманными (tsc идёт одним куском). */
  indeterminate: boolean;
  label: string;
  title: string;
}

const STAGE_LABEL: Record<ProjectStage, string> = {
  code: 'линтер',
  deps: 'зависимости',
  'python-deps': 'python-зависимости',
};

const HIDDEN: CheckProgressView = {
  hidden: true,
  fill: 0,
  busy: false,
  indeterminate: false,
  label: '',
  title: '',
};

export function checkProgress(input: CheckProgressInput | null | undefined): CheckProgressView {
  if (!input) return HIDDEN;

  const total = Math.max(0, Math.trunc(input.total));
  const done = Math.min(Math.max(0, Math.trunc(input.done)), total);
  const running = total === 0 ? [] : input.running;
  const names = running.map((stage) => STAGE_LABEL[stage] ?? stage);

  if (total === 0) {
    return {
      hidden: false,
      fill: 0,
      busy: true,
      indeterminate: true,
      label: 'проверяю…',
      title: 'Идёт проверка проекта. Шагов не видно: команда одна, о середине она не говорит',
    };
  }

  const what = names.length > 0 ? `идёт: ${names.join(', ')}` : 'все шаги позади';
  return {
    hidden: false,
    fill: done / total,
    busy: names.length > 0,
    indeterminate: false,
    label: names.length === 1 ? `проверяю: ${names[0] ?? ''}` : `проверяю: ${done} из ${total}`,
    title: `Проверка проекта: шагов сделано ${done} из ${total}, ${what}`,
  };
}
