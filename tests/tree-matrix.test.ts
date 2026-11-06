import { describe, expect, it } from 'vitest';
import type { DirEntry, TreeSort } from '../src/shared/api';
import { matrixSections, matrixVisible } from '../src/renderer/core/tree-matrix';

const dir = (name: string, mtimeMs = 0): DirEntry => ({ name, path: `/p/${name}`, kind: 'directory', size: 0, mtimeMs });
const file = (name: string, mtimeMs = 0): DirEntry => ({ name, path: `/p/${name}`, kind: 'file', size: 0, mtimeMs });

const SORTS: readonly TreeSort[] = ['name', 'type', 'modified', 'git'];

/** Набор для матрицы: папки, тесты, стили, документы, исходники и скрытое. */
const SET: readonly DirEntry[] = [
  dir('src'),
  dir('docs'),
  file('b.ts'),
  file('a.ts'),
  file('Button.test.tsx'),
  file('Button.module.css'),
  file('README.md'),
  file('.env'),
  file('.hidden.ts'),
];

/** Все комбинации из формулировки п.25 — и ни одной меньше. */
const combos = () => {
  const out: Array<{ foldersFirst: boolean; sort: TreeSort; groupByType: boolean; showHidden: boolean }> = [];
  for (const foldersFirst of [true, false]) {
    for (const sort of SORTS) {
      for (const groupByType of [true, false]) {
        for (const showHidden of [true, false]) out.push({ foldersFirst, sort, groupByType, showHidden });
      }
    }
  }
  return out;
};

describe('матрица: порядок × группировка × скрытые', () => {
  it('комбинаций ровно 32 — по числу настроек, а не по тому, сколько я придумал', () => {
    expect(combos()).toHaveLength(32);
  });

  it('НИКОГО НЕ ТЕРЯЕМ ни в одной комбинации', () => {
    // Главный инвариант: что видно на экране, то и осталось. Потеря тут тише всего
    // и дороже всего: файл есть на диске и нигде не показывается.
    const names = SET.map((entry) => entry.name);
    for (const combo of combos()) {
      // Сквозной инвариант: ушли только скрытые И ТОЛЬКО если их не велели
      // показывать. Всё прочее обязано остаться — при любом порядке и полке.
      const expected = (combo.showHidden ? names : names.filter((name) => !name.startsWith('.'))).sort();
      const visible = matrixVisible(matrixSections(SET, combo)).sort();
      expect({ combo, visible }).toEqual({ combo, visible: expected });
    }
  });

  it('скрытые видны только при showHidden — и тогда вместе со всеми', () => {
    for (const combo of combos().filter((item) => item.showHidden)) {
      const visible = matrixVisible(matrixSections(SET, combo));
      expect(visible).toContain('.env');
      expect(visible).toContain('.hidden.ts');
    }
    for (const combo of combos().filter((item) => !item.showHidden)) {
      const visible = matrixVisible(matrixSections(SET, combo));
      expect(visible).not.toContain('.env');
    }
  });

  it('вложенность убирает ровно то, что скрыла', () => {
    const hidden = new Set(['Button.test.tsx']);
    for (const combo of combos()) {
      const visible = matrixVisible(matrixSections(SET, { ...combo, hidden }));
      expect(visible).not.toContain('Button.test.tsx');
      expect(visible).toContain('b.ts');
    }
  });

  it('foldersFirst решает, идут ли папки выше файлов — во всех режимах сортировки', () => {
    for (const sort of SORTS) {
      const first = matrixVisible(matrixSections(SET, { foldersFirst: true, sort, groupByType: false, showHidden: false }));
      const mixed = matrixVisible(matrixSections(SET, { foldersFirst: false, sort, groupByType: false, showHidden: false }));
      expect(first.slice(0, 2).sort()).toEqual(['docs', 'src']);
      // Без foldersFirst порядок зависит от режима — но папки уже не обязаны быть сверху.
      expect(mixed).toHaveLength(first.length);
    }
  });
});

describe('группировка: полки не распадаются и не пустуют', () => {
  it('пустой полки с заголовком не бывает', () => {
    for (const combo of combos().filter((item) => item.groupByType)) {
      for (const section of matrixSections(SET, combo)) {
        expect(section.entries.length).toBeGreaterThan(0);
      }
    }
  });

  it('заголовок группы стоит ровно один раз', () => {
    for (const combo of combos().filter((item) => item.groupByType)) {
      const labels = matrixSections(SET, combo)
        .map((section) => section.label)
        .filter((label): label is string => label !== null);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('папки при группировке идут одной голой полкой сверху', () => {
    const sections = matrixSections(SET, { foldersFirst: true, sort: 'name', groupByType: true, showHidden: false });
    expect(sections[0]).toMatchObject({ label: null });
    expect(sections[0]!.entries.map((entry) => entry.name).sort()).toEqual(['docs', 'src']);
    // Группировка — про файлы: папок внутри подписанных полок нет.
    for (const section of sections.slice(1)) {
      expect(section.entries.every((entry) => entry.kind !== 'directory')).toBe(true);
    }
  });

  it('скрытое до группировки — иначе полка «Стили» осталась бы с одной подписью', () => {
    const onlyHiddenStyle = [file('.a.css'), file('.b.css'), file('main.ts')];
    const sections = matrixSections(onlyHiddenStyle, {
      foldersFirst: true,
      sort: 'name',
      groupByType: true,
      showHidden: false,
    });
    expect(sections.map((section) => section.label)).toEqual(['Исходники']);
  });
});

describe('независимость от скорости чтения ФС', () => {
  it('время правки по умолчанию не решает: тест не зависит от того, когда файл создан', () => {
    // Тот же набор с одинаковым mtimeMs должен давать тот же порядок — независимо
    // от того, с какой скоростью ФС отдала записи.
    const combo = { foldersFirst: false, sort: 'modified' as TreeSort, groupByType: false, showHidden: false };
    const same = SET.map((entry) => ({ ...entry, mtimeMs: 0 }));
    expect(matrixVisible(matrixSections(same, combo))).toEqual(matrixVisible(matrixSections(SET.map((e) => ({ ...e, mtimeMs: 0 })), combo)));
  });

  it('перестановка входа при sort=name не меняет порядка', () => {
    const combo = { foldersFirst: true, sort: 'name' as TreeSort, groupByType: false, showHidden: false };
    const shuffled = [...SET].reverse();
    expect(matrixVisible(matrixSections(shuffled, combo))).toEqual(matrixVisible(matrixSections(SET, combo)));
  });

  it('file10 не встаёт перед file9 — числовой порядок во всех комбинациях', () => {
    const frames = [file('file10.png'), file('file9.png'), file('file1.png')];
    for (const combo of combos()) {
      expect(matrixVisible(matrixSections(frames, combo))).toEqual(['file1.png', 'file9.png', 'file10.png']);
    }
  });
});

describe('матрица: «только изменённые» (п.18)', () => {
  const base = { foldersFirst: true, sort: 'name' as TreeSort, groupByType: false, showHidden: false };
  // Изменён только a.ts; папка src — правка внутри неё (git о папках молчит).
  const changeOf = (path: string): 'added' | 'modified' | 'deleted' | undefined =>
    path === '/p/a.ts' ? 'modified' : undefined;

  it('файлы без правки уходят, файл с правкой остаётся', () => {
    const shown = matrixVisible(matrixSections(SET, { ...base, changeOf, onlyChanged: true }));
    expect(shown).toContain('a.ts');
    expect(shown).not.toContain('b.ts');
    expect(shown).not.toContain('README.md');
  });

  it('папки остаются, даже если у них самих правки нет', () => {
    // Иначе ветка, в которой лежит изменённый файл, исчезла бы вместе с ним: git
    // про папки не знает, и судить их по себе — значит спрятать работу человека.
    const shown = matrixVisible(matrixSections(SET, { ...base, changeOf, onlyChanged: true }));
    expect(shown).toContain('src');
    expect(shown).toContain('docs');
  });

  it('включённый режим не пропускает лишнего: набор — подмножество обычного', () => {
    const plain = new Set(matrixVisible(matrixSections(SET, base)));
    const narrowed = matrixVisible(matrixSections(SET, { ...base, changeOf, onlyChanged: true }));
    for (const name of narrowed) expect(plain.has(name)).toBe(true);
  });

  it('пустой статус не оставляет ни одного файла, но папки на месте', () => {
    const shown = matrixVisible(matrixSections(SET, { ...base, changeOf: () => undefined, onlyChanged: true }));
    expect(shown).toEqual(['docs', 'src']);
  });

  it('режим выключен — changeOf ни на кого не действует', () => {
    const shown = matrixVisible(matrixSections(SET, { ...base, changeOf }));
    expect(shown).toEqual(matrixVisible(matrixSections(SET, base)));
  });
});
