import { describe, expect, it } from 'vitest';
import { pathToUri, uriToPath } from '../src/renderer/core/document';

/**
 * Перевод пути в ссылку и обратно. Ключевое свойство одно: результат должен
 * совпадать с `TextDocument.path`, иначе LSP и быстрые правки, которые ищут
 * документ по строке пути, на Windows его не находят (там Monaco отдаёт `/C:/…`,
 * а ключ хранится как `C:\…`).
 */
describe('uriToPath', () => {
  it('на POSIX оставляет путь как есть', () => {
    expect(uriToPath('file:///home/u/proj/a.py')).toBe('/home/u/proj/a.py');
  });

  it('раскодирует percent-encoding', () => {
    expect(uriToPath('file:///home/u/%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82/a.py')).toBe('/home/u/проект/a.py');
  });

  it('на Windows снимает ведущий слэш и возвращает родные разделители', () => {
    expect(uriToPath('file:///C:/proj/a.py')).toBe('C:\\proj\\a.py');
  });

  it('понимает закодированное двоеточие диска', () => {
    expect(uriToPath('file:///c%3A/proj/a.py')).toBe('c:\\proj\\a.py');
  });

  it('обратим к pathToUri: Windows', () => {
    expect(uriToPath(pathToUri('C:\\proj\\src\\a.py'))).toBe('C:\\proj\\src\\a.py');
  });

  it('обратим к pathToUri: POSIX', () => {
    expect(uriToPath(pathToUri('/home/u/proj/a.py'))).toBe('/home/u/proj/a.py');
  });
});
