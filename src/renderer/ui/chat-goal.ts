import type { ChatGoal } from '../../shared/api';
import { h, svgIcon } from './dom';

/**
 * Панель цели работы над композером.
 *
 * Цель виднее плана и живёт дольше: план — это шаги одной задачи, а цель — то,
 * ради чего идёт разговор, и она остаётся в панели между ходами. Поэтому у неё
 * своя строка, а не место в чек-листе плана: пока цель открыта, агент продолжает
 * сам, и человек должен видеть, почему ответ не кончился.
 *
 * Закрыть цель может и человек: кнопка в панели. Тогда следующий запрос уйдёт
 * без неё — это его решение, а не догадка модели.
 */

export interface GoalPanelView {
  element: HTMLElement;
  /** Показать цель; null или закрытая цель прячут панель. */
  render(goal: ChatGoal | null): void;
  /** Спрятать панель (беседа без цели). */
  hide(): void;
}

export function createGoalPanel(deps: { onClose: () => void }): GoalPanelView {
  const element = h('div', { class: 'composer-goal', hidden: true });

  function hide(): void {
    element.hidden = true;
    element.replaceChildren();
  }

  function render(goal: ChatGoal | null): void {
    if (!goal || goal.done || goal.text.trim().length === 0) {
      hide();
      return;
    }
    const close = h(
      'button',
      {
        class: 'icon-btn goal-close',
        type: 'button',
        title: 'Закрыть цель',
        'aria-label': 'Закрыть цель',
        onClick: () => deps.onClose(),
      },
      svgIcon('close', 12),
    );
    element.hidden = false;
    element.replaceChildren(
      h(
        'div',
        { class: 'goal-card', title: 'Цель работы: агент продолжает, пока она не закрыта' },
        svgIcon('target', 12),
        h('span', { class: 'goal-text' }, goal.text),
        close,
      ),
    );
  }

  return { element, render, hide };
}
