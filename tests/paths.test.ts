import { describe, expect, it } from 'vitest';
import { isInsidePath, joinPath, nameOf, parentOf, pathAfter, separatorOf, splitPath } from '../src/shared/paths';

/**
 * Пути строками. Главное здесь — не считать разделитель всегда прямым: main отдаёт
 * родные (на Windows «\»), и жёсткий «/» ломает и поиск файла в проекте, и
 * переименование, и крошки. Поэтому у каждого правила проверяем оба разделителя.
 */
describe('separatorOf', () => {
  it('берёт разделитель из пути', () => {
    expect(separatorOf('/proj/src')).toBe('/');
    expect(separatorOf('C:\\proj\\src')).toBe('\\');
    expect(separatorOf('имя')).toBe('/');
  });
});

describe('splitPath', () => {
  it('режет по обоим разделителям', () => {
    expect(splitPath('/proj/src/a.ts')).toEqual(['proj', 'src', 'a.ts']);
    expect(splitPath('C:\\proj\\src\\a.ts')).toEqual(['C:', 'proj', 'src', 'a.ts']);
  });

  it('лишние разделители не дают пустых сегментов', () => {
    expect(splitPath('/proj//src/')).toEqual(['proj', 'src']);
  });
});

describe('nameOf', () => {
  it('последний сегмент — для любого разделителя', () => {
    expect(nameOf('/proj/src/a.ts')).toBe('a.ts');
    expect(nameOf('C:\\proj\\src\\a.ts')).toBe('a.ts');
    expect(nameOf('a.ts')).toBe('a.ts');
  });
});

describe('parentOf', () => {
  it('всё до последнего разделителя', () => {
    expect(parentOf('/proj/a.ts')).toBe('/proj');
    expect(parentOf('C:\\proj\\a.ts')).toBe('C:\\proj');
  });

  it('имя без каталога — родителя нет', () => {
    expect(parentOf('a.ts')).toBe('');
  });
});

describe('joinPath', () => {
  it('соединяет тем же разделителем, что и родитель', () => {
    expect(joinPath('/proj', 'a.ts')).toBe('/proj/a.ts');
    expect(joinPath('C:\\proj', 'a.ts')).toBe('C:\\proj\\a.ts');
  });

  it('хвостовые разделители не удваиваются', () => {
    expect(joinPath('/proj/', 'a.ts')).toBe('/proj/a.ts');
    expect(joinPath('C:\\proj\\', 'a.ts')).toBe('C:\\proj\\a.ts');
  });

  it('без родителя остаётся имя', () => {
    expect(joinPath('', 'a.ts')).toBe('a.ts');
  });

  it('переименование: имя меняется в том же каталоге', () => {
    // Так explorer строит новый путь: родитель старого пути + новое имя.
    expect(joinPath(parentOf('C:\\proj\\src\\old.ts'), 'new.ts')).toBe('C:\\proj\\src\\new.ts');
    expect(joinPath(parentOf('/proj/src/old.ts'), 'new.ts')).toBe('/proj/src/new.ts');
  });
});

describe('isInsidePath', () => {
  it('папка и её содержимое — внутри', () => {
    expect(isInsidePath('/proj', '/proj/src/a.ts')).toBe(true);
    expect(isInsidePath('C:\\proj', 'C:\\proj\\a.ts')).toBe(true);
  });

  it('сам путь считается внутри себя', () => {
    expect(isInsidePath('/proj', '/proj')).toBe(true);
  });

  it('похожее имя каталога — не внутри', () => {
    // `/project` не часть `/proj`: граница по сегменту, а не по подстроке.
    expect(isInsidePath('/proj', '/project/a.ts')).toBe(false);
    expect(isInsidePath('C:\\proj', 'C:\\project\\a.ts')).toBe(false);
  });

  it('чужой путь — не внутри', () => {
    expect(isInsidePath('/proj', '/etc/passwd')).toBe(false);
  });
});

describe('pathAfter', () => {
  it('часть пути после корня', () => {
    expect(pathAfter('/proj', '/proj/src/a.ts')).toBe('src/a.ts');
    expect(pathAfter('C:\\proj', 'C:\\proj\\src\\a.ts')).toBe('src\\a.ts');
  });

  it('сам корень — пустая строка', () => {
    expect(pathAfter('/proj', '/proj')).toBe('');
    expect(pathAfter('C:\\proj', 'C:\\proj')).toBe('');
  });

  it('корень с хвостовым разделителем', () => {
    expect(pathAfter('/proj/', '/proj/src/a.ts')).toBe('src/a.ts');
    expect(pathAfter('C:\\proj\\', 'C:\\proj\\a.ts')).toBe('a.ts');
  });

  it('чужой путь возвращается как есть', () => {
    expect(pathAfter('/proj', '/etc/passwd')).toBe('/etc/passwd');
  });

  it('корень файловой системы', () => {
    expect(pathAfter('/', '/proj/a.ts')).toBe('proj/a.ts');
  });
});
