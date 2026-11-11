import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Битые байты в комментариях невидимы линтеру и typecheck: файл валиден, но в UI
 * вместо буквы „Д“ стоит ромбик. Один раз так и случилось (`agent-tools.ts`,
 * `chat-find.test.ts` — «Д» развалилась на два U+FFFD). Страж дешёвый.
 */
const ROOTS = ['src', 'tests'];
const BROKEN = '\uFFFD';

async function walk(dir: string, out: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(ts|md)$/.test(entry.name)) out.push(full);
  }
}

describe('исходники — валидный UTF-8', () => {
  it('ни в одном .ts/.md нет символа замены U+FFFD', async () => {
    const files: string[] = [];
    for (const root of ROOTS) await walk(root, files);
    const broken: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      if (text.includes(BROKEN)) broken.push(file);
    }
    expect(broken, 'битые байты — восстановите букву, не удаляйте текст').toEqual([]);
  });
});
