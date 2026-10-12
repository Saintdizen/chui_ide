import { describe, expect, it } from 'vitest';
import {
  formatRebaseTodo,
  parseRebaseTodo,
  rebaseActionLabel,
  rebaseActionShort,
  validateRebaseTodo,
  type RebaseTodoItem,
} from '../src/shared/git-rebase';

/**
 * Список шагов интерактивного rebase: как он выглядит в файле todo и что в нём
 * недопустимо. Правила чистые — git для проверки не нужен.
 */
const item = (
  action: RebaseTodoItem['action'],
  commit: string,
  extra: Partial<RebaseTodoItem> = {},
): RebaseTodoItem => ({
  action,
  commit,
  subject: `тема ${commit}`,
  ...extra,
});

describe('formatRebaseTodo', () => {
  it('строка на коммит: действие, хеш, тема', () => {
    const text = formatRebaseTodo([item('pick', 'aaa111'), item('drop', 'bbb222')]);
    expect(text).toBe('pick aaa111 тема aaa111\ndrop bbb222 тема bbb222');
  });

  it('обратен разбору', () => {
    const items = [item('pick', 'aaa111'), item('squash', 'bbb222')];
    expect(parseRebaseTodo(formatRebaseTodo(items))).toEqual(items);
  });
});

describe('parseRebaseTodo', () => {
  it('пропускает пустые строки и комментарии git', () => {
    const text = 'pick aaa111 первая\n\n# комментарий git\ndrop bbb222 вторая\n';
    expect(parseRebaseTodo(text)).toEqual([
      { action: 'pick', commit: 'aaa111', subject: 'первая' },
      { action: 'drop', commit: 'bbb222', subject: 'вторая' },
    ]);
  });

  it('незнакомое слово читает как pick', () => {
    expect(parseRebaseTodo('keep aaa111 тема')[0]?.action).toBe('pick');
  });

  it('строка без хеша пропускается', () => {
    expect(parseRebaseTodo('pick\n')).toEqual([]);
  });
});

describe('validateRebaseTodo', () => {
  it('пустой список — ошибка', () => {
    expect(validateRebaseTodo([])).toContain('пуст');
  });

  it('годный список проходит', () => {
    expect(validateRebaseTodo([item('pick', 'a'), item('squash', 'b')])).toBeNull();
  });

  it('squash первым — ошибка: склеивать не с чем', () => {
    expect(validateRebaseTodo([item('squash', 'a'), item('pick', 'b')])).toContain('squash');
    expect(validateRebaseTodo([item('fixup', 'a')])).toContain('fixup');
  });

  it('reword без нового сообщения — ошибка', () => {
    expect(validateRebaseTodo([item('reword', 'a')])).toContain('сообщение');
    expect(validateRebaseTodo([item('reword', 'a', { message: 'новое' })])).toBeNull();
  });

  it('коммит без хеша — ошибка', () => {
    expect(validateRebaseTodo([item('pick', '  ')])).toContain('хеш');
  });
});

describe('подписи действий', () => {
  it('у каждого действия есть слово и подпись', () => {
    for (const action of ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'] as const) {
      expect(rebaseActionShort(action)).toBe(action);
      expect(rebaseActionLabel(action).length).toBeGreaterThan(0);
    }
  });
});
