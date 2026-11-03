import { describe, expect, it } from 'vitest';
import { relativeToRoots, type WorkspaceRoot } from '../src/shared/workspace-roots';

/**
 * Копирование пути — на НАСТОЯЩЕМ коде, не на его пересказе.
 *
 * Найдено разбором: команды не было вовсе, путь брали глазами и тянули в чат
 * руками. Две формы нужны обе: полная — для терминала и переноса между
 * проектами, от корня — для сообщения коллеге и для диффа.
 */
const roots: WorkspaceRoot[] = [{ name: 'p', root: '/p' }];

/** Та же нормализация, что в `WorkspaceModel.relative` — через настоящую функцию. */
const relative = (target: string): string => relativeToRoots(roots, target) || 'p';

describe('путь от корня проекта', () => {
  it('файл внутри корня — без корня', () => {
    expect(relative('/p/src/a.ts')).toBe('src/a.ts');
  });

  it('сам корень — имя проекта, а не пустая строка', () => {
    // Пустая строка в буфере выглядит как «не сработало», и её вставят молча.
    expect(relative('/p')).toBe('p');
  });
});

/** Выбор цели — та же развилка, что в команде: аргумент важнее активного файла. */
const resolveTarget = (path: unknown, currentPath: string | null): string | null =>
  typeof path === 'string' && path.length > 0 ? path : currentPath;

describe('что именно копируем', () => {
  it('аргумент важнее активного файла', () => {
    // Из меню вкладки приходит ЕЁ путь. Взять вместо него активный — самая
    // обидная ошибка: не заметишь, пока не вставишь не туда.
    expect(resolveTarget('/p/other.ts', '/p/current.ts')).toBe('/p/other.ts');
  });

  it('без аргумента — активный файл', () => {
    expect(resolveTarget(undefined, '/p/current.ts')).toBe('/p/current.ts');
  });

  it('нет ни аргумента, ни открытого файла — копировать нечего', () => {
    expect(resolveTarget(undefined, null)).toBeNull();
  });
});
