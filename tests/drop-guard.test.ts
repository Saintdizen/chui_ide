import { describe, expect, it } from 'vitest';
import {
  alreadyThereNotice,
  dropKind,
  dropTargetDir,
  dropVerdict,
  movedTo,
  movesInsideItself,
  skippedSource,
} from '../src/shared/drop-guard';

describe('dropVerdict', () => {
  it('файлы берём', () => {
    expect(dropVerdict(true, ['Files'])).toEqual({ accept: true, reason: null });
  });

  it('адрес из браузера — отказ с объяснением', () => {
    expect(dropVerdict(false, ['text/uri-list'])).toMatchObject({ accept: false });
    expect(dropVerdict(false, ['text/uri-list']).reason).toContain('адрес');
  });

  it('текст — тоже отказ, но другой', () => {
    expect(dropVerdict(false, ['text/plain']).reason).toContain('текст');
  });

  it('чужой тип назван честно', () => {
    expect(dropVerdict(false, ['application/x-thing']).reason).toBe('Это не файлы');
  });

  it('пустой перенос молчит: не за что ругать', () => {
    expect(dropVerdict(false, [])).toEqual({ accept: false, reason: null });
  });
});

describe('dropKind', () => {
  it('без модификатора — перенос', () => {
    expect(dropKind(true, ['Files'], false)).toBe('move');
  });

  it('с Ctrl — копия', () => {
    expect(dropKind(true, ['Files'], true)).toBe('copy');
  });

  it('без файлов — ничего', () => {
    expect(dropKind(false, ['text/plain'], false)).toBe('none');
  });
});

describe('dropTargetDir', () => {
  it('папка остаётся собой', () => {
    expect(dropTargetDir('/p/sub', true)).toBe('/p/sub');
  });

  it('на файл — рядом с ним', () => {
    expect(dropTargetDir('/p/a.ts', false)).toBe('/p');
  });
});

describe('movesInsideItself', () => {
  it('папка в свой подкаталог — в себя', () => {
    expect(movesInsideItself('/p/sub', '/p/sub/deep')).toBe(true);
  });

  it('перенос в родителя — не в себя', () => {
    expect(movesInsideItself('/p/sub', '/p')).toBe(false);
  });

  it('чужая папка — не в себя', () => {
    expect(movesInsideItself('/p/sub', '/q')).toBe(false);
  });
});

describe('skippedSource', () => {
  it('та же папка — переноса нет', () => {
    expect(skippedSource('/p/a.ts', '/p')).toBe('same-dir');
  });

  it('в свой подкаталог — отказ', () => {
    expect(skippedSource('/p/sub', '/p/sub/deep')).toBe('inside-itself');
  });

  it('обычный перенос проходит', () => {
    expect(skippedSource('/p/a.ts', '/q')).toBeNull();
  });
});

describe('alreadyThereNotice', () => {
  it('называет имя, а не весь путь', () => {
    expect(alreadyThereNotice('/q/a.ts')).toBe('Уже есть: a.ts');
  });
});

describe('movedTo', () => {
  it('склеивает с именем файла, а не с путём', () => {
    expect(movedTo('/p/sub/a.ts', '/q')).toBe('/q/a.ts');
  });
});
