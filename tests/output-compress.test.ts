import { describe, expect, it } from 'vitest';
import {
  collapsePassedTests,
  compressToolOutput,
  looksLikeTestRun,
  summarizeInstall,
} from '../src/shared/output-compress';

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

describe('свёртка прошедших тестов', () => {
  it('сотни ✓ сворачиваются в одну строку, итог и падения целы', () => {
    const lines = [
      ' ✓ tests/a.test.ts (3)',
      '     ✓ первая проверка 3ms',
      '     ✓ вторая проверка 1ms',
      '',
      ' FAIL  tests/b.test.ts > упавшая',
      'AssertionError: expected 1 to be 2',
      '      Tests  1 failed | 2 passed (3)',
    ];
    const folded = collapsePassedTests(lines.join('\n'));
    expect(folded.hidden).toBe(3);
    expect(folded.text).toContain('… прошло тестов: 3');
    expect(folded.text).toContain('Tests  1 failed | 2 passed (3)');
    expect(folded.text).toContain('AssertionError: expected 1 to be 2');
  });

  it('точечный вывод pytest: точки считаются, F не трогается', () => {
    const folded = collapsePassedTests('............................  [100%]\n42 passed in 1.2s');
    expect(folded.hidden).toBe(28);
    expect(folded.text).toContain('42 passed in 1.2s');
    // Строка с F — это уже не «всё прошло»: таких не трогаем.
    const failed = collapsePassedTests('....F....  [ 50%]');
    expect(failed.hidden).toBe(0);
    expect(failed.text).toBe('....F....  [ 50%]');
  });

  it('признак прогона тестов узнаётся по итоговой строке', () => {
    expect(looksLikeTestRun('Test Files  364 passed (364)')).toBe(true);
    expect(looksLikeTestRun('# pass 7')).toBe(true);
    expect(looksLikeTestRun('Tests:       1 passed, 1 total')).toBe(true);
    expect(looksLikeTestRun('собрано 12 файлов')).toBe(false);
  });
});

/**
 * Сжатие установки пакетов: модели нужны ошибки и итог, а не лог дерева
 * зависимостей. Полный вывод остаётся у вызывающего (spill-файл), здесь
 * проверяем только то, что уходит в контекст.
 */
describe('summarizeInstall', () => {
  const log = [
    'npm http fetch GET 200 https://registry/npm',
    'npm http fetch GET 200 https://registry/npm2',
    '⡀ idealTree:chui-ide: sill',
    'added 3 packages, and audited 4 packages in 1s',
    '1 package is looking for funding',
    '  run `npm fund` for details',
    'found 0 vulnerabilities',
  ].join('\n');

  it('сворачивает лог установки до итога', () => {
    const result = summarizeInstall('npm install', log);
    expect(result).not.toBeNull();
    expect(result?.text).toContain('added 3 packages');
    expect(result?.text).toContain('found 0 vulnerabilities');
    expect(result?.text).not.toContain('idealTree');
    expect(result?.hidden).toBeGreaterThan(0);
  });

  it('не трогает команды не про установку', () => {
    expect(summarizeInstall('npm test', log)).toBeNull();
    expect(summarizeInstall('git status', log)).toBeNull();
  });

  it('не трогает короткий вывод: прятать нечего', () => {
    expect(summarizeInstall('npm ci', 'added 0 packages')).toBeNull();
  });

  it('сохраняет ошибки и предупреждения', () => {
    const failed = [
      'npm http fetch GET 200 https://registry/npm',
      'npm http fetch GET 200 https://registry/npm2',
      'npm error code ERESOLVE',
      'npm error unable to resolve dependency tree',
      'npm warn deprecated left-pad@1.0.0',
      'added 1 package in 0.4s',
    ].join('\n');
    const result = summarizeInstall('pnpm add left-pad', failed);
    expect(result?.text).toContain('ERESOLVE');
    expect(result?.text).toContain('unable to resolve');
    expect(result?.text).toContain('deprecated');
  });
});
