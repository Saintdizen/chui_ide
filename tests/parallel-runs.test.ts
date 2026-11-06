import { describe, expect, it } from 'vitest';
import { parallelRunNotice } from '../src/shared/parallel-runs';

describe('предупреждение о втором прогоне', () => {
  it('один прогон — говорить нечего', () => {
    expect(parallelRunNotice(1)).toBeNull();
  });

  it('никого — тоже молчим', () => {
    expect(parallelRunNotice(0)).toBeNull();
  });

  it('второй прогон говорит, что каталог общий и что делать', () => {
    const text = parallelRunNotice(2);
    expect(text).toContain('одном каталоге');
    // Куда уходить — должно быть сказано, иначе предупреждение бесполезно.
    expect(text).toContain('отдельную ветку');
  });

  it('текст честен: уводит программа, а кнопка — запасной путь', () => {
    const text = parallelRunNotice(2) ?? '';
    // С п.31 увод происходит сам. Предупреждение — про СЛУЧАЙ, когда не вышло,
    // иначе оно звучит как «делайте руками» при том, что делается само.
    expect(text).toContain('не удалось');
    expect(text).toContain('worktree');
  });

  it('третий и дальше — та же правда, без нарастания', () => {
    expect(parallelRunNotice(3)).toBe(parallelRunNotice(2));
  });
});
