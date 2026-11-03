import { automationsForClock, automationsForSave, type AutomationConfig } from '../../shared/automations';
import { pathAfter } from '../../shared/paths';
import type { DocumentStore } from './document-store';

export interface AutomationsDeps {
  documents: DocumentStore;
  /** Корень проекта: маски пишутся от него, а не от абсолютного пути. */
  root: () => string;
  settings: () => readonly AutomationConfig[];
  onDue: (item: AutomationConfig, reason: 'save' | 'clock') => void;
  now?: () => number;
}

export interface Automations {
  dispose(): void;
}

/** Как часто проверяем часы: чаще минуты смысла нет, реже — точность теряется. */
export const CLOCK_TICK_MS = 30_000;

/**
 * Автоматизации: сохранение файла или часы будят готовое задание.
 *
 * Задание не отправляется само — оно ложится в поле ввода новой беседы. Прогон
 * стоит сотни тысяч токенов промпта, и тратить их без человека — не автоматизация,
 * а утечка. Здесь только «пора, вот запрос»; отправляет человек.
 */
export function createAutomations(deps: AutomationsDeps): Automations {
  const now = deps.now ?? (() => Date.now());
  const runs = new Map<string, number[]>();

  const fire = (items: readonly AutomationConfig[], reason: 'save' | 'clock'): void => {
    if (items.length === 0) return;
    const at = now();
    for (const item of items) {
      runs.set(item.name, [...(runs.get(item.name) ?? []), at]);
      deps.onDue(item, reason);
    }
  };

  // Сохранение — единственное событие, которое видит renderer: интересует только
  // тот случай, когда `dirty` снялся, а не появился.
  const unsubscribe = deps.documents.onDidChangeDirty((document) => {
    if (document.dirty) return;
    const relative = pathAfter(deps.root(), document.path);
    fire(automationsForSave(deps.settings(), relative, runs, now()), 'save');
  });

  const timer = setInterval(() => {
    fire(automationsForClock(deps.settings(), runs, now()), 'clock');
  }, CLOCK_TICK_MS);

  return {
    dispose: () => {
      unsubscribe.dispose();
      clearInterval(timer);
    },
  };
}
