import { describe, expect, it } from 'vitest';
import { importPathAt, importPathItems, specifierFor } from '../src/renderer/editor/complete/import-path';

/**
 * Подсказка пути внутри импорта.
 *
 * Две половины, и ошибиться легко в каждой: разбор места (где кончается строка, что
 * считать импортом, где в набранном кончается каталог) и сборка спецификаторов
 * (`./`, `../`, без расширения, `index` — это каталог). Проверяем обе без окна.
 */

/** Разбор места: `|` в тексте — каретка. */
function at(marked: string, languageId = 'typescript') {
  const column = marked.indexOf('|');
  const text = marked.replace('|', '');
  return importPathAt(text, column, languageId);
}

describe('где стоят подсказки пути', () => {
  it('строка после from — это импорт', () => {
    expect(at("import x from './ut|'")).toEqual({ prefix: 'ut', dir: './', style: 'quoted' });
  });

  it('пустая строка после кавычки — тоже импорт: каталог ещё не набран', () => {
    expect(at("import x from '|'")).toEqual({ prefix: '', dir: '', style: 'quoted' });
  });

  it('require и import() — те же пути', () => {
    expect(at("const x = require('./ser|')")).toEqual({ prefix: 'ser', dir: './', style: 'quoted' });
    expect(at("const x = await import('./ser|')")).toEqual({ prefix: 'ser', dir: './', style: 'quoted' });
  });

  it('набранный каталог отделяется от имени', () => {
    expect(at("import x from './src/ut|'")).toEqual({ prefix: 'ut', dir: './src/', style: 'quoted' });
    expect(at("import x from '../lib/|'")).toEqual({ prefix: '', dir: '../lib/', style: 'quoted' });
  });

  it('обычная строка — не импорт: там подсказок нет', () => {
    expect(at("const title = 'Значе|ние'")).toBeNull();
    expect(at("console.log('Значе|ние')")).toBeNull();
  });

  it('комментарий и код — не импорт', () => {
    expect(at('// пример: from "./ut|"')).toBeNull();
    expect(at("const x = 'a' + '/ut|'")).toBeNull();
  });

  it('каретка вне строки — не импорт', () => {
    expect(at("import x from './utils'|")).toBeNull();
  });

  it('Python: модуль после from и import', () => {
    expect(at('from pkg.co| import Session', 'python')).toEqual({ prefix: 'co', dir: 'pkg.', style: 'dotted' });
    expect(at('import app.ut|', 'python')).toEqual({ prefix: 'ut', dir: 'app.', style: 'dotted' });
  });

  it('Python: обычное имя в коде — не импорт', () => {
    expect(at('value = co|', 'python')).toBeNull();
    expect(at('from pkg.module import co|', 'python')).toBeNull();
  });

  it('язык без путей в импорте подсказок не получает', () => {
    expect(at("load 'fi|'", 'lua')).toBeNull();
  });
});

describe('спецификатор файла относительно своего', () => {
  it('соседний файл — через ./ и без расширения', () => {
    expect(specifierFor('src/utils.ts', 'src/app.ts', 'typescript')).toBe('./utils');
  });

  it('файл индекса — это каталог', () => {
    expect(specifierFor('src/widgets/index.ts', 'src/app.ts', 'typescript')).toBe('./widgets');
  });

  it('файл из соседнего каталога — через ../', () => {
    expect(specifierFor('lib/a.ts', 'src/app.ts', 'typescript')).toBe('../lib/a');
  });

  it('расширение не кода остаётся: его как раз и пишут', () => {
    expect(specifierFor('src/data.json', 'src/app.ts', 'typescript')).toBe('./data.json');
  });

  it('Python — модуль точками, __init__ это сам пакет', () => {
    expect(specifierFor('app/auth.py', 'src/app.py', 'python')).toBe('app.auth');
    expect(specifierFor('app/__init__.py', 'src/app.py', 'python')).toBe('app');
  });
});

describe('список подсказок', () => {
  const files = ['src/app.ts', 'src/utils.ts', 'src/widgets/index.ts', 'src/widgets/button.ts', 'lib/a.ts'];

  it('отбор идёт по набранному, а вставляется только хвост', () => {
    const items = importPathItems(files, 'src/app.ts', 'typescript', { prefix: 'ut', dir: './', style: 'quoted' });
    expect(items.map((item) => item.label)).toEqual(['./utils']);
    // Набранный каталог в строке уже есть — вставка его не дублирует.
    expect(items[0]?.insert).toBe('utils');
  });

  it('каталог предлагается наравне с файлами', () => {
    const items = importPathItems(files, 'src/app.ts', 'typescript', { prefix: 'wid', dir: './', style: 'quoted' });
    expect(items.map((item) => item.label)).toContain('./widgets');
    expect(items.find((item) => item.label === './widgets')?.detail).toBe('каталог');
  });

  it('набранный каталог сужает список', () => {
    const items = importPathItems(files, 'src/app.ts', 'typescript', {
      prefix: 'bu',
      dir: './widgets/',
      style: 'quoted',
    });
    expect(items.map((item) => item.label)).toEqual(['./widgets/button']);
  });

  it('свой файл не предлагается: себя не импортируют', () => {
    const items = importPathItems(files, 'src/app.ts', 'typescript', { prefix: 'ap', dir: './', style: 'quoted' });
    expect(items.map((item) => item.label)).not.toContain('./app');
  });

  it('на пустом наборе вперёд идут ближние файлы', () => {
    const items = importPathItems(files, 'src/app.ts', 'typescript', { prefix: '', dir: '', style: 'quoted' });
    // Соседи по каталогу короче, значит выше: `../`-пути не первые.
    expect(items[0]?.label.startsWith('./')).toBe(true);
  });

  it('Python: точки вместо слэшей, каталогов нет', () => {
    const items = importPathItems(['src/app.py', 'src/app/core.py'], 'src/app.py', 'python', {
      prefix: 'co',
      dir: 'src.app.',
      style: 'dotted',
    });
    expect(items.map((item) => item.label)).toEqual(['src.app.core']);
    expect(items[0]?.insert).toBe('core');
  });
});
