import { describe, expect, it } from 'vitest';
import {
  STALE_RESULT_PREFIX,
  liveSources,
  pruneReads,
  rememberRead,
  restoreReads,
  snapshotReads,
  coveredRequest,
  type ReadRange,
} from '../src/shared/read-coverage';

/**
 * Покрытие чтений живёт дольше ветки: беседа помнит, что прочитано, а история
 * сообщений может это потерять (сжатие, удалённый ход, перегенерация ответа).
 * `src` — id вызова, чей результат лежит в ветке; `pruneReads` держит память ровно
 * настолько, насколько верен текст под ней.
 */
describe('покрытие чтений и источник в ветке', () => {
  const read = (from: number, to: number, src?: string) => ({ path: '/proj/a.ts', from, to, src });
  const toolResult = (toolCallId: string, content = '1 | текст') => ({ role: 'tool', toolCallId, content });
  const snapshot = (ranges: ReadRange[]) =>
    restoreReads(snapshotReads(new Map<string, ReadRange[]>([['/proj/a.ts', ranges]])));

  it('rememberRead помнит вызов, а снимок переживает запись в файл беседы', () => {
    const reads = new Map<string, ReadRange[]>();
    rememberRead(reads, read(1, 40), 'call-1');

    expect(reads.get('/proj/a.ts')).toEqual([{ from: 1, to: 40, stamp: undefined, eof: undefined, src: 'call-1' }]);
    expect(restoreReads(snapshotReads(reads))).toEqual(reads);
  });

  it('pruneReads держит кусок, пока его вызов есть в ветке', () => {
    const reads = new Map<string, ReadRange[]>();
    rememberRead(reads, read(1, 40), 'call-1');
    rememberRead(reads, read(41, 80), 'call-2');

    expect(pruneReads(reads, liveSources([toolResult('call-1')]))).toBe(1);
    expect(reads.get('/proj/a.ts')).toEqual([{ from: 1, to: 40, stamp: undefined, eof: undefined, src: 'call-1' }]);
  });

  it('свёрнутый результат инструмента источником не считается', () => {
    const messages = [
      toolResult('call-1', `${STALE_RESULT_PREFIX} read, 900 симв. — текст в файле, читайте read с диапазоном`),
    ];

    expect(liveSources(messages).size).toBe(0);
  });

  it('запись старого формата без src выбрасывается: проверить её нечем', () => {
    const reads = new Map<string, ReadRange[]>([['/proj/a.ts', [{ from: 1, to: 40 }]]]);

    expect(pruneReads(reads, liveSources([toolResult('call-1')]))).toBe(1);
    expect(reads.size).toBe(0);
  });

  it('новый ход, вызов в ветке — заглушка «уже прочитано»', () => {
    const reads = snapshot([{ from: 1, to: 40, src: 'call-1' }]);
    pruneReads(reads, liveSources([{ role: 'assistant', content: 'ок' }, toolResult('call-1')]));

    const args = JSON.stringify({ path: '/proj/a.ts', startLine: 1, endLine: 40 });

    expect(coveredRequest('read', args, reads)).toEqual({ path: '/proj/a.ts', from: 1, to: 40 });
  });

  it('вызов из удалённого хода — читаем заново, а не отсылаем в пустоту', () => {
    const reads = snapshot([{ from: 1, to: 40, src: 'call-1' }]);
    pruneReads(reads, liveSources([{ role: 'assistant', content: 'ответ перегенерирован' }]));

    const args = JSON.stringify({ path: '/proj/a.ts', startLine: 1, endLine: 40 });

    expect(coveredRequest('read', args, reads)).toBeUndefined();
  });
});
