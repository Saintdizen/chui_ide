import { describe, expect, it } from 'vitest';
import { ancestorsAt, breadcrumbChanged, type CrumbRow } from '../src/renderer/core/tree-crumbs';

/**
 * Липкая шапка дерева (область «Проводник», п. «Где я в дереве»).
 *
 * Дыра была не в разметке: дерево виртуализировано, и в монорепо папки над
 * окном давно уехали за край. По одним файлам не понять, где ты.
 *
 * Главное, что проверяем: цепочка берётся по ГЛУБИНЕ ОКНА, а не по заголовку
 * группы, и не врёт, когда строки уровня не нарисованы.
 */
// `dir` по умолчанию собирается из имён предков — ровно так, как его отдаёт
// дерево проводника: путь строки от корня проекта, без её собственного имени.
const row = (depth: number, name?: string, dir?: string): CrumbRow => ({ depth, ...(name ? { name } : {}), ...(dir ? { dir } : {}) });
const inDir = (depth: number, name: string, ...parents: string[]): CrumbRow => row(depth, name, ['/repo', ...parents].join('/'));

const ROOT = '/repo';

describe('ancestorsAt: где стоит первая видимая строка', () => {
  it('пустой список — пустая шапка', () => {
    expect(ancestorsAt([], 0, ROOT)).toEqual([]);
  });

  it('строка вне списка — пустая шапка', () => {
    expect(ancestorsAt([row(0, 'src')], 5, ROOT)).toEqual([]);
  });

  it('верхняя строка — предков нет', () => {
    const rows = [row(0, 'src'), row(1, 'main.ts')];
    expect(ancestorsAt(rows, 0, ROOT)).toEqual([]);
  });

  it('берёт имена уровней у ближайших строк (корень проекта не в счёт)', () => {
    // Контракт `depth`: это глубина ПАПКИ строки. `rpc.ts` лежит в `core` — значит `depth: 1`.
    // Глубина 2 была бы при листе в `core/sub`. Поэтому ждём только `core`.
    const rows = [row(0, 'src'), row(1, 'core'), inDir(1, 'rpc.ts', 'core'), row(1, 'ui')];
    expect(ancestorsAt(rows, 2, ROOT).map((item) => item.label)).toEqual(['core']);
  });

  it('пути собираются от корня проекта', () => {
    // `dir` у листа — папка САМА (`/repo/core` при глубине 2), а не «предки без
    // своего имени»: так его формирует дерево (`row.dir`) и так же понимает
    // `parentNameOf`. Старый вариант писал `/repo/src/core` для глубины 2 —
    // раскладка чужая, и она маскировала ошибку на 3000 файлах.
    const rows = [row(0, 'src'), row(1, 'core'), inDir(1, 'rpc.ts', 'core')];
    expect(ancestorsAt(rows, 2, ROOT).map((item) => item.path)).toEqual(['/repo/core']);
  });

  it('лист в раскрытой папке называет её, а не соседа', () => {
    // Ровно то, что давало пустую шапку в пробе: 3000 файлов в одной папке —
    // строка папки давно уехала вверх, в окне одни листы, и `depth: 1` у САМОЙ
    // папки, а листы в ней — `depth: 2` с `dir` = папка. Старый код брал имя
    // у соседа (`nearestAbove`) и подписывал шапку именем ФАЙЛА.
    const files = Array.from({ length: 100 }, (_, i) => inDir(2, `f${i}.txt`, 'many'));
    const crumbs = ancestorsAt(files, 99, ROOT);
    expect(crumbs.map((item) => item.label)).toEqual(['many']);
    expect(crumbs[0]!.path).toBe('/repo/many');
  });

  it('глубина окна 3 — предков три, даже если соседей уровней нет', () => {
    // Окно поймало только глубокие листы: строк уровней 1 и 2 в списке нет.
    const rows = [inDir(3, 'deep.ts', 'a', 'b')];
    expect(ancestorsAt(rows, 0, ROOT).map((item) => item.label)).toEqual(['a', 'b']);
  });

  it('имя уровня берётся из dir, когда строка уровня не нарисована', () => {
    const rows = [row(0, 'src'), inDir(1, 'x.ts', 'src', 'core')];
    // Уровень 1 виден строкой `src`, уровень 2 — только каталогом строки.
    // Сам файл `x.ts` предком не считается: он — содержимое папки, а не папка.
    expect(ancestorsAt(rows, 1, ROOT).map((item) => item.label)).toEqual(['src']);
  });

  it('не абсолютный путь не ломает разбор', () => {
    const rows = [row(0, 'src'), row(2, 'x.ts', 'не-путь')];
    expect(() => ancestorsAt(rows, 1, ROOT)).not.toThrow();
  });

  it('рыхлые строки без имени пропускаются', () => {
    const rows = [row(0, undefined), row(1, 'core'), inDir(2, 'rpc.ts', 'core')];
    expect(ancestorsAt(rows, 2, ROOT).map((item) => item.label)).toEqual(['core']);
  });
});

describe('breadcrumbChanged: перерисовка только по делу', () => {
  const crumb = (path: string, label: string) => ({ path, label, depth: 1 });

  it('первая сборка — всегда менять', () => {
    expect(breadcrumbChanged([], [crumb('/repo/src', 'src')])).toBe(true);
  });

  it('то же самое — не трогать разметку', () => {
    const list = [crumb('/repo/src', 'src')];
    expect(breadcrumbChanged(list, [crumb('/repo/src', 'src')])).toBe(false);
  });

  it('сменился путь — менять', () => {
    expect(breadcrumbChanged([crumb('/repo/src', 'src')], [crumb('/repo/lib', 'lib')])).toBe(true);
  });

  it('разная длина — менять', () => {
    const one = [crumb('/repo/src', 'src')];
    expect(breadcrumbChanged(one, [...one, crumb('/repo/src/core', 'core')])).toBe(true);
  });
});
