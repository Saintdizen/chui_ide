/**
 * Git LFS (Large File Storage) — модель и разбор ответов git.
 *
 * LFS хранит большие файлы не в самом репозитории, а отдельно: в коммит попадает
 * маленький текстовый указатель, а сам файл лежит в хранилище и подтягивается по
 * требованию. Что где лежит, решает `.gitattributes`: строка вида
 * `*.psd filter=lfs diff=lfs merge=lfs -text` говорит «файлы с этим именем ведёт LFS».
 *
 * Здесь — чистый разбор: список отслеживаемых файлов (`git lfs ls-files`) и шаблоны
 * из `.gitattributes`, плюс правка этого файла (добавить или убрать шаблон). Ни ФС,
 * ни запуска процессов: их дело — в main (`git/git.ts`), показ — в интерфейсе.
 *
 * Разбор терпимый: версии git-lfs печатают `ls-files` немного по-разному (со размером
 * и без), и строку, которую не поняли, лучше пропустить, чем уронить экран LFS.
 */

/** Один файл, который ведёт LFS. */
export interface GitLfsFile {
  /** Сокращённый oid объекта в хранилище. */
  oid: string;
  /** Путь от корня репозитория. */
  path: string;
  /** `true` — файл лежит в LFS; `false` — в рабочем дереве только указатель. */
  present: boolean;
  /** Размер в байтах, если git его сообщил. */
  size: number | null;
}

/** Шаблон из `.gitattributes`: каким файлам назначено хранение в LFS. */
export interface GitLfsPattern {
  /** Сам шаблон, например `*.psd`. */
  pattern: string;
  /** Строка файла как она есть — показываем её как есть. */
  line: string;
}

/** Что знает главный процесс про LFS текущего репозитория. */
export interface GitLfsInfo {
  /** Найден ли `git lfs` — без него LFS в репозитории не работает. */
  available: boolean;
  /** Отслеживает ли репозиторий что-нибудь через LFS (есть шаблоны или файлы). */
  configured: boolean;
  /** Файлы, попавшие под LFS. */
  files: GitLfsFile[];
  /** Шаблоны из `.gitattributes`. */
  patterns: GitLfsPattern[];
  /** Версия git-lfs, если её удалось узнать. */
  version: string | null;
}

/** Ключи, которыми git помечает строку `.gitattributes` как «это LFS». */
const LFS_FILTER = 'filter=lfs';

/** Пустая запись LFS: git-lfs не найден. */
export function emptyLfsInfo(patterns: GitLfsPattern[] = []): GitLfsInfo {
  return { available: false, configured: patterns.length > 0, files: [], patterns, version: null };
}

/** Похоже ли слово на сокращённый oid: 7 и больше шестнадцатеричных знаков. */
function isOid(token: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(token);
}

/**
 * Разбор `git lfs ls-files`. Ожидаем `oid <*|-> [размер] путь`, но принимаем и
 * урезанные варианты: строку без oid считаем просто путём, без статуса — присутствующей.
 */
export function parseLfsFiles(stdout: string): GitLfsFile[] {
  const files: GitLfsFile[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) {
      // Одна колонка — это, скорее всего, просто путь.
      files.push({ oid: '', path: line, present: false, size: null });
      continue;
    }
    const head = line.slice(0, space);
    let rest = line.slice(space + 1).trim();
    let oid = '';
    let path = line;
    if (isOid(head)) {
      oid = head;
      path = rest;
    }
    // Статус: `*` — файл в LFS, `-` — не подтянут.
    let present = true;
    const status = rest.slice(0, 1);
    if ((status === '*' || status === '-') && (rest.length === 1 || rest[1] === ' ')) {
      present = status === '*';
      rest = rest.slice(1).trim();
      path = rest;
    }
    // Размер идёт перед путём: цифры, за ними пробел.
    let size: number | null = null;
    const sizeMatch = /^(\d+)\s+(.*)$/.exec(rest);
    if (sizeMatch) {
      size = Number(sizeMatch[1]);
      path = sizeMatch[2]!;
    }
    if (path === '') continue;
    files.push({ oid, path, present, size });
  }
  return files;
}

/** Первое слово строки `.gitattributes` — шаблон; кавычки снимаем. */
function firstToken(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) return trimmed.slice(1, end);
  }
  const space = trimmed.indexOf(' ');
  return space < 0 ? trimmed : trimmed.slice(0, space);
}

/** Шаблоны LFS из содержимого `.gitattributes`. */
export function parseLfsPatterns(attributes: string): GitLfsPattern[] {
  const patterns: GitLfsPattern[] = [];
  for (const line of attributes.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (!trimmed.includes(LFS_FILTER)) continue;
    patterns.push({ pattern: firstToken(trimmed), line: trimmed });
  }
  return patterns;
}

/** Строка `.gitattributes`, которую git пишет для шаблона. */
export function lfsTrackLine(pattern: string): string {
  return `${pattern} filter=lfs diff=lfs merge=lfs -text`;
}

/** Привести шаблон к виду, который примет git: без пробелов и кавычек по краям. */
export function normalizeLfsPattern(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

/**
 * Добавить шаблон в `.gitattributes`. Если он уже есть — текст не меняется: повторная
 * строка только запутала бы git (последняя перебивает первую, но читать это тяжело).
 * Возвращает новый текст и признак «изменилось».
 */
export function addPattern(attributes: string, pattern: string): { text: string; changed: boolean } {
  const clean = normalizeLfsPattern(pattern);
  if (clean === '') return { text: attributes, changed: false };
  if (parseLfsPatterns(attributes).some((item) => item.pattern === clean)) {
    return { text: attributes, changed: false };
  }
  const line = lfsTrackLine(clean);
  if (attributes === '') return { text: `${line}\n`, changed: true };
  const base = attributes.endsWith('\n') ? attributes : `${attributes}\n`;
  return { text: `${base}${line}\n`, changed: true };
}

/** Убрать шаблон из `.gitattributes`: строки с ним (и только они) исчезают. */
export function removePattern(attributes: string, pattern: string): { text: string; changed: boolean } {
  const clean = normalizeLfsPattern(pattern);
  const kept: string[] = [];
  let changed = false;
  for (const line of attributes.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '' && !trimmed.startsWith('#') && trimmed.includes(LFS_FILTER) && firstToken(trimmed) === clean) {
      changed = true;
      continue;
    }
    kept.push(line);
  }
  if (!changed) return { text: attributes, changed: false };
  // Хвостовые пустые строки от удалённой строки не оставляем.
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  return { text: kept.length === 0 ? '' : `${kept.join('\n')}\n`, changed: true };
}

/** Сколько файлов ещё не подтянуто — их видно по пометке в интерфейсе. */
export function missingCount(files: readonly GitLfsFile[]): number {
  return files.filter((file) => !file.present).length;
}

/** Подпись одного файла: путь и размер, если он есть. */
export function lfsFileLabel(file: GitLfsFile): string {
  if (file.size === null) return file.path;
  return `${file.path} · ${formatSize(file.size)}`;
}

/** Размер в удобных единицах. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}
