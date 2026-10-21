import { describe, expect, it } from 'vitest';
import { failedOperationLabel, fileOperationError, outcomeOfFailure } from '../src/renderer/core/file-operations';

const create = (ignoreIfExists: boolean) => ({ kind: 'create' as const, path: '/p/a.ts', ignoreIfExists });
const rename = { kind: 'rename' as const, from: '/p/a.ts', to: '/p/b.ts', ignoreIfExists: false };
const del = (ignoreIfNotExists: boolean) => ({ kind: 'delete' as const, path: '/p/a.ts', ignoreIfNotExists });

describe('outcomeOfFailure', () => {
  it('создание с ignoreIfExists: файл уже есть — это не ошибка', () => {
    expect(outcomeOfFailure(create(true), new Error('exists'))).toEqual({ kind: 'skipped' });
  });

  it('создание без флага — настоящая ошибка', () => {
    const outcome = outcomeOfFailure(create(false), new Error('denied'));
    expect(outcome.kind).toBe('failed');
  });

  it('удаление с ignoreIfNotExists: файла нет — это не ошибка', () => {
    expect(outcomeOfFailure(del(true), new Error('missing'))).toEqual({ kind: 'skipped' });
  });

  it('флаг создания не прощает провал удаления', () => {
    const outcome = outcomeOfFailure(del(false), new Error('locked'));
    expect(outcome.kind).toBe('failed');
  });

  it('у переименования флага нет: любая ошибка показывается', () => {
    expect(outcomeOfFailure(rename, new Error('busy')).kind).toBe('failed');
  });
});

describe('failedOperationLabel', () => {
  it('у переименования обе стороны: иначе непонятно, куда идти смотреть', () => {
    expect(failedOperationLabel(rename)).toBe('/p/a.ts → /p/b.ts');
  });

  it('у создания и удаления — путь', () => {
    expect(failedOperationLabel(create(false))).toBe('/p/a.ts');
    expect(failedOperationLabel(del(false))).toBe('/p/a.ts');
  });
});

describe('fileOperationError', () => {
  it('в текст попадает причина, а не только факт провала', () => {
    expect(fileOperationError(create(false), new Error('denied'))).toBe(
      'Не удалось выполнить операцию с файлом /p/a.ts: Error: denied',
    );
  });

  it('не-Error значение тоже читаемо', () => {
    expect(fileOperationError(del(false), 'нет места')).toContain('нет места');
  });
});
