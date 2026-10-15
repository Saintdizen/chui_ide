import { describe, expect, it } from 'vitest';
import { hunkPatch, hunkRanges } from '../src/shared/git-hunks';

/** Diff файла с двумя правками, между которыми больше контекста — два блока. */
const TWO_HUNKS = [
  'diff --git a/a.ts b/a.ts',
  'index 1111111..2222222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,4 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -20,3 +20,3 @@',
  ' twenty',
  '-twenty one',
  '+TWENTY ONE',
  ' twenty two',
  '',
].join('\n');

describe('hunkRanges', () => {
  it('находит границы блоков по строкам файла', () => {
    expect(hunkRanges(TWO_HUNKS)).toEqual([
      { oldStart: 1, oldCount: 4, newStart: 1, newCount: 4 },
      { oldStart: 20, oldCount: 3, newStart: 20, newCount: 3 },
    ]);
  });

  it('пропущенное число в шапке означает одну строку', () => {
    const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -5 +5 @@', ' x', ''].join('\n');
    expect(hunkRanges(diff)).toEqual([{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 }]);
  });

  it('добавление файла даёт блок с нулём старых строк', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+first',
      '+second',
      '',
    ].join('\n');
    expect(hunkRanges(diff)).toEqual([{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }]);
  });

  it('пустой или неполный diff блоков не даёт', () => {
    expect(hunkRanges('')).toEqual([]);
    expect(hunkRanges('просто текст\n')).toEqual([]);
  });

  it('заголовок следующего файла закрывает блок предыдущего', () => {
    // Строка `diff --git` — не тело блока (не начинается со знака изменения), поэтому
    // она и завершает предыдущий блок, и открывает заголовок следующего файла.
    const two = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    // Оба блока найдены: закрытие первого строкой `diff --git` разбор не сбило.
    expect(hunkRanges(two)).toEqual([
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
      { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    ]);
  });
});

describe('hunkPatch', () => {
  it('собирает патч из одного блока вместе с заголовком файла', () => {
    const patch = hunkPatch(TWO_HUNKS, 0);

    expect(patch).toContain('diff --git a/a.ts b/a.ts');
    expect(patch).toContain('--- a/a.ts');
    expect(patch).toContain('@@ -1,4 +1,4 @@');
    expect(patch).toContain('-two');
    expect(patch).toContain('+TWO');
    // Второй блок в патч не попадает: индексируем только выбранное.
    expect(patch).not.toContain('TWENTY ONE');
  });

  it('второй блок собирается отдельно', () => {
    const patch = hunkPatch(TWO_HUNKS, 1);

    expect(patch).toContain('@@ -20,3 +20,3 @@');
    expect(patch).toContain('+TWENTY ONE');
    expect(patch).not.toContain('+TWO');
  });

  it('завершается переводом строки: без него git apply ругается на обрыв', () => {
    expect(hunkPatch(TWO_HUNKS, 0)?.endsWith('\n')).toBe(true);
  });

  it('номера вне диапазона и неполный diff дают null', () => {
    expect(hunkPatch(TWO_HUNKS, 2)).toBeNull();
    expect(hunkPatch(TWO_HUNKS, -1)).toBeNull();
    expect(hunkPatch(TWO_HUNKS, 1.5)).toBeNull();
    // Заголовка файла нет — `git apply` такой кусок не примет.
    expect(hunkPatch('@@ -1,1 +1,1 @@\n-x\n+y\n', 0)).toBeNull();
  });
});
