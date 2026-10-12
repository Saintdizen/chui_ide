import { describe, expect, it } from 'vitest';
import {
  addPattern,
  emptyLfsInfo,
  formatSize,
  lfsFileLabel,
  lfsTrackLine,
  missingCount,
  normalizeLfsPattern,
  parseLfsFiles,
  parseLfsPatterns,
  removePattern,
} from '../src/shared/git-lfs';

/**
 * Разбор ответов git-lfs и правка `.gitattributes`.
 *
 * Версии git-lfs печатают `ls-files` по-разному (со размером и без), поэтому разбор
 * терпимый: проверяем оба варианта и то, что непонятная строка пропускается, а не
 * роняет список. Правка `.gitattributes` — чистая работа с текстом, тут важно, что
 * повторный шаблон не дублируется и что уборка не трогает чужие строки.
 */
describe('parseLfsFiles', () => {
  it('читает строки «oid статус путь»', () => {
    const files = parseLfsFiles('d1a5e3c3a1 * assets/logo.psd\nb2c3d4e5f6 - assets/big.zip\n');
    expect(files).toEqual([
      { oid: 'd1a5e3c3a1', path: 'assets/logo.psd', present: true, size: null },
      { oid: 'b2c3d4e5f6', path: 'assets/big.zip', present: false, size: null },
    ]);
  });

  it('читает вариант с размером перед путём', () => {
    const files = parseLfsFiles('d1a5e3c3a1 * 22752 assets/logo.psd');
    expect(files).toEqual([{ oid: 'd1a5e3c3a1', path: 'assets/logo.psd', present: true, size: 22752 }]);
  });

  it('строка без oid читается как путь', () => {
    const files = parseLfsFiles('только/путь.bin');
    expect(files).toEqual([{ oid: '', path: 'только/путь.bin', present: false, size: null }]);
  });

  it('пустой ответ — пустой список', () => {
    expect(parseLfsFiles('')).toEqual([]);
    expect(parseLfsFiles('\n  \n')).toEqual([]);
  });

  it('путь с пробелами не режется', () => {
    const files = parseLfsFiles('abc1234f * my folder/my file.bin');
    expect(files[0]?.path).toBe('my folder/my file.bin');
  });
});

describe('parseLfsPatterns', () => {
  it('берёт только строки с filter=lfs', () => {
    const attributes = [
      '# комментарий',
      '*.psd filter=lfs diff=lfs merge=lfs -text',
      '*.txt text',
      '',
      'assets/** filter=lfs diff=lfs merge=lfs -text',
    ].join('\n');
    expect(parseLfsPatterns(attributes).map((item) => item.pattern)).toEqual(['*.psd', 'assets/**']);
  });

  it('шаблон в кавычках читается без кавычек', () => {
    const patterns = parseLfsPatterns('"*.my file" filter=lfs diff=lfs merge=lfs -text');
    expect(patterns[0]?.pattern).toBe('*.my file');
  });

  it('файл без LFS-строк даёт пустой список', () => {
    expect(parseLfsPatterns('*.js text eol=lf\n')).toEqual([]);
    expect(parseLfsPatterns('')).toEqual([]);
  });
});

describe('addPattern', () => {
  it('добавляет строку шаблона в конец', () => {
    const result = addPattern('*.txt text\n', '*.psd');
    expect(result.changed).toBe(true);
    expect(result.text).toBe(`*.txt text\n${lfsTrackLine('*.psd')}\n`);
  });

  it('в пустом файле создаёт единственную строку', () => {
    expect(addPattern('', '*.bin').text).toBe(`${lfsTrackLine('*.bin')}\n`);
  });

  it('без завершающего перевода строки ставит его сам', () => {
    expect(addPattern('*.txt text', '*.bin').text).toBe(`*.txt text\n${lfsTrackLine('*.bin')}\n`);
  });

  it('повторный шаблон не добавляется', () => {
    const once = addPattern('', '*.psd');
    const twice = addPattern(once.text, '*.psd');
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it('пустой шаблон ничего не делает', () => {
    expect(addPattern('*.txt text\n', '   ').changed).toBe(false);
    expect(addPattern('*.txt text\n', '   ').text).toBe('*.txt text\n');
  });
});

describe('removePattern', () => {
  it('убирает строку шаблона и оставляет чужие', () => {
    const attributes = `${lfsTrackLine('*.psd')}\n*.txt text\n`;
    const result = removePattern(attributes, '*.psd');
    expect(result.changed).toBe(true);
    expect(result.text).toBe('*.txt text\n');
  });

  it('похожую строку без LFS не трогает', () => {
    const attributes = '*.psd text\n';
    expect(removePattern(attributes, '*.psd').changed).toBe(false);
    expect(removePattern(attributes, '*.psd').text).toBe(attributes);
  });

  it('удаление последнего шаблона оставляет пустой файл', () => {
    const result = removePattern(`${lfsTrackLine('*.psd')}\n`, '*.psd');
    expect(result.text).toBe('');
  });

  it('отсутствующий шаблон — текст без изменений', () => {
    const attributes = `${lfsTrackLine('*.psd')}\n`;
    expect(removePattern(attributes, '*.bin').changed).toBe(false);
  });
});

describe('подписи и мелочи', () => {
  it('нормализация шаблона снимает пробелы и кавычки', () => {
    expect(normalizeLfsPattern('  "*.psd"  ')).toBe('*.psd');
  });

  it('счёт неподтянутых файлов', () => {
    const files = parseLfsFiles('aaa1111 * a.bin\nbbb2222 - b.bin\nccc3333 - c.bin');
    expect(missingCount(files)).toBe(2);
  });

  it('подпись файла с размером и без', () => {
    expect(lfsFileLabel({ oid: 'a', path: 'a.bin', present: true, size: null })).toBe('a.bin');
    expect(lfsFileLabel({ oid: 'a', path: 'a.bin', present: true, size: 2048 })).toBe('a.bin · 2.0 КБ');
  });

  it('размер в удобных единицах', () => {
    expect(formatSize(512)).toBe('512 Б');
    expect(formatSize(10 * 1024)).toBe('10.0 КБ');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 МБ');
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.00 ГБ');
  });

  it('пустая запись LFS говорит «не найдено», но шаблоны сохраняет', () => {
    const info = emptyLfsInfo([{ pattern: '*.psd', line: '*.psd filter=lfs' }]);
    expect(info.available).toBe(false);
    expect(info.configured).toBe(true);
    expect(info.files).toEqual([]);
  });
});
