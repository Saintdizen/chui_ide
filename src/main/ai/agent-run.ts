/**
 * `run` — сборка проекта: скрипт из `package.json` или `tsc --noEmit`.
 *
 * Отдельно от `run_tests`, потому что это другой вопрос: тесты проверяют
 * поведение, сборка — что код вообще собирается. Механика запуска та же
 * (`run_tests` и `terminal`): подтверждение, хвост вывода, код выхода в ответе,
 * а ненулевой код — результат, а не сбой инструмента.
 *
 * Что именно запускать, решает main (`project/build.ts`): у проекта есть
 * `scripts.build`, и агент зовёт его по имени, а не угадывает команду.
 */

import { decisionCommand } from '../../shared/agent-grants';
import { buildCandidates, buildCommand } from '../project/build';
import { optionalString } from './tool-args';
import { MAX_OUTPUT_CHARS } from './output-budget';
import { clipTail, condenseOutput, foldPassedTests, spillNote, trimCommandTail } from './output-trim';
import { runShellCommand, type RunOptions } from './run-command';
import { createSpillStream } from './spill';
import { ECHO_COMMAND_CHARS, needsConfirmation } from './tool-rules';
import { commandLine } from './tool-command';
import path from 'node:path';
import { findPrimaryVenvSync } from '../python/environments';
import type { ToolContext, ToolOutcome } from './tool-context';

export async function runBuild(ctx: ToolContext, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  if (!ctx.confirmCommand) {
    return { ok: false, summary: 'Сборка недоступна: окно редактора не подключено' };
  }

  const root = ctx.workspace.rootPath();
  if (!root) return { ok: false, summary: 'Проект не открыт' };

  const task = optionalString(args, 'task')?.trim();
  const resolved = await buildCommand(root, task);
  if (!resolved) {
    const candidates = await buildCandidates(root);
    const hint = task
      ? `Скрипта \`${task}\` нет в package.json.`
      : 'Скрипта сборки нет, и tsc в node_modules не найден.';
    return {
      ok: false,
      summary: task ? `Неизвестный скрипт: ${task}` : 'Сборка проекта не найдена',
      detail:
        candidates.length > 0
          ? `${hint}\nЕсть скрипты: ${candidates.join(', ')}. Вызови run с task из этого списка.`
          : `${hint} Собери вручную через terminal (action run), если команда известна.`,
    };
  }

  // Человек может поправить команду в карточке — выполняем его текст.
  let command = resolved.command;
  if (needsConfirmation(ctx, command)) {
    const decision = await ctx.confirmCommand(command);
    const allowed = typeof decision === 'boolean' ? decision : decision.allowed;
    if (!allowed) {
      return {
        ok: false,
        summary: 'Пользователь запретил сборку',
        detail: 'Пользователь не разрешил запуск. Не повторяй вызов — предложи другой ход.',
      };
    }
    command = decisionCommand(decision, command);
  }

  if (ctx.sandbox && !ctx.sandbox.available) {
    return { ok: false, summary: 'Контейнер недоступен', detail: 'Сборка пойдёт в контейнере, а он не поднялся.' };
  }

  const spillStream = ctx.spillDir ? createSpillStream(ctx.spillDir, 'run') : null;
  const runOptions: RunOptions = spillStream
    ? { signal: ctx.signal, headChars: MAX_OUTPUT_CHARS, spill: (chunk) => spillStream.write(chunk) }
    : { signal: ctx.signal, headChars: MAX_OUTPUT_CHARS };
  const result = ctx.sandbox
    ? await ctx.sandbox.run(command, root, runOptions)
    : await runShellCommand(command, root, runOptions);

  const full = spillStream?.close(result.truncated) ?? null;
  const condensed = foldPassedTests(ctx, 'run', condenseOutput(result.output));
  const output = full ? trimCommandTail(ctx, condensed, full) : clipTail(ctx, 'run', condensed);
  const notes = [
    result.timedOut ? 'превышено время' : '',
    result.signal ? `убит сигналом ${result.signal}` : '',
    result.truncated ? 'вывод обрезан' : '',
  ].filter(Boolean);
  const passed = result.code === 0 && !result.timedOut;

  // Виртуальное окружение Python: без единой команды модель не знает, что оно
  // есть, и запускает `python`, который берёт системный пакет вместо
  // установленного в проект. Строка стоит ~20 токенов и появляется только там,
  // где окружение действительно найдено.
  const venv = venvNote(ctx.workspace.rootPath());
  return {
    ok: true,
    ...(passed ? {} : { failed: true }),
    summary: `сборка (${resolved.label}): код выхода ${result.code ?? '—'}${notes.length ? ` (${notes.join(', ')})` : ''}`,
    detail:
      `${commandLine(ctx, command)}\n${output.length ? output : '(пустой вывод)'}${spillNote(full)}` +
      (venv ? `\n${venv}` : ''),
  };
}

/**
 * Строка про виртуальное окружение — один раз на прогон сборки.
 *
 * Путь ищет `findPrimaryVenvSync` (тот же, что у подсветки и активации в
 * редакторе): `.venv`, `venv`, `env` в корне проекта. Нет окружения — нет и
 * строки: молчать дешевле, чем объяснять его отсутствие.
 */
function venvNote(root: string | null): string | null {
  if (!root) return null;
  // Возвращается путь к интерпретатору окружения, а не к папке.
  const python = findPrimaryVenvSync(root);
  if (!python) return null;
  const dir = path.dirname(path.dirname(python));
  return `venv: ${dir} — этот прогон идёт без активации; python проекта: ${python}.`;
}

/** Эхо длинной команды не повторяем: оно уже есть в карточке вызова. */
export function echoLimit(): number {
  return ECHO_COMMAND_CHARS;
}
