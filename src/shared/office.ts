/**
 * Документы Office (.docx, .xlsx) как вкладка-просмотр: правила, общие для main и renderer.
 *
 * Текстом такой файл не открыть: это zip с XML внутри, и в документ редактора попал бы
 * бинарь. Показывать его собственным просмотрщиком движка нельзя (в отличие от PDF —
 * тот Chromium рисует сам), а тащить в поставку Python с `python-docx` и `openpyxl`
 * ради предпросмотра — целая зависимость на ровном месте. Поэтому здесь свой разбор:
 * распаковка zip в main (`main/doc/zip.ts`) и чтение XML по частям — стандарт Office
 * Open XML, где текст абзаца лежит в `w:t`, а ячейка листа — в `c/v`.
 *
 * Разбор считает только то, что видно человеку: заголовки, абзацы, списки, таблицы и
 * ячейки. Стили, шрифты, колонтитулы и формулы не разбираются — предпросмотр отвечает
 * на вопрос «что в этом файле», а не «как он сверстан». Потолки (блоки, символы, строки,
 * листы) стоят до отрисовки: документ на 5 000 страниц не должен вешать окно.
 *
 * Функции разбора принимают уже распакованные строки XML — так их можно проверить
 * юнит-тестом без zip и без Electron. Распаковка отдельно (`main/doc/zip.ts`).
 */

import { formatBytes } from './images';

/** Что из Office мы умеем показывать. */
export type OfficeKind = 'docx' | 'xlsx';

/** Расширение (без точки, в нижнем регистре); пустая строка — расширения нет. */
function extensionOf(filePath: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Вид документа по имени файла; `null` — это не docx и не xlsx. */
export function officeKindOf(filePath: string): OfficeKind | null {
  const extension = extensionOf(filePath);
  if (extension === 'docx') return 'docx';
  if (extension === 'xlsx') return 'xlsx';
  return null;
}

/** Открывать ли файл предпросмотром документа, а не редактором. */
export function isOfficePath(filePath: string): boolean {
  return officeKindOf(filePath) !== null;
}

/** Подпись формата для интерфейса: «DOCX», «XLSX». */
export function officeFormatLabel(filePath: string): string {
  const kind = officeKindOf(filePath);
  if (kind === null) return 'Документ';
  return kind.toUpperCase();
}

/** Подпись вкладки: имя файла, а не путь целиком — путь не влезает в полосу. */
export function officeTabTitle(filePath: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  return name || 'Документ';
}

/**
 * Предел на файл для предпросмотра. Документ разбирается в памяти целиком, и
 * распаковка может дать в разы больше исходника (XML сжимается отлично), поэтому
 * «презентация на 400 МБ» здесь не открывается — пусть её откроет система.
 */
export const MAX_VIEW_OFFICE_BYTES = 32 * 1024 * 1024;

/** Сколько блоков текста показываем: дальше документ читают не в окне IDE. */
export const MAX_OFFICE_BLOCKS = 400;
/** Потолок текста всего документа — считаем по символам, а не по блокам. */
export const MAX_OFFICE_TEXT_CHARS = 200_000;
/** Строк и колонок в одной таблице docx. */
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLUMNS = 30;
/** Листов книги и потолки одного листа. */
export const MAX_SHEETS = 20;
export const MAX_SHEET_ROWS = 500;
export const MAX_SHEET_COLUMNS = 40;
/** Сколько общих строк (shared strings) держим из книги. */
export const MAX_SHARED_STRINGS = 20_000;

/** Кусок документа словами: заголовок, абзац, пункт списка или таблица. */
export type OfficeBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; level: number; text: string }
  | { kind: 'table'; rows: string[][] };

/** Лист книги: имя и строки ячеек. */
export interface OfficeSheet {
  name: string;
  rows: string[][];
}

/** Готовый к показу документ. Вид решает, что рисовать: блоки или листы. */
export type OfficePreview =
  | { kind: 'docx'; bytes: number; blocks: OfficeBlock[]; truncated: boolean }
  | { kind: 'xlsx'; bytes: number; sheets: OfficeSheet[]; truncated: boolean };

/** Склонение по-русски: 1 лист, 2 листа, 5 листов. */
function plural(count: number, one: string, few: string, many: string): string {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return many;
  const last = count % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/** Строка для шапки вьюера: формат, объём и оговорка об обрезке. */
export function officeSummary(preview: OfficePreview): string {
  if (preview.kind === 'docx') {
    const parts = [
      'DOCX',
      `${preview.blocks.length} ${plural(preview.blocks.length, 'блок', 'блока', 'блоков')}`,
      formatBytes(preview.bytes),
    ];
    if (preview.truncated) parts.push('показано не всё');
    return parts.join(' · ');
  }
  const parts = [
    'XLSX',
    `${preview.sheets.length} ${plural(preview.sheets.length, 'лист', 'листа', 'листов')}`,
    formatBytes(preview.bytes),
  ];
  if (preview.truncated) parts.push('показано не всё');
  return parts.join(' · ');
}

/** Отказ словами, если файл предпросмотром не открыть; `null` — можно. */
export function officeRefusal(kind: OfficeKind | null, bytes: number): string | null {
  if (kind === null) return 'Предпросмотр показывает .docx и .xlsx';
  if (bytes > MAX_VIEW_OFFICE_BYTES) {
    return `Файл ${formatBytes(bytes)} больше предела предпросмотра ${formatBytes(MAX_VIEW_OFFICE_BYTES)}`;
  }
  return null;
}

/* ── разбор XML ──────────────────────────────────────────────────────────── */

/**
 * Событие разбора: открытие тега, закрытие или текст между ними.
 *
 * Своего XML-разборщика в проекте нет, а полноценный (с пространствами имён и
 * проверкой схемы) здесь не нужен: Open XML — это дерево из элементов, и нам
 * важны только имена тегов и два-три атрибута. Событийный вид выбран не из
 * любви к генераторам: `word/document.xml` у большого документа — это десятки
 * мегабайт, и дерево из них в памяти не нужно вовсе.
 */
type XmlEvent =
  | { type: 'open'; name: string; attrs: Record<string, string> }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string };

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Раскодировать `&amp;`, `&#171;` и прочие сущности: их в тексте документа полно. */
function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    let code = Number.NaN;
    if (body.startsWith('#x') || body.startsWith('#X')) code = Number.parseInt(body.slice(2), 16);
    else if (body.startsWith('#')) code = Number.parseInt(body.slice(1), 10);
    if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code);
    return XML_ENTITIES[body] ?? whole;
  });
}

/** Где кончается тег, начавшийся в `from`. Кавычки в атрибутах учитываются — `>` в них бывает. */
function tagEnd(xml: string, from: number): number {
  let quote = '';
  for (let index = from + 1; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote !== '') {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

/** Атрибуты тега в плоский набор. Значение без кавычек тоже понимаем — так пишут не всегда. */
function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(raw);
  while (match !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
    match = pattern.exec(raw);
  }
  return attrs;
}

/**
 * События XML по порядку. Комментарии, CDATA, `<?xml …?>` и `<!DOCTYPE …>` пропускаем
 * как служебное: показывать их человеку нечего, а разбирать — незачем.
 *
 * Самозакрывающийся тег отдаётся двумя событиями (открытие и закрытие): обработчику
 * проще не помнить, у какого тега закрытие может не прийти.
 */
function* xmlEvents(xml: string): Generator<XmlEvent> {
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf('<', index);
    if (lt < 0) {
      yield { type: 'text', text: xml.slice(index) };
      return;
    }
    if (lt > index) yield { type: 'text', text: xml.slice(index, lt) };
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      index = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      yield { type: 'text', text: xml.slice(lt + 9, end < 0 ? xml.length : end) };
      index = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = tagEnd(xml, lt);
      index = end < 0 ? xml.length : end + 1;
      continue;
    }
    const end = tagEnd(xml, lt);
    if (end < 0) return;
    const raw = xml.slice(lt + 1, end).trim();
    index = end + 1;
    if (raw === '') continue;
    if (raw.startsWith('/')) {
      yield { type: 'close', name: raw.slice(1).trim() };
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const space = body.search(/\s/);
    const name = space < 0 ? body : body.slice(0, space);
    yield { type: 'open', name, attrs: space < 0 ? {} : parseAttributes(body.slice(space + 1)) };
    if (selfClosing) yield { type: 'close', name };
  }
}

/** Сжать пробелы: Word любит ставить их пачками и тащить переводы строк из вёрстки. */
function normalizeSpace(value: string): string {
  return value
    .replace(/[\t\u00a0 ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Уровень заголовка по имени стиля Word: `Heading2` → 2, `Title` → 1, иначе 0. */
function headingLevel(style: string): number {
  if (style === 'Title' || style === 'Заголовок') return 1;
  if (style === 'Subtitle' || style === 'Подзаголовок') return 2;
  const match = /^(?:Heading|heading|Заголовок)\s*(\d)$/.exec(style);
  return match ? Math.min(6, Math.max(1, Number.parseInt(match[1], 10))) : 0;
}

/**
 * Разбор `word/document.xml` в блоки.
 *
 * Текст абзаца Word раскладывает по прогонам (`w:r`), идущим подряд: «жирное» и
 * «обычное» слова — разные прогоны, а читается это одним абзацем. Поэтому текст
 * собирается с открытия `w:p` до его закрытия, а не по прогонам. Удалённые правки
 * (`w:del`) и коды полей (`w:instrText`) пропускаются: в документе их не видно.
 */
export function parseDocxDocument(xml: string): { blocks: OfficeBlock[]; truncated: boolean } {
  const blocks: OfficeBlock[] = [];
  let truncated = false;
  let chars = 0;

  /** Абзац, который сейчас собирается. */
  let paragraph: { text: string; heading: number; list: boolean } | null = null;
  /** Таблица: строки и текущая ячейка (ячейка может состоять из нескольких абзацев). */
  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;
  let nestedTables = 0;
  /** Вложенные `w:del` и полевые инструкции: их текст не читаем. */
  let deleted = 0;
  let instructions = 0;
  /** Глубина `w:t`: текст между тегами — только внутри него. */
  let inText = 0;

  const appendText = (value: string): void => {
    const room = MAX_OFFICE_TEXT_CHARS - chars;
    if (value.length > room) {
      truncated = true;
      value = value.slice(0, Math.max(0, room));
    }
    if (value === '') return;
    chars += value.length;
    if (cell !== null) cell += value;
    else if (paragraph !== null) paragraph.text += value;
  };

  const pushBlock = (block: OfficeBlock): void => {
    if (blocks.length >= MAX_OFFICE_BLOCKS) {
      truncated = true;
      return;
    }
    blocks.push(block);
  };

  for (const event of xmlEvents(xml)) {
    if (event.type === 'text') {
      if (inText === 0 || deleted > 0 || instructions > 0) continue;
      appendText(decodeXmlEntities(event.text));
      continue;
    }

    if (event.type === 'open') {
      switch (event.name) {
        case 'w:t':
          inText += 1;
          break;
        case 'w:tab':
          if (inText > 0) appendText('\t');
          break;
        case 'w:br':
        case 'w:cr':
          if (inText > 0) appendText('\n');
          break;
        case 'w:p':
          paragraph = { text: '', heading: 0, list: false };
          break;
        case 'w:pStyle':
          if (paragraph !== null) paragraph.heading = headingLevel(event.attrs['w:val'] ?? '');
          break;
        case 'w:numPr':
          if (paragraph !== null) paragraph.list = true;
          break;
        case 'w:del':
          deleted += 1;
          break;
        case 'w:instrText':
        case 'w:delInstrText':
          instructions += 1;
          break;
        case 'w:tbl':
          // Вложенную таблицу не разбираем: её видно в ячейке текстом, а вторая
          // сетка внутри первой превратила бы предпросмотр в кашу.
          if (table !== null) nestedTables += 1;
          else {
            table = [];
            row = null;
          }
          break;
        case 'w:tr':
          if (table !== null && nestedTables === 0) row = [];
          break;
        case 'w:tc':
          if (table !== null && nestedTables === 0) cell = '';
          break;
        default:
          break;
      }
      continue;
    }

    switch (event.name) {
      case 'w:t':
        if (inText > 0) inText -= 1;
        break;
      case 'w:del':
        if (deleted > 0) deleted -= 1;
        break;
      case 'w:instrText':
      case 'w:delInstrText':
        if (instructions > 0) instructions -= 1;
        break;
      case 'w:p': {
        const current = paragraph;
        paragraph = null;
        if (current === null) break;
        const text = normalizeSpace(current.text);
        if (cell !== null) {
          if (text !== '') cell = cell === '' ? text : `${cell}\n${text}`;
          break;
        }
        if (text === '') break;
        if (current.heading > 0) pushBlock({ kind: 'heading', level: current.heading, text });
        else if (current.list) pushBlock({ kind: 'list', level: 0, text });
        else pushBlock({ kind: 'paragraph', text });
        break;
      }
      case 'w:tc':
        if (cell !== null && row !== null) {
          // Пустые ячейки сохраняем: без них таблица съедет по колонкам.
          row.push(normalizeSpace(cell));
          cell = null;
        }
        break;
      case 'w:tr':
        if (table !== null && row !== null && nestedTables === 0) {
          if (table.length >= MAX_TABLE_ROWS) truncated = true;
          else table.push(row.slice(0, MAX_TABLE_COLUMNS));
          row = null;
        }
        break;
      case 'w:tbl':
        if (nestedTables > 0) {
          nestedTables -= 1;
          break;
        }
        if (table !== null) {
          if (table.length > 0) pushBlock({ kind: 'table', rows: table });
          table = null;
          row = null;
          cell = null;
        }
        break;
      default:
        break;
    }
  }

  return { blocks, truncated };
}

/**
 * Общие строки книги (`xl/sharedStrings.xml`): ячейки листа ссылаются на них номером.
 *
 * Строка может быть собрана из кусков форматирования (`w:r`), поэтому все `t`
 * внутри одного `si` склеиваются — иначе «полужирное» слово выпало бы из текста.
 */
export function parseXlsxSharedStrings(xml: string): string[] {
  const values: string[] = [];
  let current: string | null = null;
  let inText = 0;

  for (const event of xmlEvents(xml)) {
    if (event.type === 'text') {
      if (current !== null && inText > 0) current += decodeXmlEntities(event.text);
      continue;
    }
    if (event.type === 'open') {
      if (event.name === 'si') current = '';
      else if (event.name === 't') inText += 1;
      continue;
    }
    if (event.name === 't') {
      if (inText > 0) inText -= 1;
      continue;
    }
    if (event.name === 'si') {
      values.push(current ?? '');
      current = null;
      if (values.length >= MAX_SHARED_STRINGS) break;
    }
  }
  return values;
}

/** Лист в книге: имя и связь (`r:id`) с файлом содержимого. */
export interface XlsxSheetRef {
  name: string;
  rid: string;
}

/** `xl/workbook.xml`: порядок листов и их имена. */
export function parseXlsxWorkbook(xml: string): XlsxSheetRef[] {
  const sheets: XlsxSheetRef[] = [];
  for (const event of xmlEvents(xml)) {
    if (event.type !== 'open' || event.name !== 'sheet') continue;
    const name = (event.attrs.name ?? '').trim() || `Лист ${sheets.length + 1}`;
    sheets.push({ name, rid: event.attrs['r:id'] ?? '' });
    if (sheets.length >= MAX_SHEETS) break;
  }
  return sheets;
}

/** `xl/_rels/workbook.xml.rels`: связь `r:id` → путь к файлу листа. */
export function parseXlsxRels(xml: string): Map<string, string> {
  const relations = new Map<string, string>();
  for (const event of xmlEvents(xml)) {
    if (event.type !== 'open' || event.name !== 'Relationship') continue;
    const id = event.attrs.Id;
    const target = event.attrs.Target;
    if (id !== undefined && target !== undefined) relations.set(id, target);
  }
  return relations;
}

/** Колонка по адресу ячейки: `B12` → 1, `AA3` → 26 (нумерация с нуля). */
function columnIndex(address: string): number {
  let index = 0;
  for (const char of address) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return Math.max(0, index - 1);
}

/** Значение ячейки: строки лежат в общей таблице, остальное — как записано. */
function cellText(cell: { type: string; value: string }, shared: readonly string[]): string {
  switch (cell.type) {
    case 's': {
      const index = Number.parseInt(cell.value, 10);
      return Number.isFinite(index) ? (shared[index] ?? '') : '';
    }
    case 'b':
      return cell.value === '1' ? 'TRUE' : cell.value === '0' ? 'FALSE' : cell.value;
    default:
      // Числа, формулы-строки и ошибки показываем как записаны: пересчитывать
      // книгу — не задача предпросмотра.
      return cell.value;
  }
}

/**
 * Разбор листа (`xl/worksheets/sheetN.xml`).
 *
 * Строки и колонки в файле разреженные: `<row r="5">` и `<c r="C1">` задают адрес,
 * а пропущенное между ними — пусто. Поэтому ячейки ставятся по номеру колонки, а
 * пропущенные строки добавляются пустыми — иначе таблица съехала бы вверх.
 */
export function parseXlsxSheet(xml: string, shared: readonly string[]): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;
  let row: string[] = [];
  let cell: { column: number; type: string; value: string } | null = null;
  let inValue = 0;

  const flushRow = (): void => {
    if (rows.length >= MAX_SHEET_ROWS) {
      truncated = true;
      row = [];
      return;
    }
    rows.push(row.slice(0, MAX_SHEET_COLUMNS));
    row = [];
  };

  for (const event of xmlEvents(xml)) {
    if (event.type === 'text') {
      if (cell !== null && inValue > 0) cell.value += decodeXmlEntities(event.text);
      continue;
    }

    if (event.type === 'open') {
      switch (event.name) {
        case 'row': {
          const index = Number.parseInt(event.attrs.r ?? '', 10);
          // Строки между прошлой и этой не занимали памяти — вставляем пустые.
          if (Number.isFinite(index) && index > 1) {
            while (rows.length < index - 1 && rows.length < MAX_SHEET_ROWS) flushRow();
            if (rows.length < index - 1) truncated = true;
          }
          break;
        }
        case 'c':
          cell = { column: columnIndex(event.attrs.r ?? ''), type: event.attrs.t ?? 'n', value: '' };
          break;
        case 'v':
        case 't':
          inValue += 1;
          break;
        default:
          break;
      }
      continue;
    }

    switch (event.name) {
      case 'v':
      case 't':
        if (inValue > 0) inValue -= 1;
        break;
      case 'c':
        if (cell !== null) {
          if (cell.column >= MAX_SHEET_COLUMNS) {
            truncated = true;
          } else {
            // Пустые ячейки слева нужны: иначе значения съедут по колонкам.
            while (row.length < cell.column) row.push('');
            row[cell.column] = cellText(cell, shared);
          }
          cell = null;
        }
        break;
      case 'row':
        flushRow();
        break;
      default:
        break;
    }
  }

  // Файл без закрывающих тегов (обрезанный) — показываем то, что успели собрать.
  if (row.length > 0) flushRow();
  return { rows, truncated };
}
