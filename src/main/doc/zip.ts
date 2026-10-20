/**
 * Чтение zip для предпросмотра документов Office.
 *
 * `.docx` и `.xlsx` — это zip с XML внутри. Библиотеку ради двух файлов не тянем:
 * формат простой (записи, оглавление в конце, сжатие deflate), а `zlib` в Node уже
 * есть. Читаем ТОЛЬКО нужные записи, а не весь архив: книга на сотню листов распаковывается
 * в разы больше исходника, и «прочитать всё, потом поискать» — это способ съесть память
 * на файле, который человек открыл посмотреть один абзац.
 *
 * Потолки здесь обязательны, и оба: на запись и на сумму. Zip сжимает отлично, и
 * документ в 100 КБ может распаковаться в гигабайты; проверять размер после распаковки
 * поздно — память уже потрачена, поэтому потолок стоит ДО `inflate`.
 */

import { inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/** В конце архива — оглавление: его ищем в хвосте файла, а не по всему объёму. */
const EOCD_SEARCH_BYTES = 66_000;

export interface ZipLimits {
  /** Потолок одной записи после распаковки. */
  maxEntryBytes: number;
  /** Потолок всего распакованного за один вызов. */
  maxTotalBytes: number;
}

/** Похоже ли это на zip: у документа Office первой должна идти локальная запись. */
export function isZipFile(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === SIG_LOCAL;
}

/** Где кончается оглавление: смещение записи EOCD или -1. */
function findEocd(buffer: Buffer): number {
  const last = buffer.length - 22;
  const first = Math.max(0, buffer.length - EOCD_SEARCH_BYTES);
  for (let offset = last; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) return offset;
  }
  return -1;
}

/**
 * Достать записи по именам. Нет записи в архиве — её нет и в результате: вызывающий
 * сам решает, ошибка это или необязательная часть (у книги может не быть строк-строк).
 */
export function readZipEntries(buffer: Buffer, names: readonly string[], limits: ZipLimits): Map<string, Buffer> {
  const wanted = new Set(names);
  const entries = new Map<string, Buffer>();
  if (wanted.size === 0) return entries;
  if (!isZipFile(buffer)) throw new Error('Это не документ Office: файл не похож на zip-архив');

  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('Архив повреждён: в конце нет оглавления');
  const count = buffer.readUInt16LE(eocd + 10);
  const start = buffer.readUInt32LE(eocd + 16);
  if (start >= buffer.length) throw new Error('Архив повреждён: оглавление за пределами файла');

  let total = 0;
  let offset = start;
  for (let index = 0; index < count && entries.size < wanted.size; index += 1) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (!wanted.has(name)) continue;
    // 0xFFFFFFFF — признак zip64: такой архив больше 4 ГБ, и он нам не нужен.
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) {
      throw new Error(`Часть «${name}»: архив слишком большой (zip64)`);
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new Error(`Часть «${name}» после распаковки больше предела предпросмотра`);
    }
    total += uncompressedSize;
    if (total > limits.maxTotalBytes) {
      throw new Error('Документ распаковывается в слишком большой объём');
    }
    entries.set(name, extractEntry(buffer, name, localOffset, method, compressedSize, uncompressedSize));
  }

  return entries;
}

/** Распаковать одну запись по её месту в архиве. */
function extractEntry(
  buffer: Buffer,
  name: string,
  localOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Buffer {
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new Error(`Часть «${name}»: битый заголовок в архиве`);
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buffer.length) throw new Error(`Часть «${name}»: данные выходят за пределы файла`);
  const data = buffer.subarray(dataStart, dataEnd);

  if (method === 0) {
    if (compressedSize !== uncompressedSize) throw new Error(`Часть «${name}»: размеры не совпадают`);
    return Buffer.from(data);
  }
  if (method !== 8) throw new Error(`Часть «${name}»: сжатие методом ${method} не поддерживается`);
  // Потолок вывода ещё и здесь: оглавлению можно и не поверить.
  return inflateRawSync(data, { maxOutputLength: Math.max(1, uncompressedSize) });
}
