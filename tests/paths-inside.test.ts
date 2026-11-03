import { describe, expect, it } from 'vitest';
import { isInsidePath } from '../src/shared/paths';

/**
 * Граница папки. Функция сторожит перенос файлов (папка не должна уехать в себя)
 * и поиск (что считать вложенным), поэтому проверяем её отдельно от них.
 *
 * Раньше граница строилась через `joinPath(folder, '')`: у папки с разделителем
 * на конце разделитель съезжал (`/p/` → `/p/`), и проверка путалась.
 */
describe('isInsidePath', () => {
  it('папка — внутри себя', () => {
    expect(isInsidePath('/p/sub', '/p/sub')).toBe(true);
  });

  it('подкаталог — внутри', () => {
    expect(isInsidePath('/p/sub', '/p/sub/deep/a.ts')).toBe(true);
  });

  it('сосед по префиксу — не внутри', () => {
    expect(isInsidePath('/p/src', '/p/src2/a.ts')).toBe(false);
  });

  it('родитель — не внутри', () => {
    expect(isInsidePath('/p/sub', '/p')).toBe(false);
  });

  it('разделитель на конце папки не ломает границу', () => {
    expect(isInsidePath('/p/sub/', '/p/sub/a.ts')).toBe(true);
    expect(isInsidePath('/p/sub/', '/p/sub2/a.ts')).toBe(false);
  });

  it('обратные слэши', () => {
    expect(isInsidePath('C:\\p\\sub', 'C:\\p\\sub\\a.ts')).toBe(true);
    expect(isInsidePath('C:\\p\\src', 'C:\\p\\src2\\a.ts')).toBe(false);
  });
});
