import { describe, expect, it } from 'vitest';
import { overlayRanges, type RoleRange } from '../src/renderer/editor/highlight/overlay';

/**
 * Наложение семантической подсветки на грамматику. Проверяем главное: участок сервера
 * побеждает, где он есть; где сервер промолчал — остаётся грамматика; соседние участки с
 * одной ролью склеиваются, иначе строка рассыпалась бы на лишние `<span>`.
 */

const r = (start: number, end: number, role: string | null): RoleRange => ({ start, end, role });

describe('overlayRanges', () => {
  it('без верхних участков грамматика остаётся как есть', () => {
    const base = [r(0, 3, 'keyword'), r(3, 9, 'identifier')];
    expect(overlayRanges(base, [])).toEqual(base);
  });

  it('верхний участок перекрывает нижнюю роль', () => {
    // Грамматика видела весь текст как identifier, сервер уточнил середину как function.
    const base = [r(0, 10, 'identifier')];
    const top = [r(4, 8, 'function')];
    expect(overlayRanges(base, top)).toEqual([r(0, 4, 'identifier'), r(4, 8, 'function'), r(8, 10, 'identifier')]);
  });

  it('где сервер промолчал — остаётся грамматика', () => {
    const base = [r(0, 10, 'string')];
    const top = [r(0, 4, 'keyword')];
    expect(overlayRanges(base, top)).toEqual([r(0, 4, 'keyword'), r(4, 10, 'string')]);
  });

  it('роль null поверх грамматики гасит цвет под собой', () => {
    // Сервер назвал оператор — у нас это бесцветно; цвет грамматики под ним убирается.
    const base = [r(0, 3, 'number'), r(3, 4, 'identifier'), r(4, 7, 'number')];
    const top = [r(3, 4, null)];
    expect(overlayRanges(base, top)).toEqual([r(0, 3, 'number'), r(3, 4, null), r(4, 7, 'number')]);
  });

  it('соседние участки с одной ролью склеиваются', () => {
    const base = [r(0, 5, 'identifier'), r(5, 8, 'identifier')];
    expect(overlayRanges(base, [])).toEqual([r(0, 8, 'identifier')]);
  });

  it('пустые участки игнорируются', () => {
    const base = [r(0, 5, 'keyword'), r(5, 5, 'type')];
    expect(overlayRanges(base, [r(2, 2, 'string')])).toEqual([r(0, 5, 'keyword')]);
  });

  it('верхний участок шире нижних — целиком его роль', () => {
    const base = [r(0, 3, 'keyword'), r(3, 7, 'identifier'), r(7, 9, 'number')];
    const top = [r(0, 9, 'type')];
    expect(overlayRanges(base, top)).toEqual([r(0, 9, 'type')]);
  });
});
