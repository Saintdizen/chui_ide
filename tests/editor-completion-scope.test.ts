import { describe, expect, it } from 'vitest';
import {
  extendItems,
  isCodeLanguage,
  scopeLabel,
  worthAskingIndex,
  type CompletionScope,
  type ProjectCompletion,
} from '../src/renderer/editor/complete/assistant';

/**
 * Ширина списка подсказок: повторный Ctrl+Space расширяет его.
 *
 * Первое нажатие даёт слова файла, второе — символы проекта, третье — установленные
 * зависимости. Проверяем правило отбора (что попадает на каждом уровне) и порядок
 * уровней: если третий покажет то же, что второй, «шире» перестанет быть правдой.
 * Сам ассистент требует DOM и живёт в пробе; здесь — чистая часть.
 */

const own: ProjectCompletion = { name: 'Parser', kind: 'класс' };
const fromPackage: ProjectCompletion = { name: 'Session', kind: 'класс', package: 'requests' };

describe('уровни ширины', () => {
  it('второй уровень — свои объявления, третий добавляет к ним чужие', () => {
    expect(extendItems('project', [own, fromPackage], new Set()).map((item) => item.label)).toEqual(['Parser']);
    // Третий уровень — надмножество второго: при расширении свои имена не пропадают.
    expect(extendItems('dependencies', [own, fromPackage], new Set()).map((item) => item.label)).toEqual([
      'Parser',
      'Session',
    ]);
  });

  it('первый уровень карту не спрашивает: это слова файла', () => {
    expect(extendItems('file', [own, fromPackage], new Set())).toEqual([]);
  });

  it('уже показанное не повторяется', () => {
    expect(extendItems('project', [own], new Set(['Parser']))).toEqual([]);
  });

  it('подпись говорит, откуда имя, и называет пакет', () => {
    const [mine] = extendItems('project', [own], new Set());
    expect(mine?.detail).toBe('из проекта');
    const [, theirs] = extendItems('dependencies', [own, fromPackage], new Set());
    expect(theirs?.detail).toBe('из зависимости: requests');
  });

  it('подписи уровней — разные, иначе список не различить', () => {
    const labels = (['file', 'project', 'dependencies'] as CompletionScope[]).map(scopeLabel);
    expect(new Set(labels).size).toBe(3);
    expect(labels[0]).toBeNull();
  });
});

describe('точка только в коде', () => {
  it('языки кода — да', () => {
    for (const language of ['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp']) {
      expect(isCodeLanguage(language), language).toBe(true);
    }
  });

  it('проза и разметка — нет: там точка — знак препинания', () => {
    for (const language of ['markdown', 'text', 'plaintext', 'html', 'xml', 'yaml', 'css']) {
      expect(isCodeLanguage(language), language).toBe(false);
    }
  });

  it('данные и журналы — тоже нет', () => {
    expect(isCodeLanguage('json')).toBe(false);
    expect(isCodeLanguage('jsonc')).toBe(false);
    expect(isCodeLanguage('csv')).toBe(false);
    expect(isCodeLanguage('log')).toBe(false);
  });
});

describe('карта при обычном наборе', () => {
  it('двух знаков уже достаточно, одного — нет', () => {
    expect(worthAskingIndex('Pr', true)).toBe(true);
    expect(worthAskingIndex('P', true)).toBe(false);
    expect(worthAskingIndex('', true)).toBe(false);
  });

  it('без источника не спрашиваем, сколько бы ни набрали', () => {
    expect(worthAskingIndex('Parser', false)).toBe(false);
  });
});
