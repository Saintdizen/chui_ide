import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanStepStatus } from '../src/shared/api';
import { createPlanPanel } from '../src/renderer/ui/chat-plan';
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
});
