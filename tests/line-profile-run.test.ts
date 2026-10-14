import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runLineProfile } from '../src/main/python/line-profile';
import { heatLevel, hottestLines } from '../src/shared/line-profile';

/**
 * Профилировщик строк целиком: настоящий Python исполняет настоящий скрипт под обёрткой,
 * и мы проверяем, что отчёт разобран и «горячая» строка найдена.
 *
 * Тест пропускается, если в системе нет Python: проверять чужой инструмент нечем, а
 * падать на его отсутствии тест не должен — это не ошибка кода проекта.
 */

function findPython(): string | null {
  for (const candidate of ['python3', 'python']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Нет такого — пробуем следующий.
    }
  }
  return null;
}

const python = findPython();

// Каталог — через realpath: на macOS os.tmpdir() это симлинк, и путь в отчёте иначе
// не совпал бы с тем, что мы передали в запуск (та же ловушка, что у git-тестов).
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'chui-profile-test-')));
const scriptPath = path.join(dir, 'hot.py');
writeFileSync(
  scriptPath,
  [
    'def hot():',
    '    total = 0',
    '    for i in range(20000):',
    '        total += i',
    '    return total',
    '',
    'print(hot())',
    '',
  ].join('\n'),
  'utf8',
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(python === null)('runLineProfile: профиль настоящего скрипта', () => {
  it('отчёт разобран: строки, время и горячая строка найдены', async () => {
    const run = await runLineProfile({
      root: dir,
      python: python ?? 'python3',
      path: scriptPath,
      tempDir: os.tmpdir(),
    });

    expect(run.failed).toBe(false);
    expect(run.profile.error).toBeNull();
    expect(run.profile.files.map((file) => file.path)).toContain(scriptPath);
    expect(run.stdout).toContain('199990000');

    const hottest = hottestLines(run.profile, 1)[0];
    expect(hottest).toBeDefined();
    // Самая дорогая строка — тело цикла: она обязана исполниться много раз.
    expect(hottest!.line.hits).toBeGreaterThan(1000);
    expect(heatLevel(hottest!.line.percent)).toBeGreaterThan(0);
  });

  it('скрипт с ошибкой даёт профиль и текст падения', async () => {
    const broken = path.join(dir, 'broken.py');
    writeFileSync(broken, 'print("до")\nraise RuntimeError("сломалось")\n', 'utf8');
    const run = await runLineProfile({ root: dir, python: python ?? 'python3', path: broken, tempDir: os.tmpdir() });

    expect(run.failed).toBe(false);
    expect(run.profile.exitCode).toBe(1);
    expect(run.profile.error).toContain('RuntimeError');
    // Строка до падения всё равно попала в профиль.
    expect(run.profile.files.flatMap((file) => file.lines).length).toBeGreaterThan(0);
  });
});

describe('runLineProfile без рабочего интерпретатора', () => {
  it('сообщает, что запустить нечем, вместо падения', async () => {
    const run = await runLineProfile({
      root: dir,
      python: 'python-которого-нет',
      path: scriptPath,
      tempDir: os.tmpdir(),
      timeoutMs: 5000,
    });
    expect(run.failed).toBe(true);
    expect(run.message).toBeTruthy();
  });
});
