import { describe, expect, it, vi } from 'vitest';
import { paletteEmptyReason } from '../src/renderer/ui/palette';
import { problemEmptyPlan } from '../src/renderer/ui/problem-panel';
import { symbolEmptyReason } from '../src/renderer/ui/symbol-picker';

/**
 * П.10: «Пустые состояния объясняют себя».
 *
 * Источник (JB `lists-and-trees`, VS Code `ux-views`): пустой список — это
 * сообщение о ПРИЧИНЕ плюс действие, а не пустая панель и не одно «Ничего
 * не найдено» на любую беду.
 *
 * Дыра была одна и та же в трёх местах: код печатал одинаковый текст, хотя
 * причины разные и следующий шаг у них разный.
 */
describe('палитра команд', () => {
  // Раньше «Ничего не найдено» печаталось и при пустом запросе, и при пустом
  // реестре: человек думал, что такой команды нет, — хотя команд нет вообще.
  it('пустой реестр говорит, что команд нет, а не «не найдено»', () => {
    expect(paletteEmptyReason(0, '')).not.toContain('не найдено');
  });

  it('ищет причину в реестре, а не в запросе', () => {
    expect(paletteEmptyReason(0, 'формат').toLowerCase()).toContain('команд');
  });

  it('на непустом реестре виноват запрос', () => {
    expect(paletteEmptyReason(120, 'zzz')).toContain('Ничего не найдено');
  });
});

describe('список символов', () => {
  it('пустой источник не выдаёт себя за неудачный запрос', () => {
    expect(symbolEmptyReason({ found: 0 })).not.toContain('Ничего не найдено');
  });

  // `@метод` — фильтр по виду: если он отсёк всё, советовать «наберите
  // короче» вредно, набирать надо иначе.
  it('фильтр по виду называет себя', () => {
    expect(symbolEmptyReason({ found: 40, kindQuery: 'метод', kindSize: 0 })).toContain('метод');
  });

  it('несовпавший по виду — не повод советовать короче', () => {
    expect(symbolEmptyReason({ found: 40, kindQuery: 'метод', kindSize: 0 })).not.toContain('короче');
  });

  it('остальное — неудачный запрос', () => {
    expect(symbolEmptyReason({ found: 40, kindSize: 40 })).toContain('Ничего не найдено');
  });
});

describe('панель проблем', () => {
  // До правки «Проблем нет.» стояло и до первой проверки проекта — то есть
  // утверждало чистоту, не посмотрев ни одного файла.
  it('до проверки — это не «проблемы», а «не проверено», и есть действие', () => {
    const plan = problemEmptyPlan({ markers: 0, filter: '' });
    expect(plan.text).not.toBe('Проблем нет.');
    expect(plan.action).toBe('Проверить проект');
  });

  it('после проверки — честное «проблем нет»', () => {
    expect(problemEmptyPlan({ markers: 0, filter: '', checked: true }).text).toBe('Проблем нет.');
  });

  it('фильтр предлагает сброс, а не проверку', () => {
    const plan = problemEmptyPlan({ markers: 3, filter: 'zzz' });
    expect(plan.action).toBe('Сбросить фильтр');
  });

  it('действие сброса чистит фильтр', () => {
    const reset = vi.fn();
    const plan = problemEmptyPlan({ markers: 3, filter: 'zzz', reset });
    plan.run();
    expect(reset).toHaveBeenCalled();
  });
});
