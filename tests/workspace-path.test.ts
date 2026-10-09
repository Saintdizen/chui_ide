import { describe, expect, it } from 'vitest';
import { relativePath } from '../src/renderer/core/workspace-model';

/**
 * Путь относительно корня. Renderer не имеет `node:path` (изоляция контекста),
 * поэтому считаем строками — но разделителем может быть и обратный слэш: main
 * отдаёт пути как есть (`path.join`), а не в POSIX-виде.
 */
describe('relativePath', () => {
  it('POSIX: путь внутри корня', () => {
    expect(relativePath('/proj', '/proj/src/a.ts')).toBe('src/a.ts');
  });

  it('сам корень — пустая строка', () => {
    expect(relativePath('/proj', '/proj')).toBe('');
  });

  it('корень с хвостовым слэшем', () => {
    expect(relativePath('/proj/', '/proj/src/a.ts')).toBe('src/a.ts');
  });

  it('файл вне корня возвращается как есть', () => {
    expect(relativePath('/proj', '/etc/passwd')).toBe('/etc/passwd');
  });

  it('Windows: путь внутри корня (обратные слэши)', () => {
    expect(relativePath('C:\\proj', 'C:\\proj\\src\\a.ts')).toBe('src\\a.ts');
  });

  it('Windows: корень и путь не путаются с похожим именем', () => {
    // `C:\project` не должен считаться частью `C:\proj`.
    expect(relativePath('C:\\proj', 'C:\\project\\a.ts')).toBe('C:\\project\\a.ts');
  });
});
