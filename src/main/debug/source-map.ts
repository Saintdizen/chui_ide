import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-карта: перевод позиций между сгенерированным кодом и исходником.
 *
 * TypeScript, сборщики и минификаторы меняют код так, что строка в исполняемом
 * файле перестаёт совпадать со строкой в исходнике. Карта (`*.js.map`) хранит
 * это соответствие: «строка 3, колонка 0 сгенерированного файла — это строка 2,
 * колонка 2 файла `app.ts`». Отладчику перевод нужен в обе стороны: точку
 * останова, заданную в `.ts`, превратить в исполняемую позицию `.js` (иначе
 * точка встанет не туда), а кадр стека из `.js` — обратно в `.ts` (иначе панель
 * покажет собранный файл, а не тот, что человек открыл).
 *
 * Разбор свой, без зависимости `source-map`: нужны ровно две операции, а
 * библиотека везёт с собой разбор формата целиком. Поддерживается версия 3 —
 * единственная, которую пишут современные компиляторы и сборщики.
 *
 * Позиции внутри модуля нумеруются с нуля (как в формате и как в CDP); DAP
 * считает строки и колонки с единицы, поэтому перевод в адаптере.
 */

/** Таблица цифр VLQ: индекс в этой строке — значение base64-символа. */
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Разбор одного символа быстрый: код символа → цифра, `-1` — символа в VLQ нет. */
const DIGITS = new Int16Array(128).fill(-1);
for (let index = 0; index < BASE64.length; index += 1) DIGITS[BASE64.charCodeAt(index)] = index;

/** Позиция в исходном файле: то, что показывает панель отладки. */
export interface OriginalPosition {
  /** Путь исходника (абсолютный, если карта позволяет его собрать). */
  source: string;
  line: number;
  column: number;
  /** Имя из карты (`names`), если оно у сегмента есть. */
  name: string | null;
}

/** Позиция в сгенерированном файле: туда ставится точка останова. */
export interface GeneratedPosition {
  line: number;
  column: number;
}

/** Один сегмент карты: сгенерированная и исходная позиции одной строки кода. */
interface Mapping {
  generatedLine: number;
  generatedColumn: number;
  sourceIndex: number;
  originalLine: number;
  originalColumn: number;
}

export class SourceMap {
  /** Исходники карты по порядку индексов: индекс `n` — это `sources[n]`. */
  readonly sources: string[];
  /** Имя сгенерированного файла, если карта его записала. */
  readonly file: string | null;

  private readonly mappings: Mapping[];
  /** Сегменты по строке сгенерированного файла — для перевода `.js` → `.ts`. */
  private readonly byGeneratedLine = new Map<number, Mapping[]>();
  /** Сегменты по «исходник + строка» — для перевода `.ts` → `.js`. */
  private readonly byOriginal = new Map<string, Mapping[]>();
  /** Индексы исходников по ключу пути: по нему ищем, знает ли карта файл. */
  private readonly sourceIndexes = new Map<string, number[]>();

  private constructor(sources: string[], file: string | null, mappings: Mapping[]) {
    this.sources = sources;
    this.file = file;
    this.mappings = mappings;

    for (const [index, source] of sources.entries()) {
      const key = pathKey(source);
      const known = this.sourceIndexes.get(key);
      if (known) known.push(index);
      else this.sourceIndexes.set(key, [index]);
    }

    for (const mapping of mappings) {
      const line = this.byGeneratedLine.get(mapping.generatedLine);
      if (line) line.push(mapping);
      else this.byGeneratedLine.set(mapping.generatedLine, [mapping]);

      const key = `${mapping.sourceIndex}:${mapping.originalLine}`;
      const original = this.byOriginal.get(key);
      if (original) original.push(mapping);
      else this.byOriginal.set(key, [mapping]);
    }
    for (const list of this.byOriginal.values()) list.sort((a, b) => a.originalColumn - b.originalColumn);
  }

  /** Разобрать карту из текста. `base` — каталог карты: от него считаются относительные пути. */
  static parse(text: string, base: string): SourceMap | null {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    return SourceMap.fromJson(raw, base);
  }

  static fromJson(raw: unknown, base: string): SourceMap | null {
    if (!raw || typeof raw !== 'object') return null;
    const data = raw as { version?: unknown; sources?: unknown; sourceRoot?: unknown; mappings?: unknown; file?: unknown };
    if (typeof data.mappings !== 'string' || !Array.isArray(data.sources)) return null;
    // Версию не проверяем жёстко: сборщики иногда опускают поле, а формат всё равно третий.
    const sourceRoot = typeof data.sourceRoot === 'string' ? data.sourceRoot : '';
    const sources = data.sources.map((source) => resolveSource(typeof source === 'string' ? source : '', sourceRoot, base));
    return new SourceMap(sources, typeof data.file === 'string' ? data.file : null, decodeMappings(data.mappings));
  }

  /** Знает ли карта такой исходник. */
  hasSource(source: string): boolean {
    return this.sourceIndexes.has(pathKey(source));
  }

  /** Сколько сегментов разобрано — для тестов и диагностики. */
  get size(): number {
    return this.mappings.length;
  }

  /**
   * Позиция в исходнике по позиции в сгенерированном файле.
   *
   * Смотрим сегменты той же строки: берём ближайший слева (колонка сегмента не
   * больше запрошенной). Если слева сегментов нет — первый справа: он всё равно
   * принадлежит этой строке. Чужие строки не подставляем: «сдвинуть» кадр на
   * строку с ближайшим сегментом значило бы показать место, где кода нет.
   */
  originalPositionFor(line: number, column: number): OriginalPosition | null {
    const candidates = this.byGeneratedLine.get(line);
    if (!candidates) return null;

    let left: Mapping | null = null;
    let right: Mapping | null = null;
    for (const mapping of candidates) {
      if (mapping.generatedColumn <= column) {
        if (!left || mapping.generatedColumn > left.generatedColumn) left = mapping;
      } else if (!right || mapping.generatedColumn < right.generatedColumn) {
        right = mapping;
      }
    }

    const chosen = left ?? right;
    if (!chosen) return null;
    const source = this.sources[chosen.sourceIndex];
    if (source === undefined) return null;
    return { source, line: chosen.originalLine, column: chosen.originalColumn, name: null };
  }

  /**
   * Позиция в сгенерированном файле по позиции в исходнике — куда ставить точку
   * останова. Колонка исходника подсказывает, какой сегмент строки выбрать: при
   * `column = 0` это первый сегмент строки, то есть начало исполняемого кода.
   */
  generatedPositionFor(source: string, line: number, column: number): GeneratedPosition | null {
    const indexes = this.sourceIndexes.get(pathKey(source));
    if (!indexes) return null;

    let left: Mapping | null = null;
    let right: Mapping | null = null;
    for (const index of indexes) {
      for (const mapping of this.byOriginal.get(`${index}:${line}`) ?? []) {
        if (mapping.originalColumn <= column) {
          if (!left || mapping.originalColumn > left.originalColumn) left = mapping;
        } else if (!right || mapping.originalColumn < right.originalColumn) {
          right = mapping;
        }
      }
    }

    const chosen = left ?? right;
    return chosen ? { line: chosen.generatedLine, column: chosen.generatedColumn } : null;
  }
}

/**
 * Текст карты из `data:`-ссылки. Компиляторы часто вкладывают карту прямо в
 * файл (`sourceMappingURL=data:application/json;base64,…`), и отдельного файла
 * на диске тогда нет.
 */
export function inlineSourceMap(url: string): string | null {
  if (!url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const body = url.slice(comma + 1);
  if (/;base64/i.test(header)) {
    try {
      return Buffer.from(body, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  try {
    return decodeURIComponent(body);
  } catch {
    return body;
  }
}

/**
 * Ссылка на карту из комментария в коде: `//# sourceMappingURL=app.js.map`.
 *
 * Нужна как запасной путь: инспектор обычно отдаёт ссылку сам (поле
 * `sourceMapURL` события `scriptParsed`), но не для всех скриптов — например,
 * для загруженных из строки.
 */
export function sourceMappingUrlFromSource(source: string): string | null {
  const pattern = /\/\/[#@][ \t]*sourceMappingURL=([^\s'"]+)|\/\*[#@][ \t]*sourceMappingURL=([^\s'"*]+)[ \t]*\*\//g;
  let found: string | null = null;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    found = match[1] ?? match[2] ?? null;
  }
  return found;
}

/**
 * Путь исходника из карты, приведённый к виду, которым пользуется IDE.
 *
 * Абсолютные пути нормализуем, `file://` разворачиваем; ссылки на чужие схемы
 * (например, `webpack://`) оставляем как есть — это не файлы на диске, и
 * открывать по ним нечего.
 */
function resolveSource(raw: string, sourceRoot: string, base: string): string {
  let value = raw.trim();
  if (!value) return value;
  if (sourceRoot) value = joinRoot(sourceRoot, value);
  if (value.startsWith('file:')) {
    try {
      return path.normalize(fileURLToPath(value));
    } catch {
      return value;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.resolve(base, value);
}

function joinRoot(root: string, source: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(root)) {
    try {
      return new URL(source, root.endsWith('/') ? root : `${root}/`).toString();
    } catch {
      return source;
    }
  }
  return path.join(root, source);
}

/** Ключ пути: на Windows один и тот же файл пишут разным регистром. */
function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Разбор VLQ-сегмента: знак закодирован младшим битом значения. */
function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    const digit = code < 128 ? DIGITS[code] : -1;
    if (digit < 0) return []; // мусорный символ — сегмент целиком не наш
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) === 1;
    value >>>= 1;
    values.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  return values;
}

/**
 * Разбор строки `mappings`.
 *
 * Поля сегмента идут дельтой к предыдущему (строка сгенерированного файла — не
 * дельта: она задаётся точкой с запятой). Сегмент из одного поля двигает только
 * колонку и позиции в исходнике не несёт — такие пропускаем.
 */
function decodeMappings(mappings: string): Mapping[] {
  const result: Mapping[] = [];
  let generatedLine = 0;
  let generatedColumn = 0;
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;

  let index = 0;
  while (index < mappings.length) {
    const code = mappings.charCodeAt(index);
    if (code === 59 /* ; */) {
      generatedLine += 1;
      generatedColumn = 0;
      index += 1;
      continue;
    }
    if (code === 44 /* , */) {
      index += 1;
      continue;
    }

    let end = index;
    while (end < mappings.length) {
      const next = mappings.charCodeAt(end);
      if (next === 44 || next === 59) break;
      end += 1;
    }

    const fields = decodeVlq(mappings.slice(index, end));
    index = end;
    if (fields.length === 0) continue;

    generatedColumn += fields[0];
    if (fields.length < 4) continue;

    sourceIndex += fields[1];
    originalLine += fields[2];
    originalColumn += fields[3];
    if (generatedColumn < 0 || sourceIndex < 0 || originalLine < 0 || originalColumn < 0) continue;
    result.push({ generatedLine, generatedColumn, sourceIndex, originalLine, originalColumn });
  }
  return result;
}
