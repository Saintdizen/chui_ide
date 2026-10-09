import type { PlanStep } from '../../shared/api';
import { clear, h, svgIcon } from './dom';

/**
 * Панель плана агента: чек-лист шагов над композером.
 *
 * Закреплена внизу, перед глазами, пока агент работает, — раньше чек-лист жил
 * внутри сообщения и участвовал в порядке ленты. Панель только рисует: план
 * приходит событиями потока, а сворачивание — её собственное состояние.
 */

export interface PlanPanelView {
  element: HTMLElement;
  /** Показать шаги; пустой список прячет панель. */
  render(steps: readonly PlanStep[]): void;
  /** Спрятать панель (генерация кончилась). */
  hide(): void;
}

export function createPlanPanel(): PlanPanelView {
  const element = h('div', { class: 'composer-plan', hidden: true });
  /** Свёрнут ли чек-лист. Состояние переживает перерисовку: план обновляется часто. */
  let expanded = true;

  function hide(): void {
    element.hidden = true;
    clear(element);
  }

  function render(steps: readonly PlanStep[]): void {
    if (steps.length === 0) {
      hide();
      return;
    }
    element.hidden = false;
    clear(element);

    const done = steps.filter((step) => step.status === 'done').length;
    // Список шагов прячется целиком: шапка остаётся и говорит, что план свёрнут.
    const list = h(
      'div',
      { class: 'plan-list', hidden: !expanded },
      ...steps.map((step) =>
        h(
          'div',
          { class: `plan-step is-${step.status}` },
          h('span', { class: 'plan-mark' }, step.status === 'done' ? svgIcon('sparkle', 11) : null),
          h('span', { class: 'plan-text' }, step.text),
        ),
      ),
    );

    const head = h(
      'button',
      { class: 'plan-head', type: 'button', 'aria-expanded': String(expanded) },
      svgIcon('chevronDown', 12),
      svgIcon('checklist', 12),
      h('span', { class: 'plan-title' }, 'План'),
      h('span', { class: 'plan-count' }, `${done}/${steps.length}`),
    );
    const syncHead = (): void => {
      head.classList.toggle('is-collapsed', !expanded);
      head.setAttribute('aria-expanded', String(expanded));
      list.hidden = !expanded;
      head.title = expanded ? 'Свернуть план' : 'Развернуть план';
    };
    head.addEventListener('click', () => {
      expanded = !expanded;
      syncHead();
    });
    syncHead();

    element.appendChild(h('div', { class: 'plan-card' }, head, list));
  }

  return { element, render, hide };
}
