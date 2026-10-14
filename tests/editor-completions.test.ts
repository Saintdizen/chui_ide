import { describe, expect, it } from 'vitest';
import { allCompletions, buildCompletions, languageWords } from '../src/renderer/editor/complete/completions';
import { WordIndex } from '../src/renderer/editor/complete/word-index';

function indexOf(lines: readonly string[]): WordIndex {
  const index = new WordIndex();
  index.addLines(0, lines);
  return index;
}

/** Подписи подсказок — чаще всего проверяют именно порядок слов. */
const labels = (items: readonly { label: string }[]) => items.map((item) => item.label);

describe('слова языка', () => {
  it('берутся из словарей подсветки, без повторов по происхождению', () => {
    const words = languageWords('typescript');
    expect(words).toContain('function');
    expect(words).toContain('for');
    // Примитивы TS — типы, они тоже в подсказках.
    expect(words).toContain('string');
  });

  it('язык без словаря слов не даёт', () => {
    expect(languageWords('markdown')).toEqual([]);
    expect(languageWords('нетакогоязыка')).toEqual([]);
  });
});

describe('подсказки по префиксу', () => {
  it('пустой префикс ничего не даёт: попап не вылезает на каждом слове', () => {
    const index = indexOf(['value']);
    expect(buildCompletions(index, 'typescript', '')).toEqual([]);
  });

  it('короткий префикс: языковое слово впереди слов файла', () => {
    const index = indexOf(['formatRow formatRow']);
    const items = buildCompletions(index, 'typescript', 'f');
    // Набрано «f» — предложить `for` честнее, чем `formatRow`.
    expect(items[0]?.label).toBe('for');
    expect(labels(items)).toContain('formatRow');
  });

  it('длинный префикс: слова файла впереди языковых', () => {
    const index = indexOf(['forEachItem forEachItem forEachItem']);
    const items = buildCompletions(index, 'typescript', 'forE');
    expect(items[0]?.label).toBe('forEachItem');
  });

  it('слова документа получают пометку с частотой, языковые — пометку языка', () => {
    const index = indexOf(['myValue myValue myValueBox']);
    // Набранное целиком слово в подсказках не участвует, поэтому берём его часть.
    const doc = buildCompletions(index, 'typescript', 'myVa').find((item) => item.label === 'myValue');
    expect(doc?.kind).toBe('word');
    expect(doc?.detail).toBe('в файле: 2');

    const language = buildCompletions(index, 'typescript', 'va').find((item) => item.kind === 'language');
    expect(language?.label).toBe('var');
    expect(language?.detail).toBe('язык');
  });

  it('свои дополнения идут первыми', () => {
    const index = indexOf(['value']);
    const items = buildCompletions(index, 'typescript', 'v', { external: ['valueFromServer'] });
    // Сравниваем существенное: у подсказки ещё есть `positions` (подсветка совпадения).
    expect(items[0]).toMatchObject({ label: 'valueFromServer', kind: 'external', detail: 'предложено' });
  });

  it('совпадение по «горбам»: gT находит getTitle', () => {
    const index = indexOf(['const getTitle = () => {}']);
    const items = buildCompletions(index, 'typescript', 'gT');
    expect(labels(items)).toContain('getTitle');
    // Совпали именно «горбы» — их индексы и отдаём для подсветки.
    expect(items[0]?.positions).toEqual([0, 3]);
  });

  it('заглавная в набранном требует заглавной в имени', () => {
    const index = indexOf(['macOS macos']);
    const items = buildCompletions(index, 'typescript', 'MC');
    // `MC` — это `MyClass`-подобное совпадение: `macOS` его не удовлетворяет.
    expect(labels(items)).not.toContain('macOS');
  });

  it('лучшее совпадение — первым: точное начало обгоняет продолжение', () => {
    const index = indexOf(['format formatRow']);
    const items = buildCompletions(index, 'typescript', 'form');
    // `format` — короче, при равном начале оно и должно быть выше.
    expect(items[0]?.label).toBe('format');
  });

  it('исключённые слова не предлагаются', () => {
    const index = indexOf(['value other']);
    const items = buildCompletions(index, 'typescript', 'va', { exclude: new Set(['value']) });
    expect(labels(items)).not.toContain('value');
  });

  it('предел списка соблюдается', () => {
    const index = indexOf(Array.from({ length: 80 }, (_, i) => `item${i}`));
    expect(buildCompletions(index, 'typescript', 'it', { limit: 10 })).toHaveLength(10);
  });
});

describe('подсказки по вызову (Ctrl+Space)', () => {
  it('без префикса списки языка и файла чередуются', () => {
    const index = indexOf(['alpha alpha beta']);
    const items = allCompletions(index, 'typescript', { limit: 20 });
    const found = labels(items);
    // Список начинается словами языка...
    expect(found[0]).toBe('if');
    // ...но до имён из файла доходит, хотя слов языка много: они идут не подряд.
    expect(found).toContain('alpha');
    expect(found).toContain('beta');
    expect(found.indexOf('alpha')).toBeGreaterThan(5);
  });

  it('предел соблюдается и здесь', () => {
    const index = indexOf(['alpha beta gamma']);
    expect(allCompletions(index, 'typescript', { limit: 3 })).toHaveLength(3);
  });

  it('исключения и свои дополнения уважаются', () => {
    const index = indexOf(['alpha']);
    const items = allCompletions(index, 'typescript', { limit: 2, external: ['custom'], exclude: new Set(['break']) });
    expect(items[0]?.label).toBe('custom');
    expect(labels(items)).not.toContain('break');
  });

  it('сниппеты предлагаются по триггеру целиком, без префикса', () => {
    const index = indexOf(['alpha']);
    const items = allCompletions(index, 'typescript', {
      limit: 5,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: тело сниппета — разметка как есть
      snippets: [{ prefix: 'clg', body: 'console.log(${1})', description: 'console.log' }],
    });
    const snippet = items.find((item) => item.label === 'clg');
    expect(snippet?.kind).toBe('snippet');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: тело сниппета — разметка как есть
    expect(snippet?.snippet).toBe('console.log(${1})');
  });
});

describe('сниппеты в подсказках по префиксу', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: тело сниппета — разметка как есть
  const snippets = [{ prefix: 'clg', body: 'console.log(${1})', description: 'console.log' }];

  it('набранный триггер не исключается как «слово строки»', () => {
    // Слово под курсором — и есть триггер; сниппет всё равно должен найтись.
    const index = indexOf(['clg']);
    const items = buildCompletions(index, 'typescript', 'clg', { snippets, exclude: new Set(['clg']) });
    expect(labels(items)).toContain('clg');
  });

  it('идут раньше слов языка', () => {
    const index = indexOf(['cl']);
    const items = buildCompletions(index, 'typescript', 'cl', { snippets, exclude: new Set(['cl']) });
    expect(items[0]?.kind).toBe('snippet');
  });

  it('чужой префикс сниппет не показывает', () => {
    const index = indexOf(['cl']);
    const items = buildCompletions(index, 'typescript', 'zz', { snippets });
    expect(labels(items)).not.toContain('clg');
  });
});
