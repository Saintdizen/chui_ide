/**
 * Документ Office разбирается в структуру для предпросмотра.
 *
 * Чистое чтение XML живёт в `shared/office.ts` (его же проверяют тесты без Electron),
 * а здесь — распаковка нужных частей архива и сборка ответа. Части читаются по именам:
 * книга на сотню листов распаковывается в разы больше исходника.
 */

import {
  MAX_SHEETS,
  officeKindOf,
  parseDocxDocument,
  parseXlsxRels,
  parseXlsxSharedStrings,
  parseXlsxSheet,
  parseXlsxWorkbook,
  type OfficePreview,
  type OfficeSheet,
} from '../../shared/office';
import { readZipEntries } from './zip';

/** Потолки распаковки: одна часть 24 МБ, всё вместе — 64 МБ. */
const LIMITS = { maxEntryBytes: 24 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

const DOCX_DOCUMENT = 'word/document.xml';
const XLSX_WORKBOOK = 'xl/workbook.xml';
const XLSX_RELS = 'xl/_rels/workbook.xml.rels';
const XLSX_SHARED = 'xl/sharedStrings.xml';

/** Текст части архива; нет части — пустая строка. */
function partText(entries: Map<string, Buffer>, name: string): string {
  return entries.get(name)?.toString('utf8') ?? '';
}

/**
 * Путь листа из связи: `worksheets/sheet1.xml` считается от папки `xl/`, но бывает
 * и абсолютный. Сегменты `..` разворачиваем, иначе имя части не совпадёт с архивом.
 */
function sheetPartPath(target: string): string {
  const clean = target.replace(/\\/g, '/');
  const parts = (clean.startsWith('/') ? clean.slice(1) : `xl/${clean}`).split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

/** Собрать предпросмотр документа по его содержимому. */
export function parseOfficeDocument(buffer: Buffer, filePath: string): OfficePreview {
  const kind = officeKindOf(filePath);
  if (kind === null) throw new Error('Предпросмотр показывает .docx и .xlsx');
  const bytes = buffer.byteLength;

  if (kind === 'docx') {
    const entries = readZipEntries(buffer, [DOCX_DOCUMENT], LIMITS);
    const xml = partText(entries, DOCX_DOCUMENT);
    if (xml === '') throw new Error('В документе нет текста: не нашлась часть word/document.xml');
    const parsed = parseDocxDocument(xml);
    return { kind: 'docx', bytes, blocks: parsed.blocks, truncated: parsed.truncated };
  }

  // Сначала оглавление книги: имена листов и связи с частями.
  const head = readZipEntries(buffer, [XLSX_WORKBOOK, XLSX_RELS, XLSX_SHARED], LIMITS);
  const workbookXml = partText(head, XLSX_WORKBOOK);
  if (workbookXml === '') throw new Error('В книге нет листов: не нашлась часть xl/workbook.xml');
  const refs = parseXlsxWorkbook(workbookXml).slice(0, MAX_SHEETS);
  const rels = parseXlsxRels(partText(head, XLSX_RELS));
  const sharedXml = partText(head, XLSX_SHARED);
  const shared = sharedXml === '' ? [] : parseXlsxSharedStrings(sharedXml);

  const names = new Map<string, string>();
  const parts: string[] = [];
  for (const ref of refs) {
    const target = rels.get(ref.rid);
    if (target === undefined) continue;
    const part = sheetPartPath(target);
    names.set(part, ref.name);
    parts.push(part);
  }

  const sheetEntries = readZipEntries(buffer, parts, LIMITS);
  const sheets: OfficeSheet[] = [];
  let truncated = false;
  for (const part of parts) {
    const xml = partText(sheetEntries, part);
    // Нет части — лист пуст, а не обрезан: пустой лист бывает и по-настоящему.
    const parsed = xml === '' ? { rows: [], truncated: false } : parseXlsxSheet(xml, shared);
    if (parsed.truncated) truncated = true;
    sheets.push({ name: names.get(part) ?? 'Лист', rows: parsed.rows });
  }
  return { kind: 'xlsx', bytes, sheets, truncated };
}
