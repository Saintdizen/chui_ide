import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runRipgrep } from '../src/main/workspace/workspace';
import { parseRipgrepJson, ripgrepArgs } from '../src/shared/ripgrep';

/**
 * Запуск ripgrep: коды возврата.
 *
 * `rg` отвечает тремя кодами: 0 — совпадения есть, 1 — их нет, 2 — сбой поиска.
 * Пустой результат обязан ехать тем же путём, что и непустой: иначе поиск, где
 * ничего не нашлось (а это самый частый исход опечатки), каждый раз заново
 * обходил бы проект своим медленным обходом `fs`. Счётчик просмотренных файлов
 * при этом берётся из итоговой записи `--stats`, то есть и он не теряется.
 *
 * Проверки гоняют настоящий `rg`, как тесты git — настоящий `git`: без команды
 * в системе они пропускаются, а не притворяются пройденными.
 */

const hasRipgrep = (): boolean => spawnSync('rg', ['--version'], { windowsHide: true }).status === 0;

/** Каталог с файлами: их число и есть ожидаемое «просмотрено». */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-run-'));
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, name), text);
  return dir;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe.runIf(hasRipgrep())('runRipgrep', () => {
  it('код 1 (совпадений нет) — результат с итогом, а не отсутствие команды', async () => {
    const dir = await project({ 'a.ts': 'тут ничего\n', 'b.ts': 'и тут ничего\n' });
    dirs.push(dir);

    const output = await runRipgrep(ripgrepArgs({ query: 'нет-такого' }, [], 200, 0), dir);

    // null означал бы «rg не найден» — и вызов ушёл бы в обход `fs`.
    expect(output).not.toBeNull();
    const result = parseRipgrepJson(output!, { query: 'нет-такого' }, 200);
    expect(result.hits).toEqual([]);
    expect(result.scanned).toBe(2);
  });

  it('совпадение приходит с путём файла и итогом', async () => {
    const dir = await project({ 'a.ts': 'вот needle\n', 'b.ts': 'пусто\n' });
    dirs.push(dir);

    const output = await runRipgrep(ripgrepArgs({ query: 'needle' }, [], 200, 0), dir);

    const result = parseRipgrepJson(output!, { query: 'needle' }, 200);
    expect(result.hits.map((hit) => hit.text)).toEqual(['вот needle']);
    expect(result.scanned).toBe(2);
  });

  it('код 2 (сбой поиска) — отказ, а не пустой результат', async () => {
    const dir = await project({ 'a.ts': 'needle\n' });
    dirs.push(dir);

    // Такого флага у ripgrep нет: это ошибка вызова, и молча вернуть «ничего
    // не нашлось» значило бы спрятать поломку поиска.
    await expect(runRipgrep(['--json', '--нет-такого-флага'], dir)).rejects.toThrow(/кодом 2/);
  });
});
