/**
 * Наследование типов: кто от кого наследует — разбор по языку.
 *
 * Языковой сервер умеет показать иерархию типов, но только для символа под курсором и
 * только если сервер этого языка поднят. Здесь другой вопрос — «кто во всём проекте
 * наследует это имя» и «от кого наследует само имя», — и ответ виден по строкам: у класса
 * есть `extends`/`implements`, у интерфейса — `extends`, у Python-класса — родители в
 * скобках. Полный разбор типов не нужен, нужны имена, написанные в этих местах.
 *
 * Модуль чистый: ни файлов, ни DOM. Обход проекта и показ — дело вызывающего.
 */

/** Как объявлен тип: класс, интерфейс, трейт, структура или перечисление. */
export type TypeKind = 'class' | 'interface' | 'trait' | 'struct' | 'enum';

/** Объявление типа и его прямые родители (базовые типы). */
export interface TypeDeclaration {
  name: string;
  line: number;
  kind: TypeKind;
  /** Прямые родители, как они написаны (уже без дженериков и `metaclass=`). */
  bases: string[];
}

/** Направление поиска: кто наследует имя или от кого наследует само имя. */
export type InheritanceDirection = 'subtypes' | 'supertypes';

const JS_LANGUAGES = new Set(['typescript', 'javascript']);

/** Есть ли для языка разбор наследования. */
export function supportsInheritance(languageId: string | null): boolean {
  return languageId !== null && (JS_LANGUAGES.has(languageId) || languageId === 'python');
}

/** Объявления типов в тексте файла. Неизвестный язык — пусто: обещать нечего. */
export function typeDeclarations(text: string, languageId: string | null): TypeDeclaration[] {
  if (languageId !== null && JS_LANGUAGES.has(languageId)) return jsDeclarations(text);
  if (languageId === 'python') return pythonDeclarations(text);
  return [];
}

/** Кто наследует имя: объявления, у которых `name` стоит среди родителей. */
export function findSubtypes(text: string, languageId: string | null, name: string): TypeDeclaration[] {
  const target = normalizeBase(name);
  return typeDeclarations(text, languageId).filter((declaration) =>
    declaration.bases.some((base) => normalizeBase(base) === target),
  );
}

/** От кого наследует имя: объявления с таким именем (их родители — ответ). */
export function findSupertypes(text: string, languageId: string | null, name: string): TypeDeclaration[] {
  return typeDeclarations(text, languageId).filter((declaration) => declaration.name === name);
}

/** Наследование по направлению — одна точка входа для вызывающего. */
export function inheritanceMatches(
  text: string,
  languageId: string | null,
  name: string,
  direction: InheritanceDirection,
): TypeDeclaration[] {
  return direction === 'subtypes' ? findSubtypes(text, languageId, name) : findSupertypes(text, languageId, name);
}

// ── JavaScript и TypeScript ──────────────────────────────────────────────────

function stripLineComment(line: string): string {
  const cut = line.indexOf('//');
  return cut < 0 ? line : line.slice(0, cut);
}

const JS_CLASS = /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)([\s\S]*)$/;
const JS_INTERFACE = /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)(.*)$/;
const JS_EXTENDS = /\bextends\s+([A-Za-z_$][\w$.]*)/;
const JS_IMPLEMENTS = /\bimplements\s+([^{]+)/;
const JS_INTERFACE_EXTENDS = /\bextends\s+([^{]+)/;

function jsDeclarations(text: string): TypeDeclaration[] {
  const out: TypeDeclaration[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = stripLineComment(lines[index] ?? '').trim();
    const line = index + 1;

    // Интерфейс проверяем первым: у него имя идёт сразу за словом, без модификаторов класса.
    const iface = JS_INTERFACE.exec(trimmed);
    if (iface) {
      const bases = splitList(JS_INTERFACE_EXTENDS.exec(iface[2] ?? '')?.[1] ?? '');
      out.push({ name: iface[1] ?? '', line, kind: 'interface', bases });
      continue;
    }

    const klass = JS_CLASS.exec(trimmed);
    if (!klass) continue;
    const rest = klass[2] ?? '';
    const bases: string[] = [];
    const parent = JS_EXTENDS.exec(rest)?.[1];
    if (parent) bases.push(parent);
    for (const implemented of splitList(JS_IMPLEMENTS.exec(rest)?.[1] ?? '')) bases.push(implemented);
    out.push({ name: klass[1] ?? '', line, kind: 'class', bases });
  }
  return out.filter((declaration) => declaration.name !== '');
}

// ── Python ───────────────────────────────────────────────────────────────────

const PY_CLASS = /^class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/;

function pythonDeclarations(text: string): TypeDeclaration[] {
  const out: TypeDeclaration[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    // Отступ — вложенный класс: родитель у него есть, но объявление не верхнего уровня.
    if (/^\s/.test(raw)) continue;
    const line = index + 1;
    const match = PY_CLASS.exec(raw);
    if (!match) continue;
    const bases = splitList(match[2] ?? '').filter((base) => !base.includes('=') && !base.startsWith('*'));
    out.push({ name: match[1] ?? '', line, kind: 'class', bases });
  }
  return out;
}

// ── общее ────────────────────────────────────────────────────────────────────

/** Разбить список через запятую: `A, B[C], D` → `['A', 'B[C]', 'D']`. */
function splitList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Имя типа для сравнения: убираем дженерик (`Base<T>` → `Base`) и берём последний отрезок
 * пути (`mod.Base` → `Base`). Так `extends Base<T>` сходится с именем `Base`, а запись
 * через модуль — с коротким именем.
 */
export function normalizeBase(base: string): string {
  const withoutGeneric = base.replace(/[<[].*$/, '').trim();
  const dot = withoutGeneric.lastIndexOf('.');
  return (dot < 0 ? withoutGeneric : withoutGeneric.slice(dot + 1)).trim();
}

// ── результат поиска по проекту ──────────────────────────────────────────────

/** Что спрашивают: имя типа, направление и, необязательно, маска пути. */
export interface InheritanceQuery {
  name: string;
  /** Без направления ищем наследников: это частый вопрос. */
  direction?: InheritanceDirection;
  glob?: string;
}

/** Один файл с найденными объявлениями. */
export interface InheritanceFileHits {
  path: string;
  entries: TypeDeclaration[];
}

/** Итог поиска: файлы с местами, общее число и сколько файлов просмотрено. */
export interface InheritanceResult {
  name: string;
  direction: InheritanceDirection;
  files: InheritanceFileHits[];
  total: number;
  scanned: number;
}
