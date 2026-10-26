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

describe('свёртка по возрасту', () => {
  it('сворачивает старое, не дожидаясь переполнения окна', async () => {
    const { ageStaleResults } = await import('../src/main/ai/age-results');
    const messages = [long(1), long(2), long(3), long(4), long(5)];
    const outcome = ageStaleResults(messages, { keepRecent: 2, spillDir: spillDir(), minChars: 100 });
    expect(outcome.aged).toBe(3);
    // Свёрнуты первые три, последние два (окно keepRecent) целы.
    expect(messages[2]?.content).toContain('свёрнуто');
    expect(messages[3]?.content).toContain('строка 4-0');
    expect(messages[4]?.content).toContain('строка 5-0');
  });

  it('одно сообщение на пачку файла не создаёт', async () => {
    const { ageStaleResults } = await import('../src/main/ai/age-results');
    const messages = [long(1), long(2)];
    const outcome = ageStaleResults(messages, { keepRecent: 1, spillDir: spillDir() });
    expect(outcome.aged).toBe(0);
    expect(messages[0]?.content).toContain('строка 1-0');
  });

  it('повторная свёртка не трогает уже свёрнутое', async () => {
    const { ageStaleResults } = await import('../src/main/ai/age-results');
    const messages = [long(1), long(2), long(3), long(4)];
    const first = ageStaleResults(messages, { keepRecent: 1, spillDir: spillDir(), minChars: 100 });
    expect(first.aged).toBe(3);
    const again = ageStaleResults(messages, { keepRecent: 1, spillDir: spillDir() });
    expect(again.aged).toBe(0);
  });

  it('без каталога копий молчит', async () => {
    const { ageStaleResults } = await import('../src/main/ai/age-results');
    const messages = [long(1), long(2), long(3)];
    expect(ageStaleResults(messages, { keepRecent: 0 }).aged).toBe(0);
  });
});

describe('картинки в истории', () => {
  it('снимок сворачивается, а путь остаётся', async () => {
    const { ageStaleResults } = await import('../src/main/ai/age-results');
    const shot = (index: number): ChatMessage => ({
      role: 'user',
      content: `Изображение из «read_image»: shots/${index}.png: png, 800x600`,
      images: ['data:image/png;base64,AAAA'],
    });
    const messages = [shot(1), shot(2), long(3)];
    const outcome = ageStaleResults(messages, { keepRecent: 1, spillDir: spillDir() });

    // Тысяча токенов за снимок ехала на каждом шаге до конца прогона: длина
    // подписи порог не переходила, и свёртка картинок не видела вовсе.
    expect(outcome.aged).toBe(2);
    expect(messages[0]?.images).toEqual([]);
    expect(messages[0]?.content).toContain('shots/1.png');
    expect(messages[0]?.content).toContain('read_image');
  });

  it('свёрнутая картинка считается по своей цене, а не по длине подписи', async () => {
    const { ageStaleResults } = await import('../src/main/ai/age-results');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Изображение: a.png', images: ['data:image/png;base64,AAAA'] },
      long(2),
      long(3),
    ];
    const outcome = ageStaleResults(messages, { keepRecent: 1, spillDir: spillDir() });
    // Подпись весит токенов двадцать, снимок — тысячу. Оценка идёт по снимку.
    expect(outcome.freedTokens).toBeGreaterThan(900);
  });
});

describe('что свёртка не трогает', () => {
  it('системное сообщение не сворачивается: адреса у него нет', async () => {
    const { ageStaleResults } = await import('../src/main/ai/age-results');
    // Карта проекта и кодекс лежат в `system` и стоят в каждом запросе. Свёртка
    // выбирает по длине, а не по роли, — и система с картинкой или длинная рамка
    // уехала бы в пометку с адресом копии. Вернуть её агент не сможет: `spill`
    // пишет её же копию, но прочитать карту инструментом — это шаг, а не правило.
    const system: ChatMessage = { role: 'system', content: `карта проекта\n${'файл.ts '.repeat(400)}` };
    const messages: ChatMessage[] = [system, long(1), long(2), long(3)];
    const outcome = ageStaleResults(messages, { keepRecent: 1, spillDir: spillDir(), minChars: 100 });
    expect(messages[0]?.content).toBe(system.content);
    expect(outcome.aged).toBe(2);
  });
});

describe('порог давности', () => {
  it('ответ на две тысячи символов сворачивается, а не живёт вечно', async () => {
    const { ageStaleResults } = await import('../src/main/ai/age-results');
    // Порог 4 000 сворачивал 1 ответ из 95 в живом прогоне: почти всё, что
    // приходит от инструментов, короче и потому ехало на каждом шаге до конца.
    const twoThousand = (index: number): ChatMessage => ({
      role: 'tool',
      name: 'read_file',
      content: `файл ${index}\n${'строка текста '.repeat(140)}`,
    });
    const messages = [twoThousand(1), twoThousand(2), long(3)];
    const outcome = ageStaleResults(messages, { keepRecent: 1, spillDir: spillDir() });
    expect(outcome.aged).toBe(2);
    expect(messages[0]?.content).toContain('свёрнуто');
  });
});
