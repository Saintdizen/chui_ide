/**
 * Где имя объявлено экспортом — разбор по языку.
 *
 * Обычный поиск по тексту нашёл бы `foo` и в вызове, и в комментарии. Здесь вопрос
 * другой: где `foo` ЭКСПОРТИРУЕТСЯ, то есть откуда его можно взять извне модуля.
 * Это нельзя спросить у языкового сервера — такого запроса в LSP нет, — поэтому
 * считаем сами, но не разбором дерева, а разбором строк: экспорт пишется заметно
 * (`export`, `__all__`, `def`/`class` верхнего уровня), и этого достаточно, чтобы
 * показать человеку места, а не гадать.
 *
 * Модуль чистый: ни файлов, ни DOM. Обход проекта и показ — дело вызывающего.
 */

/** Как имя выходит наружу: объявлением, списком, экспортом по умолчанию или звёздочкой. */
export type ExportKind = 'declaration' | 'named' | 'default' | 'star';

export interface ExportedName {
  /** Имя, под которым символ виден снаружи (алиас, если он есть). */
  name: string;
  /** Строка с единицы. */
  line: number;
  kind: ExportKind;
}

/** Языки, у которых мы разбираем экспорты. Прочие честно не обещаем. */
const JS_LANGUAGES = new Set(['typescript', 'javascript']);

/** Есть ли для языка разбор экспортов. */
export function supportsExports(languageId: string | null): boolean {
  return languageId !== null && (JS_LANGUAGES.has(languageId) || languageId === 'python');
}

/** Экспорты в тексте файла. Неизвестный язык — пусто: обещать нечего. */
export function exportedNames(text: string, languageId: string | null): ExportedName[] {
  if (languageId !== null && JS_LANGUAGES.has(languageId)) return jsExports(text);
  if (languageId === 'python') return pythonExports(text);
  return [];
}

// ── JavaScript и TypeScript ──────────────────────────────────────────────────

/** Строка с отрезанным строчным комментарием: `export { a } // примечание` — это `export { a }`. */
function stripLineComment(line: string): string {
  const cut = line.indexOf('//');
  return cut < 0 ? line : line.slice(0, cut);
}

const JS_DECLARATION =
  /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/;
const JS_BRACES = /^export\s*(?:type\s*)?\{([^}]*)\}/;
const JS_STAR_AS = /^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/;
const JS_STAR = /^export\s+\*\s+from\b/;
const JS_DEFAULT = /^export\s+default\b/;
const JS_SPECIFIER = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/;

function jsExports(text: string): ExportedName[] {
  const out: ExportedName[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const trimmed = stripLineComment(lines[index] ?? '').trim();
    if (!trimmed.startsWith('export')) continue;

    const starAs = JS_STAR_AS.exec(trimmed);
    if (starAs) {
      out.push({ name: starAs[1] ?? '*', line, kind: 'star' });
      continue;
    }
    if (JS_STAR.test(trimmed)) {
      out.push({ name: '*', line, kind: 'star' });
      continue;
    }
    if (JS_DEFAULT.test(trimmed)) {
      out.push({ name: 'default', line, kind: 'default' });
      continue;
    }

    const braces = JS_BRACES.exec(trimmed);
    if (braces) {
      for (const specifier of (braces[1] ?? '').split(',')) {
        const match = JS_SPECIFIER.exec(specifier.trim());
        if (!match) continue;
        // Наружу видно имя справа от `as`; без `as` — само имя.
        out.push({ name: match[2] ?? match[1] ?? '', line, kind: 'named' });
      }
      continue;
    }

    const declaration = JS_DECLARATION.exec(trimmed);
    if (declaration) out.push({ name: declaration[1] ?? '', line, kind: 'declaration' });
  }
  return out.filter((entry) => entry.name !== '');
}

// ── Python ───────────────────────────────────────────────────────────────────

/** Строка с отрезанным `#`-комментарием. */
function stripHashComment(line: string): string {
  const cut = line.indexOf('#');
  return cut < 0 ? line : line.slice(0, cut);
}

const PY_DEF = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const PY_CLASS = /^class\s+([A-Za-z_]\w*)/;
const PY_ALL = /^__all__\s*(?::[^=]*)?=/;

function pythonExports(text: string): ExportedName[] {
  const out: ExportedName[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    // Отступ — не верхний уровень: это вложенное объявление, наружу оно не выходит.
    if (/^\s/.test(raw)) continue;
    const line = stripHashComment(raw).trim();

    const all = PY_ALL.exec(line);
    if (all) {
      // `__all__` часто переносят на несколько строк — собираем до закрывающей скобки.
      const startLine = index + 1;
      let collected = line.slice(all[0].length);
      while (!collected.includes(']') && index + 1 < lines.length) {
        index += 1;
        collected += ` ${stripHashComment(lines[index] ?? '')}`;
      }
      for (const match of collected.matchAll(/['"]([^'"]+)['"]/g)) {
        out.push({ name: match[1] ?? '', line: startLine, kind: 'named' });
      }
      continue;
    }

    const definition = PY_DEF.exec(line)?.[1] ?? PY_CLASS.exec(line)?.[1];
    // Приватное (`_name`) наружу не выходит: его и не ищут.
    if (definition && !definition.startsWith('_')) out.push({ name: definition, line: index + 1, kind: 'declaration' });
  }
  return out.filter((entry) => entry.name !== '');
}

// ── результат поиска по проекту ──────────────────────────────────────────────

/** Что спрашивают: имя символа и, необязательно, маска пути. */
export interface ExportsQuery {
  name: string;
  glob?: string;
}

/** Один файл с найденными экспортами. */
export interface ExportFileHits {
  path: string;
  entries: ExportedName[];
}

/** Итог поиска: файлы с местами, общее число и сколько файлов просмотрено. */
export interface ExportsResult {
  name: string;
  files: ExportFileHits[];
  total: number;
  scanned: number;
}
