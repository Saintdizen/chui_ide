/**
 * Карта символов проекта: объявления всех файлов без тел — то, по чему ищут мгновенно.
 *
 * Языковой сервер знает про объявления всё, но его ответ стоит процесса: он живёт,
 * пока жив сервер, и повторяется при каждом запуске. Здесь — своя, узкая выжимка:
 * только имя, вид, строки, объемлющее объявление и базовые классы. Тела в карту не
 * попадают: код читается по требованию, а карта должна уместиться в диск и в память
 * целиком (в этом и смысл — по ней ищут, не поднимая сервер).
 *
 * Карта отвечает на два вопроса из тех, что человек задаёт чаще всего:
 *   • «где объявлено имя N» — поиск по всем файлам без сервера (он же работает, пока
 *     сервер поднимается, — это и есть «глупый режим», где подсказки не молчат);
 *   • «что наследует класс C и что он от этого получает» — базовые классы разбираются
 *     из строки объявления, а методы — из вложенных объявлений.
 *
 * Модуль чистый: ни диска, ни сервера. Поэтому его видно в тестах, и им же
 * пользуется main при сборке карты.
 */

import type { FileSymbol, ProjectSymbol } from './lsp-symbols';
import { typeDeclarations } from './type-inheritance';

/** Версия формата файла карты: сменили форму записи — старый кэш читаем как пустой. */
export const INDEX_FORMAT = 2;

/**
 * Откуда объявление: из кода проекта или из установленной зависимости.
 *
 * Разница нужна в показе: свою функцию человек ищет чаще, чем чужую, и в списке она
 * должна быть выше. Кроме того, чужой файл открывается только на чтение — об этом лучше
 * знать заранее.
 */
export type IndexOrigin = 'project' | 'dependency';

/**
 * Языки, для которых карта собирается. Список короткий намеренно: это два языка,
 * у которых в IDE есть сервер и, значит, источник объявлений. Данные и разметку
 * в карту не берём — там объявлений нет, а файлов много.
 */
export const INDEXED_LANGUAGES: readonly string[] = ['python', 'typescript', 'javascript'];

/** Собираем ли карту для файла этого языка. */
export function isIndexedLanguage(languageId: string | null | undefined): boolean {
  return typeof languageId === 'string' && INDEXED_LANGUAGES.includes(languageId);
}

/**
 * Одно объявление в карте. Полей мало намеренно: чем меньше, тем больше влезает,
 * и каждое поле должно отвечать на конкретный вопрос.
 */
export interface IndexDecl {
  /** Имя как написано в коде: `Parser`, `read_file`. */
  name: string;
  /** Вид словами («класс», «функция», «метод») — как у скелета файла. */
  kind: string;
  /** Строка объявления, 1-based. */
  line: number;
  /** Последняя строка объявления, 1-based. */
  endLine: number;
  /** Объемлющее объявление: у метода — класс, у вложенной функции — внешняя. */
  container: string | null;
  /** Чему наследует: базовые классы Python, `extends` у классов и интерфейсов. */
  bases: string[];
}

/** Объявления одного файла вместе с отпечатком его содержимого. */
export interface IndexedFile {
  /**
   * Путь к файлу: у кода проекта — относительный POSIX-путь от корня, у зависимости —
   * абсолютный. Так потому, что чужие пакеты лежат и вне проекта (окружение в `~/.venvs`),
   * и относительного пути для них просто нет.
   */
  path: string;
  /** Язык файла (id из `shared/languages`). */
  language: string;
  /** Откуда файл: проект или установленная зависимость. */
  origin: IndexOrigin;
  /** Пакет, из которого файл (`requests`, `express`); у кода проекта — `null`. */
  package: string | null;
  /** Размер в байтах: первый признак, что файл изменился. */
  size: number;
  /** Время изменения в миллисекундах: второй признак. */
  mtime: number;
  decls: IndexDecl[];
}

/** Что карта знает сейчас — ответ `index.status` и основа «глупого режима». */
export interface SymbolIndexStatus {
  /** Корень, по которому собрана карта; `null` — карта пуста. */
  root: string | null;
  /**
   * `idle` — карты нет (проект не открыт), `warming` — собирается прямо сейчас,
   * `ready` — собрана. Пока `warming`, поиск отвечает тем, что уже есть.
   */
  phase: 'idle' | 'warming' | 'ready';
  /** Сколько файлов в карте. */
  files: number;
  /** Сколько объявлений в карте. */
  decls: number;
  /** Сколько файлов зависимостей в карте и из скольких пакетов. */
  dependencyFiles: number;
  dependencyPackages: number;
  /** Сколько файлов языка осталось вне карты: сервер не ответил или файл слишком велик. */
  skipped: number;
  /**
   * Сколько файлов прочитано и сколько их всего в текущем заходе; `null` — сборка
   * не идёт. Счёт — именно файлы: файл либо прочитан сервером и разобран, либо
   * нет, середины у него нет.
   */
  progress: { done: number; total: number; stage: SymbolIndexStage } | null;
}

/** Заход сборки: свой код проекта или чужой код из пакетов. */
export type SymbolIndexStage = 'project' | 'dependencies';

/** Пустая карта: проекта нет. */
export const EMPTY_INDEX_STATUS: SymbolIndexStatus = {
  root: null,
  phase: 'idle',
  files: 0,
  decls: 0,
  dependencyFiles: 0,
  dependencyPackages: 0,
  skipped: 0,
  progress: null,
};

/**
 * Чем показать карту символов в строке состояния. `null` — показывать нечего:
 * карта готова (молчим, как только индекс досчитан) или её нет вовсе.
 *
 * Показываем только сборку: это единственное состояние, в котором человеку полезно
 * знать, что поиск по структуре ещё неполон. Готовая карта — рабочий фон, а не событие.
 */
export interface SymbolIndexChip {
  text: string;
  title: string;
  progress: { done: number; total: number } | null;
}

export function symbolIndexChip(status: SymbolIndexStatus): SymbolIndexChip | null {
  if (status.phase !== 'warming') return null;
  const parts = [`${status.files} ${declinations(status.files, 'файл', 'файла', 'файлов')}`];
  if (status.dependencyFiles > 0) parts.push(`из них ${status.dependencyFiles} из зависимостей`);
  if (status.skipped > 0) parts.push(`${status.skipped} пропущено`);
  // Всего файлов не знает никто до обхода каталога: пока его нет, полосы не будет —
  // показывать долю от выдуманного числа хуже, чем просто сказать «читаю…».
  const progress = status.progress;
  const stage = progress?.stage === 'dependencies' ? 'читаю зависимости' : 'читаю проект';
  // `total === 0` — разбор начался, а список файлов ещё не готов. Раньше в этот миг
  // в строке стояло «читаю проект: 0 из 0», что читается как поломка; теперь —
  // «читаю проект…» и бегущий штрих без чисел.
  const counted = progress !== null && progress.total > 0;
  return {
    text: counted
      ? `${stage}: ${progress.done} из ${progress.total}`
      : progress
        ? `${stage}…`
        : `Символы: ${status.files}…`,
    title: `Карта символов собирается: ${parts.join(', ')}. Поиск по структуре отвечает уже сейчас, но пока неполно.`,
    progress: counted ? { done: progress.done, total: progress.total } : null,
  };
}

/** Русское склонение по числу: 1 файл, 2 файла, 5 файлов. */
function declinations(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/* ── сборка записи по скелету файла ─────────────────────────────────────── */

/** Виды объявлений, у которых бывают базовые классы. */
const TYPES_WITH_BASES: ReadonlySet<string> = new Set(['класс', 'интерфейс', 'структура']);

/**
 * Объявления файла из его скелета (ответ `textDocument/documentSymbol`).
 *
 * `basesAt` отдаёт предков объявления по номеру строки: сервер их в скелете не
 * сообщает, а без них карта не ответит на вопрос о наследовании. Правила разбора
 * предков живут в `type-inheritance.ts` — там они уже проверены и ими же пользуется
 * `workspace.findInheritance`; второй такой разбор разъехался бы с первым.
 */
export function toIndexDecls(
  symbols: readonly FileSymbol[],
  basesAt: (line: number) => readonly string[] = () => [],
): IndexDecl[] {
  const out: IndexDecl[] = [];

  const walk = (items: readonly FileSymbol[], container: string | null): void => {
    for (const symbol of items) {
      out.push({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        endLine: Math.max(symbol.endLine, symbol.line),
        container,
        bases: TYPES_WITH_BASES.has(symbol.kind) ? [...basesAt(symbol.line)] : [],
      });
      // Вложенные объявления знают своё объемлющее: у метода контейнер — класс,
      // а не имя файла. Так «что есть у класса» — это отбор по контейнеру.
      if (symbol.children.length > 0) walk(symbol.children, symbol.name);
    }
  };

  walk(symbols, null);
  return out;
}

/**
 * Предки по строкам файла: строка объявления → имена базовых типов.
 *
 * Одна точка сборки для всей карты: разбор делает `typeDeclarations`, здесь лишь
 * раскладка по номерам строк (объявления сервера адресуются строками) и чистка имён
 * до простых (`mod.Base` → `Base`) — карта знает имена, а не пути к типам.
 */
export function basesByLine(text: string, languageId: string | null): Map<number, string[]> {
  const byLine = new Map<number, string[]>();
  for (const declaration of typeDeclarations(text, languageId)) {
    const names = byLine.get(declaration.line) ?? [];
    for (const base of declaration.bases) {
      const simple = simpleBase(base);
      if (simple && !names.includes(simple)) names.push(simple);
    }
    if (names.length > 0) byLine.set(declaration.line, names);
  }
  return byLine;
}

/** Имя предка без обобщений и пути к модулю: `mod.Base<T>` → `Base`. */
function simpleBase(base: string): string {
  const trimmed = base.trim().replace(/^\*+/, '').trim();
  // `metaclass=ABCMeta` и подобные аргументы — не предки.
  if (!trimmed || /^[\w$]+\s*=/.test(trimmed)) return '';
  const dotted = /^[\w$]+(?:\.[\w$]+)*/.exec(trimmed);
  if (!dotted) return '';
  const segments = dotted[0].split('.');
  return segments[segments.length - 1] ?? '';
}

/* ── поиск по карте ────────────────────────────────────────────────────── */

/**
 * Где объявлено имя — все файлы разом, без сервера.
 *
 * Порядок — по тому, насколько имя похоже на запрос: точное совпадение, затем начало
 * имени, затем вхождение. Одинаково похожие идут сначала свои, потом из зависимостей:
 * `run` из проекта человек ищет чаще, чем `run` из чужого пакета. Дальше решают длина
 * имени и путь: короткое имя ближе к тому, что человек имел в виду, а путь делает
 * порядок воспроизводимым.
 */
export function queryIndex(files: Iterable<IndexedFile>, query: string, limit = 50): ProjectSymbol[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const found: Array<{ symbol: ProjectSymbol; score: number }> = [];
  for (const file of files) {
    for (const decl of file.decls) {
      const name = decl.name.toLowerCase();
      const match = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : -1;
      if (match < 0) continue;
      found.push({
        // Своё — на шаг выше чужого при той же степени совпадения.
        score: match * 2 + (file.origin === 'dependency' ? 1 : 0),
        symbol: {
          name: decl.name,
          kind: decl.kind,
          container: decl.container,
          path: file.path,
          line: decl.line,
          column: 1,
          origin: file.origin,
          package: file.package,
        },
      });
    }
  }

  found.sort(
    (a, b) =>
      a.score - b.score ||
      a.symbol.name.length - b.symbol.name.length ||
      a.symbol.name.localeCompare(b.symbol.name) ||
      a.symbol.path.localeCompare(b.symbol.path) ||
      a.symbol.line - b.symbol.line,
  );

  return found.slice(0, Math.max(0, limit)).map((item) => item.symbol);
}

/* ── наследование ──────────────────────────────────────────────────────── */

/** Объявление типа (класс, интерфейс, структура) вместе с файлом, где оно лежит. */
export interface IndexType {
  name: string;
  path: string;
  line: number;
  bases: string[];
}

/** Найти объявления типа по имени. Пусто — такого типа в карте нет. */
export function findTypes(files: Iterable<IndexedFile>, name: string): IndexType[] {
  const wanted = name.trim();
  if (!wanted) return [];
  const found: IndexType[] = [];
  for (const file of files) {
    for (const decl of file.decls) {
      if (decl.name !== wanted || !TYPES_WITH_BASES.has(decl.kind)) continue;
      found.push({ name: decl.name, path: file.path, line: decl.line, bases: decl.bases });
    }
  }
  return found;
}

/**
 * Предки типа по цепочке: сначала прямые, затем их предки. Повторы убраны, круг
 * (`A extends B`, `B extends A`) обрывается — в живом коде он бывает у опечаток.
 */
export function ancestorsOf(files: Iterable<IndexedFile>, name: string, maxDepth = 8): string[] {
  const all = [...files];
  const chain: string[] = [];
  const seen = new Set<string>([name]);
  let frontier = [...(findTypes(all, name)[0]?.bases ?? [])];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const base of frontier) {
      if (seen.has(base)) continue;
      seen.add(base);
      chain.push(base);
      for (const type of findTypes(all, base)) next.push(...type.bases);
    }
    frontier = next;
  }

  return chain;
}

/** Объявление внутри типа: метод, поле, вложенный класс. */
export interface IndexMember {
  name: string;
  kind: string;
  line: number;
  path: string;
  /** В каком типе объявлен: у унаследованного метода это родитель, а не сам класс. */
  from: string;
}

/** Что объявлено в самом типе (без предков). */
export function membersOf(files: Iterable<IndexedFile>, name: string): IndexMember[] {
  const members: IndexMember[] = [];
  for (const file of files) {
    for (const decl of file.decls) {
      if (decl.container !== name) continue;
      members.push({ name: decl.name, kind: decl.kind, line: decl.line, path: file.path, from: name });
    }
  }
  return members;
}

/**
 * Что тип умеет: свои объявления и унаследованные от предков.
 *
 * Ближний предок важнее дальнего, а своё объявление важнее унаследованного с тем же
 * именем — ровно так это и работает в языке: переопределённый метод перекрывает
 * родительский. Поэтому сбор идёт от самого типа вверх, а повторы по имени отбрасываются.
 */
export function inheritedMembers(files: Iterable<IndexedFile>, name: string): IndexMember[] {
  const all = [...files];
  const ordered = [name, ...ancestorsOf(all, name)];
  const seen = new Set<string>();
  const result: IndexMember[] = [];

  for (const type of ordered) {
    for (const member of membersOf(all, type)) {
      if (seen.has(member.name)) continue;
      seen.add(member.name);
      result.push(member);
    }
  }

  return result;
}

/**
 * Ответ на «что тип умеет и откуда это взялось» — то, что показывают списком.
 *
 * Одного списка членов мало: человеку нужно видеть, от кого тип это получил, и уметь
 * перейти к предку. Поэтому здесь и цепочка предков, и место объявления самого типа.
 */
export interface InheritedResult {
  /** Имя, про которое спросили. */
  name: string;
  /** Где объявлен сам тип; `null` — в карте его нет (опечатка, чужой язык, не собран). */
  declared: IndexType | null;
  /** Предки по цепочке: прямые, затем их предки. */
  ancestors: string[];
  /** Своё и унаследованное, без повторов: своё перекрывает родительское. */
  members: IndexMember[];
  /** Состояние карты: по нему видно, стоит ли ждать и спросить снова. */
  phase: SymbolIndexStatus['phase'];
}

/** Собрать ответ про наследование типа по карте. */
export function inheritedFor(
  files: Iterable<IndexedFile>,
  name: string,
  phase: SymbolIndexStatus['phase'] = 'ready',
): InheritedResult {
  const all = [...files];
  return {
    name,
    declared: findTypes(all, name)[0] ?? null,
    ancestors: ancestorsOf(all, name),
    members: inheritedMembers(all, name),
    phase,
  };
}

/* ── чтение кэша ───────────────────────────────────────────────────────── */

/**
 * Запись карты из файла кэша. Формат может быть от прежней версии IDE, а файл —
 * обрезан при сбое: и то и другое даёт `null`, и карта просто собирается заново.
 */
export function sanitizeIndexedFile(raw: unknown): IndexedFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    path?: unknown;
    language?: unknown;
    origin?: unknown;
    package?: unknown;
    size?: unknown;
    mtime?: unknown;
    decls?: unknown;
  };
  if (typeof value.path !== 'string' || !value.path) return null;
  if (typeof value.size !== 'number' || !Number.isFinite(value.size)) return null;
  if (typeof value.mtime !== 'number' || !Number.isFinite(value.mtime)) return null;
  if (!Array.isArray(value.decls)) return null;

  const decls: IndexDecl[] = [];
  for (const item of value.decls) {
    const decl = sanitizeDecl(item);
    if (decl) decls.push(decl);
  }

  return {
    path: value.path,
    language: typeof value.language === 'string' ? value.language : '',
    origin: value.origin === 'dependency' ? 'dependency' : 'project',
    package: typeof value.package === 'string' && value.package ? value.package : null,
    size: value.size,
    mtime: value.mtime,
    decls,
  };
}

function sanitizeDecl(raw: unknown): IndexDecl | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as {
    name?: unknown;
    kind?: unknown;
    line?: unknown;
    endLine?: unknown;
    container?: unknown;
    bases?: unknown;
  };
  if (typeof value.name !== 'string' || !value.name) return null;
  const line = numberOr(value.line, 0);
  if (line <= 0) return null;

  return {
    name: value.name,
    kind: typeof value.kind === 'string' ? value.kind : 'символ',
    line,
    endLine: Math.max(numberOr(value.endLine, line), line),
    container: typeof value.container === 'string' && value.container ? value.container : null,
    bases: Array.isArray(value.bases) ? value.bases.filter((base): base is string => typeof base === 'string') : [],
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** Записи карты из содержимого файла кэша. Мусор и старая версия — пустой список. */
export function sanitizeIndexPayload(raw: unknown): IndexedFile[] {
  if (!raw || typeof raw !== 'object') return [];
  const value = raw as { version?: unknown; files?: unknown };
  if (value.version !== INDEX_FORMAT || !Array.isArray(value.files)) return [];
  const files: IndexedFile[] = [];
  for (const item of value.files) {
    const file = sanitizeIndexedFile(item);
    if (file) files.push(file);
  }
  return files;
}
