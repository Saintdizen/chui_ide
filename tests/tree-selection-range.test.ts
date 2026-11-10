import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clickSelection, EMPTY_SELECTION } from '../src/renderer/core/tree-selection';

/**
 * Выделение диапазона с клавиатуры (шаг `Shift+↑/↓` в дереве проекта).
 *
 * Правило «от якоря до курсора» уже жило в `core/tree-selection.ts` — для мыши
 * (`Shift+клик`). С клавиатуры в него не было входа: стрелки шли через
 * `core/tree-walk.ts`, а тот про модификатор не знает и знать не должен — он решает,
 * куда ведёт клавиша, а не как ложится выделение. Дыра была в отсутствии входа, а не
 * в правиле, поэтому здесь проверяется и правило, и то, что вид его действительно
 * зовёт: связка без проверки отсохнет тихо.
 */

const ORDER = ['/a', '/a/1', '/a/2', '/a/3', '/b'];

/** Диапазон от якоря до `path` — тот же вызов, что делает вид. */
function drag(anchor: string | null, path: string) {
  const start = anchor === null ? EMPTY_SELECTION : { paths: [anchor], anchor };
  return clickSelection(start, ORDER, path, 'range');
}

describe('диапазон от якоря до курсора', () => {
  it('вниз берёт строки включительно', () => {
    const range = drag('/a/1', '/a/3');
    expect(range.paths).toEqual(['/a/1', '/a/2', '/a/3']);
  });

  it('вверх берёт тот же набор — порядок не зависит от направления', () => {
    expect(drag('/a/3', '/a/1').paths).toEqual(['/a/1', '/a/2', '/a/3']);
  });

  it('якорь остаётся на месте — второй шаг тянет от него же', () => {
    // Это и есть смысл якоря: Shift+↓, ещё Shift+↑ возвращает выделение
    // к одной строке, а не переносит точку отсчёта.
    const first = drag('/a/2', '/a/3');
    expect(first.anchor).toBe('/a/2');
    const back = clickSelection(first, ORDER, '/a/2', 'range');
    expect(back.paths).toEqual(['/a/2']);
  });

  it('якорь вне списка не теряет строку под курсором', () => {
    // Файл мог исчезнуть из дерева между нажатиями: выделение не должно
    // схлопнуться в пустоту без движения.
    const range = drag('/gone', '/b');
    expect(range).toEqual({ paths: ['/b'], anchor: '/b' });
  });
});

describe('вид действительно зовёт диапазон по `Shift+стрелке`', () => {
  const EXPLORER = readFileSync(resolve(process.cwd(), 'src/renderer/ui/explorer.ts'), 'utf8');

  it("есть ветка `Shift+↑/↓`, и она доходит до `clickSelection(..., 'range')`", () => {
    expect(EXPLORER).toMatch(/if \(event\.shiftKey && \(walkKey === 'ArrowUp' \|\| walkKey === 'ArrowDown'\)\)/);
    expect(EXPLORER).toMatch(/clickSelection\([\s\S]{0,200}'range'/);
  });

  it('ветка стоит ДО обычного хода — иначе `Shift` терялся бы', () => {
    // Порядок важен: `WALK_KEYS` разобрал бы Shift+стрелку как простой ход.
    const shiftAt = EXPLORER.search(/if \(event\.shiftKey && \(walkKey === 'ArrowUp'/);
    const walkAt = EXPLORER.search(/if \(WALK_KEYS\.has\(walkKey\)\) \{/);
    expect(shiftAt).toBeGreaterThan(0);
    expect(walkAt).toBeGreaterThan(shiftAt);
  });

  it('курсор после протяжки двигается — без этого диапазон не вырастет', () => {
    expect(EXPLORER).toMatch(/selected = action\.path;[\s\S]{0,40}paint\(\);/);
  });
});
