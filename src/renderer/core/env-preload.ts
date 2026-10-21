import type { ProjectTools } from './project-tools';
import { envWidgetLabel } from './env-widget';

/**
 * Прогрев окружения при открытии проекта.
 *
 * Поводок один: при стартовом проекте `workspace`-подписка и начальный код приходят
 * оба, и окружение читалось бы дважды. Поэтому запоминаем, для чего уже грели —
 * пара «корень проекта + вид проекта». Меняется любой из двух — греем заново.
 *
 * Какой попап прогревать, решает `envWidgetLabel`: в проекте без осмысленного
 * окружения греть нечего (см. `core/env-widget.ts`).
 */

/** Что было в прошлый раз. Отдельный тип — чтобы не тащить в app.ts три поля. */
export type PreloadSignature = string | null;

export interface PreloadPlannerOptions {
  /** Корень открытого проекта; null — проект не открыт. */
  root: () => string | null;
  /** Вид проекта: `node`, `python` или null, пока не распознан. */
  kind: () => string | null;
  /** Снимок окружения проекта — тот же, по которому рисуется виджет. */
  tools: () => ProjectTools;
  /** Настроенный человеком интерпретатор Python из настроек. */
  configuredPython: () => string;
}

export interface PreloadPlanner {
  /** Взводить ли прогрев сейчас; повторный ответ на то же — false. */
  shouldPreload: () => boolean;
  /** Что прогреть: попап окружения Node или Python. */
  target: () => 'node' | 'python';
}

/** Подпись «что уже грели»: корень и вид проекта через разделитель, которого нет в путях. */
export function preloadSignature(root: string | null, kind: string | null): string {
  return `${root ?? ''}|${kind ?? ''}`;
}

export function createPreloadPlanner(options: PreloadPlannerOptions): PreloadPlanner {
  let preloaded: PreloadSignature = null;

  return {
    shouldPreload: () => {
      const kind = options.kind();
      if (!envWidgetLabel(kind, options.tools(), options.configuredPython())) return false;
      const signature = preloadSignature(options.root(), kind);
      if (signature === preloaded) return false;
      preloaded = signature;
      return true;
    },
    // Неизвестный вид греет Python: так было и раньше — для «непонятно чего»
    // интерпретатор осмысленнее всего (см. envWidgetLabel).
    target: () => (options.kind() === 'node' ? 'node' : 'python'),
  };
}
