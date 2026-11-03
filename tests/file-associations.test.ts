import { describe, expect, it } from 'vitest';
import {
  fileAssociationsToText,
  languageFromAssociations,
  normalizeFileAssociations,
} from '../src/shared/associations';

describe('normalizeFileAssociations', () => {
  it('строка из формы: «*.proto = proto»', () => {
    expect(normalizeFileAssociations('*.proto = proto\nJakefile = make')).toEqual([
      { pattern: '*.proto', language: 'proto' },
      { pattern: 'Jakefile', language: 'make' },
    ]);
  });

  it('двоеточие тоже годится, комментарий и пустые строки пропускаются', () => {
    expect(normalizeFileAssociations('# свои\n\n*.tpl: html # шаблон')).toEqual([
      { pattern: '*.tpl', language: 'html' },
    ]);
  });

  it('массив объектов — как в settings.json; половина правила не считается', () => {
    expect(
      normalizeFileAssociations([
        { pattern: '*.proto', language: 'proto' },
        { pattern: '*.x', language: '  ' },
        { language: 'go' },
        null,
      ]),
    ).toEqual([{ pattern: '*.proto', language: 'proto' }]);
  });

  it('повтор правила не копится', () => {
    expect(normalizeFileAssociations('*.proto = proto\n*.proto = proto')).toHaveLength(1);
  });
});

describe('languageFromAssociations', () => {
  const list = normalizeFileAssociations('*.html = html\n*.tpl.html = html+liquid\nJakefile = make');

  it('шаблон по имени файла, а не по пути', () => {
    expect(languageFromAssociations('/p/src/a.proto', normalizeFileAssociations('*.proto = proto'))).toBe('proto');
  });

  it('частное правило сильнее общего, если стоит ниже', () => {
    expect(languageFromAssociations('/p/page.tpl.html', list)).toBe('html+liquid');
    expect(languageFromAssociations('/p/page.html', list)).toBe('html');
  });

  it('точное имя без звёздочки', () => {
    expect(languageFromAssociations('/p/Jakefile', list)).toBe('make');
    expect(languageFromAssociations('/p/jakefile', list)).toBe('make');
  });

  it('ничего не подошло — null, решает таблица языков', () => {
    expect(languageFromAssociations('/p/a.ts', list)).toBeNull();
  });
});

describe('fileAssociationsToText', () => {
  it('обратно в строки формы', () => {
    const list = normalizeFileAssociations('*.proto = proto');
    expect(fileAssociationsToText(list)).toBe('*.proto = proto');
  });
});

describe('ассоциации в реестре языков', () => {
  it('своё правило сильнее таблицы, и оно снимается', async () => {
    const { languageFromPath, languageInfoForPath, setFileAssociations } = await import(
      '../src/shared/languages'
    );
    const own = normalizeFileAssociations('*.proto = proto\nJakefile = make');
    setFileAssociations(own);
    expect(languageFromPath('/p/api.proto')).toBe('proto');
    expect(languageInfoForPath('/p/api.proto')?.id).toBe('proto');
    expect(languageFromPath('/p/Jakefile')).toBe('make');
    // Файл с обычным расширением ассоциации не трогают.
    expect(languageFromPath('/p/a.ts')).toBe('typescript');
    setFileAssociations([]);
    expect(languageFromPath('/p/api.proto')).not.toBe('proto');
  });
});
