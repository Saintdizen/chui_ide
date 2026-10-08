/**
 * Один реестр языков на всё приложение.
 *
 * Из него берут данные и редактор (идентификатор для Monaco, отступы, правила
 * комментариев), и дерево проекта (значок файла), и статусбар (человеческая
 * подпись), и запуск (чем файл этого языка запускается). Раньше сведения о
 * языках были размазаны по трём модулям и расходились — например, `.mts`
 * подсвечивался как TypeScript, но в подписи стояло сырое `typescript`.
 *
 * Идентификаторы языков (`id`) — ровно те, что понимает Monaco: от них зависит
 * и подсветка, и подсказки. Всё остальное — наши надстройки.
 */

/** Как рисовать значок файла: от вида зависит форма и цвет. */
export type FileIconKind =
  | 'code'
  | 'js'
  | 'ts'
  | 'python'
  | 'json'
  | 'markdown'
  | 'css'
  | 'html'
  | 'shell'
  | 'yaml'
  | 'config'
  | 'database'
  | 'docker'
  | 'text'
  | 'image'
  | 'archive'
  | 'lock'
  | 'git';

/** Чем запускается файл: оболочка запуска подбирает команду сама. */
export type RunKind = 'python' | 'node' | 'shell';

export interface LanguageIndent {
  tabSize: number;
  /** Python и Makefile требуют разного: пробелы против символа табуляции. */
  insertSpaces: boolean;
}

export interface LanguageInfo {
  id: string;
  label: string;
  /** Короткая надпись на значке файла: 1–3 символа. */
  badge: string;
  icon: FileIconKind;
  extensions?: readonly string[];
  /** Файлы, у которых расширения нет вовсе: `Makefile`, `.env`, `Dockerfile`. */
  filenames?: readonly string[];
  /** Отступы по умолчанию. Нет — значит берём общие из настроек редактора. */
  indent?: LanguageIndent;
  /** Язык можно запустить как программу. */
  runner?: RunKind;
}

const FOUR_SPACES: LanguageIndent = { tabSize: 4, insertSpaces: true };

export const LANGUAGES: readonly LanguageInfo[] = [
  // ── Node.js и TypeScript ────────────────────────────────────────────────
  {
    id: 'typescript',
    label: 'TypeScript',
    badge: 'TS',
    icon: 'ts',
    extensions: ['ts', 'mts', 'cts', 'tsx'],
    indent: { tabSize: 2, insertSpaces: true },
    runner: 'node',
  },
  {
    id: 'javascript',
    label: 'JavaScript',
    badge: 'JS',
    icon: 'js',
    extensions: ['js', 'mjs', 'cjs', 'jsx'],
    indent: { tabSize: 2, insertSpaces: true },
    runner: 'node',
  },
  { id: 'json', label: 'JSON', badge: '{}', icon: 'json', extensions: ['json', 'jsonc', 'json5', 'map'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'html', label: 'HTML', badge: '<>', icon: 'html', extensions: ['html', 'htm', 'vue', 'svelte'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'css', label: 'CSS', badge: 'CSS', icon: 'css', extensions: ['css'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'scss', label: 'SCSS', badge: 'SC', icon: 'css', extensions: ['scss', 'sass'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'less', label: 'Less', badge: 'LE', icon: 'css', extensions: ['less'], indent: { tabSize: 2, insertSpaces: true } },

  // ── Python ──────────────────────────────────────────────────────────────
  { id: 'python', label: 'Python', badge: 'PY', icon: 'python', extensions: ['py', 'pyi', 'pyw', 'pyx'], indent: FOUR_SPACES, runner: 'python' },

  // ── Разметка и данные ───────────────────────────────────────────────────
  { id: 'markdown', label: 'Markdown', badge: 'MD', icon: 'markdown', extensions: ['md', 'markdown', 'mdx'] },
  { id: 'yaml', label: 'YAML', badge: 'YML', icon: 'yaml', extensions: ['yml', 'yaml'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'ini', label: 'TOML / INI', badge: 'CFG', icon: 'config', extensions: ['toml', 'ini', 'cfg', 'conf', 'properties', 'env', 'editorconfig'], filenames: ['.env', '.npmrc', '.editorconfig', '.prettierrc', '.flake8'] },
  { id: 'xml', label: 'XML', badge: 'XML', icon: 'config', extensions: ['xml', 'plist', 'csproj'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'sql', label: 'SQL', badge: 'SQL', icon: 'database', extensions: ['sql', 'db'] },

  // ── Скрипты и сборка ────────────────────────────────────────────────────
  { id: 'shell', label: 'Shell', badge: '$', icon: 'shell', extensions: ['sh', 'bash', 'zsh', 'fish', 'ksh'], filenames: ['.gitignore', '.gitattributes', '.bashrc', '.zshrc', '.profile'], indent: { tabSize: 2, insertSpaces: true }, runner: 'shell' },
  { id: 'dockerfile', label: 'Dockerfile', badge: 'DK', icon: 'docker', extensions: ['dockerfile'], filenames: ['Dockerfile', 'dockerfile', '.dockerignore'] },
  { id: 'makefile', label: 'Makefile', badge: 'MK', icon: 'shell', extensions: ['mk'], filenames: ['Makefile', 'makefile', 'GNUmakefile'], indent: { tabSize: 4, insertSpaces: false } },

  // ── Прочие языки (подсветка есть, надстроек нет) ────────────────────────
  { id: 'rust', label: 'Rust', badge: 'RS', icon: 'code', extensions: ['rs'], indent: FOUR_SPACES },
  { id: 'go', label: 'Go', badge: 'GO', icon: 'code', extensions: ['go'], indent: { tabSize: 4, insertSpaces: false } },
  { id: 'java', label: 'Java', badge: 'JV', icon: 'code', extensions: ['java'], indent: FOUR_SPACES },
  { id: 'kotlin', label: 'Kotlin', badge: 'KT', icon: 'code', extensions: ['kt', 'kts'], indent: FOUR_SPACES },
  { id: 'swift', label: 'Swift', badge: 'SW', icon: 'code', extensions: ['swift'], indent: FOUR_SPACES },
  { id: 'c', label: 'C', badge: 'C', icon: 'code', extensions: ['c', 'h'], indent: FOUR_SPACES },
  { id: 'cpp', label: 'C++', badge: 'C+', icon: 'code', extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hxx'], indent: FOUR_SPACES },
  { id: 'csharp', label: 'C#', badge: 'C#', icon: 'code', extensions: ['cs'], indent: FOUR_SPACES },
  { id: 'ruby', label: 'Ruby', badge: 'RB', icon: 'code', extensions: ['rb', 'gemspec'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'php', label: 'PHP', badge: 'PHP', icon: 'code', extensions: ['php'], indent: FOUR_SPACES },
  { id: 'lua', label: 'Lua', badge: 'LUA', icon: 'code', extensions: ['lua'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'dart', label: 'Dart', badge: 'DT', icon: 'code', extensions: ['dart'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'r', label: 'R', badge: 'R', icon: 'code', extensions: ['r'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'perl', label: 'Perl', badge: 'PL', icon: 'code', extensions: ['pl', 'pm'], indent: FOUR_SPACES },
  { id: 'scala', label: 'Scala', badge: 'SC', icon: 'code', extensions: ['scala'], indent: { tabSize: 2, insertSpaces: true } },
  { id: 'groovy', label: 'Groovy', badge: 'GR', icon: 'code', extensions: ['gradle', 'groovy'], indent: FOUR_SPACES },
];

/** Язык для файла, чьё расширение мы не знаем: Monaco подсветит как простой текст. */
export const PLAIN_LANGUAGE = 'plaintext';

const BY_ID = new Map(LANGUAGES.map((language) => [language.id, language]));
/** Расширения и имена файлов → язык. Имена важнее расширений: `Dockerfile` без точки. */
const BY_EXTENSION = new Map<string, LanguageInfo>();
const BY_FILENAME = new Map<string, LanguageInfo>();

for (const language of LANGUAGES) {
  // Идём от конца: поздние записи уточняют ранние (например, `env` у ini).
  for (const extension of language.extensions ?? []) BY_EXTENSION.set(extension, language);
  for (const filename of language.filenames ?? []) BY_FILENAME.set(filename.toLowerCase(), language);
}

export function basename(target: string): string {
  const index = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  return index < 0 ? target : target.slice(index + 1);
}

/** Язык файла по его пути. Имя файла целиком проверяем раньше расширения. */
export function languageInfoForPath(filePath: string): LanguageInfo | null {
  const name = basename(filePath).toLowerCase();
  const byName = BY_FILENAME.get(name);
  if (byName) return byName;

  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXTENSION.get(name.slice(dot + 1)) ?? null;
}

export function languageInfo(languageId: string): LanguageInfo | null {
  return BY_ID.get(languageId) ?? null;
}

/** Идентификатор языка для Monaco. */
export function languageFromPath(filePath: string): string {
  return languageInfoForPath(filePath)?.id ?? PLAIN_LANGUAGE;
}

export function languageLabel(languageId: string): string {
  return BY_ID.get(languageId)?.label ?? languageId;
}

/** Отступы, положенные языку по умолчанию (null — «как в настройках редактора»). */
export function languageIndent(languageId: string): LanguageIndent | null {
  return BY_ID.get(languageId)?.indent ?? null;
}

/** Значок файла: вид для отрисовки и подпись внутри. */
export function fileIconOf(filePath: string): { kind: FileIconKind; badge: string } {
  const name = basename(filePath);
  const lower = name.toLowerCase();
  const special = SPECIAL_FILES[lower];
  if (special) return special;

  const language = languageInfoForPath(filePath);
  if (language) return { kind: language.icon, badge: language.badge };

  const dot = lower.lastIndexOf('.');
  const extension = dot > 0 ? lower.slice(dot + 1) : '';
  return EXTRA_ICONS[extension] ?? { kind: 'text', badge: '' };
}

/**
 * Файлы, чей значок не совпадает с языком: манифесты, замки версий, картинки.
 * Держим рядом с языками, чтобы вид дерева описывался в одном месте.
 */
const SPECIAL_FILES: Record<string, { kind: FileIconKind; badge: string }> = {
  'package.json': { kind: 'js', badge: 'NPM' },
  'package-lock.json': { kind: 'lock', badge: '' },
  'yarn.lock': { kind: 'lock', badge: '' },
  'pnpm-lock.yaml': { kind: 'lock', badge: '' },
  'bun.lockb': { kind: 'lock', badge: '' },
  'tsconfig.json': { kind: 'ts', badge: 'TS' },
  'requirements.txt': { kind: 'python', badge: 'PIP' },
  'pyproject.toml': { kind: 'python', badge: 'PY' },
  'pipfile': { kind: 'python', badge: 'PY' },
  'setup.py': { kind: 'python', badge: 'PY' },
  'cargo.toml': { kind: 'code', badge: 'RS' },
  'go.mod': { kind: 'code', badge: 'GO' },
  '.gitignore': { kind: 'git', badge: '' },
  '.gitattributes': { kind: 'git', badge: '' },
  '.gitmodules': { kind: 'git', badge: '' },
  'dockerfile': { kind: 'docker', badge: 'DK' },
  'docker-compose.yml': { kind: 'docker', badge: 'DK' },
  'docker-compose.yaml': { kind: 'docker', badge: 'DK' },
  'makefile': { kind: 'shell', badge: 'MK' },
};

const EXTRA_ICONS: Record<string, { kind: FileIconKind; badge: string }> = {
  png: { kind: 'image', badge: '' },
  jpg: { kind: 'image', badge: '' },
  jpeg: { kind: 'image', badge: '' },
  gif: { kind: 'image', badge: '' },
  webp: { kind: 'image', badge: '' },
  bmp: { kind: 'image', badge: '' },
  ico: { kind: 'image', badge: '' },
  avif: { kind: 'image', badge: '' },
  svg: { kind: 'image', badge: 'SVG' },
  zip: { kind: 'archive', badge: '' },
  gz: { kind: 'archive', badge: '' },
  tar: { kind: 'archive', badge: '' },
  bz2: { kind: 'archive', badge: '' },
  xz: { kind: 'archive', badge: '' },
  '7z': { kind: 'archive', badge: '' },
  rar: { kind: 'archive', badge: '' },
  lock: { kind: 'lock', badge: '' },
  bin: { kind: 'archive', badge: '' },
  so: { kind: 'archive', badge: '' },
  dll: { kind: 'archive', badge: '' },
  dylib: { kind: 'archive', badge: '' },
  exe: { kind: 'archive', badge: '' },
  woff: { kind: 'text', badge: 'F' },
  woff2: { kind: 'text', badge: 'F' },
  ttf: { kind: 'text', badge: 'F' },
  otf: { kind: 'text', badge: 'F' },
  log: { kind: 'text', badge: '' },
  txt: { kind: 'text', badge: '' },
  csv: { kind: 'database', badge: '' },
  ipynb: { kind: 'python', badge: 'NB' },
};
