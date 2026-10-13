/**
 * Разбор потока терминала: текст и управляющие последовательности вперемешку.
 *
 * Оболочка отдаёт не «одну команду за раз», а поток байт, в котором текст перемешан
 * с последовательностями: `\x1b[2J` — очистить экран, `\x1b[31m` — красный,
 * `\x1b]0;заголовок\x07` — имя окна. Парсер превращает этот поток в СПИСОК СОБЫТИЙ, а
 * как их применить — знает модель экрана (`screen.ts`). Разделение нужно, чтобы правило
 * разбора проверялось тестами без DOM, а экран не разбирал байты сам.
 *
 * Поток идёт порциями, и граница порции может попасть ВНУТРЬ последовательности:
 * `\x1b[3` и `1m` приходят отдельно. Поэтому парсер — СОСТОЯНИЕ, а не функция над
 * строкой: недобранную последовательность он держит до следующего `write` и не теряет.
 *
 * Разбор — по схеме отчётной модели VT (та же, что у xterm): состояние `ground`,
 * `escape`, `csi`, `osc`; промежуточные байты; параметры и завершающий байт. Это
 * стандарт, которому следуют все терминалы; выдумывать здесь нечего — только объём
 * охваченных последовательностей выбирается по нужде.
 */

/** Готовая порция текста без управляющих байтов: очередь печати. */
export interface PrintEvent {
  readonly type: 'print';
  readonly text: string;
}

/** Управляющий символ C0 (BEL, BS, TAB, LF, CR…): у него нет ни параметров, ни завершителя. */
export interface ControlEvent {
  readonly type: 'control';
  readonly code: number;
}

/** Последовательность CSI: `ESC [ параметры;… завершитель` (`\x1b[2;5H`). */
export interface CsiEvent {
  readonly type: 'csi';
  /**
   * Параметры: внешний список — группы через `;`, внутренний — подпараметры через `:`.
   * Пропущенный параметр становится нулём; значение по умолчанию выбирает уже экран,
   * потому что оно зависит от команды (`CSI H` — это 1,1, а `CSI m` — сброс).
   */
  readonly params: readonly (readonly number[])[];
  /** Маркер перед параметрами: `?` (DEC-режимы), `>`, `=`, `<` или пустая строка. */
  readonly private: string;
  /** Промежуточные байты `0x20–0x2f` (`!`, `"`, пробел) — входят в последовательность. */
  readonly intermediates: string;
  /** Завершающий байт `0x40–0x7e`: `m`, `H`, `J`, `h`… */
  readonly final: string;
}

/** Последовательность ESC без параметров: `ESC 7`, `ESC ( B`, `ESC M`. */
export interface EscEvent {
  readonly type: 'esc';
  readonly intermediates: string;
  readonly final: string;
}

/** Управляющая строка OSC: `ESC ] 0;заголовок BEL` — данные целиком, без разбора. */
export interface OscEvent {
  readonly type: 'osc';
  readonly data: string;
}

export type VtEvent = PrintEvent | ControlEvent | CsiEvent | EscEvent | OscEvent;

type State = 'ground' | 'escape' | 'csi' | 'osc' | 'oscEscape' | 'dcs' | 'dcsEscape';

const ESC = 0x1b;
const BEL = 0x07;

/**
 * Параметры CSI в виде групп. `;` делит группы, `:` — подпараметры внутри группы.
 * Пустая позиция — это 0 (как и у xterm): так `CSI ;5H` читается как «столбец 5».
 */
function parseParams(raw: string): number[][] {
  if (raw === '') return [];
  return raw.split(';').map((group) => group.split(':').map((part) => (part === '' ? 0 : Number(part))));
}

export class VtParser {
  private state: State = 'ground';
  private text = '';
  private params = '';
  private privateMarker = '';
  private intermediates = '';
  private payload = '';

  /** Разобрать порцию вывода и вернуть события в том порядке, в каком их применять. */
  write(data: string): VtEvent[] {
    const events: VtEvent[] = [];
    // Идём по кодовым точкам, а не по единицам UTF-16: эмодзи и иероглифы должны
    // попасть в печать целиком, одним знаком, иначе знак развалится на суррогаты.
    for (const ch of data) this.step(ch, events);
    this.flush(events);
    return events;
  }

  /** Забыть недобранную последовательность: следующий `write` начнётся с чистого листа. */
  reset(): void {
    this.state = 'ground';
    this.text = '';
    this.params = '';
    this.privateMarker = '';
    this.intermediates = '';
    this.payload = '';
  }

  private flush(events: VtEvent[]): void {
    if (this.text === '') return;
    events.push({ type: 'print', text: this.text });
    this.text = '';
  }

  private beginEscape(): void {
    this.state = 'escape';
    this.intermediates = '';
    this.params = '';
    this.privateMarker = '';
  }

  private emitOsc(events: VtEvent[]): void {
    events.push({ type: 'osc', data: this.payload });
    this.payload = '';
    this.state = 'ground';
  }

  private step(ch: string, events: VtEvent[]): void {
    const code = ch.codePointAt(0) ?? 0;

    switch (this.state) {
      case 'ground':
        if (code === ESC) {
          this.flush(events);
          this.beginEscape();
          return;
        }
        if (code < 0x20) {
          this.flush(events);
          events.push({ type: 'control', code });
          return;
        }
        // DEL (0x7f) — заполнитель, на экран не попадает.
        if (code === 0x7f) return;
        this.text += ch;
        return;

      case 'escape':
        this.stepEscape(ch, code, events);
        return;

      case 'csi':
        this.stepCsi(ch, code, events);
        return;

      case 'osc':
        if (code === BEL) {
          this.emitOsc(events);
          return;
        }
        // OSC завершается и через ST (ESC \\): ждём второй байт пары.
        if (code === ESC) {
          this.state = 'oscEscape';
          return;
        }
        this.payload += ch;
        return;

      case 'oscEscape':
        if (ch === '\\') {
          this.emitOsc(events);
          return;
        }
        // ESC начал не ST — возвращаем его в данные и продолжаем строку.
        this.payload += `\x1b${ch}`;
        this.state = 'osc';
        return;

      // DCS (ESC P …) — например, запросы к терминалу. Содержимое не нужно: пропускаем.
      case 'dcs':
        if (code === ESC) this.state = 'dcsEscape';
        return;

      case 'dcsEscape':
        this.state = ch === '\\' ? 'ground' : 'dcs';
        return;
    }
  }

  private stepEscape(ch: string, code: number, events: VtEvent[]): void {
    if (code === ESC) {
      this.beginEscape();
      return;
    }
    // CAN/SUB отменяют последовательность.
    if (code === 0x18 || code === 0x1a) {
      this.state = 'ground';
      this.intermediates = '';
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.intermediates += ch;
      return;
    }
    if (ch === '[') {
      this.state = 'csi';
      this.params = '';
      this.privateMarker = '';
      this.intermediates = '';
      return;
    }
    if (ch === ']') {
      this.state = 'osc';
      this.payload = '';
      return;
    }
    if (ch === 'P') {
      this.state = 'dcs';
      return;
    }
    events.push({ type: 'esc', intermediates: this.intermediates, final: ch });
    this.state = 'ground';
    this.intermediates = '';
  }

  private stepCsi(ch: string, code: number, events: VtEvent[]): void {
    if (code === ESC) {
      this.beginEscape();
      return;
    }
    if (code === 0x18 || code === 0x1a) {
      this.state = 'ground';
      return;
    }
    // Управляющий символ внутри CSI выполняется сразу, последовательность продолжается.
    if (code < 0x20) {
      events.push({ type: 'control', code });
      return;
    }
    if (code >= 0x30 && code <= 0x3b) {
      this.params += ch;
      return;
    }
    if (code >= 0x3c && code <= 0x3f) {
      this.privateMarker += ch;
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.intermediates += ch;
      return;
    }
    if (code >= 0x40 && code <= 0x7e) {
      events.push({
        type: 'csi',
        params: parseParams(this.params),
        private: this.privateMarker,
        intermediates: this.intermediates,
        final: ch,
      });
      this.state = 'ground';
      this.params = '';
      this.privateMarker = '';
      this.intermediates = '';
    }
  }
}
