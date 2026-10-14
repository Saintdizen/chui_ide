import { describe, expect, it } from 'vitest';
import { formatDocsAnswer, isDocPath, rankDocChunks, splitDocChunks, type DocChunk } from '../src/shared/docs-index';

const chunk = (over: Partial<DocChunk>): DocChunk => ({
  path: 'README.md',
  heading: 'Установка',
  line: 10,
  text: '## Установка\nКак установить проект.',
  ...over,
});

describe('isDocPath', () => {
  it('документация по расширению', () => {
    expect(isDocPath('README.md')).toBe(true);
    expect(isDocPath('docs/guide.md')).toBe(true);
    expect(isDocPath('docs/guide.rst')).toBe(true);
    expect(isDocPath('notes.txt')).toBe(true);
  });

  it('документация по имени без расширения', () => {
    expect(isDocPath('README')).toBe(true);
    expect(isDocPath('docs/CHANGELOG')).toBe(true);
    expect(isDocPath('CONTRIBUTING')).toBe(true);
  });

  it('код и двоичные файлы в документацию не попадают', () => {
    expect(isDocPath('src/app.ts')).toBe(false);
    expect(isDocPath('readme.ts')).toBe(false);
    expect(isDocPath('docs/logo.png')).toBe(false);
    expect(isDocPath('package.json')).toBe(false);
  });
});

describe('splitDocChunks — markdown', () => {
  const text = '# Заголовок\n\nВступление.\n\n## Установка\n\nnpm install\n';

  it('режет по заголовкам и ведёт цепочку вложенности', () => {
    const chunks = splitDocChunks('README.md', text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ heading: 'Заголовок', line: 1 });
    expect(chunks[1]).toMatchObject({ heading: 'Заголовок > Установка', line: 5 });
  });

  it('текст раздела идёт вместе с заголовком', () => {
    const chunks = splitDocChunks('README.md', text);
    expect(chunks[0]?.text).toContain('Вступление.');
    expect(chunks[1]?.text).toContain('npm install');
  });

  it('снимает закрывающие решётки из названия', () => {
    const chunks = splitDocChunks('a.md', '## Установка ##\n\nтекст\n');
    expect(chunks[0]?.heading).toBe('Установка');
  });

  it('текст до первого заголовка — отдельный раздел без заголовка', () => {
    const chunks = splitDocChunks('a.md', 'Просто введение.\n\n# Раздел\n\nтело\n');
    expect(chunks[0]).toMatchObject({ heading: '', line: 1 });
    expect(chunks[1]?.heading).toBe('Раздел');
  });

  it('огромный раздел режется по абзацам', () => {
    const body = Array.from({ length: 40 }, (_, index) => `Абзац ${index}. ${'x'.repeat(120)}`).join('\n\n');
    const chunks = splitDocChunks('a.md', `# Большой\n\n${body}\n`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((item) => item.heading === 'Большой')).toBe(true);
  });
});

describe('splitDocChunks — rst и текст', () => {
  it('заголовок rst — строка под подчёркиванием', () => {
    const chunks = splitDocChunks('docs/guide.rst', 'Установка\n=========\n\nТекст.\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ heading: 'Установка', line: 1 });
    expect(chunks[0]?.text).toContain('Текст.');
  });

  it('текст без разметки делится на абзацы, без заголовков', () => {
    const chunks = splitDocChunks('notes.txt', 'Первый абзац.\n\nВторой абзац.\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ heading: '', line: 1 });
    expect(chunks[0]?.text).toContain('Первый абзац.');
    expect(chunks[0]?.text).toContain('Второй абзац.');
  });
});

describe('rankDocChunks', () => {
  it('заголовок весит больше текста', () => {
    const hits = rankDocChunks(
      [
        chunk({ path: 'a.md', heading: 'Установка', line: 10, text: 'Как установить: npm install' }),
        chunk({ path: 'b.md', heading: 'install guide', line: 1, text: 'прочее' }),
      ],
      'install',
      10,
    );
    expect(hits.map((hit) => hit.path)).toEqual(['b.md', 'a.md']);
  });

  it('раздел без совпадений не попадает в ответ', () => {
    const hits = rankDocChunks([chunk({ heading: 'Установка', text: 'ничего общего' })], 'деплой', 10);
    expect(hits).toEqual([]);
  });

  it('дубли по пути и строке схлопываются', () => {
    const hits = rankDocChunks([chunk({ line: 5 }), chunk({ line: 5 })], 'установка', 10);
    expect(hits).toHaveLength(1);
  });

  it('предел соблюдается, пустой запрос ничего не находит', () => {
    const many = [chunk({ line: 1 }), chunk({ line: 2 }), chunk({ line: 3 })];
    expect(rankDocChunks(many, 'установка', 2)).toHaveLength(2);
    expect(rankDocChunks(many, '   ', 10)).toEqual([]);
  });
});

describe('formatDocsAnswer', () => {
  it('документации нет — так и говорим', () => {
    const { summary, detail } = formatDocsAnswer({ query: 'q', hits: [], files: 0, chunks: 0 });
    expect(summary).toContain('документации в проекте нет');
    expect(detail).toContain('не нашлось');
  });

  it('файлы есть, совпадений нет — честно про причину', () => {
    const { detail } = formatDocsAnswer({ query: 'q', hits: [], files: 2, chunks: 9 });
    expect(detail).toContain('Просмотрено файлов документации: 2, разделов 9');
  });

  it('разделы показываются путём, заголовком и выдержкой', () => {
    const { summary, detail } = formatDocsAnswer(
      {
        query: 'установка',
        hits: [{ path: '/proj/README.md', heading: 'Установка', line: 10, snippet: 'npm install', score: 15 }],
        files: 1,
        chunks: 3,
      },
      (path) => path.replace('/proj/', ''),
    );
    expect(summary).toBe('«установка»: разделов 1 в документации');
    expect(detail).toContain('README.md:10 — «Установка»');
    expect(detail).toContain('npm install');
  });
});
