import type { PlanArchiveEntry, PlanStep } from '../../shared/api';
import { clear, h, svgIcon } from './dom';

/**
 * Сколько планов держим в истории беседы. Старые не нужны: по ним не понять,
 * что сделано сейчас, а файл беседы растёт с каждой правкой плана.
 */
export const PLAN_HISTORY_LIMIT = 10;

/** Время смены плана — часы и минуты: по ним видно, когда шёл тот прогон. */
function formatPlanTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Шаги те же по составу (статусы не в счёт): тогда это обновление, а не новый план. */
function sameSteps(left: readonly PlanStep[], right: readonly PlanStep[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((step, index) => step.text === right[index]?.text);
}

/**
 * Новый план вытесняет текущий в историю — с отметкой времени. Возвращает новую
 * историю, а не правит массив на месте: состояние беседы меняется одной строкой.
 */
export function archivePlan(
  history: readonly PlanArchiveEntry[] | undefined,
  previous: readonly PlanStep[] | undefined,
  now: number,
): PlanArchiveEntry[] {
  // Пустой или отсутствующий план архивировать нечего: это не прогон, а его след.
  if (!previous || previous.length === 0) return [...(history ?? [])];
  const last = history?.[history.length - 1];
  // Статус шага меняется на каждом событии плана: архивируем только смену состава.
  if (last && sameSteps(last.steps, previous)) return [...(history ?? [])];
  const fresh: PlanArchiveEntry = { at: now, steps: previous.map((step) => ({ ...step })) };
  return [...(history ?? []), fresh].slice(-PLAN_HISTORY_LIMIT);
}

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
  /** Планы прошлых прогонов: свёрнутые списки под текущим планом. */
  renderHistory(entries: readonly PlanArchiveEntry[]): void;
  /** Спрятать панель (генерация кончилась). */
  hide(): void;
}

export function createPlanPanel(): PlanPanelView {
  const element = h('div', { class: 'composer-plan', hidden: true });
  /** Свёрнут ли чек-лист. Состояние переживает перерисовку: план обновляется часто. */
  let expanded = true;
  /** Последние отрисованные шаги: история показывается под ними и живёт рядом. */
  let current: readonly PlanStep[] = [];
  let historyEntries: readonly PlanArchiveEntry[] = [];

  function hide(): void {
    element.hidden = true;
    clear(element);
  }

  /** Одна запись истории: свёрнутый список, время смены и счёт выполненных шагов. */
  function historyNode(entry: PlanArchiveEntry): HTMLElement {
    const done = entry.steps.filter((step) => step.status === 'done').length;
    return h(
      'details',
      { class: 'plan-history' },
      h(
        'summary',
        { class: 'plan-history-head' },
        h('span', { class: 'plan-history-time' }, formatPlanTime(entry.at)),
        h('span', { class: 'plan-history-count' }, `${done}/${entry.steps.length}`),
      ),
      ...entry.steps.map((step) =>
        h('div', { class: `plan-step is-${step.status}` }, h('span', { class: 'plan-text' }, step.text)),
      ),
    );
  }

  function render(steps: readonly PlanStep[]): void {
    current = steps;
    paint();
  }

  function renderHistory(entries: readonly PlanArchiveEntry[]): void {
    historyEntries = entries;
    paint();
  }

  function paint(): void {
    // Без текущего плана показывать нечего: одна история — не повод держать панель.
    if (current.length === 0) {
      hide();
      return;
    }
    element.hidden = false;
    clear(element);
    const steps = current;

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

    const card = h('div', { class: 'plan-card' }, head, list);
    // История — под текущим планом, последние сверху.
    if (historyEntries.length > 0) {
      card.appendChild(
        h(
          'div',
          { class: 'plan-history-list' },
          h('div', { class: 'plan-history-title' }, 'Прошлые планы'),
          ...[...historyEntries].reverse().map(historyNode),
        ),
      );
    }
    element.appendChild(card);
  }

  return { element, render, renderHistory, hide };
}
