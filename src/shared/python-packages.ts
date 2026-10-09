/**
 * Пакеты Python: что установлено, что просит `requirements.txt` и чем модуль
 * отличается от пакета.
 *
 * Здесь только разбор строк — ни процессов, ни диска. Спрашивает интерпретатор
 * и читает файлы main, а решения («чего не хватает», «какой пакет даёт этот
 * модуль») живут здесь и потому проверяются в тестах без Electron.
 *
 * Нужно двум вещам: показу окружения и подсказке «поставить то, чего не хватает».
 */

/** Один установленный пакет: имя как его знает pip и версия. */
export interface InstalledPackage {
  name: string;
  version: string;
}

/** Строка `requirements.txt`, которую поняли. Остальные просто пропускаем. */
export interface Requirement {
  /** Имя распределения в том виде, как написано: `PyYAML`. */
  name: string;
  /** Спецификатор версии без пробелов (`>=6,<7`), пусто — любая. */
  specifier: string;
  /** Строка файла (1-based). */
  line: number;
}

/** Что дало сравнение зависимостей с установленным. */
export interface RequirementsDiff {
  /** Просят, но не установлено. */
  missing: Requirement[];
  /** Установлено, но в `requirements.txt` не упомянуто. */
  extra: InstalledPackage[];
  /** Совпало по имени. */
  present: Requirement[];
}

/**
 * Разбор ответа `pip list --format=json`. Формат — массив `{name, version}`,
 * но полагаться на это слепо нельзя: вывод может быть с мусором в начале
 * (предупреждения pip). Поэтому берём самый длинный JSON-массив в строке.
 */
export function parsePipList(output: string): InstalledPackage[] {
  const json = extractJsonArray(output);
  if (!json) return [];
  const result: InstalledPackage[] = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as { name?: unknown }).name;
    const version = (item as { version?: unknown }).version;
    if (typeof name !== 'string' || !name) continue;
    result.push({ name, version: typeof version === 'string' ? version : '' });
  }
  return result;
}

/** Первый разборчивый JSON-массив в тексте: `pip` любит печатать предупреждения перед ним. */
function extractJsonArray(output: string): unknown[] | null {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Разбор `requirements.txt`.
 *
 * Берём только обычные зависимости: пакет с необязательным спецификатором
 * версии. Строки с флагами (`-r`, `-e`, `--index-url`), ссылки и пути пропускаем —
 * их установка — отдельная история, и обещать по ним что-то было бы враньём.
 */
export function parseRequirements(text: string): Requirement[] {
  const result: Requirement[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    // Хвостовой комментарий: `pytest==7  # тесты`.
    const hash = line.indexOf(' #');
    if (hash >= 0) line = line.slice(0, hash).trim();
    // Строка-перенос (незакрытые скобки) или продолжение — оставляем как есть.
    if (line.startsWith('-') || line.includes('://') || line.includes('/') || line.includes('\\')) continue;

    // Имя до спецификатора: `name[extra]==1.2`, `name>=1`.
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (!match) continue;
    result.push({ name: match[1], specifier: (match[3] ?? '').replace(/\s+/g, ''), line: index + 1 });
  }

  return result;
}

/** Имя для сравнения: регистр, `-`, `_` и `.` не различаются — так велит PEP 503. */
export function canonicalName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-').replace(/\[.*\]$/, '');
}

/**
 * Чего не хватает из `requirements.txt` и что установлено сверх него.
 *
 * Сравниваем по каноничному имени (PEP 503): `PyYAML`, `pyyaml` и `Py_Yaml` —
 * один и тот же пакет, и человеку неважно, как он записан у него в файле.
 */
export function diffRequirements(
  requirements: readonly Requirement[],
  installed: readonly InstalledPackage[],
): RequirementsDiff {
  const have = new Set(installed.map((item) => canonicalName(item.name)));
  const want = new Set(requirements.map((item) => canonicalName(item.name)));

  const missing: Requirement[] = [];
  const present: Requirement[] = [];
  for (const requirement of requirements) {
    if (have.has(canonicalName(requirement.name))) present.push(requirement);
    else missing.push(requirement);
  }

  const extra = installed.filter((item) => !want.has(canonicalName(item.name)));
  return { missing, extra, present };
}

/**
 * Известные расхождения «имя модуля ≠ имя пакета». Полного соответствия не
 * существует: узнать его можно только по метаданным установленного пакета
 * (`top_level.txt`), а здесь мы помогаем угадать для тех случаев, что встречаются
 * постоянно. Нет в таблице — возвращаем имя как есть.
 */
const MODULE_TO_PACKAGE: Readonly<Record<string, string>> = {
  yaml: 'PyYAML',
  PIL: 'Pillow',
  cv2: 'opencv-python',
  sklearn: 'scikit-learn',
  bs4: 'beautifulsoup4',
  dotenv: 'python-dotenv',
  OpenSSL: 'pyOpenSSL',
  dateutil: 'python-dateutil',
  jwt: 'PyJWT',
  serial: 'pyserial',
  Crypto: 'pycryptodome',
  fitz: 'PyMuPDF',
  win32: 'pywin32',
  attr: 'attrs',
  skimage: 'scikit-image',
  mpl_toolkits: 'matplotlib',
  git: 'GitPython',
  IPython: 'ipython',
  googleapiclient: 'google-api-python-client',
  sqlalchemy: 'SQLAlchemy',
  seleniumwire: 'selenium-wire',
  playwright: 'playwright',
};

/**
 * Короткая строка для попапа: всё ли из `requirements.txt` стоит в окружении.
 * Показываем имена недостающих — по ним человек сразу видит, что доустановить,
 * а не только «чего-то не хватает». `limit` держит строку читаемой при длинном файле.
 */
export function requirementsNote(diff: RequirementsDiff, limit = 5): string {
  const total = diff.present.length + diff.missing.length;
  if (diff.missing.length === 0) return `Установлено всё из requirements.txt (${total})`;
  const names = diff.missing.slice(0, limit).map((item) => item.name);
  const rest = diff.missing.length - names.length;
  return `Не хватает ${diff.missing.length} из ${total}: ${names.join(', ')}${rest > 0 ? ` и ещё ${rest}` : ''}`;
}

/** Имя пакета для модуля, который не нашёлся в окружении. */
export function packageForModule(module: string): string {
  const known = MODULE_TO_PACKAGE[module];
  if (known) return known;
  // Сравнение без регистра: `pYYAML` и `yaml` должны попасть в таблицу.
  const lower = module.toLowerCase();
  for (const [key, value] of Object.entries(MODULE_TO_PACKAGE)) {
    if (key.toLowerCase() === lower) return value;
  }
  return module;
}
