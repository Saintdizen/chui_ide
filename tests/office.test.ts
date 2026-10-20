import { describe, expect, it } from 'vitest';
import {
  MAX_OFFICE_BLOCKS,
  MAX_SHEET_ROWS,
  officeFormatLabel,
  officeKindOf,
  officeRefusal,
  officeSummary,
  officeTabTitle,
  parseDocxDocument,
  parseXlsxRels,
  parseXlsxSharedStrings,
  parseXlsxSheet,
  parseXlsxWorkbook,
} from '../src/shared/office';

/** Документ, как его пишет Word: заголовок, абзац из двух прогонов, список и таблица. */
const DOCX = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Договор</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">Первый </w:t></w:r><w:r><w:t>абзац</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>пункт списка</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:del><w:r><w:t>удалено</w:t></w:r></w:del><w:r><w:t>осталось</w:t></w:r></w:p>
</w:body></w:document>`;

describe('разбор docx', () => {
  it('собирает абзац из прогонов и узнаёт стиль', () => {
    const { blocks } = parseDocxDocument(DOCX);
    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, text: 'Договор' });
    expect(blocks[1]).toEqual({ kind: 'paragraph', text: 'Первый абзац' });
  });

  it('пункт списка отличается от абзаца', () => {
    const { blocks } = parseDocxDocument(DOCX);
    expect(blocks[2]).toEqual({ kind: 'list', level: 0, text: 'пункт списка' });
  });

  it('таблица приходит строками, пустая ячейка остаётся', () => {
    const { blocks } = parseDocxDocument(DOCX);
    expect(blocks[3]).toEqual({
      kind: 'table',
      rows: [
        ['A1', 'B1'],
        ['A2', ''],
      ],
    });
  });

  it('удалённые правки не читаются, остальной текст абзаца цел', () => {
    const { blocks } = parseDocxDocument(DOCX);
    expect(blocks[4]).toEqual({ kind: 'paragraph', text: 'осталось' });
  });

  it('длинный документ обрезается и говорит об этом', () => {
    const paragraphs = Array.from(
      { length: MAX_OFFICE_BLOCKS + 20 },
      (_, index) => `<w:p><w:r><w:t>строка ${index}</w:t></w:r></w:p>`,
    );
    const xml = `<w:document><w:body>${paragraphs.join('')}</w:body></w:document>`;
    const { blocks, truncated } = parseDocxDocument(xml);
    expect(blocks.length).toBe(MAX_OFFICE_BLOCKS);
    expect(truncated).toBe(true);
  });
});

describe('разбор книги xlsx', () => {
  const WORKBOOK = `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Данные" sheetId="1" r:id="rId1"/><sheet name="Итоги" sheetId="2" r:id="rId2"/></sheets>
</workbook>`;
  const RELS = `<Relationships>
  <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/>
</Relationships>`;
  const SHARED = `<sst><si><t>Товар</t></si><si><r><t>Молоко</t></r><r><t xml:space="preserve"> 2%</t></r></si></sst>`;

  it('берёт имена листов и их связи', () => {
    expect(parseXlsxWorkbook(WORKBOOK)).toEqual([
      { name: 'Данные', rid: 'rId1' },
      { name: 'Итоги', rid: 'rId2' },
    ]);
    const rels = parseXlsxRels(RELS);
    expect(rels.get('rId1')).toBe('worksheets/sheet1.xml');
    expect(rels.get('rId2')).toBe('/xl/worksheets/sheet2.xml');
  });

  it('склеивает общую строку из кусков форматирования', () => {
    expect(parseXlsxSharedStrings(SHARED)).toEqual(['Товар', 'Молоко 2%']);
  });
});

describe('лист книги', () => {
  it('ставит ячейки по адресу: пропуски остаются пустыми', () => {
    const sheet = `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="3"><c r="B3" t="inlineStr"><is><t>пропуск</t></is></c><c r="C3"><v>42</v></c></row>
    </sheetData></worksheet>`;
    const { rows } = parseXlsxSheet(sheet, ['Товар', 'Молоко 2%']);
    expect(rows).toEqual([['Товар', 'Молоко 2%'], [], ['', 'пропуск', '42']]);
  });

  it('уставший лист обрезается по потолку строк и говорит об этом', () => {
    const rows = Array.from(
      { length: MAX_SHEET_ROWS + 5 },
      (_, index) => `<row r="${index + 1}"><c r="A1"><v>${index}</v></c></row>`,
    );
    const xml = `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`;
    const parsed = parseXlsxSheet(xml, []);
    expect(parsed.rows.length).toBe(MAX_SHEET_ROWS);
    expect(parsed.truncated).toBe(true);
  });
});

describe('правила предпросмотра', () => {
  it('узнаёт вид по имени файла', () => {
    expect(officeKindOf('/проект/Договор.DOCX')).toBe('docx');
    expect(officeKindOf('/проект/Отчёт.xlsx')).toBe('xlsx');
    expect(officeKindOf('/проект/readme.md')).toBeNull();
    expect(officeFormatLabel('/a/b.xlsx')).toBe('XLSX');
    expect(officeTabTitle('/a/b/Договор.docx')).toBe('Договор.docx');
  });

  it('называет объём и обрезку в подписи', () => {
    const docx = officeSummary({
      kind: 'docx',
      bytes: 2048,
      blocks: [{ kind: 'paragraph', text: 'x' }],
      truncated: false,
    });
    expect(docx).toBe('DOCX · 1 блок · 2 КБ');
    const book = officeSummary({ kind: 'xlsx', bytes: 2048, sheets: [], truncated: true });
    expect(book).toContain('показано не всё');
  });

  it('отказывает словами на чужой файл и слишком большой документ', () => {
    expect(officeRefusal(null, 10)).toBe('Предпросмотр показывает .docx и .xlsx');
    expect(officeRefusal('docx', 64 * 1024 * 1024)).toContain('больше предела');
    expect(officeRefusal('docx', 1024)).toBeNull();
  });
});
