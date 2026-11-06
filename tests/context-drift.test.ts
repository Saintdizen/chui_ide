/**
 * П.36: модель видит то же, что и ты.
 *
 * Проверяем не «файл изменился», а расхождение «модель держит одно — на диске
 * другое»: сверка молчит, пока версии совпадают, и говорит ходом, в котором
 * модель получила свою.
 */
import { describe, expect, it } from 'vitest';
import { type FileView, countChanged, describeDrift, driftOf, modelViews } from '../src/renderer/core/context-drift';
import type { ChatSession } from '../src/renderer/ui/chat-session';
import type { Checkpoint } from '../src/renderer/ui/chat-checkpoints';

function sessionWith(checkpoints: Checkpoint[]): ChatSession {
  return { checkpoints } as unknown as ChatSession;
}

function checkpoint(index: number, title: string, path: string, text: string): Checkpoint {
  return { messageIndex: index, title, files: new Map([[path, { existed: true, text }]]) };
}

const before = 'a\nb\nc';
const after = 'a\nB\nc';
const view = (text: string): Map<string, FileView> => new Map([['/f.ts', { kind: 'read', text }]]);

describe('сверка версий', () => {
  it('молчит, когда версии совпадают', () => {
    expect(driftOf(sessionWith([]), new Map([['/f.ts', before]]), view(before))).toEqual([]);
  });

  it('говорит, сколько строк разошлось', () => {
    const [drift] = driftOf(sessionWith([]), new Map([['/f.ts', after]]), view(before));
    expect(drift!.changed).toBe(2);
  });

  it('файл без взгляда модели не сверяется вовсе', () => {
    const views: Map<string, FileView> = new Map([['/f.ts', { kind: 'none' }]]);
    expect(driftOf(sessionWith([]), new Map([['/f.ts', after]]), views)).toEqual([]);
  });

  it('версию подписывает самый поздний ход, в снимке которого файл есть', () => {
    const session = sessionWith([checkpoint(1, 'первый', '/f.ts', before), checkpoint(5, 'пятый', '/f.ts', before)]);
    const [drift] = driftOf(session, new Map([['/f.ts', after]]), view(before));
    expect(drift!.view).toEqual({ turn: 'пятый', index: 5 });
  });

  it('самые разошедшиеся — сверху', () => {
    const current = new Map([
      ['/small.ts', 'a\nB\nc'],
      ['/big.ts', 'x\ny\nz'],
    ]);
    const views: Map<string, FileView> = new Map([
      ['/small.ts', { kind: 'read', text: before }],
      ['/big.ts', { kind: 'read', text: 'q\nq\nq' }],
    ]);
    expect(driftOf(sessionWith([]), current, views).map((drift) => drift.path)).toEqual(['/big.ts', '/small.ts']);
  });

  it('правка, ждущая согласия, не путается с чтением', () => {
    const views: Map<string, FileView> = new Map([['/f.ts', { kind: 'edit', text: before }]]);
    const [drift] = driftOf(sessionWith([]), new Map([['/f.ts', after]]), views);
    expect(drift!.edit).toBe(true);
    expect(describeDrift(drift!)).toContain('правка ждёт согласия');
  });
});

describe('взгляды модели', () => {
  it('файл, прочитанный целиком, даёт свою версию', () => {
    const reads = new Map([['/f.ts', [{ from: 1, to: 3, eof: true }]]]);
    expect(modelViews(reads, [], new Map([['/f.ts', before]])).get('/f.ts')).toEqual({ kind: 'read', text: before });
  });

  it('прочитанный кусками — версии не даёт: сверять нечего', () => {
    const reads = new Map([['/f.ts', [{ from: 2, to: 2 }]]]);
    expect(modelViews(reads, [], new Map([['/f.ts', before]])).get('/f.ts')).toBeUndefined();
  });

  it('ожидающая правка важнее чтения: модель смотрела позже', () => {
    const reads = new Map([['/f.ts', [{ from: 1, to: 3, eof: true }]]]);
    const edits = [
      { path: '/f.ts', edits: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2, newText: 'A' }] },
    ];
    expect(modelViews(reads, edits, new Map([['/f.ts', before]])).get('/f.ts')).toEqual({ kind: 'edit', text: 'A' });
  });
});

describe('счёт строк', () => {
  it('общая середина не считается изменением', () => {
    expect(countChanged('a\nb\nc\nd\ne', 'a\nX\nc\nd\ne')).toBe(2);
  });

  it('одинаковый текст — ноль', () => {
    expect(countChanged('a\nb', 'a\nb')).toBe(0);
  });
});
