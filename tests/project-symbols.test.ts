import { describe, expect, it } from 'vitest';
import { mayExtendFromServers, projectSymbolAnswer, toProjectSymbols } from '../src/renderer/core/project-symbols';

describe('toProjectSymbols', () => {
  it('отсутствие пакета — своё объявление, а не пустая строка', () => {
    expect(toProjectSymbols([{ name: 'f', kind: 'function' }])).toEqual([
      { name: 'f', kind: 'function', package: null },
    ]);
  });

  it('пакет сохраняется как есть — по нему рисуется пометка библиотеки', () => {
    expect(toProjectSymbols([{ name: 'useState', kind: 'function', package: 'react' }])[0]?.package).toBe('react');
  });
});

describe('mayExtendFromServers', () => {
  it('карта не собрана — расширять нечем', () => {
    expect(mayExtendFromServers({ phase: 'idle' })).toBe(false);
  });

  it('карта собирается или готова — можно', () => {
    expect(mayExtendFromServers({ phase: 'warming' })).toBe(true);
    expect(mayExtendFromServers({ phase: 'ready' })).toBe(true);
  });

  it('статус не получен — показываем, что пришло: запрос состояния не судья ответу', () => {
    expect(mayExtendFromServers(null)).toBe(true);
  });
});

describe('projectSymbolAnswer', () => {
  it('на несобранной карте ответ пуст — иначе читается как «в проекте ничего нет»', () => {
    expect(projectSymbolAnswer([{ name: 'a', kind: 'class' }], { phase: 'idle' })).toEqual([]);
  });

  it('на готовой карте — переложенные символы', () => {
    const answer = projectSymbolAnswer([{ name: 'a', kind: 'class', package: 'x' }], { phase: 'ready' });
    expect(answer).toEqual([{ name: 'a', kind: 'class', package: 'x' }]);
  });

  it('пустой ответ серверов остаётся пустым', () => {
    expect(projectSymbolAnswer([], { phase: 'ready' })).toEqual([]);
  });
});
