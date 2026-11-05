import { describe, expect, it, vi } from 'vitest';
import { createRunFold, nextFoldIcon, nextFoldLabel } from '../src/renderer/ui/run-fold';

describe('раскрытие ленты прогона: один режим на беседу', () => {
  it('по умолчанию — обычный вид', () => {
    expect(createRunFold().mode()).toBe('auto');
  });

  it('первый щелчок СВОРАЧИВАЕТ, а не разворачивает', () => {
    // Лента и так свёрнута по умолчанию: человек, дотянувшийся до кнопки,
    // хочет убрать лишнее. Обратный порядок заставлял бы щёлкать впустую.
    expect(createRunFold().cycle()).toBe('collapsed');
  });

  it('круг: auto → collapsed → expanded → auto', () => {
    const fold = createRunFold();
    expect(fold.cycle()).toBe('collapsed');
    expect(fold.cycle()).toBe('expanded');
    expect(fold.cycle()).toBe('auto');
  });

  it('о смене сообщают слушателю', () => {
    const fold = createRunFold();
    const seen: string[] = [];
    fold.onChange((mode) => seen.push(mode));
    fold.cycle();
    fold.cycle();
    expect(seen).toEqual(['collapsed', 'expanded']);
  });

  it('отписка прекращает сообщения', () => {
    const fold = createRunFold();
    const listener = vi.fn();
    const off = fold.onChange(listener);
    off();
    fold.cycle();
    expect(listener).not.toHaveBeenCalled();
  });

  it('беседы независимы: режим одной не трогает другую', () => {
    const first = createRunFold();
    const second = createRunFold();
    first.cycle();
    first.cycle();
    expect(first.mode()).toBe('expanded');
    expect(second.mode()).toBe('auto');
  });

  it('подпись обещает следующее действие, а не текущее состояние', () => {
    expect(nextFoldLabel('auto')).toBe('Свернуть всё, кроме ответа');
    expect(nextFoldLabel('collapsed')).toBe('Развернуть все действия');
    expect(nextFoldLabel('expanded')).toBe('Вернуть обычный вид');
    // Ни одна подпись не повторяется: иначе два состояния не различить.
    const labels = new Set([nextFoldLabel('auto'), nextFoldLabel('collapsed'), nextFoldLabel('expanded')]);
    expect(labels.size).toBe(3);
  });

  it('у каждого режима свой значок', () => {
    const icons = new Set([nextFoldIcon('auto'), nextFoldIcon('collapsed'), nextFoldIcon('expanded')]);
    expect(icons.size).toBe(3);
  });
});
