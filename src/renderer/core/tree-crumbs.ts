import { separatorOf, splitPath } from '../../shared/paths';

/**
 * Липкая шапка дерева: в какой папке я сейчас.
 *
 * Дерево виртуальное — в DOM живёт только окно прокрутки, и по первой видимой
 * строке не видно, ЧЕЙ она (соседние папки сливаются в сплошной поток листьев).
 * Шапка отвечает на это одним взглядом.
 */

/** Одна ступень шапки: имя, полный путь и уровень в дереве (0 — корень). */
export interface Breadcrumb {
  readonly label: string;
  readonly path: string;
  readonly depth: number;
}

/** Строка окна в том виде, в каком шапке нужны её координаты. */
export interface CrumbRow {
  readonly depth: number;
  readonly name?: string;
  /** Каталог строки БЕЗ её собственного имени. */
  readonly dir?: string;
}

/**
 * Предки строки `index` — ступени шапки сверху вниз.
 *
 * Проход один: идём от окна вверх и собираем ближайшую строку каждого уровня.
 * Обрыв в глубине (папку свернули, окно поймало только листья) тем же проходом
 * и лечится — предком уровня остаётся последняя строка этого уровня.
 *
 * Цель в шапку НЕ идёт: она сама строка, на которой стоит курсор. Предки — это
 * уровни ВЫШЕ неё (`1 .. depth-1`). Раньше в границу входила и `depth` цели, и
 * лист без нарисованной строки папки подставлял СЕБЯ как родителя.
 *
 * Имя уровня сверяется с `dir` цели, а не берётся у соседа на веру: в раскрытой
 * папке лист помечен ЕЁ глубиной, но `dir` у него — сама папка. На 3000 файлах
 * `nearestAbove` отдавал имя ФАЙЛА («f2960.txt») вместо папки («many»).
 */
export function ancestorsAt(rows: readonly CrumbRow[], index: number, rootPath: string): Breadcrumb[] {
  if (index < 0 || index >= rows.length) return [];
  const target = rows[index]!;
  // Строка ВНЕ папки предков не имеет (корень проекта, загрузка).
  if (target.depth < 1) return [];

  const parts = splitPath(target.dir ?? rootPath);
  const rootParts = splitPath(rootPath);
  const sep = separatorOf(rootPath);
  const found: { label: string; depth: number }[] = [];
  // `dir` — папка САМА, и её уровень равен `depth`: строка файла внутри `many`
  // приходит c `depth: 1` и `dir: …/many`. Раньше здесь стояло `< target.depth`,
  // и у такого листа не выходило ни одного предка — шапка молчала ровно в том
  // окне, где она нужна (прокрутка в большой папке).
  // `depth` — уровень ПАПКИ строки, а не её самой (`dir` и есть эта папка).
  // Поэтому уровни идут до `depth - 1`: сама папка идёт отдельным ходом ниже.
  for (let level = 1; level < target.depth; level += 1) {
    // Уровень 0 — корень проекта, он уже стоит заголовком проводника.
    const fromDir = parts[rootParts.length + level - 1];
    // `dir` говорит правду даже тогда, когда строки уровня нет в окне; на него и
    // опираемся. `nearestAbove` — только запасной ход для строк без `dir`.
    if (fromDir !== undefined && fromDir !== '') found.push({ label: fromDir, depth: level });
  }
  // Сама папка строки — последний уровень цепочки.
  const own = parts[rootParts.length + target.depth - 1];
  if (own !== undefined && own !== '') found.push({ label: own, depth: target.depth });

  // Путь строится СРЕЗОМ `dir`, а не склейкой имён: имя может прийти из соседа,
  // и склейка дала бы в пути чужой файл.
  const crumbs: Breadcrumb[] = [];
  for (const item of found) {
    // `dir` — папка САМА (`/repo/src/core` для листа в `core`), поэтому её
    // сегмент лежит на `rootParts.length + depth - 1`, а отрез — до `+ depth`.
    const levelParts = parts.slice(0, rootParts.length + item.depth);
    // Ведущий разделитель теряется при `splitPath`: без него путь становится
    // ОТНОСИТЕЛЬНЫМ (`repo/src` вместо `/repo/src`) — по такому не кликнешь.
    crumbs.push({
      label: item.label,
      path: `${sep}${levelParts.join(sep)}`,
      depth: item.depth,
    });
  }
  return crumbs;
}

/**
 * Надо ли перерисовывать липкую шапку.
 *
 * Шапка пересобирается на каждом кадре прокрутки, а создание узлов дёргает
 * разметку. Сравнение путей дешевле сборки DOM — менять её без нужды незачем.
 */
export function breadcrumbChanged(prev: readonly Breadcrumb[], next: readonly Breadcrumb[]): boolean {
  if (prev.length !== next.length) return true;
  for (let at = 0; at < prev.length; at += 1) {
    const a = prev[at]!;
    const b = next[at]!;
    if (a.path !== b.path || a.label !== b.label) return true;
  }
  return false;
}
