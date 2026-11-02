import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clipNote,
  clipTail,
  clipText,
  condenseOutput,
  isBinary,
  outputRoom,
  spendRoom,
  spillNote,
  truncateTail,
} from '../src/main/ai/output-trim';
import { MAX_OUTPUT_CHARS, MIN_OUTPUT_CHARS } from '../src/main/ai/output-budget';
import type { ToolContext } from '../src/main/ai/tool-context';

/**
 * Обрезка вывода инструментов (`main/ai/output-trim.ts`).
 *
 * Всё, что не влезло в промпт, либо теряется, либо кладётся в файл-копию. Отсюда два
 * обязательства, которые и проверяются: обрезка НАЗЫВАЕТ, сколько отброшено и куда
 * лечь остатку, а бюджет шага не обходится ни одним путём. Пометка без адреса — это
 * тупик: агент знает, что чего-то не видит, но не может это достать.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function context(options: { left?: number; spill?: boolean } = {}): ToolContext {
  const ctx: ToolContext = {} as ToolContext;
  if (options.left !== undefined) {
    (ctx as { stepBudget?: { left: number } }).stepBudget = { left: options.left };
  }
  if (options.spill) {
    void fs.mkdtemp(path.join(os.tmpdir(), 'chui-spill-')).then((dir) => {
      dirs.push(dir);
      (ctx as { spillDir?: string }).spillDir = dir;
    });
  }
  return ctx;
}

describe('хвостовая обрезка', () => {
  it('короткий текст не трогается', () => {
    expect(truncateTail('привет', 100)).toBe('привет');
  });

  it('остаются ПОСЛЕДНИЕ символы: начало вывода модели уже не нужно', () => {
    const text = `${'a'.repeat(50)}ХВОСТ`;

    const trimmed = truncateTail(text, 10);

    expect(trimmed.endsWith('ХВОСТ')).toBe(true);
    expect(trimmed).toContain('отброшено символов в начале: 45');
  });

  it('ровно в пределе — без пометки', () => {
    // Пометка на границе пугала бы «обрезано», хотя не отброшено ничего.
    const text = 'x'.repeat(20);

    expect(truncateTail(text, 20)).toBe(text);
  });
});

describe('бюджет шага', () => {
  it('без бюджета отдаётся полный предел', () => {
    expect(outputRoom(context())).toBe(MAX_OUTPUT_CHARS);
  });

  it('остаток бюджета меньше предела — отдаётся остаток', () => {
    // Берём остаток, но не ниже минимума: ниже него инструмент ответил бы пустотой.
    expect(outputRoom(context({ left: 500 }), MAX_OUTPUT_CHARS)).toBe(MIN_OUTPUT_CHARS);
  });

  it('остаток больше предела — предел важнее', () => {
    expect(outputRoom(context({ left: MAX_OUTPUT_CHARS * 2 }), MAX_OUTPUT_CHARS)).toBe(MAX_OUTPUT_CHARS);
  });

  it('исчерпанный бюджет всё равно даёт минимум', () => {
    // Ноль символов сломали бы ответ инструмента: модели нужно хоть что-то.
    expect(outputRoom(context({ left: 0 }), MAX_OUTPUT_CHARS)).toBe(MIN_OUTPUT_CHARS);
  });

  it('списание не уводит бюджет ниже нуля', () => {
    const ctx = context({ left: 10 });

    spendRoom(ctx, 100);

    expect((ctx as unknown as { stepBudget: { left: number } }).stepBudget.left).toBe(0);
  });

  it('без бюджета списание ничего не делает', () => {
    expect(() => spendRoom(context(), 100)).not.toThrow();
  });
});

describe('обрезка с копией', () => {
  it('короткий текст возвращается как есть и списывается целиком', () => {
    const ctx = context({ left: 1000 });

    const result = clipText(ctx, 'run', 'коротко');

    expect(result).toEqual({ text: 'коротко', truncated: false });
    expect((ctx as unknown as { stepBudget: { left: number } }).stepBudget.left).toBe(1000 - 7);
  });

  it('длинный текст обрезан и помечен', () => {
    const ctx = context({ left: 200 });

    const result = clipText(ctx, 'run', 'x'.repeat(3000));

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('вывод обрезан');
    expect(result.text.length).toBeLessThan(3000);
  });

  it('хвостовая копия говорит, сколько отброшено', () => {
    const ctx = context({ left: 100 });

    const tail = clipTail(ctx, 'run', 'a'.repeat(300), 60);

    expect(tail).toContain('отброшено символов в начале');
    expect(tail.length).toBeLessThan(300);
  });

  it('пустое место в бюджете — пометка об исчерпании', () => {
    const ctx = context({ left: 0 });

    expect(clipNote(ctx, null, 'вывод обрезан')).toContain('бюджет вывода на шаг исчерпан');
  });

  it('копия есть — пометка называет файл, копии нет — не выдумывает', () => {
    const ctx = context({ left: 100 });

    expect(clipNote(ctx, '/tmp/x.log', 'обрезано')).toContain('/tmp/x.log');
    expect(clipNote(ctx, null, 'обрезано')).not.toContain('/tmp');
  });

  it('подсказка о копии приходит с новой строки, а пустая — пустая', () => {
    expect(spillNote('/tmp/x.log')).toContain('/tmp/x.log');
    expect(spillNote(null)).toBe('');
  });
});

describe('прочее', () => {
  it('сжатие вывода не пустое и короче исходника', () => {
    const long = 'строка вывода\n'.repeat(500);
    const condensed = condenseOutput(long);

    expect(condensed.length).toBeGreaterThan(0);
    expect(condensed.length).toBeLessThan(long.length);
  });

  it('бинарный файл узнаётся по нулевому байту', () => {
    // Декодированный в utf8 бинарник — мусор из U+FFFD, и причины в нём не видно.
    expect(isBinary('a\u0000b')).toBe(true);
    expect(isBinary('обычный текст')).toBe(false);
  });
});
