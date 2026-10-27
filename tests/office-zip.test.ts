import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseOfficeDocument } from '../src/main/doc/office';
import { isZipFile, readZipEntries } from '../src/main/doc/zip';

/** Собрать zip так, как его пишет Office: локальные записи, оглавление, EOCD. */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const LIMITS = { maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 };

describe('чтение архива', () => {
  it('достаёт только запрошенные части', () => {
    const archive = zipOf({ 'a.txt': 'первая', 'b.txt': 'вторая' });
    expect(isZipFile(archive)).toBe(true);
    const entries = readZipEntries(archive, ['b.txt'], LIMITS);
    expect(entries.get('b.txt')?.toString('utf8')).toBe('вторая');
    expect(entries.has('a.txt')).toBe(false);
  });

  it('не-архив отвергает словами', () => {
    expect(isZipFile(Buffer.from('обычный текст'))).toBe(false);
    expect(() => readZipEntries(Buffer.from('обычный текст'), ['a'], LIMITS)).toThrow(/не похож на zip/);
  });

  it('часть сверх потолка не распаковывается вовсе', () => {
    const archive = zipOf({ 'big.txt': 'я'.repeat(4096) });
    expect(() => readZipEntries(archive, ['big.txt'], { maxEntryBytes: 100, maxTotalBytes: 1024 })).toThrow(
      /больше предела/,
    );
  });
});

describe('предпросмотр целиком', () => {
  const DOCX_XML = `<w:document><w:body>
    <w:p><w:r><w:t>Первый абзац</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Раздел</w:t></w:r></w:p>
  </w:body></w:document>`;

  it('docx разбирается из архива', () => {
    const archive = zipOf({ 'word/document.xml': DOCX_XML });
    const preview = parseOfficeDocument(archive, '/проект/Договор.docx');
    expect(preview.kind).toBe('docx');
    if (preview.kind !== 'docx') return;
    expect(preview.blocks).toEqual([
      { kind: 'paragraph', text: 'Первый абзац' },
      { kind: 'heading', level: 2, text: 'Раздел' },
    ]);
    expect(preview.bytes).toBe(archive.byteLength);
  });

  it('docx без текстовой части объясняет отказ', () => {
    const archive = zipOf({ 'word/styles.xml': '<styles/>' });
    expect(() => parseOfficeDocument(archive, '/проект/Договор.docx')).toThrow(/word\/document\.xml/);
  });
});

describe('книга из архива', () => {
  const BOOK = {
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="Данные" r:id="rId1"/><sheet name="Пусто" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Товар</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>7</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  };

  it('листы идут по порядку книги, ячейки на своих местах', () => {
    const preview = parseOfficeDocument(zipOf(BOOK), '/проект/Отчёт.xlsx');
    expect(preview.kind).toBe('xlsx');
    if (preview.kind !== 'xlsx') return;
    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(['Данные', 'Пусто']);
    expect(preview.sheets[0]!.rows).toEqual([['Товар', '7']]);
    expect(preview.sheets[1]!.rows).toEqual([]);
    expect(preview.truncated).toBe(false);
  });

  it('без оглавления книги предпросмотра нет', () => {
    const archive = zipOf({ 'xl/sharedStrings.xml': '<sst/>' });
    expect(() => parseOfficeDocument(archive, '/проект/Отчёт.xlsx')).toThrow(/xl\/workbook\.xml/);
  });

  it('чужой файл предпросмотром не открывается', () => {
    expect(() => parseOfficeDocument(zipOf({}), '/проект/readme.md')).toThrow(/docx и \.xlsx/);
  });
});
