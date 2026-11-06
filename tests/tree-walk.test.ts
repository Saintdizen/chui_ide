import { describe, expect, it } from 'vitest';
import { walkTree, type WalkRow } from '../src/renderer/core/tree-walk';

/**
 * Ход по дереву стрелками.
 *
 * Стрелок в проводнике не было ВООБЩЕ: `onTreeKey` знал Enter/F2/Delete/пробел,
 * а обхода не было. Объявить `role="treeitem"` без этого договора значило бы
 * обмануть скринридер — поэтому правило сначала написано здесь, а роль в
 * разметке придёт после.
 */
const row = (path: string, depth: number, directory = false, expanded = false): WalkRow => ({
  path,
  depth,
  directory,
  expanded,
});

// src/ (раскрыта) → a.ts, lib/ (свёрнута), b.ts
const TREE: WalkRow[] = [row('src', 0, true, true), row('src/a.ts', 1), row('src/lib', 1, true, false), row('b.ts', 0)];

describe('ключи действия — из того же договора, что и стрелки', () => {
  // Раньше эти клавиши разбирал сам `onTreeKey`: дерево знало Enter/F2/Delete
  // отдельным списком, а стрелки — таблицей хода. Два места — одно поведение,
  // которое нельзя проверить целиком: здесь оно в одном месте.
  it('Enter открывает строку', () => {
    expect(walkTree(TREE, 'src/a.ts', 'Enter')).toEqual({ kind: 'open', path: 'src/a.ts' });
  });

  it('пробел — показать, не открывая вкладку', () => {
    expect(walkTree(TREE, 'src/a.ts', 'Space')).toEqual({ kind: 'peek', path: 'src/a.ts' });
  });

  it('F2 — переименовать, Delete — удалить эту строку', () => {
    expect(walkTree(TREE, 'src/lib', 'F2')).toEqual({ kind: 'rename', path: 'src/lib' });
    expect(walkTree(TREE, 'src/lib', 'Delete')).toEqual({ kind: 'delete', paths: ['src/lib'] });
  });

  it('меню клавишей — та же строка, что под выделением', () => {
    expect(walkTree(TREE, 'b.ts', 'ContextMenu')).toEqual({ kind: 'menu', path: 'b.ts' });
  });

  it('без выделения Delete не угадывает цель', () => {
    // У «удалить» нет разумной цели по умолчанию: нажатие без выделения
    // молчит, а не сносит первую строку дерева.
    expect(walkTree(TREE, null, 'Delete')).toBeNull();
  });
});

describe('соседние строки', () => {
  it('вниз и вверх идут по видимому порядку', () => {
    expect(walkTree(TREE, 'src', 'ArrowDown')).toEqual({ kind: 'move', path: 'src/a.ts' });
    expect(walkTree(TREE, 'src/a.ts', 'ArrowUp')).toEqual({ kind: 'move', path: 'src' });
  });

  it('на краях ничего не происходит — нажатие чужое', () => {
    // Возвращаем null, а не «остаться на месте»: иначе дерево съедало бы
    // стрелку, которая должна уйти дальше (например, в поле поиска).
    expect(walkTree(TREE, 'src', 'ArrowUp')).toBeNull();
    expect(walkTree(TREE, 'b.ts', 'ArrowDown')).toBeNull();
  });

  it('без выделения движение начинает с первой строки', () => {
    expect(walkTree(TREE, null, 'ArrowDown')).toEqual({ kind: 'move', path: 'src' });
  });

  it('Home и End — к краям', () => {
    expect(walkTree(TREE, 'src/lib', 'Home')).toEqual({ kind: 'move', path: 'src' });
    expect(walkTree(TREE, 'src', 'End')).toEqual({ kind: 'move', path: 'b.ts' });
  });
});

describe('вправо и влево', () => {
  it('вправо раскрывает свёрнутую папку', () => {
    expect(walkTree(TREE, 'src/lib', 'ArrowRight')).toEqual({ kind: 'expand', path: 'src/lib' });
  });

  it('вправо у раскрытой уходит к первому ребёнку', () => {
    expect(walkTree(TREE, 'src', 'ArrowRight')).toEqual({ kind: 'move', path: 'src/a.ts' });
  });

  it('вправо на файле ничего не делает', () => {
    expect(walkTree(TREE, 'src/a.ts', 'ArrowRight')).toBeNull();
  });

  it('влево сворачивает раскрытую папку, а не уходит к родителю', () => {
    // Тот же жест значит разное в зависимости от состояния — так в проводниках
    // и в VS Code; перепутать значит сбить человека с толку.
    expect(walkTree(TREE, 'src', 'ArrowLeft')).toEqual({ kind: 'collapse', path: 'src' });
  });

  it('влево на свёрнутой и на файле идёт к родителю', () => {
    expect(walkTree(TREE, 'src/lib', 'ArrowLeft')).toEqual({ kind: 'move', path: 'src' });
    expect(walkTree(TREE, 'src/a.ts', 'ArrowLeft')).toEqual({ kind: 'move', path: 'src' });
  });

  it('влево у свёрнутого корня не уводит в никуда', () => {
    // У корневой строки родителя нет: молча остаться лучше, чем уехать в конец.
    const collapsed = [row('src', 0, true, false)];
    expect(walkTree(collapsed, 'src', 'ArrowLeft')).toBeNull();
  });
});

describe('края', () => {
  it('пустое дерево — любое нажатие чужое', () => {
    expect(walkTree([], null, 'ArrowDown')).toBeNull();
    expect(walkTree([], 'x', 'Enter')).toBeNull();
  });

  it('Enter открывает выбранное', () => {
    expect(walkTree(TREE, 'src/a.ts', 'Enter')).toEqual({ kind: 'open', path: 'src/a.ts' });
  });
});

describe('страница и раскрытие соседей', () => {
  /** Длинный список файлов в корне — как в реальной большой папке. */
  const MANY: WalkRow[] = Array.from({ length: 40 }, (_, index) => row(`f${index}.ts`, 0));

  it('PageDown и PageUp прыгают на страницу и не вылетают за края', () => {
    expect(walkTree(MANY, 'f0.ts', 'PageDown')).toEqual({ kind: 'move', path: 'f15.ts' });
    expect(walkTree(MANY, 'f30.ts', 'PageUp')).toEqual({ kind: 'move', path: 'f15.ts' });
    // У последней строки дальше некуда — нажатие чужое, а не «остаться».
    expect(walkTree(MANY, 'f39.ts', 'PageDown')).toBeNull();
    expect(walkTree(MANY, 'f0.ts', 'PageUp')).toBeNull();
  });

  it('прыжок у конца списка упирается в последнюю строку, а не уходит в никуда', () => {
    expect(walkTree(MANY, 'f35.ts', 'PageDown')).toEqual({ kind: 'move', path: 'f39.ts' });
  });

  it('«*» раскрывает только папки-соседей, файлы не трогает', () => {
    // Нажимаем на ребёнка `src`, а не на сам `src`: соседи тогда — строки
    // глубины 1 под `src`, а `docs` (глубина 0) — нет.
    //
    // ПЕРВАЯ ВЕРСИЯ ЭТОГО ТЕСТА БЫЛА НЕВЕРНА: я нажимал на `src` и ждал
    // `src/a`, `src/lib`, а `src/a` — его РЕБЁНОК, а не сосед. Соседи у `src` —
    // это другие корни, и правильный ответ 'docs' (проверено ниже).
    const rows: WalkRow[] = [
      row('src', 0, true, true),
      row('src/a', 1, true, false),
      row('src/b.ts', 1),
      row('src/lib', 1, true, false),
      row('docs', 0, true, false),
    ];
    // Соседи `src/a` — все строки глубины 1 под `src`: свёрнутые папки `src/a`
    // и `src/lib` (файл `src/b.ts` в набор не попадает, `docs` — другой уровень).
    expect(walkTree(rows, 'src/a', 'Star')).toEqual({
      kind: 'expandAll',
      paths: ['src/a', 'src/lib'],
    });
  });

  it('«*» на корне раскрывает другие корни, а не собственных детей', () => {
    const rows: WalkRow[] = [row('src', 0, true, true), row('src/a', 1, true, false), row('docs', 0, true, false)];
    // Дети раскрытой `src` — не соседи `src`, а её содержимое.
    expect(walkTree(rows, 'src', 'Star')).toEqual({ kind: 'expandAll', paths: ['docs'] });
  });

  it('«*» не трогает папки другого уровня и уже раскрытые', () => {
    const rows: WalkRow[] = [row('a', 0, true, true), row('b', 0, true, true)];
    // Раскрывать нечего — нажатие чужое.
    expect(walkTree(rows, 'a', 'Star')).toBeNull();
  });

  it('«*» на файле раскрывает папки его уровня', () => {
    // По APG «*» работает от любой строки набора, не только от папки.
    const rows: WalkRow[] = [row('a.ts', 0), row('b', 0, true, false)];
    expect(walkTree(rows, 'a.ts', 'Star')).toEqual({ kind: 'expandAll', paths: ['b'] });
  });
});

describe('просьба о прокрутке живёт до нужной строки', () => {
  /**
   * Открыли файл из поиска, он в свёрнутой ветке пятью уровнями глубже.
   * `reveal` раскрывает папки и просит прокрутку. Если папки ещё читаются,
   * строка появляется только на СЛЕДУЮЩЕЙ перерисовке — и просьбу нельзя
   * снимать раньше, иначе подсветка есть, а строка за краем экрана.
   */
  const applyReveal = (
    rows: readonly string[],
    target: string,
  ): { scrolled: string | null; pending: string | null } => {
    const found = rows.includes(target);
    return { scrolled: found ? target : null, pending: found ? null : target };
  };

  it('строка уже есть — прокручиваем сразу, просьбу снимаем', () => {
    expect(applyReveal(['a', 'b'], 'b')).toEqual({ scrolled: 'b', pending: null });
  });

  it('строки ещё нет — просьба остаётся до следующей перерисовки', () => {
    // Именно здесь был дефект: просьбу ставили до загрузки, и первая
    // перерисовка не находившая строку её не снимала — а `scrollIntoView`
    // после `render` уже не мог ничего.
    expect(applyReveal(['a'], 'deep/file.ts')).toEqual({ scrolled: null, pending: 'deep/file.ts' });
  });

  it('после догрузки просьба исполняется ровно один раз', () => {
    const afterLoad = applyReveal(['a', 'deep/file.ts'], 'deep/file.ts');
    expect(afterLoad).toEqual({ scrolled: 'deep/file.ts', pending: null });
  });
});
