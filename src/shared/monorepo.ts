/**
 * Пакеты монорепозитория: где они лежат и к какому относится файл.
 *
 * В монорепо репозиторий один, а проектов внутри много: `packages/api`,
 * `packages/web`, `services/pay`. Когда изменений десяток, важен не список файлов,
 * а «какой пакет задет» — так правку видно целиком, а не по кусочкам. Здесь — только
 * правила: как найти пакеты по манифестам и как отнести к ним путь.
 *
 * Манифесты разные: у Node это `package.json` (иногда с `workspaces` — списком
 * маскированных каталогов), у Python — `pyproject.toml` или `setup.py`. Имя пакета
 * берём из манифеста, а если там его нет — из имени папки: пустой подписи быть не должно.
 *
 * Модуль чистый: ни ФС, ни процессов. Чтение манифестов — в main (`project/packages.ts`).
 */

/** Вид пакета: по нему видно, чем он собирается. */
export type PackageKind = 'node' | 'python' | 'other';

/** Пакет внутри репозитория. */
export interface ProjectPackage {
  /** Имя: из манифеста, иначе — имя папки. */
  name: string;
  /** Путь от корня репозитория (без ведущего слэша), для корня — пустая строка. */
  path: string;
  kind: PackageKind;
}

/** Что нашли в манифесте: имя пакета и маски вложенных рабочих областей. */
export interface ManifestInfo {
  name: string;
  /** Значения `workspaces` из `package.json` — каталоги-пакеты (могут быть масками). */
  workspaces: string[];
}

/** Имя пакета из содержимого `package.json`; пусто — возьмём имя папки. */
export function manifestName(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return '';
    const name = (value as { name?: unknown }).name;
    return typeof name === 'string' ? name.trim() : '';
  } catch {
    // Битый манифест — не ошибка открытия проекта: обойдёмся именем папки.
    return '';
  }
}

/**
 * `workspaces` из `package.json`. Бывает и массивом, и объектом с ключом `packages`
 * (старый формат yarn), поэтому читаем оба.
 */
export function parseWorkspaces(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return [];
    const raw = (value as { workspaces?: unknown }).workspaces;
    const list = Array.isArray(raw)
      ? raw
      : typeof raw === 'object' && raw !== null && Array.isArray((raw as { packages?: unknown }).packages)
        ? ((raw as { packages: unknown[] }).packages as unknown[])
        : [];
    return list
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
  } catch {
    return [];
  }
}

/** Манифест и его разбор одним вызовом — чтобы вызывающему не читать текст дважды. */
export function parseManifest(text: string): ManifestInfo {
  return { name: manifestName(text), workspaces: parseWorkspaces(text) };
}

/** Имя папки из пути (последний сегмент). */
function baseName(dirPath: string): string {
  const clean = dirPath.replace(/\/+$/, '');
  const index = clean.lastIndexOf('/');
  return index < 0 ? clean : clean.slice(index + 1);
}

/** Пакет по пути каталога: имя из манифеста, иначе — имя папки. */
export function packageAt(dirPath: string, kind: PackageKind, manifestText?: string): ProjectPackage {
  const path = dirPath.replace(/^\/+|\/+$/g, '');
  const name = manifestText ? manifestName(manifestText) : '';
  return { name: name !== '' ? name : baseName(path) || 'корень', path, kind };
}

/**
 * Какие каталоги подходят под маски рабочих областей. Маска простая: `packages/*`
 * означает «все папки внутри packages». Сравниваем по сегментам, не по регулярке:
 * путь может содержать знаки, которые в регулярке значили бы другое.
 */
export function matchWorkspaces(workspaces: readonly string[], dirs: readonly string[]): string[] {
  const result = new Set<string>();
  for (const dir of dirs) {
    const clean = dir.replace(/^\/+|\/+$/g, '');
    for (const mask of workspaces) {
      if (maskMatches(mask, clean)) {
        result.add(clean);
        break;
      }
    }
  }
  return [...result];
}

/** Подходит ли путь каталога под маску: `*` — один сегмент, `**` — сколько угодно. */
function maskMatches(mask: string, dir: string): boolean {
  const maskParts = mask.replace(/^\/+|\/+$/g, '').split('/');
  const dirParts = dir.split('/');
  return matchParts(maskParts, dirParts, 0, 0);
}

function matchParts(mask: readonly string[], dir: readonly string[], mi: number, di: number): boolean {
  if (mi === mask.length) return di === dir.length;
  const part = mask[mi]!;
  if (part === '**') {
    // `**` съедает любое число сегментов, включая ноль.
    for (let skip = di; skip <= dir.length; skip += 1) {
      if (matchParts(mask, dir, mi + 1, skip)) return true;
    }
    return false;
  }
  if (di >= dir.length) return false;
  if (part !== '*' && part !== dir[di]) return false;
  return matchParts(mask, dir, mi + 1, di + 1);
}

/**
 * Пакет, которому принадлежит файл: самый ГЛУБОКИЙ из вмещающих. Вложенные пакеты —
 * обычное дело (`packages/web/lib` со своим манифестом), и файл принадлежит ему, а не
 * внешнему пакету целиком.
 */
export function packageForPath(packages: readonly ProjectPackage[], filePath: string): ProjectPackage | null {
  const clean = filePath.replace(/^\/+/, '');
  let found: ProjectPackage | null = null;
  for (const item of packages) {
    if (!isInside(item.path, clean)) continue;
    if (!found || item.path.length > found.path.length) found = item;
  }
  return found;
}

/** Лежит ли путь внутри каталога (или совпадает с ним). */
function isInside(dir: string, target: string): boolean {
  if (dir === '') return true;
  return target === dir || target.startsWith(`${dir}/`);
}

/** Знак «файл не попал ни в один пакет»: не может совпасть с настоящим путём. */
export const NO_PACKAGE = '\u0000';

/** Файлы, разложенные по пакетам: сначала пакет, потом его файлы. */
export function groupByPackage(
  packages: readonly ProjectPackage[],
  files: readonly string[],
): Array<{ name: string; path: string; files: string[] }> {
  const groups = new Map<string, { name: string; path: string; files: string[] }>();
  for (const file of files) {
    const owner = packageForPath(packages, file);
    // Остаток помечаем знаком, который не может быть путём: у корневого пакета путь
    // тоже пустой, и без этого «вне пакетов» слилось бы с корнем.
    const key = owner ? owner.path : NO_PACKAGE;
    if (!groups.has(key)) {
      groups.set(key, { name: owner?.name ?? 'вне пакетов', path: key, files: [] });
    }
    groups.get(key)!.files.push(file);
  }
  // Пакеты — по пути, затем корень, затем остаток: остаток это не пакет.
  return [...groups.values()].sort((a, b) => {
    const rank = (path: string): number => (path === NO_PACKAGE ? 2 : path === '' ? 1 : 0);
    const diff = rank(a.path) - rank(b.path);
    return diff !== 0 ? diff : a.path.localeCompare(b.path);
  });
}

/** Сколько пакетов в проекте — по одному решаем, нужна ли разбивка вообще. */
export function isMonorepo(packages: readonly ProjectPackage[]): boolean {
  return packages.filter((item) => item.path !== '').length > 1;
}

/** Подпись списка пакетов для интерфейса: «3 пакета» или «пакетов не найдено». */
export function packagesLabel(packages: readonly ProjectPackage[]): string {
  const count = packages.filter((item) => item.path !== '').length;
  if (count === 0) return 'пакетов не найдено';
  const mod100 = count % 100;
  const mod10 = count % 10;
  const word =
    mod100 >= 11 && mod100 <= 14 ? 'пакетов' : mod10 === 1 ? 'пакет' : mod10 >= 2 && mod10 <= 4 ? 'пакета' : 'пакетов';
  return `${count} ${word}`;
}

/**
 * Пакеты, которые видны в дереве на верхнем уровне: те, что не лежат внутри другого
 * пакета. Вложенные показывать отдельно незачем — они и так видны при раскрытии
 * родителя, а отдельная строка на каждый дублировала бы дерево.
 */
export function topLevelPackages(packages: readonly ProjectPackage[]): ProjectPackage[] {
  const real = packages.filter((item) => item.path !== '');
  return real
    .filter((item) => !real.some((other) => other.path !== item.path && isInside(other.path, item.path)))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Промежуточные каталоги, в которых лежат пакеты (`packages` для `packages/api`).
 * Их строки в дереве лишние: пакеты и так видны под своими именами — а сам каталог
 * «packages» — это просто место на диске, а не проект.
 */
export function packageAncestorDirs(packages: readonly ProjectPackage[]): string[] {
  const dirs = new Set<string>();
  for (const item of packages) {
    if (item.path === '') continue;
    const segments = item.path.split('/');
    segments.pop();
    let acc = '';
    for (const segment of segments) {
      acc = acc === '' ? segment : `${acc}/${segment}`;
      dirs.add(acc);
    }
  }
  return [...dirs];
}
