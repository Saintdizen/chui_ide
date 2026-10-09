/**
 * Фрейминг DAP поверх байтового потока.
 *
 * DAP — это JSON, а поверх потока он обрамляется заголовком `Content-Length: N`
 * и пустой строкой: `Content-Length: 123\r\n\r\n{...}`. Заголовков бывает и
 * больше (в стандарте допускается `Content-Type`), поэтому разбор не привязан к
 * единственному заголовку: ищем разделитель, а в нём — длину тела.
 *
 * Здесь только рамка и её чтение; смысл сообщений — дело тех, кто их шлёт.
 */

/** Сообщение DAP в том виде, в каком оно ходит по проводу. */
export interface DapMessage {
  seq?: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: unknown;
  arguments?: unknown;
}

/** Обрамить сообщение в кадр DAP — готовые байты для записи в поток. */
export function encodeDap(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Разборщик входящего потока: кормим его кусками, он зовёт `onMessage` на каждое
 * целиком принятое сообщение. Буфер держит недобранное до следующего куска.
 */
export class DapReader {
  private buffer = Buffer.alloc(0);

  constructor(private readonly onMessage: (message: DapMessage) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      const start = headerEnd + 4;
      if (!match) {
        // Кадр без длины пропустить нельзя осмысленно — отбрасываем заголовок.
        this.buffer = this.buffer.slice(start);
        continue;
      }

      const length = Number(match[1]);
      if (this.buffer.length < start + length) return;

      const body = this.buffer.slice(start, start + length).toString('utf8');
      this.buffer = this.buffer.slice(start + length);
      try {
        this.onMessage(JSON.parse(body) as DapMessage);
      } catch {
        // обрывок кадра — пропускаем
      }
    }
  }
}
