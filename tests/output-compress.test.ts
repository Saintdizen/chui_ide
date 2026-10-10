import { describe, expect, it } from 'vitest';
import { compressToolOutput } from '../src/shared/output-compress';

/**
 * Сжатие вывода инструментов. Проверяем обе стороны: шум уходит, а содержание —
 * код, диффы, ошибки — остаётся дословно. Второе важнее первого: в проекте уже
 * был механизм, который сворачивал результаты и терял прочитанное.
 */
describe('compressToolOutput', () => {
  it('CRLF и перевод строки в конец файла', () => {
    expect(compressToolOutput('первая\r\nвторая\r\n')).toBe('первая\nвторая');
  });

  it('оставляет последнее состояние перерисованной строки', () => {
    // Так выглядит прогресс скачивания: строка перерисовывается на месте.
    const raw = 'скачивание\rскачивание 10%\rскачивание 100%\nготово\n';
    expect(compressToolOutput(raw)).toBe('скачивание 100%\nготово');
  });

  it('снимает цвет и управляющие последовательности', () => {
    const raw = '\u001b[32mуспешно\u001b[0m\n\u001b]0;заголовок\u0007итог\n';
    expect(compressToolOutput(raw)).toBe('успешно\nитог');
  });

  it('выбрасывает прогресс-строки во всех трёх видах', () => {
    const raw = ['[####>        ] 45%', '|██████       | 12%', '⸨⠂⠄⡀⠤⠐⠒⸩ 80%', '⠹', 'сборка завершена'].join('\n');
    expect(compressToolOutput(raw)).toBe('сборка завершена');
  });

  it('полоса прогресса с подписью и спиннер впереди строки — тоже шум', () => {
    const raw = ['⠼ idealTree', '[#########] / reify:lodash: 42%', 'added 1 package'].join('\n');
    expect(compressToolOutput(raw)).toBe('added 1 package');
  });

  it('строка в квадратных скобках — это данные, а не прогресс', () => {
    // Квадратные скобки в выводе команд обычны (`[main]`, `[INFO]`), поэтому
    // полосой считается только заливка внутри рамки, а не любые скобки.
    const raw = ['[main] тест пройден', '[INFO] сборка началась', '[/x] путь'].join('\n');
    expect(compressToolOutput(raw)).toBe(raw);
  });

  it('три одинаковых строки подряд — одна с пометкой', () => {
    const raw = ['npm warn deprecated x@1', 'npm warn deprecated x@1', 'npm warn deprecated x@1', 'ok'].join('\n');
    expect(compressToolOutput(raw)).toBe('npm warn deprecated x@1\n… (такая же строка повторена ещё 2 раз)\nok');
  });

  it('две одинаковых строки подряд — это данные, не повтор', () => {
    const raw = ['src/a.ts', 'src/a.ts', 'src/b.ts'].join('\n');
    expect(compressToolOutput(raw)).toBe(raw);
  });

  it('пустые простыни сжимаются до одной пустой строки', () => {
    expect(compressToolOutput('итог:\n\n\n\nследующее\n')).toBe('итог:\n\nследующее');
  });

  it('содержание диффа не портится', () => {
    const raw = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
    ].join('\n');
    expect(compressToolOutput(`${raw}\n`)).toBe(raw);
  });

  it('отступы кода сохраняются', () => {
    const raw = 'def run():\n    return 1\n\n\nrun()';
    expect(compressToolOutput(raw)).toBe('def run():\n    return 1\n\nrun()');
  });

  it('осталась одна пометка, если вывод был только из прогресса', () => {
    expect(compressToolOutput('\u001b[2K[####] 45%\n')).toBe('(вывод — прогресс и служебные строки)');
  });

  it('пустой вывод остаётся пустым, а не превращается в пометку', () => {
    expect(compressToolOutput('')).toBe('');
    expect(compressToolOutput('\n\n')).toBe('');
  });

  it('разделительная линия без слов уходит, а с подписью — нет', () => {
    expect(compressToolOutput('========\nвнимание\n========')).toBe('внимание');
    expect(compressToolOutput('---- итог ----')).toBe('---- итог ----');
  });
});
