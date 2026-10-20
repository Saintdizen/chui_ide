import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ageToolResults } from '../src/main/ai/age-results';
import type { ChatMessage } from '../src/shared/api';

/**
 * Свёртка старых результатов — дешёвая замена выбрасыванию ходов. Проверяем три
 * вещи, на которых она и держится: свежий шаг не трогается, текст не теряется
 * (остаётся файл и адрес), а пара «вызов — ответ» остаётся целой.
 */

let dir: string | null = null;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function spillDir(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'age-'));
  return dir;
}

function long(index: number): ChatMessage {
  return {
    role: 'tool',
    toolCallId: `call-${index}`,
    name: 'read_file',
    content: Array.from({ length: 200 }, (_, line) => `${line + 1} | строка ${index}-${line}`).join('\n'),
  };
}

describe('свёртка старых результатов', () => {
  it('без каталога копий ничего не трогает: терять текст нельзя', () => {
    const messages = [long(1), long(2)];
    const outcome = ageToolResults(messages, { keepRecent: 0, needTokens: 10_000 });
    expect(outcome.aged).toBe(0);
    expect(messages[0]?.content).toContain('строка 1-0');
  });

  it('без нужды в токенах не трогает ничего', () => {
    const messages = [long(1)];
    const outcome = ageToolResults(messages, { keepRecent: 0, needTokens: 0, spillDir: spillDir() });
    expect(outcome.aged).toBe(0);
  });

  it('свежие сообщения остаются как есть', () => {
    const messages = [long(1), long(2), long(3)];
    const outcome = ageToolResults(messages, { keepRecent: 2, needTokens: 10_000, spillDir: spillDir() });
    expect(outcome.aged).toBe(1);
    expect(messages[0]?.content).toContain('свёрнуто');
    expect(messages[1]?.content).toContain('строка 2-0');
    expect(messages[2]?.content).toContain('строка 3-0');
  });

  it('свёрнутое можно прочитать по адресу, а исходный объект цел', () => {
    const first = long(1);
    const messages = [first];
    const outcome = ageToolResults(messages, { keepRecent: 0, needTokens: 1, spillDir: spillDir() });
    expect(outcome.aged).toBe(1);
    expect(outcome.file).not.toBeNull();

    // Строка «вызова» в истории: адрес есть, текст остался в файле.
    const stub = String(messages[0]?.content);
    expect(stub).toContain('read_file');
    expect(stub).toContain(String(outcome.file));
    const where = stub.match(/:(\d+),/);
    expect(where).not.toBeNull();

    const saved = fs.readFileSync(outcome.file!, 'utf8').split('\n');
    const line = Number(where?.[1] ?? 1);
    expect(saved[line - 1]).toContain('строка 1-0');

    // Тот же объект держит `produced` — человек видит полный текст в карточке.
    expect(first.content).toContain('строка 1-0');
  });

  it('роль не tool и мелкие результаты не трогаются', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'x'.repeat(5000) },
      { role: 'tool', toolCallId: 'c', name: 'list_dir', content: 'коротко' },
      long(1),
    ];
    const outcome = ageToolResults(messages, { keepRecent: 0, needTokens: 1, spillDir: spillDir() });
    expect(outcome.aged).toBe(1);
    expect(messages[0]?.content).toBe('x'.repeat(5000));
    expect(messages[1]?.content).toBe('коротко');
  });

  it('свёртывает столько, сколько нужно, а не всё подряд', () => {
    const messages = [long(1), long(2), long(3), long(4)];
    const outcome = ageToolResults(messages, { keepRecent: 0, needTokens: 800, spillDir: spillDir() });
    expect(outcome.aged).toBeGreaterThanOrEqual(1);
    expect(outcome.aged).toBeLessThan(messages.length);
  });
});
