import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTool, type SandboxRunner, type ToolContext } from '../src/main/ai/agent-tools';
import { WorkspaceService } from '../src/main/workspace/workspace';
import { rememberRead, type ReadRange } from '../src/shared/read-coverage';

/**
 * Чтение через шелл — 43% вызовов `terminal` в переписи (TASKS.md, п.43).
 * `cat`, `head -n N`, `sed -n 'A,Bp'`, `grep` и `ls` теперь разбираются и
 * выполняются структурными `read`/`search`/`list`: с номерами строк, с потолком
 * вывода и без запуска шелла. Всё, что не разобралось, идёт в шелл как раньше.
 */

let dir: string;
let workspace: WorkspaceService;

const LINES = 40;

/** Песочница-подставка: помнит, что и где просили выполнить. */
function sandbox(): SandboxRunner & { calls: { command: string; cwd: string }[] } {
  const calls: { command: string; cwd: string }[] = [];
  return {
    label: 'контейнер обрезка',
    available: true,
    run: async (command: string, cwd: string) => {
      calls.push({ command, cwd });
      return { code: 0, signal: null, output: 'шелл', truncated: false, timedOut: false };
    },
    calls,
  };
}

/** Контекст с подтверждением: путь через шелл его спрашивает, разбор — нет. */
function context(box: SandboxRunner, coveredReads?: ToolContext['coveredReads']): ToolContext {
  return {
    workspace,
    sandbox: box,
    coveredReads,
    confirmCommand: async () => true,
  } as unknown as ToolContext;
}

const run = (box: SandboxRunner, command: string) =>
  runTool(context(box), 'terminal', JSON.stringify({ action: 'run', command }));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chui-lookup-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  const rows = Array.from({ length: LINES }, (_, index) => `const row${index + 1} = ${index + 1};`);
  await fs.writeFile(path.join(dir, 'src/app.ts'), rows.join('\n'), 'utf8');
  await fs.writeFile(path.join(dir, 'src/note.md'), 'иголка в стоге\n', 'utf8');
  workspace = new WorkspaceService(() => undefined);
  await workspace.open(dir);
});

afterEach(async () => {
  workspace.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('команда-читалка выполняется структурно', () => {
  it('cat файла — это read с номерами строк', async () => {
    const box = sandbox();
    const outcome = await run(box, 'cat src/app.ts');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    // Файл короткий — `read` отдаёт его целиком и без номеров (номера только у
    // диапазона): `cat` получает ровно то же, что дал бы `read(path)`.
    expect(String(outcome.detail)).toContain('const row1 = 1;');
    expect(String(outcome.detail)).toContain(`const row${LINES} = ${LINES};`);
    expect(outcome.summary).toContain('cat → read');
  });

  it('cd папка && cat файл — тот же read, и область — из cd', async () => {
    // 655 вызовов `cd` в замере уходили в шелл целиком: менялась область, а не
    // суть. Теперь префикс снимается, и в шелл не уходит ничего.
    const box = sandbox();
    const outcome = await run(box, 'cd src && cat app.ts');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(String(outcome.detail)).toContain('const row1 = 1;');
  });

  it('cd вне проекта — всё равно шелл: подстановку делает он', async () => {
    const box = sandbox();
    const outcome = await run(box, 'cd ~/чужое && cat app.ts');

    expect(box.calls).toHaveLength(1);
    expect(outcome.ok).toBe(true);
  });

  it('awk по номерам строк — это read диапазоном', async () => {
    const box = sandbox();
    const range = await run(box, "awk 'NR>=3 && NR<=4' src/app.ts");
    const single = await run(box, "awk 'NR==7' src/app.ts");

    expect(box.calls).toEqual([]);
    expect(String(range.detail)).toContain('3 | const row3 = 3;');
    expect(String(range.detail)).not.toContain('5 | const row5 = 5;');
    expect(String(single.detail)).toContain('7 | const row7 = 7;');
  });

  it('awk, печатающий поля, — по-прежнему шелл', async () => {
    // У `read` нет ответа «второе поле от каждой строки» — не притворяемся.
    const box = sandbox();
    await run(box, "awk -F: '{print $2}' /etc/passwd");
    expect(box.calls).toHaveLength(1);
  });

  it('cat файл | head -N — read с потолком, а не шелл', async () => {
    // Потолок понимает только `search`; для `read` он становится концом диапазона,
    // иначе `cat f | head -20` тихо терялся и шёл в шелл.
    const box = sandbox();
    const outcome = await run(box, 'cat src/app.ts | head -2');

    expect(box.calls).toEqual([]);
    expect(String(outcome.detail)).not.toContain('3 | const row3 = 3;');
  });

  it('sed -n «A,Bp» — это read диапазоном', async () => {
    const box = sandbox();
    const outcome = await run(box, "sed -n '3,5p' src/app.ts");

    expect(box.calls).toEqual([]);
    const detail = String(outcome.detail);
    expect(detail).toContain('3 | const row3 = 3;');
    expect(detail).toContain('5 | const row5 = 5;');
    expect(detail).not.toContain('6 | const row6 = 6;');
  });

  it('head -n N и head -N — это read с endLine', async () => {
    const box = sandbox();
    const spaced = await run(box, 'head -n 2 src/app.ts');
    const joined = await run(box, 'head -2 src/app.ts');

    expect(box.calls).toEqual([]);
    for (const outcome of [spaced, joined]) {
      expect(String(outcome.detail)).toContain('2 | const row2 = 2;');
      expect(String(outcome.detail)).not.toContain('3 | const row3 = 3;');
    }
  });

  it('grep — это search, а не шелл', async () => {
    const box = sandbox();
    const outcome = await run(box, 'grep -rn иголка src');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(String(outcome.detail)).toContain('note.md');
    expect(outcome.summary).toContain('grep → search');
  });

  it('ls — это list', async () => {
    const box = sandbox();
    const outcome = await run(box, 'ls -la src');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(String(outcome.detail)).toContain('app.ts');
    expect(String(outcome.detail)).toContain('note.md');
  });
  it('образец с трубой в кавычках — всё равно search', async () => {
    // `grep 'a\|b'` шелл не раскрывает: это образец, а не скрипт.
    for (const command of ['grep "row3\\|row4" src/app.ts', 'grep "(row3)" src/app.ts']) {
      const box = sandbox();
      await run(box, command);
      expect(box.calls, command).toEqual([]);
    }
  });

  it('`| head -N` — тот же поиск, только с пределом', async () => {
    const box = sandbox();
    for (const command of ['grep row src/app.ts | head -5', 'grep row src/app.ts | head -n 5']) {
      await run(box, command);
    }
    expect(box.calls).toEqual([]);
  });

  it('`"` не часть команды: труба внутри цитаты — образец, а не конвейер', async () => {
    // Грабля: `asPipedCommand` не знал про кавычки и читал `a|"b` в образце как
    // конвейер. `commandWords` на незакрытой цитате возвращал null, вызов молча
    // уходил в шелл, а шелл на таком образце молча отдавал пустой вывод — то есть
    // «не нашлось» вместо «не смог». Проверяем именно разбор: в шелл не идём.
    const box = sandbox();
    const outcome = await run(box, 'grep -nE "row3|row4" src/app.ts | head -5');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(String(outcome.detail)).toContain('row3');
    expect(String(outcome.detail)).toContain('row4');
  });

  it('`\\|` в образце внутри конвейера — всё равно search', async () => {
    // Грабля: `pipePosition` не пропускал `\\` внутри кавычек — труба в образце
    // (`"row3\\|row4"`) виделась второй, внешней, `splitPipe` отвечал `'script'`,
    // и вызов уходил в шелл мимо `search`. Образец с экранированной трубой —
    // обычное дело: так пишут «или» без regex.
    const box = sandbox();
    const outcome = await run(box, 'grep -nE "row3\\|row4" src/app.ts | head -5');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(String(outcome.detail)).toContain('row3');
  });

  it('`--include=*.md` — маска для search, а не глоб шелла', async () => {
    const box = sandbox();
    await run(box, 'grep -rn иголка src --include=*.md');
    expect(box.calls).toEqual([]);
  });

  it('конвейер с `head` не глотает regex-трубу в образце', async () => {
    // Грабля: `takeHeadTail` резал строку regex-ом `^(.*?)\\s*\\|\\s*head...`, и
    // ленивая группа отдавала кусок ДО первой трубы — тут это труба в самом образце.
    // Всё после терялось, в `search` уезжал одинокий `row3` без `-E`: ложный ответ.
    const box = sandbox();
    const outcome = await run(box, 'grep -nE "row3|row4" src/app.ts | head -5');
    expect(box.calls).toEqual([]);
    expect(String(outcome.detail)).toContain('row4');
  });

  it('`\\|` из BRE не доходит до JS regex буквальной трубой', async () => {
    // Грабля: в grep `\\|` — это «или», а в JS regex `\\|` — буквальная труба.
    // Образец уезжал в `search` как есть, и `grep -n "row3\\|row4" файл`
    // неизменно отвечал «Совпадений нет» там, где совпадения есть.
    const box = sandbox();
    const outcome = await run(box, 'grep -n "row3\\|row4" src/app.ts');
    expect(box.calls).toEqual([]);
    expect(outcome.summary).toContain('10 совпадений');
  });

  it('но `cat src/*.ts` — всё равно глоб: в шелл', async () => {
    const box = sandbox();
    await run(box, 'cat src/*.ts');
    expect(box.calls.length).toBe(1);
  });

  it('незакрытая кавычка — отказ с объяснением, а не пустой вывод из шелла', async () => {
    // Грабля: `shellSyntax` отдавал такую команду шеллу, тот отрабатывал с кодом 0
    // и пустым выводом, и модель читала `(пустой вывод)` как «файла нет» или
    // «файл пуст». Сломанная команда — это ответ, а не повод идти в шелл.
    const box = sandbox();
    const outcome = await run(box, 'grep -n "row3 src/app.ts');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain('кавычка без пары');
  });

  it('то же для `cat` с незакрытой кавычкой', async () => {
    const box = sandbox();
    const outcome = await run(box, 'cat "src/app.ts');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(false);
  });

  it('парная кавычка — по-прежнему `search`, отказ её не задевает', async () => {
    const box = sandbox();
    const outcome = await run(box, 'grep -n "row3" src/app.ts');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
  });
});

describe('background на чистых чтениях', () => {
  // Грабля: `terminalRun` смотрел на `background` раньше, чем на команду, и `cat
  // file` с `background: true` уходил в ветку заданий — в песочнице это отказ
  // «фон не поддерживается», то есть чтение вообще не выполнялось. Флаг — про
  // долгие процессы, а читалка всё равно отвечает сразу.
  const runBackground = (box: SandboxRunner, command: string) =>
    runTool(context(box), 'terminal', JSON.stringify({ action: 'run', command, background: true }));

  it('`cat` с background читается структурно, а не падает в фон', async () => {
    const box = sandbox();
    const outcome = await runBackground(box, 'cat src/app.ts');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('read');
  });

  it('`grep` с background — это `search`, а не задание', async () => {
    const box = sandbox();
    const outcome = await runBackground(box, 'grep row3 src/app.ts');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('search');
  });

  it('`ls` с background — это `list`', async () => {
    const box = sandbox();
    const outcome = await runBackground(box, 'ls src');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toContain('list');
  });

  it('а вот не-читалка с background в фон по-прежнему уходит', async () => {
    // Страж в другую сторону: правка не должна превратить `background` в пустышку.
    // В тестовом контексте заданий нет — значит до ветки фона дошли, и она сказала своё.
    const box = sandbox();
    const outcome = await runBackground(box, 'npm run build');

    expect(outcome.summary).toContain('Задания недоступны');
  });
});

describe('всё остальное по-прежнему идёт в шелл', () => {
  it('не команда-читалка', async () => {
    const box = sandbox();
    await run(box, 'npm test');

    expect(box.calls.length).toBe(1);
  });

  it('труба или перенаправление — это уже скрипт', async () => {
    for (const command of ['grep иголка src > out.txt', 'cat a.ts && cat b.ts', 'grep foo src | wc -l']) {
      const box = sandbox();
      await run(box, command);
      expect(box.calls.length, command).toBe(1);
    }
  });

  it('`grep … | grep …` — одна труба, разбирается в один search', async () => {
    const box = sandbox();
    const outcome = await run(box, 'grep -rn row src | grep row2');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    // Оба условия разом: `row` из левой части и `row2` из правой.
    expect(String(outcome.detail)).toContain('row2');
    expect(String(outcome.detail)).not.toContain('row1 =');
    expect(outcome.summary).toContain('grep | grep → search');
  });

  it('`grep … | grep -c …` — счёт по всему, а не по видимому', async () => {
    const box = sandbox();
    const outcome = await run(box, 'grep -rn row src/app.ts | grep -c row1');

    expect(box.calls).toEqual([]);
    // Строк в app.ts больше, чем потолок на файл (10), а «row1» ловит 11 из них
    // (row1, row10, row11…): счёт не должен упереться в 10.
    expect(Number(outcome.detail)).toBeGreaterThan(10);
  });

  it('`-c` — это тот же search, но ответ — число', async () => {
    const box = sandbox();
    const outcome = await run(box, 'grep -c row2 src/app.ts');

    expect(box.calls).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(Number(outcome.detail)).toBeGreaterThan(0);
    expect(outcome.summary).toContain('совпадений');
  });

  it('труба с папкой у фильтра — не гадаем, в шелл', async () => {
    const box = sandbox();
    await run(box, 'grep -rn row src | grep row docs');
    expect(box.calls.length).toBe(1);
  });

  it('неизвестный флаг — не наш случай', async () => {
    const box = sandbox();
    await run(box, 'ls -R src');

    expect(box.calls.length).toBe(1);
  });
});

describe('читалка поверх уже прочитанного', () => {
  it('не прячет изменившийся файл за старым покрытием', async () => {
    const box = sandbox();
    const coveredReads = new Map<string, ReadRange[]>();
    const ctx = context(box, coveredReads);
    const args = JSON.stringify({ action: 'run', command: 'cat src/app.ts' });
    const first = await runTool(ctx, 'terminal', args);
    rememberRead(coveredReads, first.read!);
    coveredReads.get(first.read!.path)![0]!.suspect = true;
    await fs.writeFile(first.read!.path, 'changed file\n');
    const second = await runTool(ctx, 'terminal', args);
    expect(second.detail).toContain('changed file');
    expect(second.summary).not.toContain('уже прочитано');
  });
  it('повторный cat того же файла — строка, а не вторая копия', async () => {
    const box = sandbox();
    const coveredReads = new Map<string, Array<{ from: number; to: number }>>();
    coveredReads.set(path.join(dir, 'src/app.ts'), [{ from: 1, to: LINES }]);
    const outcome = await runTool(
      context(box, coveredReads),
      'terminal',
      JSON.stringify({ action: 'run', command: 'cat src/app.ts' }),
    );
    expect(outcome.summary).toContain('уже прочитано');
    expect(String(outcome.detail)).toContain('уже есть выше в ветке');
    expect(String(outcome.detail)).not.toContain('const row1');
    expect(box.calls, 'шелл не понадобился').toEqual([]);
  });
});

/**
 * Относительный `cwd` — от корня проекта. Модель видит в контексте «Рабочая папка
 * проекта: …» и пишет `cwd: "src"`; до 26.10 такой вызов падал «Путь вне рабочей
 * папки», потому что относительное разворачивалось от текущего каталога процесса.
 * `read`/`edit` относительный путь понимали — расхождение было только у шелла.
 */
describe('terminal: относительный cwd считается от корня проекта', () => {
  // В песочнице монтируется только корень, поэтому подпапка едет в команде как `cd`,
  // а `cwd` процесса остаётся корнем. Отсюда и проверка: команда стартует в подпапке.
  const commandOf = (box: { calls: { command: string; cwd: string }[] }) => box.calls[0]?.command ?? '';

  for (const cwd of ['src', './src', 'src/']) {
    it(`cwd ${cwd} запускает команду в подпапке проекта`, async () => {
      const box = sandbox();
      const out = await runTool(context(box), 'terminal', JSON.stringify({ action: 'run', command: 'npm test', cwd }));
      expect(out.ok).toBe(true);
      expect(box.calls[0]?.cwd).toBe(dir);
      expect(commandOf(box)).toContain("cd 'src'");
    });
  }

  it('несуществующая папка — отказ, а не запуск в корне', async () => {
    const box = sandbox();
    const out = await runTool(
      context(box),
      'terminal',
      JSON.stringify({ action: 'run', command: 'npm test', cwd: 'нет-такой' }),
    );
    expect(out.ok).toBe(false);
    expect(box.calls).toHaveLength(0);
  });

  it('абсолютный cwd внутри проекта по-прежнему работает', async () => {
    const box = sandbox();
    const out = await runTool(
      context(box),
      'terminal',
      JSON.stringify({ action: 'run', command: 'npm test', cwd: path.join(dir, 'src') }),
    );
    expect(out.ok).toBe(true);
    expect(commandOf(box)).toContain("cd 'src'");
  });
});
