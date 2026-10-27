import { describe, expect, it } from 'vitest';
import type { FileSymbol } from '../src/shared/lsp-symbols';
import {
  ancestorsOf,
  basesByLine,
  inheritedMembers,
  isIndexedLanguage,
  membersOf,
  queryIndex,
  sanitizeIndexPayload,
  symbolIndexChip,
  toIndexDecls,
  INDEX_FORMAT,
  EMPTY_INDEX_STATUS,
  type IndexedFile,
} from '../src/shared/symbol-index';

/**
 * Карта символов: то, по чему поиск отвечает без языкового сервера.
 *
 * Проверяем три вещи, за которыми карту и заводили: объявления собираются из скелета
 * с сохранением вложенности, поиск ставит точное совпадение выше вхождения, а
 * наследование собирает своё и родительское без повторов. Плюс — что испорченный кэш
 * на диске не притворяется картой.
 */

const file = (path: string, decls: IndexedFile['decls']): IndexedFile => ({
  path,
  language: 'python',
  size: 10,
  mtime: 1000,
  decls,
  origin: 'project',
  package: null,
});

/** Скелет, каким его отдаёт сервер: класс с методами и функция на верхнем уровне. */
const skeleton: FileSymbol[] = [
  {
    name: 'Base',
    kind: 'класс',
    line: 3,
    endLine: 9,
    children: [
      { name: 'run', kind: 'метод', line: 5, endLine: 7, children: [] },
      { name: 'name', kind: 'поле', line: 8, endLine: 8, children: [] },
    ],
  },
  { name: 'helper', kind: 'функция', line: 12, endLine: 14, children: [] },
];

describe('toIndexDecls', () => {
  it('раскладывает скелет в объявления и помнит объемлющее', () => {
    const decls = toIndexDecls(skeleton);

    expect(decls.map((decl) => `${decl.container ?? '-'}:${decl.name}`)).toEqual([
      '-:Base',
      'Base:run',
      'Base:name',
      '-:helper',
    ]);
  });

  it('предков спрашивает по номеру строки объявления', () => {
    const decls = toIndexDecls(skeleton, (line) => (line === 3 ? ['Base'] : []));
    expect(decls[0]?.bases).toEqual(['Base']);
    // У метода предков не бывает, даже если сервер что-то прислал.
    expect(decls[1]?.bases).toEqual([]);
  });

  it('конец объявления не бывает раньше начала', () => {
    const broken: FileSymbol[] = [{ name: 'f', kind: 'функция', line: 7, endLine: 0, children: [] }];
    expect(toIndexDecls(broken)[0]?.endLine).toBe(7);
  });
});

describe('basesByLine', () => {
  it('Python: класс с родителями в скобках', () => {
    const text = 'class Parser(Base, mod.Mixin):\n    pass\n';
    expect([...basesByLine(text, 'python')]).toEqual([[1, ['Base', 'Mixin']]]);
  });

  it('Python: metaclass и распаковка — не родители', () => {
    // Правило общее с `workspace.findInheritance`: аргумент со значением (metaclass=)
    // и распаковка (*bases) предками не считаются.
    expect(basesByLine('class Meta(*bases, Other):\n    pass\n', 'python').get(1)).toEqual(['Other']);
    expect(basesByLine('class Meta(metaclass=ABCMeta):\n    pass\n', 'python').size).toBe(0);
  });

  it('TypeScript: extends и implements у класса, extends у интерфейса', () => {
    const text = 'export class A extends Base<T> implements Runnable, Closeable {\n}\n';
    const iface = 'interface B extends One, Two {\n}\n';

    expect(basesByLine(text, 'typescript').get(1)).toEqual(['Base', 'Runnable', 'Closeable']);
    expect(basesByLine(iface, 'typescript').get(1)).toEqual(['One', 'Two']);
  });

  it('язык без разбора наследования даёт пустую карту строк', () => {
    expect(basesByLine('class A(B):', 'css').size).toBe(0);
  });
});

describe('queryIndex', () => {
  const files = [
    file('src/parser.py', [
      { name: 'Parser', kind: 'класс', line: 3, endLine: 9, container: null, bases: [] },
      { name: 'parse_file', kind: 'функция', line: 12, endLine: 14, container: null, bases: [] },
    ]),
    file('src/helpers.py', [{ name: 'make_parser', kind: 'функция', line: 1, endLine: 4, container: null, bases: [] }]),
  ];

  it('точное совпадение выше вхождения и начала имени', () => {
    expect(queryIndex(files, 'parser').map((hit) => hit.name)).toEqual(['Parser', 'make_parser']);
  });

  it('находит по части имени и не учитывает регистр', () => {
    expect(queryIndex(files, 'PARSE').map((hit) => hit.name)).toEqual(['Parser', 'parse_file', 'make_parser']);
  });

  it('пустой запрос не ищет ничего: иначе это был бы список всего проекта', () => {
    expect(queryIndex(files, '   ')).toEqual([]);
  });

  it('отдаёт путь и строку — по ним открывается объявление', () => {
    const [hit] = queryIndex(files, 'Parser');
    expect(hit).toMatchObject({ name: 'Parser', path: 'src/parser.py', line: 3, column: 1, kind: 'класс' });
  });

  it('предел соблюдается', () => {
    expect(queryIndex(files, 'a', 1)).toHaveLength(1);
  });
});

describe('наследование по карте', () => {
  const files = [
    file('src/base.py', [
      { name: 'Base', kind: 'класс', line: 1, endLine: 20, container: null, bases: ['Root'] },
      { name: 'run', kind: 'метод', line: 3, endLine: 5, container: 'Base', bases: [] },
      { name: 'name', kind: 'поле', line: 6, endLine: 6, container: 'Base', bases: [] },
    ]),
    file('src/root.py', [
      { name: 'Root', kind: 'класс', line: 1, endLine: 30, container: null, bases: [] },
      { name: 'run', kind: 'метод', line: 2, endLine: 4, container: 'Root', bases: [] },
      { name: 'reset', kind: 'метод', line: 5, endLine: 7, container: 'Root', bases: [] },
    ]),
    file('src/parser.py', [
      { name: 'Parser', kind: 'класс', line: 1, endLine: 10, container: null, bases: ['Base'] },
      { name: 'run', kind: 'метод', line: 2, endLine: 4, container: 'Parser', bases: [] },
    ]),
  ];

  it('предки идут цепочкой от ближнего к дальнему', () => {
    expect(ancestorsOf(files, 'Parser')).toEqual(['Base', 'Root']);
  });

  it('круг в наследовании обрывается, а не висит', () => {
    const looped = [
      file('a.py', [{ name: 'A', kind: 'класс', line: 1, endLine: 2, container: null, bases: ['B'] }]),
      file('b.py', [{ name: 'B', kind: 'класс', line: 1, endLine: 2, container: null, bases: ['A'] }]),
    ];
    expect(ancestorsOf(looped, 'A')).toEqual(['B']);
  });

  it('своё объявление перекрывает унаследованное, предок даёт недостающее', () => {
    const members = inheritedMembers(files, 'Parser');

    expect(members.map((member) => `${member.from}:${member.name}`)).toEqual(['Parser:run', 'Base:name', 'Root:reset']);
  });

  it('в объявлениях самого типа — только его собственные', () => {
    expect(membersOf(files, 'Base').map((member) => member.name)).toEqual(['run', 'name']);
  });

  it('у незнакомого типа ничего не выдумывается', () => {
    expect(inheritedMembers(files, 'Nope')).toEqual([]);
    expect(ancestorsOf(files, 'Nope')).toEqual([]);
  });
});

describe('кэш карты', () => {
  it('читает запись своей версии', () => {
    const raw = { version: INDEX_FORMAT, files: [file('a.py', [])] };
    expect(sanitizeIndexPayload(raw)).toHaveLength(1);
  });

  it('запись прежней версии и мусор — пустая карта', () => {
    expect(sanitizeIndexPayload({ version: INDEX_FORMAT + 1, files: [file('a.py', [])] })).toEqual([]);
    expect(sanitizeIndexPayload({ files: 'нет' })).toEqual([]);
    expect(sanitizeIndexPayload(null)).toEqual([]);
  });

  it('битое объявление не ломает остальные', () => {
    const raw = {
      version: INDEX_FORMAT,
      files: [
        {
          path: 'a.py',
          size: 1,
          mtime: 2,
          decls: [
            { name: '', line: 0 },
            { name: 'ok', line: 4 },
          ],
        },
        { path: '', size: 1, mtime: 2, decls: [] },
      ],
    };
    const [parsed] = sanitizeIndexPayload(raw);
    expect(parsed?.decls.map((decl) => decl.name)).toEqual(['ok']);
  });

  it('карта собирается только для Python и Node', () => {
    expect(isIndexedLanguage('python')).toBe(true);
    expect(isIndexedLanguage('typescript')).toBe(true);
    expect(isIndexedLanguage('javascript')).toBe(true);
    expect(isIndexedLanguage('css')).toBe(false);
    expect(isIndexedLanguage(null)).toBe(false);
  });
});

describe('виджет карты в строке состояния', () => {
  it('пока карта собирается — видно, сколько уже разобрано', () => {
    const chip = symbolIndexChip({ ...EMPTY_INDEX_STATUS, phase: 'warming', files: 812, decls: 4000 });
    expect(chip?.text).toBe('Символы: 812…');
    expect(chip?.title).toContain('812 файлов');
  });

  it('готовая карта молчит: это фон, а не событие', () => {
    expect(symbolIndexChip({ ...EMPTY_INDEX_STATUS, phase: 'ready', files: 812 })).toBeNull();
    expect(symbolIndexChip(EMPTY_INDEX_STATUS)).toBeNull();
  });

  it('зависимости и пропуски названы в подсказке', () => {
    const chip = symbolIndexChip({
      ...EMPTY_INDEX_STATUS,
      phase: 'warming',
      files: 2,
      dependencyFiles: 1,
      skipped: 3,
    });
    // 2 файла, а не 2 «файлов»: склонение считается по числу.
    expect(chip?.title).toContain('2 файла');
    expect(chip?.title).toContain('1 из зависимостей');
    expect(chip?.title).toContain('3 пропущено');
  });
});
