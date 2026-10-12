import { describe, expect, it } from 'vitest';
import {
  countProblems,
  filterProblems,
  groupProblems,
  problemsSummary,
  type ProblemCounts,
} from '../src/shared/problem-list';
import type { DiagnosticItem } from '../src/shared/api';

function item(path: string, line: number, severity: DiagnosticItem['severity'], message: string, source = 'ts') {
  return { path, line, column: 1, severity, message, source } satisfies DiagnosticItem;
}

const items: DiagnosticItem[] = [
  item('/p/a.ts', 2, 'error', 'Тип «string» не присваивается «number»'),
  item('/p/a.ts', 7, 'warning', 'Переменная не используется'),
  item('/p/b.ts', 1, 'error', 'Неизвестное имя', 'import-check'),
  item('/p/b.ts', 3, 'info', 'Можно упростить'),
];

describe('счётчики проблем', () => {
  it('считает по видам', () => {
    expect(countProblems(items)).toEqual({ errors: 2, warnings: 1, infos: 1 });
  });

  it('на пустом списке — нули', () => {
    expect(countProblems([])).toEqual({ errors: 0, warnings: 0, infos: 0 });
  });
});

describe('отбор по подстроке', () => {
  it('ищет в сообщении без учёта регистра', () => {
    expect(filterProblems(items, 'не используется')).toHaveLength(1);
    expect(filterProblems(items, 'НЕ ИСПОЛЬЗУЕТСЯ')).toHaveLength(1);
  });

  it('ищет по источнику и по пути', () => {
    expect(filterProblems(items, 'import-check')).toHaveLength(1);
    expect(filterProblems(items, '/p/b.ts')).toHaveLength(2);
  });

  it('пустой запрос ничего не отсеивает', () => {
    expect(filterProblems(items, '   ')).toHaveLength(items.length);
  });

  it('ничего не найдено — пустой список', () => {
    expect(filterProblems(items, 'нет такого')).toEqual([]);
  });
});

describe('группировка по файлам', () => {
  const label = (path: string) => path.replace('/p/', '');

  it('собирает файлы с их проблемами и счётчиками', () => {
    const groups = groupProblems(items, '', label);
    expect(groups.map((group) => group.label)).toEqual(['a.ts', 'b.ts']);
    expect(groups[0]!.items).toHaveLength(2);
    expect(groups[0]!.counts).toEqual({ errors: 1, warnings: 1, infos: 0 });
    expect(groups[1]!.counts).toEqual({ errors: 1, warnings: 0, infos: 1 });
  });

  it('файлы без подходящих проблем в список не попадают', () => {
    const groups = groupProblems(items, 'упростить', label);
    expect(groups.map((group) => group.label)).toEqual(['b.ts']);
    expect(groups[0]!.items).toHaveLength(1);
  });

  it('порядок файлов сохраняется как во входном списке', () => {
    const shuffled = [items[3]!, items[0]!, items[1]!, items[2]!];
    expect(groupProblems(shuffled, '', label).map((group) => group.label)).toEqual(['b.ts', 'a.ts']);
  });
});

describe('заголовок панели', () => {
  it('называет виды с правильными формами слова', () => {
    expect(problemsSummary({ errors: 1, warnings: 0, infos: 0 })).toBe('1 ошибка');
    expect(problemsSummary({ errors: 2, warnings: 3, infos: 0 })).toBe('2 ошибки, 3 предупреждения');
    expect(problemsSummary({ errors: 5, warnings: 11, infos: 21 })).toBe('5 ошибок, 11 предупреждений, 21 замечание');
  });

  it('без проблем говорит об этом прямо', () => {
    expect(problemsSummary({ errors: 0, warnings: 0, infos: 0 } as ProblemCounts)).toBe('Проблем нет');
  });
});
