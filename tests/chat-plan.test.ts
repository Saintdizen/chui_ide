import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanStepStatus } from '../src/shared/api';
import { createPlanPanel, archivePlan, PLAN_HISTORY_LIMIT } from '../src/renderer/ui/chat-plan';
import { installMiniDom } from './helpers/mini-dom';

/**
 * Панель плана агента (`renderer/ui/chat-plan.ts`).
 *
 * Панель одна на все вкладки, поэтому её собственное состояние (свёрнут ли
 * чек-лист) не должно переезжать на чужой план, а пустой список обязан прятать
 * панель целиком — иначе над пустым композером висела бы шапка с «0/0».
 */

beforeEach(() => {
  installMiniDom();
});

const steps = (...items: Array<[string, PlanStepStatus]>) => items.map(([text, status]) => ({ text, status }));

const panelHidden = (element: HTMLElement): boolean => element.hasAttribute('hidden');

describe('createPlanPanel', () => {
  it('пустой список прячет панель и чистит разметку', () => {
    const panel = createPlanPanel();
    panel.render(steps(['один', 'done']));
    expect(panelHidden(panel.element)).toBe(false);

    panel.render([]);
    expect(panelHidden(panel.element)).toBe(true);
    expect(panel.element.querySelector('.plan-step')).toBeNull();
  });

  it('счётчик считает только выполненные шаги', () => {
    const panel = createPlanPanel();
    panel.render(steps(['a', 'done'], ['b', 'in_progress'], ['c', 'pending'], ['d', 'done']));
    expect(panel.element.querySelector('.plan-count')?.textContent).toBe('2/4');
  });

  it('перерисовка не плодит карточки: шаги заменяются целиком', () => {
    const panel = createPlanPanel();
    panel.render(steps(['a', 'done'], ['b', 'pending']));
    panel.render(steps(['a', 'done'], ['b', 'done'], ['c', 'in_progress']));
    expect(panel.element.querySelectorAll('.plan-card')).toHaveLength(1);
    expect(panel.element.querySelectorAll('.plan-step')).toHaveLength(3);
    expect(panel.element.querySelector('.plan-count')?.textContent).toBe('2/3');
  });

  it('сворачивание переживает перерисовку: план обновляется на каждом шаге', () => {
    const panel = createPlanPanel();
    panel.render(steps(['a', 'pending']));
    const head = panel.element.querySelector('.plan-head') as HTMLElement;
    head.click();
    panel.render(steps(['a', 'in_progress']));
    const again = panel.element.querySelector('.plan-head') as HTMLElement;
    expect(again.getAttribute('aria-expanded')).toBe('false');
  });

  it('история показывается под текущим планом, последний план выше', () => {
    const panel = createPlanPanel();
    panel.render(steps(['a', 'done']));
    panel.renderHistory([
      { at: Date.UTC(2026, 0, 1, 10, 5), steps: steps(['старый', 'done']) },
      { at: Date.UTC(2026, 0, 1, 11, 30), steps: steps(['новый', 'pending']) },
    ]);
    const entries = panel.element.querySelectorAll('.plan-history');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.textContent).toContain('новый');
    expect(entries[1]?.textContent).toContain('старый');
    // Счёт выполненных шагов в каждой записи: по нему видно, чем план кончился.
    expect(entries[1]?.querySelector('.plan-history-count')?.textContent).toBe('1/1');
  });

  it('история без текущего плана панель не рисует: показать её негде', () => {
    const panel = createPlanPanel();
    panel.renderHistory([{ at: 1, steps: steps(['a', 'done']) }]);
    expect(panelHidden(panel.element)).toBe(true);
  });
});

describe('archivePlan', () => {
  const plan = steps(['a', 'done'], ['b', 'pending']);

  it('вытесненный план попадает в историю со временем смены', () => {
    const history = archivePlan(undefined, plan, 1000);
    expect(history).toHaveLength(1);
    expect(history[0]?.at).toBe(1000);
    expect(history[0]?.steps.map((step) => step.text)).toEqual(['a', 'b']);
  });

  it('обновление того же плана историю не плодит: это один прогон', () => {
    const first = archivePlan(undefined, plan, 1000);
    expect(archivePlan(first, steps(['a', 'done'], ['b', 'done']), 2000)).toHaveLength(1);
  });

  it('новый план по составу добавляет запись, а пустой архив не трогает', () => {
    const first = archivePlan(undefined, plan, 1000);
    const second = archivePlan(first, steps(['c', 'pending']), 2000);
    expect(second).toHaveLength(2);
    expect(archivePlan(second, [], 3000)).toHaveLength(2);
  });

  it('история не растёт бесконечно', () => {
    let history = archivePlan(undefined, steps(['x0', 'done']), 0);
    for (let index = 1; index <= PLAN_HISTORY_LIMIT + 3; index += 1) {
      history = archivePlan(history, steps([`x${index}`, 'done']), index);
    }
    expect(history).toHaveLength(PLAN_HISTORY_LIMIT);
    // Старые ушли, свежие на месте.
    expect(history.at(-1)?.steps[0]?.text).toBe(`x${PLAN_HISTORY_LIMIT + 3}`);
  });

  it('сохранённый план не меняется задним числом', () => {
    const current = steps(['a', 'pending']);
    archivePlan(undefined, current, 1);
    current[0]!.status = 'done';
    const history = archivePlan(undefined, current, 2);
    expect(history[0]?.steps[0]?.status).toBe('done');
  });
});
