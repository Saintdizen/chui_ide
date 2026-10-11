import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanCompletion,
  CURSOR_MARKER,
  delayOrCancel,
  inlineContext,
  renderInlinePrompt,
  type CancellationLike,
} from '../src/shared/inline-ai';

/** Простой токен отмены: повторяет поведение токена Monaco. */
function tokenStub() {
  let cancelled = false;
  const listeners = new Set<() => void>();
  const token: CancellationLike = {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
  };
  return {
    token,
    cancel: () => {
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('inlineContext', () => {
  it('делит текст по курсору на хвост и начало', () => {
    const text = 'первая\nвторая\nтретья';

    // Курсор в конце второй строки (13-й символ — после «вторая»).
    const context = inlineContext(text, { line: 2, column: 7 });

    expect(context.prefix.endsWith('вторая')).toBe(true);
    expect(context.suffix.startsWith('\nтретья')).toBe(true);
  });

  it('ограничивает обе стороны по длине', () => {
    // Курсор ровно посередине: слева сто «A», справа сто «B».
    const text = 'A'.repeat(100) + 'B'.repeat(100);

    const context = inlineContext(text, { line: 1, column: 101 }, { maxPrefixChars: 10, maxSuffixChars: 5 });

    expect(context.prefix).toBe('A'.repeat(10));
    expect(context.suffix).toBe('B'.repeat(5));
  });

  it('в начале и конце файла одна из сторон пуста', () => {
    const context = inlineContext('код', { line: 1, column: 1 });

    expect(context.prefix).toBe('');
    expect(context.suffix).toBe('код');
  });
});

describe('renderInlinePrompt', () => {
  it('ставит маркер курсора между хвостом и началом и называет язык', () => {
    const prompt = renderInlinePrompt({
      language: 'python',
      relativePath: 'src/app.py',
      prefix: 'def f():',
      suffix: '\n    pass',
    });

    expect(prompt).toContain('Язык: python');
    expect(prompt).toContain('Файл: src/app.py');
    expect(prompt).toContain(`def f():${CURSOR_MARKER}`);
  });
});

describe('cleanCompletion', () => {
  it('снимает закрытое markdown-ограждение', () => {
    expect(cleanCompletion('```python\nprint(1)\n```')).toBe('print(1)');
  });

  it('снимает незакрытое ограждение', () => {
    expect(cleanCompletion('```\nprint(1)')).toBe('print(1)');
  });

  it('убирает пустые строки и пробелы в конце, но не ведущий перевод строки', () => {
    expect(cleanCompletion('\nreturn x\n\n\n')).toBe('\nreturn x');
  });

  it('нормализует переводы строк и чистое продолжение оставляет как есть', () => {
    expect(cleanCompletion('value = 1\r\n')).toBe('value = 1');
    expect(cleanCompletion('x = 1')).toBe('x = 1');
  });
});

describe('delayOrCancel', () => {
  it('возвращает true, когда пауза прошла', async () => {
    vi.useFakeTimers();
    const { token } = tokenStub();

    const promise = delayOrCancel(100, token);
    await vi.advanceTimersByTimeAsync(100);

    expect(await promise).toBe(true);
  });

  it('отмена во время паузы возвращает false и не ждёт конца', async () => {
    vi.useFakeTimers();
    const { token, cancel } = tokenStub();

    const promise = delayOrCancel(100, token);
    cancel();

    expect(await promise).toBe(false);
  });

  it('уже отменённый токен не запускает ожидание вовсе', async () => {
    const { token, cancel } = tokenStub();
    cancel();

    expect(await delayOrCancel(100, token)).toBe(false);
  });
});
