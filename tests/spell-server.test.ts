import { describe, expect, it } from 'vitest';
import { offsetToPosition, spellServerDiagnostics } from '../src/main/spell/server';

/**
 * Настоящий cSpell с настоящими словарями. Медленно (первый вызов поднимает
 * 79 словарей), зато проверяет то, что увидит человек: подчёркивания совпадают
 * с прогоном в CI. Подменять здесь нечем — смысл модуля в самих словарях.
 */
describe('орфография проекта: cSpell в main', () => {
  it('слово из словаря проекта не подчёркивается', async () => {
    const found = await spellServerDiagnostics('/p/a.md', 'Чую чиназес', ['чиназес']);
    expect(found).toEqual([]);
  }, 30000);

  it('опечатка находится с позицией и сообщением', async () => {
    const found = await spellServerDiagnostics('/p/a.md', 'Это теекст', []);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(0);
    expect(found[0]!.message).toContain('теекст');
    expect(found[0]!.source).toBe('cspell');
  }, 30000);

  it('без своих слов опечатки видны обе', async () => {
    const found = await spellServerDiagnostics('/p/a.md', 'теекст ашипка');
    expect(found.length).toBe(2);
  }, 30000);

  it('смещение переводится в строку и колонку', () => {
    const text = 'первая\nвторая строка';
    const position = offsetToPosition(text, text.indexOf('вторая'));
    expect(position).toEqual({ line: 1, column: 0 });
  });
});
