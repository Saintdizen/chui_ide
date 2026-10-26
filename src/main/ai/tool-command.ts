import path from 'node:path';
import { runShellCommand, type RunOptions } from './run-command';
import type { SandboxRunner, ToolContext, ToolOutcome } from './tool-context';
import { clipTail, condenseOutput, foldPassedTests, spillNote, trimCommandTail } from './output-trim';
import { createSpillStream } from './spill';
import { needsConfirmation } from './tool-rules';
import { optionalString } from './tool-args';
import { relativePath as relativeFrom } from './agent-terminal';
import { testTargetProblem } from '../../shared/test-target';
import { ECHO_COMMAND_CHARS } from './tool-rules';

/**
 * Запуск тестов проекта: команду (pytest, vitest, jest, `node --test`) собирает
 * main — агент не должен угадывать раннер. Запуск спрашивает подтверждение, как
 * и команда в терминале: тесты выполняют код проекта. Вывод отдаём хвостом — он важнее
 * начала, а падение (упавший тест — код выхода не 0) это результат, а не сбой.
 */
export async function runTests(ctx: ToolContext, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const target = optionalString(args, 'target')?.trim();
  if (target) {
    const problem = testTargetProblem(target);
    if (problem) return { ok: false, summary: problem };
  }
  if (!ctx.tests) return { ok: false, summary: 'Запуск тестов недоступен' };
  if (!ctx.confirmCommand)
    return {
      ok: false,
      summary: 'Запуск тестов недоступен: окно редактора не подключено',
    };

  const resolved = await ctx.tests.command(target);
  if (!resolved) {
    return {
      ok: false,
      summary: 'Тесты проекта не найдены',
      detail:
        'В проекте нет тестов или известного раннера: у Python это pytest с файлами `test_*.py`, ' +
        'у Node — vitest, jest или встроенный `node --test`. Отдельный файл можно запустить через terminal (action run).',
    };
  }

  if (needsConfirmation(ctx, resolved.command)) {
    const allowed = await ctx.confirmCommand(resolved.command);
    if (!allowed) {
      return {
        ok: false,
        summary: 'Пользователь запретил запуск тестов',
        detail: 'Пользователь не разрешил запустить тесты. Не повторяй вызов — предложи другой ход.',
      };
    }
  }

  const root = ctx.workspace.rootPath();
  if (!root) return { ok: false, summary: 'Проект не открыт' };

  if (ctx.sandbox && !ctx.sandbox.available) return sandboxUnavailable(ctx.sandbox);
  // Полная копия вывода: ниже остаётся только хвост, а отброшенное начало иначе
  // не достать ничем, кроме повторного запуска — а он даёт уже другой вывод.
  const spillStream = ctx.spillDir ? createSpillStream(ctx.spillDir, 'run_tests') : null;
  const options: RunOptions = spillStream
    ? { signal: ctx.signal, spill: (chunk) => spillStream.write(chunk) }
    : { signal: ctx.signal };
  const result = ctx.sandbox
    ? await ctx.sandbox.run(resolved.command, root, options)
    : await runShellCommand(resolved.command, root, options);
  // Файл оставляем только тогда, когда вывод действительно не поместился в потолок.
  const full = spillStream?.close(result.truncated) ?? null;
  const condensed = foldPassedTests(ctx, 'run_tests', condenseOutput(result.output));
  const output = full ? trimCommandTail(ctx, condensed, full) : clipTail(ctx, 'run_tests', condensed);
  const notes = [
    result.timedOut ? 'превышено время' : '',
    result.signal ? `убит сигналом ${result.signal}` : '',
    result.truncated ? 'вывод обрезан' : '',
  ].filter(Boolean);
  // Ненулевой код — это упавшие тесты, а не ошибка инструмента: ответ ok, но с кодом.
  const passed = result.code === 0 && !result.timedOut;

  return {
    ok: passed,
    summary: `тесты (${resolved.label}): код выхода ${result.code ?? '—'}${notes.length ? ` (${notes.join(', ')})` : ''}`,
    detail: `${commandLine(ctx, resolved.command)}\n${output.length ? output : '(пустой вывод)'}${spillNote(full)}`,
  };
}

/**
 * Строка команды для вывода: видно, что именно выполнялось и где. В песочнице
 * это ещё и подсказка человеку, что код шёл в контейнере, а не на его машине.
 */
export function commandLine(ctx: ToolContext, command: string, relative = ''): string {
  const where = relative ? ` [${relative}]` : '';
  // Длинную команду не повторяем: она уже есть в вызове выше — модель сама её
  // написала, и человек видит её в карточке. Замер на живом прогоне: в ответах
  // `terminal` эхо команды занимало 34% символов, а heredoc на две тысячи
  // символов возвращался целиком, ничего не сообщая.
  const lines = command.split('\n');
  const shown =
    lines.length === 1 && command.length <= ECHO_COMMAND_CHARS
      ? command
      : `${lines[0]!.slice(0, ECHO_COMMAND_CHARS)}… (команда из ${lines.length} строк)`;
  return ctx.sandbox ? `$ (в ${ctx.sandbox.label})${where} ${shown}` : `$${where} ${shown}`;
}

/**
 * Папка запуска команды: `cwd` из аргументов, иначе корень проекта.
 *
 * Путь проверяется рабочей папкой (`workspace.stat`): запустить команду за
 * пределами проекта не выйдет, а `..` и симлинки границу не обходят. Отдельно
 * возвращается путь относительно корня: он нужен контейнеру, где смонтирован
 * только корень.
 */
export async function commandCwd(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<{ root: string; path: string; relative: string } | null> {
  const root = ctx.workspace.rootPath();
  if (!root) return null;
  const raw = optionalString(args, 'cwd');
  if (!raw) return { root, path: root, relative: '' };
  // Относительный `cwd` — от корня проекта, а не от текущего каталога процесса:
  // модель видит в контексте «Рабочая папка проекта: …» и потому пишет `cwd: "src"`,
  // а `safePath` разворачивает относительное от cwd процесса и отвечает «Путь вне
  // рабочей папки» (проверено живьём 26.10: `src`, `./src`, `src/` — все три отказа).
  // Те же слова, что и «пути абсолютные и внутри проекта», но вызов честнее принять:
  // `read`/`edit` относительный путь тоже понимают — расхождение было только тут.
  const target = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  const stat = await ctx.workspace.stat(target);
  if (stat.kind !== 'directory') throw new Error(`Аргумент «cwd» — не папка: ${raw}`);
  const relative = relativeFrom(stat.path, root);
  return { root, path: stat.path, relative: relative === '.' ? '' : relative };
}

/**
 * Команда для контейнера: проекта там только корень, поэтому подпапка — `cd`.
 * Кавычки обязательны: в имени папки может быть пробел, и `sh -c` разберёт его
 * как границу аргумента.
 */
export function insideProject(relative: string, command: string): string {
  if (!relative) return command;
  return `cd ${quoteSh(relative)} && ${command}`;
}

/** Строка в одинарных кавычках для `sh -c`: внутри них ничего не раскрывается. */
export function quoteSh(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * `cd <папка> && команда` — тот же запуск, только папку несёт сама команда.
 *
 * В переписи живых вызовов 76 из 93 начинались с такого префикса, хотя у `run`
 * есть `cwd`: привычка модели, а не нужда. Поднимаем префикс в аргумент — панель
 * ревью и история показывают саму команду, а не обвязку. Папку вне проекта
 * (`stat` бросит) не трогаем: пусть откажет проверка пути, а не догадка.
 */
export async function liftCdPrefix(
  ctx: ToolContext,
  command: string,
  args: Record<string, unknown>,
): Promise<{ command: string; args: Record<string, unknown> }> {
  // Явный `cwd` главнее: тогда `cd` внутри команды — это уже её собственный шаг.
  if (optionalString(args, 'cwd')?.trim()) return { command, args };
  const match = /^cd\s+(?:'([^']*)'|"([^"]*)"|(\S+))\s*&&\s*(\S[\s\S]*)$/.exec(command);
  if (!match) return { command, args };
  const dir = match[1] ?? match[2] ?? match[3];
  const rest = match[4];
  if (!dir) return { command, args };
  try {
    const stat = await ctx.workspace.stat(dir);
    if (stat.kind !== 'directory') return { command, args };
    return { command: rest, args: { ...args, cwd: stat.path } };
  } catch {
    return { command, args };
  }
}

/**
 * Песочница включена, а движка нет: команду не выполняем и прямо говорим, что на
 * хост она не переключится. Тихий откат был бы худшим исходом — человек считал бы,
 * что чужой код идёт в изоляции, а он шёл бы на его машине.
 */
export function sandboxUnavailable(sandbox: SandboxRunner): ToolOutcome {
  return {
    ok: false,
    summary: 'Песочница включена, но движок контейнеров не найден',
    detail:
      `Команды должны идти в ${sandbox.label}, но docker (или podman) в PATH нет. ` +
      'На хост команда НЕ выполняется. Скажи об этом пользователю: пусть установит движок ' +
      'или выключит песочницу в настройках.',
  };
}
