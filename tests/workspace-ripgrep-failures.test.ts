import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runRipgrep } from '../src/main/workspace/workspace';
import { stubSupported } from './ripgrep-stub';

/**
 * Что делает поиск, когда `rg` недоступен: упал, завис, его прервали.
 *
 * Дорога ошибки тут одна: молчание. Если сбой `rg` превратится в «ничего не
 * найдено», человек получит уверенный пустой ответ там, где на самом деле
 * поиск не состоялся. Поэтому проверяем не текст, а решения: `null` —
 * команды нет (жить можно, есть свой обход), отказ — сбой поиска.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/**
 * Поддельный `rg`: настоящий исполняемый файл с телом на Node. Не `sh` — на Windows
 * его нет, и тест молча получал `null`: `rg` якобы не установлен, а решения
 * сервиса при таком ответе другие, и проверка ничего не доказывала.
 *
 * На POSIX обычный файл с шебангом запускается только через execvp, а спавн
 * без дисплея идёт в оболочке через PATH — так и происходит в бою. На Windows
 * без оболочки — только `.exe`: ни `rg` без расширения, ни `rg.cmd` спавн не найдёт
 * (ENOENT даже с `PATHEXT`). Шебанг для этого не нужен: Node читает его сам.
 *
 * Шебанг `#!/usr/bin/env node` в прогоне тестов врёт: env находит `node` в PATH,
 * а там под vitest лежит обёртка, которая ДОПИСЫВАЕТ к аргументам свои —
 * `--require …/vitest/suppress-warnings.cjs`. Наш `rg` работает не по argv, а по
 * `process.argv[2]`, поэтому такой флаг сжирал позиционный аргумент, скрипт
 * просыпал SIGTERM, и тест на прерывание падал раз в несколько полных прогонов
 * («ENOENT» — подпись уборки временного каталога). Поэтому Node зовётся полным
 * путём, тем же, что у самого vitest.
 */
async function withFakeRg(body: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-fail-'));
  roots.push(dir);
  const file = path.join(dir, 'rg');
  // process.execPath — не «первый node в PATH», а тот бинарник, что сейчас работает.
  // `--` первым аргументом — чтобы Node не съел флаги, которые допишет обёртка
  // vitest: строка `#!node --` тоже верна (`--` разбирается Node после версии, а
  // голая `--` без версии идёт позиционным аргументом и ломает поиск файла).
  await fs.writeFile(file, `#!${process.execPath} --\n${body}\n`, 'utf8');
  await fs.chmod(file, 0o755);
  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}${path.delimiter}${previous}`;
  // Возврат PATH — через afterEach неудобно: сохраняем в замыкании хука.
  afterEach(() => {
    process.env.PATH = previous;
  });
}

/**
 * Тело поддельного `rg`: проверка `--version` и действие `body`. Без `sh`: тело
 * пишется на Node, как и сам файл.
 */
function script(body: string): string {
  return `if (process.argv[2] === '--version') process.exit(0);\n${body}`;
}

/**
 * Дождаться отметки от убитого процесса. `close` приходит по выходу процесса, но
 * запись файла файловая система может отдать с задержкой (Windows — разделяем:
 * там сигнал не ловится вовсе и отметки нет, — поэтому `skip`).
 */
async function expectFileToContain(
  file: string,
  text: string,
  skip: boolean,
  context: () => Promise<string> = async () => '',
  timeoutMs = 2000,
): Promise<void> {
  if (skip) return;
  const deadline = Date.now() + timeoutMs;
  let mark = '';
  while (Date.now() < deadline) {
    mark = await fs.readFile(file, 'utf8').catch(() => '');
    if (mark.includes(text)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Журнал заглушки — в текст провала: без него причина («не тот процесс убит»)
  // не видна ни в CI, ни на машине, где провал повторился.
  expect(`${mark}\n--- журнал заглушки ---\n${await context()}`).toContain(text);
}

describe('сбои rg', () => {
  it('нет команды — null, а не ошибка и не пустой результат', async () => {
    // PATH без rg: только пустой каталог, чтобы ничего не нашлось случайно.
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-empty-'));
    roots.push(empty);
    const previous = process.env.PATH;
    process.env.PATH = empty;
    try {
      expect(await runRipgrep(['--version'], os.tmpdir())).toBeNull();
    } finally {
      process.env.PATH = previous;
    }
  });

  it.skipIf(!stubSupported)('сбой поиска (код 2) — отказ с причиной из stderr', async () => {
    await withFakeRg(script(`process.stderr.write('битый шаблон\\n');\nprocess.exit(2);`));
    await expect(runRipgrep(['--json', '-e', 'x', '.'], os.tmpdir())).rejects.toThrow(
      'rg завершился с кодом 2: битый шаблон',
    );
  });

  it.skipIf(!stubSupported)('совпадений нет (код 1) — это результат, а не отказ', async () => {
    await withFakeRg(script(`process.stdout.write('итог\\n');\nprocess.exit(1);`));
    expect(await runRipgrep(['--json', '-e', 'x', '.'], os.tmpdir())).toBe('итог\n');
  });

  it.skipIf(!stubSupported)('прерванный поиск убивает процесс', async () => {
    // Скрипт живёт, пока его не убьют: проверяем, что сигнал доходит.
    const marker = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-rg-kill-'));
    roots.push(marker);
    const died = path.join(marker, 'died.txt');
    const isWindows = process.platform === 'win32';
    // Сам сигнал на Windows не ловится: там процесс просто завершается убийством.
    const diedLiteral = JSON.stringify(died);
    const log = path.join(marker, 'rg.log');
    const logLiteral = JSON.stringify(log);
    // Журнал нужен потому, что провал этого теста (1 на ~4 полных прогона)
    // ничего не говорил о причине: «отметки нет» одинаково означало и «сигнал
    // не дошёл», и «дошёл, но убил не тот процесс». Теперь видно, кого ждали.

    // Отмену ждём от САМОЙ заглушки, а не по часам: 150 мс — это «ещё не успел
    // подняться» на загруженной машине (полный прогон: 1 падение на N; локально
    // журнал заглушки был ПУСТ — ни одной строки, значит node не успел дойти до
    // первой записи). Тест доказывает «сигнал доходит до живого процесса», и для
    // этого достаточно, чтобы процесс был жив — а он живёт 5 секунд.
    const ready = path.join(marker, 'started.txt');
    const readyLiteral = JSON.stringify(ready);
    await withFakeRg(
      script(
        `require('node:fs').appendFileSync(${logLiteral}, 'pid ' + process.pid + ' argv ' + process.argv.slice(2).join(',') + '\\n');\n` +
          `require('node:fs').writeFileSync(${readyLiteral}, 'да');\n` +
          `process.on('SIGTERM', () => { require('node:fs').appendFileSync(${logLiteral}, 'term ' + process.pid + '\\n'); require('node:fs').writeFileSync(${diedLiteral}, 'да'); process.exit(143); });\nsetTimeout(() => {}, 5000);`,
      ),
    );
    const controller = new AbortController();
    const pending = runRipgrep(['--json', '-e', 'x', '.'], os.tmpdir(), controller.signal);
    // Поднимаемся не дольше 3 с, иначе это не загруженность, а поломка заглушки.
    await expectFileToContain(ready, 'да', isWindows, async () => '', 3000);
    controller.abort();
    // Отказ называет наше решение, а не код убитого процесса: кода может не быть
    // вовсе (сигнал пришёл раньше обработчика), и `143` не отличался от `null` ни
    // для вызывающего, ни для человека. Ловим отказ в переменную, а не через
    // `rejects.toThrow`: так провал читается, даже если обещание уже отклонено.
    const failure = await pending.then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(failure)).toMatch(/^Error: поиск прерван: /);
    // Сигнал получил ТОТ САМЫЙ процесс, а не другой запуск заглушки: pid из журнала
    // поднятия должен встретиться в строке `term`. Это и есть исходная защита теста —
    // без неё «убит» ничего не доказывало бы.
    const journal = await fs.readFile(log, 'utf8').catch(() => '');
    const pid = /^pid (\d+)/m.exec(journal)?.[1];
    expect(pid).toBeDefined();
    await expectFileToContain(log, `term ${pid}`, isWindows);
    // Что доказать надо — что процесс был убит: он мог жить 5 секунд. Отметку ждём
    // отдельно, её пишет уже сам умирающий процесс; журнал заглушки идёт в текст
    // провала, чтобы причина была видна без повторного запуска.
    await expectFileToContain(died, 'да', isWindows, () => fs.readFile(log, 'utf8').catch(() => ''));
  });
});
