/**
 * Чем занят языковой сервер — состояние для полоски прогресса.
 *
 * Сервер шлёт `begin`/`report`/`end` по токенам (`$/progress`), и токенов бывает
 * несколько сразу: индексация и поиск идут параллельно, и каждый шлёт свои шаги.
 * Показываем последнее начатое занятие — оно и есть то, чего человек ждёт.
 *
 * Раньше это был `Map` вместе с функцией прямо в `app.ts`, между разбором ответа
 * сервера (`shared/lsp-progress.ts`) и обновлением статусбара. Проверить нельзя было
 * ровно то, что легко сломать: убрать «своё» занятие, не перепутав его с чужим, и не
 * погасить полоску, когда один из параллельных отчётов закончился, а другой ещё идёт.
 */

import { type LspProgress, progressLabel } from '../../shared/lsp-progress';

/** Состояние полоски: что писать и сколько процентов. `null` — сервер не занят. */
export interface ProgressView {
  label: string;
  percentage: number | null;
}

export interface LspProgressControllerOptions {
  /** Показать состояние: `null` — занятий нет, полоску убрать. */
  show: (view: ProgressView | null) => void;
}

export interface LspProgressController {
  /** Учесть уведомление сервера. Чужое (`kind !== 'work'`) игнорируем. */
  apply: (progress: LspProgress) => void;
  /** Чем занят сейчас — для проверок и для перерисовки статусбара. */
  current: () => ProgressView | null;
  /** Сколько занятий идёт: индексация и поиск вместе дают два. */
  count: () => number;
  /** Забыть всё: сервер перезапущен — его отчёты уже не про то, что на экране. */
  reset: () => void;
}

/** Поля, которые и вправду пришли: `report` без заголовка не должен обнулить `begin`. */
function definedOnly(progress: Extract<LspProgress, { kind: 'work' }>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(progress).filter(([, value]) => value !== undefined));
}

export function createLspProgressController(options: LspProgressControllerOptions): LspProgressController {
  const running = new Map<string, Extract<LspProgress, { kind: 'work' }>>();
  let last: ProgressView | null = null;

  const current = (): ProgressView | null => {
    const active = [...running.values()].at(-1);
    if (!active) return null;
    return { label: progressLabel(active), percentage: active.percentage ?? null };
  };

  const publish = (): void => {
    const view = current();
    // Сервер повторяет `report` с тем же текстом — не трогаем DOM зря.
    if (view?.label === last?.label && view?.percentage === last?.percentage) return;
    last = view;
    options.show(view);
  };
  return {
    apply: (progress) => {
      // «Частичный результат» — не занятость: это ответ по кускам, его ждёт не человек.
      if (progress.kind !== 'work') return;
      const key = String(progress.token);
      if (progress.phase === 'begin') {
        running.set(key, progress);
      } else if (progress.phase === 'report') {
        // Сервер вправе прислать `report` без `begin` — тогда берём, что дали.
        // `report` часто идёт только с процентами: незаполненные поля не затираем,
        // иначе занятие потеряет заголовок и полоска станет безымянной.
        const known = running.get(key) ?? { kind: 'work', token: progress.token, phase: 'begin' };
        running.set(key, {
          ...known,
          ...definedOnly(progress),
        } as Extract<LspProgress, { kind: 'work' }>);
      } else {
        running.delete(key);
      }
      publish();
    },
    current,
    count: () => running.size,
    reset: () => {
      running.clear();
      last = null;
    },
  };
}

/** Чем занят сервер прямо сейчас — для статусбара и проверок. */
export function lspProgressView(controller: LspProgressController): ProgressView | null {
  return controller.current();
}
