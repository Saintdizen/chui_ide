/**
 * Таблица кусков (piece table) — как хранится текст документа.
 *
 * Зачем своя структура, а не обычная строка: правка в строке — это пересборка
 * строки целиком, то есть работа O(размера файла) на каждый набранный символ. На
 * файле в 100 000 строк это заметно на глаз — ввод «плывёт». Таблица кусков хранит
 * текст как список ссылок на два буфера и правит только крайние куски: вставка
 * символа — разделение одного куска и добавление нового, то есть работа на длину
 * правки, а не на длину файла.
 *
 * Два буфера (так же устроены известные редакторы; оригинальная идея — Wagner, 1998):
 *
 *   • `original` — текст, каким он был при открытии файла. Не меняется никогда,
 *     поэтому на него можно ссылаться сколько угодно раз, ничего не копируя. Это
 *     и есть выигрыш: файл целиком лежит в памяти ОДИН раз;
 *   • `added` — то, что дописал человек за сессию. Только растёт: текст приписывается
 *     в конец, а куски ссылаются на уже приписанные участки.
 *
 * Кусок знает только буфер, смещение в нём и длину — самого текста он не хранит.
 * Текст документа собирается из кусков по порядку (`getText`).
 *
 * Смещения — в единицах UTF-16 (в них считает длину сама строка JS). Суррогатную
 * пару эта структура никогда не режет: `insert` и `delete` при необходимости сдвигают
 * границу к границе кодовой точки. Границы графемных кластеров (эмодзи с ZWJ,
 * комбинированные знаки) — уровень выше (см. `graphemes.ts`): там правки выравнивают
 * по кластерам, чтобы курсор не встал внутрь одного видимого символа.
 *
 * Цена операций: правка линейна по ЧИСЛУ КУСКОВ, а не по размеру файла. Число кусков
 * держим малым двумя приёмами: соседние куски одного буфера сливаются, если примыкают
 * друг к другу (`normalize`), а набор подряд идёт в конец последнего куска, а не
 * создаёт новый (`insert`). Префиксные суммы (для поиска куска по смещению) считаются
 * лениво — после серии правок один раз, а не на каждую.
 */

export type PieceBuffer = 'original' | 'added';

/** Кусок текста: откуда взять и сколько взять. Текста в себе не держит. */
export interface Piece {
  readonly buffer: PieceBuffer;
  /** Смещение начала куска внутри своего буфера. */
  readonly start: number;
  /** Длина в единицах UTF-16. */
  readonly length: number;
}

/** Сколько байт-в-строке проверять при выравнивании границы — см. `alignDown`/`alignUp`. */
function isLowSurrogate(code: number): boolean {
  // 0xDC00..0xDFFF — вторая половина суррогатной пары. Если смещение встало
  // ровно между halves, оно режет один символ надвое.
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  // 0xD800..0xDBFF — первая половина пары.
  return code >= 0xd800 && code <= 0xdbff;
}

export class PieceTable {
  private readonly original: string;
  private added = '';
  private pieces: Piece[] = [];
  /** Ленивые префиксные суммы: `sums[i]` — длина всех кусков до `i`. `null` — устарели. */
  private sums: number[] | null = null;
  private totalLength: number;

  constructor(text = '') {
    this.original = text;
    this.totalLength = text.length;
    if (text.length > 0) this.pieces.push({ buffer: 'original', start: 0, length: text.length });
  }

  /** Длина документа в единицах UTF-16. */
  get length(): number {
    return this.totalLength;
  }

  /** Сколько сейчас кусков — по нему видно, работает ли слияние (нужен тестам и пробе). */
  get pieceCount(): number {
    return this.pieces.length;
  }

  /** Текст документа или его участка `[start, end)`. */
  getText(start = 0, end: number = this.totalLength): string {
    const from = Math.max(0, Math.min(start, this.totalLength));
    const to = Math.max(from, Math.min(end, this.totalLength));
    if (from === to) return '';
    const sums = this.ensureSums();
    const parts: string[] = [];
    let index = this.pieceIndexAt(from);
    let offset = from;
    while (offset < to && index < this.pieces.length) {
      const piece = this.pieces[index];
      const pieceStart = sums[index];
      const pieceEnd = pieceStart + piece.length;
      const sliceStart = Math.max(offset, pieceStart) - pieceStart;
      const sliceEnd = Math.min(to, pieceEnd) - pieceStart;
      if (sliceEnd > sliceStart) {
        const buffer = piece.buffer === 'original' ? this.original : this.added;
        parts.push(buffer.slice(piece.start + sliceStart, piece.start + sliceEnd));
      }
      offset = pieceEnd;
      index += 1;
    }
    return parts.join('');
  }

  /** Весь текст документа. */
  toString(): string {
    return this.getText();
  }

  /**
   * Вставить текст в смещение. Текст не копируется: он приписывается в буфер
   * `added`, а документ получает кусок, ссылающийся на этот участок.
   */
  insert(offset: number, text: string): void {
    if (text.length === 0) return;
    const at = this.alignDown(Math.max(0, Math.min(offset, this.totalLength)));

    const addedStart = this.added.length;
    this.added += text;
    const piece: Piece = { buffer: 'added', start: addedStart, length: text.length };
    const { index, inside } = this.locate(at);

    if (inside > 0) {
      // Смещение внутри куска: разрезаем его на две части и ставим новый между ними.
      const target = this.pieces[index];
      const head: Piece = { buffer: target.buffer, start: target.start, length: inside };
      const tail: Piece = {
        buffer: target.buffer,
        start: target.start + inside,
        length: target.length - inside,
      };
      this.pieces.splice(index, 1, head, piece, tail);
    } else {
      // Смещение на границе кусков. Подряд идущий набор дописываем в предыдущий
      // кусок — так набор текста не плодит по куску на символ.
      const previous = index > 0 ? this.pieces[index - 1] : undefined;
      if (previous && previous.buffer === 'added' && previous.start + previous.length === addedStart) {
        this.pieces[index - 1] = {
          buffer: 'added',
          start: previous.start,
          length: previous.length + text.length,
        };
      } else {
        this.pieces.splice(index, 0, piece);
      }
    }

    this.totalLength += text.length;
    this.touch();
  }

  /**
   * Удалить `length` единиц, начиная со смещения. Возвращает удалённый текст —
   * он нужен истории правок, чтобы отмена могла вернуть его на место.
   */
  delete(offset: number, length: number): string {
    if (length <= 0) return '';
    const requested = Math.max(0, Math.min(offset, this.totalLength));
    const requestedEnd = Math.min(requested + length, this.totalLength);
    // Границы расширяем до целых кодовых точек: если участок задел половину
    // суррогатной пары, оставлять в документе половину символа нельзя.
    const from = this.alignDown(requested);
    const to = this.alignUp(requestedEnd);
    if (to <= from) return '';
    const removed = this.getText(from, to);

    const head = this.locate(from);
    const tail = this.locate(to);
    const next: Piece[] = [];

    for (let index = 0; index < head.index; index += 1) next.push(this.pieces[index]);

    // Хвост куска, в который попал НАЧАЛО удаления: он остаётся слева от правки.
    const first = this.pieces[head.index];
    if (first && head.inside > 0) {
      next.push({ buffer: first.buffer, start: first.start, length: head.inside });
    }

    // Начало куска, в который попал КОНЕЦ удаления: остаётся справа от правки.
    if (tail.index < this.pieces.length) {
      const last = this.pieces[tail.index];
      if (tail.inside < last.length) {
        next.push({
          buffer: last.buffer,
          start: last.start + tail.inside,
          length: last.length - tail.inside,
        });
      }
      // Всё, что лежит ЗА правкой, она не задела — переносим как есть.
      for (let index = tail.index + 1; index < this.pieces.length; index += 1) {
        next.push(this.pieces[index]);
      }
    }

    this.pieces = next;
    this.totalLength -= to - from;
    this.touch();
    return removed;
  }

  /** Заменить участок текстом. Возвращает то, что было на его месте. */
  replace(offset: number, length: number, text: string): string {
    const removed = this.delete(offset, length);
    this.insert(offset, text);
    return removed;
  }

  /** Соседние куски одного буфера, примыкающие друг к другу, — один кусок. */
  private normalize(): void {
    const next: Piece[] = [];
    for (const piece of this.pieces) {
      if (piece.length === 0) continue;
      const last = next[next.length - 1];
      if (last && last.buffer === piece.buffer && last.start + last.length === piece.start) {
        next[next.length - 1] = { buffer: last.buffer, start: last.start, length: last.length + piece.length };
      } else {
        next.push(piece);
      }
    }
    this.pieces = next;
  }

  /** После правки: суммы устарели, лишние куски склеены. */
  private touch(): void {
    this.sums = null;
    this.normalize();
  }

  private ensureSums(): number[] {
    if (this.sums) return this.sums;
    const sums = new Array<number>(this.pieces.length + 1);
    sums[0] = 0;
    for (let index = 0; index < this.pieces.length; index += 1) {
      sums[index + 1] = sums[index] + this.pieces[index].length;
    }
    this.sums = sums;
    return sums;
  }

  /** Номер куска, в который попадает смещение (самый правый кусок, начинающийся не позже). */
  private pieceIndexAt(offset: number): number {
    const sums = this.ensureSums();
    if (this.pieces.length === 0) return 0;
    let low = 0;
    let high = this.pieces.length - 1;
    let found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (sums[middle] <= offset) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }

  /** Кусок и смещение внутри него для позиции правки. `index` может равняться числу кусков. */
  private locate(offset: number): { index: number; inside: number } {
    if (offset >= this.totalLength) return { index: this.pieces.length, inside: 0 };
    const sums = this.ensureSums();
    const index = this.pieceIndexAt(offset);
    return { index, inside: offset - sums[index] };
  }

  /** Сдвинуть границу вниз, если она разрезает суррогатную пару (остаться на кодовой точке). */
  private alignDown(offset: number): number {
    // Границу проверяем по тексту документа: смещение может лежать на границе
    // кусков, где левый кусок кончается, а правый начинается.
    const code = this.codeAt(offset);
    return isLowSurrogate(code) && isHighSurrogate(this.codeAt(offset - 1)) ? offset - 1 : offset;
  }

  /** Сдвинуть границу вверх, если она разрезает пару: участок должен накрыть символ целиком. */
  private alignUp(offset: number): number {
    const code = this.codeAt(offset);
    return isLowSurrogate(code) && isHighSurrogate(this.codeAt(offset - 1)) ? offset + 1 : offset;
  }

  /** Код символа по смещению документа — через куски, без сборки всего текста. */
  private codeAt(offset: number): number {
    if (offset < 0 || offset >= this.totalLength) return -1;
    const sums = this.ensureSums();
    const index = this.pieceIndexAt(offset);
    const piece = this.pieces[index];
    const buffer = piece.buffer === 'original' ? this.original : this.added;
    return buffer.charCodeAt(piece.start + (offset - sums[index]));
  }
}
