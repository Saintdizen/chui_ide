import { describe, expect, it } from 'vitest';
import {
  EMPTY_TYPEAHEAD,
  TYPEAHEAD_RESET_MS,
  typeaheadPress,
  typeaheadTarget,
} from '../src/renderer/core/tree-typeahead';

/**
 * Типизированный поиск по дереву.
 *
 * Главное здесь — не поиск, а СБРОС буфера: без него буквы из разных мыслей
 * склеиваются в одно слово и уводят не туда.
 */
describe('буфер набора', () => {
  it('буквы копятся, пока не прошла пауза', () => {
    let state = typeaheadPress(EMPTY_TYPEAHEAD, 'i', 1000);
    state = typeaheadPress(state, 'n', 1100);
    expect(state.buffer).toBe('in');
  });

  it('после паузы начинается новое слово', () => {
    // Иначе набранное «index» через «in» + пауза + «dex» искало бы «index».
    let state = typeaheadPress(EMPTY_TYPEAHEAD, 'i', 1000);
    state = typeaheadPress(state, 'd', 1000 + TYPEAHEAD_RESET_MS + 1);
    expect(state.buffer).toBe('d');
  });

  it('повтор одной буквы — тоже новое слово', () => {
    // Так в VS Code: «ss» ведёт к следующему «s…», а не ищет «ss».
    let state = typeaheadPress(EMPTY_TYPEAHEAD, 's', 1000);
    state = typeaheadPress(state, 's', 1050);
    expect(state.buffer).toBe('s');
  });

  it('разные буквы после повтора снова копятся', () => {
    let state = typeaheadPress(EMPTY_TYPEAHEAD, 's', 1000);
    state = typeaheadPress(state, 's', 1050);
    state = typeaheadPress(state, 't', 1100);
    expect(state.buffer).toBe('st');
  });
});

const ROWS = [
  { path: 'src/a.ts', name: 'a.ts' },
  { path: 'src/b.ts', name: 'b.ts' },
  { path: 'src/lib', name: 'lib' },
];

describe('куда прыгнуть', () => {
  it('первая строка из набора, начинающаяся с набранного', () => {
    expect(typeaheadTarget(ROWS, null, 'b')).toBe('src/b.ts');
  });

  it('ищется по имени, а не по пути', () => {
    // Набравший «a.ts» не должен промахнуться мимо `a.ts` из-за `src/` в начале.
    expect(typeaheadTarget(ROWS, null, 'a.ts')).toBe('src/a.ts');
  });

  it('повтор тех же букв ведёт к следующему совпадению, а не стоит на месте', () => {
    const many = [
      { path: 'a1', name: 'app.ts' },
      { path: 'a2', name: 'app.test.ts' },
    ];
    expect(typeaheadTarget(many, 'a1', 'a')).toBe('a2');
  });

  it('дошёл до конца — заворачивает на начало', () => {
    const many = [
      { path: 'a1', name: 'app.ts' },
      { path: 'a2', name: 'app.test.ts' },
    ];
    expect(typeaheadTarget(many, 'a2', 'a')).toBe('a1');
  });

  it('нет совпадений — никуда не прыгаем', () => {
    // `null` значит «оставь выделение как есть», а не «сбрось».
    expect(typeaheadTarget(ROWS, 'src/a.ts', 'zzz')).toBeNull();
  });

  it('пустое набранное — не прыжок', () => {
    expect(typeaheadTarget(ROWS, 'src/a.ts', '')).toBeNull();
  });

  it('регистр не важен', () => {
    expect(typeaheadTarget(ROWS, null, 'B')).toBe('src/b.ts');
  });

  it('шаблон `*` прыгает по концу имени, а не по началу', () => {
    const rows = [
      { path: 'a1', name: 'app.ts' },
      { path: 'a2', name: 'app.test.ts' },
    ];
    // Ни одно из имён не начинается с `*.test.ts` — сравнение идёт по всему имени.
    expect(typeaheadTarget(rows, null, '*.test.ts')).toBe('a2');
  });

  it('`?` — ровно один символ', () => {
    const rows = [
      { path: 'a1', name: 'app.ts' },
      { path: 'a2', name: 'a.ts' },
    ];
    expect(typeaheadTarget(rows, null, '?.ts')).toBe('a2');
  });

  it('шаблон без совпадений — никуда не прыгаем', () => {
    expect(typeaheadTarget(ROWS, 'src/a.ts', '*.nope')).toBeNull();
  });
});
