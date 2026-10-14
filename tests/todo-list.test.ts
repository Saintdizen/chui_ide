import { describe, expect, it } from 'vitest';
import {
  TODO_QUERY,
  filterTodos,
  groupTodos,
  parseTodo,
  toTodoItems,
  todoBadgeText,
  todoCounts,
  todoSummary,
  type TodoItem,
} from '../src/shared/todo-list';
import type { SearchHit } from '../src/shared/api';

/** Строка находки поиска: путь, место и текст строки (обрезанный, как у ripgrep). */
function hit(path: string, line: number, text: string, column = 1): SearchHit {
  return { path, line, column, text };
}

describe('разбор строки находки', () => {
  it('вид пометки берётся первым словом, остальное — текстом', () => {
    expect(parseTodo(hit('/p/a.ts', 1, 'const x = 1; // TODO: переписать'))).toEqual({
      path: '/p/a.ts',
      line: 1,
      column: 1,
      marker: 'TODO',
      text: 'переписать',
    });
  });

  it('ведущие знаки-разделители и пробелы убираются', () => {
    expect(parseTodo(hit('/p/a.ts', 2, '// FIXME — падает на пустом вводе'))?.text).toBe('падает на пустом вводе');
    expect(parseTodo(hit('/p/a.ts', 2, '# HACK: костыль'))?.text).toBe('костыль');
  });

  it('регистр пометки не важен, в вид она приводится в верхнем', () => {
    expect(parseTodo(hit('/p/a.ts', 3, '// todo без двоеточия'))?.marker).toBe('TODO');
  });

  it('слово с пометкой внутри слова не считается пометкой', () => {
    // Границ слова в самом тексте может и не быть: проверяем, что «TODOLIST» не ловится.
    expect(parseTodo(hit('/p/a.ts', 4, 'const TODO_LIST = [];'))).toBeNull();
  });

  it('строка без пометки — null', () => {
    expect(parseTodo(hit('/p/a.ts', 5, 'const value = 1;'))).toBeNull();
  });

  it('берётся первая пометка строки', () => {
    expect(parseTodo(hit('/p/a.ts', 6, '// TODO A FIXME B'))?.marker).toBe('TODO');
  });

  it('текста после пометки нет — пустая строка, а не null', () => {
    expect(parseTodo(hit('/p/a.ts', 7, '// TODO'))?.text).toBe('');
  });
});

describe('сборка списка находок', () => {
  it('строки без пометки отбрасываются', () => {
    const items = toTodoItems([
      hit('/p/a.ts', 1, '// TODO: одно'),
      hit('/p/a.ts', 2, 'const value = 1;'),
      hit('/p/b.ts', 1, '// FIXME: другое'),
    ]);
    expect(items.map((item) => item.marker)).toEqual(['TODO', 'FIXME']);
    expect(items.map((item) => item.path)).toEqual(['/p/a.ts', '/p/b.ts']);
  });
});

const items: TodoItem[] = [
  { path: '/p/a.ts', line: 1, column: 1, marker: 'TODO', text: 'переписать на класс' },
  { path: '/p/a.ts', line: 4, column: 3, marker: 'FIXME', text: 'падает на пустом вводе' },
  { path: '/p/b.ts', line: 1, column: 1, marker: 'TODO', text: 'второй файл' },
  { path: '/p/b.ts', line: 2, column: 1, marker: 'HACK', text: 'обходной путь' },
];

describe('счётчики и заголовок', () => {
  it('считает по видам', () => {
    expect(todoCounts(items)).toEqual({ TODO: 2, FIXME: 1, HACK: 1, XXX: 0 });
  });

  it('на пустом списке — нули по всем видам', () => {
    expect(todoCounts([])).toEqual({ TODO: 0, FIXME: 0, HACK: 0, XXX: 0 });
  });

  it('заголовок называет виды с числами, порядок — как в наборе', () => {
    expect(todoSummary(items)).toBe('2 TODO, 1 FIXME, 1 HACK');
    expect(todoSummary([])).toBe('Пометок нет');
  });
});

describe('значок вкладки', () => {
  it('всего пометок; пусто — значка нет', () => {
    expect(todoBadgeText(items)).toBe('4');
    expect(todoBadgeText([])).toBeNull();
  });
});

describe('отбор по подстроке', () => {
  it('ищет в тексте, виде и пути без учёта регистра', () => {
    expect(filterTodos(items, 'пустом')).toHaveLength(1);
    expect(filterTodos(items, 'hack')).toHaveLength(1);
    expect(filterTodos(items, '/p/b.ts')).toHaveLength(2);
  });

  it('пустой запрос ничего не отсеивает', () => {
    expect(filterTodos(items, '   ')).toHaveLength(items.length);
  });
});

describe('группировка по файлам', () => {
  const label = (path: string) => path.replace('/p/', '');

  it('собирает файлы с их пометками и счётчиками', () => {
    const groups = groupTodos(items, '', label);
    expect(groups.map((group) => group.label)).toEqual(['a.ts', 'b.ts']);
    expect(groups[0]!.items).toHaveLength(2);
    expect(groups[0]!.counts).toEqual({ TODO: 1, FIXME: 1, HACK: 0, XXX: 0 });
    expect(groups[1]!.counts).toEqual({ TODO: 1, FIXME: 0, HACK: 1, XXX: 0 });
  });

  it('файлы без подходящих пометок в список не попадают', () => {
    const groups = groupTodos(items, 'обходной', label);
    expect(groups.map((group) => group.label)).toEqual(['b.ts']);
  });

  it('порядок файлов сохраняется как во входном списке', () => {
    const shuffled = [items[2]!, items[3]!, items[0]!, items[1]!];
    expect(groupTodos(shuffled, '', label).map((group) => group.label)).toEqual(['b.ts', 'a.ts']);
  });
});

describe('запрос к поиску по проекту', () => {
  it('ловит все виды пометок словом целиком', () => {
    const regex = new RegExp(TODO_QUERY, 'g');
    const line = '// TODO и FIXME и HACK и XXX';
    expect(line.match(regex)).toEqual(['TODO', 'FIXME', 'HACK', 'XXX']);
  });
});
