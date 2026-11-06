/**
 * П.28: у поиска своя история запросов.
 *
 * Причина, по которой это не мелочь: запрос умирал вместе с панелью, и в проекте
 * с сотней файлов регулярку приходилось вспоминать по памяти.
 */
import { describe, expect, it } from 'vitest';
import { SEARCH_HISTORY_LIMIT, createSearchHistory, stepHistory } from '../src/renderer/core/search-history';

describe('история поиска: запоминание', () => {
  it('свежий запрос идёт первым, старый уезжает вниз', () => {
    const history = createSearchHistory();
    history.remember('TODO');
    history.remember('FIXME');
    expect(history.entries()).toEqual(['FIXME', 'TODO']);
  });

  it('повтор не двоит строку, а поднимает запрос наверх', () => {
    const history = createSearchHistory();
    history.remember('a');
    history.remember('b');
    history.remember('a');
    expect(history.entries()).toEqual(['a', 'b']);
  });

  it('регистр — часть запроса, а не опечатка', () => {
    const history = createSearchHistory();
    history.remember('todo');
    history.remember('TODO');
    expect(history.entries()).toEqual(['TODO', 'todo']);
  });

  it('пустое и многострочное не помним: повторить это нельзя', () => {
    const history = createSearchHistory();
    history.remember('');
    history.remember('   ');
    history.remember('a\nb');
    expect(history.entries()).toEqual([]);
  });

  it('помнит не больше предела', () => {
    const history = createSearchHistory(3);
    history.remember('1');
    history.remember('2');
    history.remember('3');
    history.remember('4');
    expect(history.entries()).toEqual(['4', '3', '2']);
    expect(SEARCH_HISTORY_LIMIT).toBeGreaterThan(3);
  });

  it('clear забывает всё', () => {
    const history = createSearchHistory();
    history.remember('x');
    history.clear();
    expect(history.entries()).toEqual([]);
  });
});

describe('история поиска: листание стрелками', () => {
  const entries = ['b', 'a'];

  it('вверх от своего места даёт свежий запрос', () => {
    expect(stepHistory(entries, -1, -1, 'черновик')).toEqual({ index: 0, query: 'b' });
  });

  it('вниз — от свежего к старым', () => {
    expect(stepHistory(entries, 0, 1, 'черновик')).toEqual({ index: 1, query: 'a' });
  });

  it('выше самого свежего — возврат к набранному, а не залипание', () => {
    // Самое важное здесь: листание отменяется, и своё не теряется.
    expect(stepHistory(entries, 0, -1, 'черновик')).toEqual({ index: -1, query: 'черновик' });
  });

  it('за последним — тоже возврат к набранному', () => {
    expect(stepHistory(entries, 1, 1, 'черновик')).toEqual({ index: -1, query: 'черновик' });
  });

  it('вниз от своего места ничего не подставляет', () => {
    expect(stepHistory(entries, -1, 1, 'черновик')).toEqual({ index: -1, query: null });
  });

  it('пустая история — нечего листать и незачем падать', () => {
    expect(stepHistory([], -1, -1, 'x')).toEqual({ index: -1, query: null });
  });
});
