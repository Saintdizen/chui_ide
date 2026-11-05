import { describe, expect, it } from 'vitest';
import { ChatStreamEvent } from '../src/shared/api/ai';
import { createStreamDedupe } from '../src/renderer/ui/stream-dedupe';

const E = ChatStreamEvent;

describe('заслон повторов: событие пришло дважды — лента сказала один раз', () => {
  it('tool_start по одному id — одна карточка', () => {
    const d = createStreamDedupe();
    expect(d.accept(E.ToolStart, { id: 'c1', name: 'read' })).toBe(true);
    expect(d.accept(E.ToolStart, { id: 'c1', name: 'read' })).toBe(false);
  });

  it('разные вызовы проходят', () => {
    const d = createStreamDedupe();
    expect(d.accept(E.ToolStart, { id: 'c1' })).toBe(true);
    expect(d.accept(E.ToolStart, { id: 'c2' })).toBe(true);
  });

  it('tool_result по одному id — один итог', () => {
    const d = createStreamDedupe();
    d.accept(E.ToolStart, { id: 'c1' });
    expect(d.accept(E.ToolResult, { id: 'c1' })).toBe(true);
    expect(d.accept(E.ToolResult, { id: 'c1' })).toBe(false);
  });

  it('итог без начала проходит: это потеря, а не повтор', () => {
    // Карточки нет, но счёт изменений и артефакты из результата взять надо.
    const d = createStreamDedupe();
    expect(d.accept(E.ToolResult, { id: 'c1' })).toBe(true);
  });

  it('шаг назад и шаг тот же не проходят, вперёд — проходит', () => {
    const d = createStreamDedupe();
    expect(d.accept(E.Step, { index: 3, limit: 24 })).toBe(true);
    expect(d.accept(E.Step, { index: 3, limit: 24 })).toBe(false);
    expect(d.accept(E.Step, { index: 2, limit: 24 })).toBe(false);
    expect(d.accept(E.Step, { index: 4, limit: 24 })).toBe(true);
  });

  it('тот же план не повторяется, изменённый — проходит', () => {
    const d = createStreamDedupe();
    const plan = { steps: [{ title: 'читать' }, { title: 'править' }] };
    expect(d.accept(E.Plan, plan)).toBe(true);
    expect(d.accept(E.Plan, { steps: [{ title: 'читать' }, { title: 'править' }] })).toBe(false);
    expect(d.accept(E.Plan, { steps: [{ title: 'читать' }] })).toBe(true);
  });

  it('пауза: то же состояние дважды — один раз', () => {
    const d = createStreamDedupe();
    expect(d.accept(E.Paused, { paused: true })).toBe(true);
    expect(d.accept(E.Paused, { paused: true })).toBe(false);
    expect(d.accept(E.Paused, { paused: false })).toBe(true);
    expect(d.accept(E.Paused, { paused: false })).toBe(false);
  });

  it('цель: та же цель и то же число продолжений — повтор', () => {
    const d = createStreamDedupe();
    const goal = { goal: { text: 'сделать' }, continued: 0 };
    expect(d.accept(E.Goal, goal)).toBe(true);
    expect(d.accept(E.Goal, { goal: { text: 'сделать' }, continued: 0 })).toBe(false);
    expect(d.accept(E.Goal, { goal: { text: 'сделать' }, continued: 1 })).toBe(true);
  });

  it('текст не глотается: delta, reasoning, interject без идентичности', () => {
    // Здесь повтор — это правда новый текст. Съесть его значит потерять ответ.
    const d = createStreamDedupe();
    for (let i = 0; i < 3; i += 1) {
      expect(d.accept(E.Delta, { text: 'да' })).toBe(true);
      expect(d.accept(E.Reasoning, { text: 'да' })).toBe(true);
      expect(d.accept(E.Interject, { text: 'да' })).toBe(true);
    }
  });

  it('reset: следующий прогон начинается с шага 1 и тех же id', () => {
    const d = createStreamDedupe();
    d.accept(E.Step, { index: 1, limit: 10 });
    d.accept(E.ToolStart, { id: 'c1' });
    d.reset();
    expect(d.accept(E.Step, { index: 1, limit: 10 })).toBe(true);
    expect(d.accept(E.ToolStart, { id: 'c1' })).toBe(true);
  });

  it('событие без нужного поля не блокируется: чужой формы не судим', () => {
    const d = createStreamDedupe();
    expect(d.accept(E.ToolStart, {})).toBe(true);
    expect(d.accept(E.ToolStart, {})).toBe(true);
    expect(d.accept(E.Step, {})).toBe(true);
  });
});
