import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapesRoot, isInsideRoot } from '../src/main/workspace/path-guard';

/**
 * Проверки пути. Первая защищает от `..` в запросе, вторая — от чтения чужих
 * файлов по симлинку. Различие важно: уход за проект для содержимого запрещён,
 * а для метаданных разрешён — так устроены виртуальные окружения.
 */
describe('isInsideRoot', () => {
  const root = path.resolve('/proj');

  it('свой файл и подпапка — внутри', () => {
    expect(isInsideRoot(root, '/proj/a.py')).toBe(true);
    expect(isInsideRoot(root, '/proj/src/deep/a.py')).toBe(true);
  });

  it('сам корень — внутри', () => {
    expect(isInsideRoot(root, '/proj')).toBe(true);
  });

  it('выход через .. наружу', () => {
    expect(isInsideRoot(root, '/proj/../secret')).toBe(false);
  });

  it('абсолютный путь в стороне', () => {
    expect(isInsideRoot(root, '/etc/passwd')).toBe(false);
  });

  it('похожее имя каталога не считается своим', () => {
    // `/project` не должен проходить как часть `/proj`.
    expect(isInsideRoot(root, '/project/a.py')).toBe(false);
  });
});

describe('escapesRoot', () => {
  const rootReal = path.resolve('/proj');
  // Пути берём через `path.resolve`: модуль сравнивает готовые имена, а POSIX-литералы
  // на Windows не совпали бы с ними ни разделителем, ни диском.
  const inside = path.resolve('/proj/.venv/bin/python');
  const outside = path.resolve('/usr/bin/python3');
  const similar = path.resolve('/project/x');

  it('симлинк внутри проекта — не уход', () => {
    expect(escapesRoot(rootReal, inside)).toBe(false);
  });

  it('симлинк на системный интерпретатор — уход (так устроен venv)', () => {
    expect(escapesRoot(rootReal, outside)).toBe(true);
  });

  it('нечего сравнивать — не уход', () => {
    expect(escapesRoot(null, outside)).toBe(false);
    expect(escapesRoot(rootReal, null)).toBe(false);
  });

  it('похожее имя каталога не считается своим', () => {
    expect(escapesRoot(rootReal, similar)).toBe(true);
  });
});
