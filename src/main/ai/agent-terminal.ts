/**
 * Терминал как голос модели: запуск, живая сессия, чтение и запись.
 *
 * Вынесено из `agent-tools.ts` блоком «терминальные сессии»: у терминала свой
 * цикл — `start` отвечает сразу, а `read`/`write`/`stop` ходят в живую сессию,
 * которую держит отдельный сервис. Здесь же `describe`/`relative`/`relativePath`:
 * их терминал зовёт в каждом чтении, а больше никто так часто.
 */
import path from 'node:path';
import type { DirEntry } from '../../shared/api';
import { asLookupCall } from './agent-lookup';
import { clipTail, condenseOutput, foldPassedTests, spillNote, trimCommandTail } from './output-trim';
import { createSpillStream } from './spill';
import { missingForAction, optionalBoolean, optionalInteger, optionalString, requireString } from './tool-args';
import { MAX_COMMAND_CHARS } from './tool-rules';
import { confirmRun } from './tool-rules';
import { commandCwd, commandLine, insideProject, liftCdPrefix, sandboxUnavailable } from './tool-command';
import { lookupOutcome } from './agent-tools';
import { runShellCommand } from './run-command';
import type { JobHandle, JobSnapshot } from './jobs';
import type { RunOptions } from './run-command';
import type { ToolContext, ToolOutcome } from './tool-context';

/** С какого размера файл называем в `list`. Мелкие размеры — шум: за вызов
 * их бывает до 500, и «(412 Б)» у каждой записи стоит дороже, чем сообщает. */
export const BIG_FILE_BYTES = 1024 * 1024;

/** Размер крупного файла в удобных единицах — только для таких и зовётся. */
export function formatBigSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${mb.toFixed(1)} МБ`;
}

/* ── терминальные сессии (pty) ──────────────────────────────────────────── */

/** ANSI-последовательности и возврат каретки модели не нужны: оставляем текст. */

/* ── вспомогательное ────────────────────────────────────────────────────── */

export function describe(entry: DirEntry, root: string | null): string {
  const suffix = entry.kind === 'directory' ? '/' : '';
  // Размер печатаем только там, где он что-то решает: «(412 Б)» у каждой
  // записи — это шум, который едет в контекст модели в каждом `list` и
  // ничего не сообщает (до 500 записей за вызов). Крупный файл — другое дело:
  // по нему видно, что читать его целиком не стоит.
  const size = entry.kind === 'file' && entry.size >= BIG_FILE_BYTES ? ` (${formatBigSize(entry.size)})` : '';
  // Ссылку видно отдельно: агент должен знать, что путь — не обычная запись, а
  // ссылка (и куда ведёт). Битую помечаем словом: по ней ничего не прочитать.
  const link = entry.symlink ? ` → ${entry.symlink.target}${entry.symlink.broken ? ' (битая)' : ''}` : '';
  return `${relativePath(entry.path, root)}${suffix}${size}${link}`;
}

export function relative(target: string, root: string | null): string {
  return relativePath(target, root);
}

/**
 * Путь относительно корня проекта в каноническом виде — прямыми слэшами.
 *
 * Разделитель не оставляем «как есть»: на Windows `path.relative` вернул бы
 * обратные слэши, и один и тот же путь выглядел бы по-разному до и после —
 * в выводе `search`, `list` и в самом проекте (`workspace.ts` уже отдаёт
 * относительные пути POSIX-вида). Путь в ответе модели должен быть один и тот же
 * на любой системе: по нему она ходит в следующие инструменты.
 */
export function relativePath(target: string, root: string | null): string {
  if (!root) return target;
  const rel = path.relative(root, target);
  return rel.length === 0 ? '.' : rel.split(path.sep).join('/');
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC-титул
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI-цвета и курсор
    .replace(/\r/g, '');
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Отменено'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Отменено'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Терминальная сессия — это процесс на хосте: контейнер живёт ровно на время
 * команды, поэтому «интерактивный терминал в песочнице» не бывает. Пока
 * песочница включена, начинать сессию и печатать в неё нельзя — иначе команда
 * уходила бы на машину человека мимо песочницы (команда и команда в фоне этот режим
 * уже соблюдают). Остановить уже запущенную сессию можно: `action: stop` команду
 * не выполняет.
 */
export function sandboxRefusesTerminal(ctx: ToolContext): ToolOutcome | null {
  if (!ctx.sandbox) return null;
  return {
    ok: false,
    summary: 'В песочнице терминальная сессия не поддерживается',
    detail:
      `Песочница включена (${ctx.sandbox.label}), а терминальная сессия — процесс на хосте. ` +
      'Запускай команды через terminal (долгие — с background: true): они идут в контейнер.',
  };
}

/**
 * Действия терминала — каждое отдельным инструментом, без аргумента `action`.
 *
 * Слияние восьми действий в одно стоило модели на каждом шаге: схема весила 370 токенов
 * и называла поля, к делу не относящиеся (`data` при `run`, `command` при `read`).
 * Сессия (живой pty, в который человек смотрит) и команда (одноразовый прогон с выводом)
 * теперь разведены по именам, как того и ждёт модель.
 */
export async function terminalAction(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'terminal':
      return missingForAction(args, ['command']) ?? (await terminalRun(ctx, args));
    case 'terminalOpen':
      return await terminalStart(ctx, args);
    case 'terminalOutput':
      return terminalOutput(ctx, args);
    case 'terminalWrite':
      return missingForAction(args, ['id', 'data']) ?? (await terminalWrite(ctx, args));
    case 'terminalStop': {
      const id = requireString(args, 'id').trim();
      // Имя одно, а цели две: сессию убиваем, у фоновой команды снимаем Ctrl-C.
      const session = ctx.terminals?.list().some((item) => item.id === id) ?? false;
      return session ? terminalStop(ctx, args) : terminalCancel(ctx, args);
    }
    default:
      return terminalList(ctx);
  }
}

export function terminalList(ctx: ToolContext): ToolOutcome {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };
  const sessions = ctx.terminals.list();
  if (sessions.length === 0) {
    return {
      ok: true,
      summary: 'открытых терминалов нет',
      detail: 'Список пуст. Открой сессию через terminalOpen.',
    };
  }
  const lines = sessions.map((session) => `${session.id} · ${session.shell} · ${session.cwd} (pid ${session.pid})`);
  return {
    ok: true,
    summary: `терминалов: ${sessions.length}`,
    detail: lines.join('\n'),
  };
}

export const TERMINAL_COLS = 120;
export const TERMINAL_ROWS = 30;
/** Сколько ждём первый вывод после старта/команды, прежде чем вернуть управление. */
export const TERMINAL_SETTLE_MS = 700;

export async function terminalStart(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };
  const refuses = sandboxRefusesTerminal(ctx);
  if (refuses) return refuses;

  const cwd = await commandCwd(ctx, args);
  const command = optionalString(args, 'command');
  if (command && command.length > MAX_COMMAND_CHARS) {
    throw new Error(`Команда длиннее ${MAX_COMMAND_CHARS} символов`);
  }

  // Обычный агент спрашивает всегда; полный доступ — только если включена страховка.
  if (command) {
    const refusal = await confirmRun(ctx, command);
    if (refusal) return refusal;
  }

  const session = await ctx.terminals.create({
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
    cwd: cwd?.path,
  });
  if (command) ctx.terminals.write(session.id, `${command}\r`);

  await delay(TERMINAL_SETTLE_MS, ctx.signal);
  const { data, offset, alive } = ctx.terminals.read(session.id, 0);
  // Причёсывание снимает пустые простыни, обрезка держит хвост: у сборки и логов
  // важен последний вывод, а один большой cat иначе съедает всё окно модели.
  const output = clipTail(ctx, 'terminal_start', condenseOutput(stripAnsi(data)));

  return {
    ok: true,
    summary: `сессия ${session.id}${command ? `: ${command}` : ''}`,
    detail: [
      `id: ${session.id}`,
      `cwd: ${session.cwd}`,
      `offset: ${offset}`,
      `alive: ${alive}`,
      '',
      output || '(пока пусто)',
    ].join('\n'),
  };
}

export function terminalRead(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };

  const id = requireString(args, 'id');
  const from = optionalInteger(args, 'from') ?? 0;
  const { data, offset, alive, exitCode } = ctx.terminals.read(id, from);
  // Как в terminal_start: хвост важнее начала, пустые простыни сжимаем.
  const output = clipTail(ctx, 'terminal_read', condenseOutput(stripAnsi(data)));

  return {
    ok: true,
    summary: `${id}: ${output ? `${output.split('\n').length} строк нового вывода` : 'нового вывода нет'}${alive ? '' : ' (процесс завершён)'}`,
    detail: [
      `offset: ${offset}`,
      `alive: ${alive}${exitCode !== undefined ? ` (код ${exitCode})` : ''}`,
      '',
      output || '(нового вывода нет)',
    ].join('\n'),
  };
}

export async function terminalWrite(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };
  const refuses = sandboxRefusesTerminal(ctx);
  if (refuses) return refuses;

  const id = requireString(args, 'id');
  const data = requireString(args, 'data');

  // Ввод в терминал может быть чем угодно — страховка ловит необратимое и здесь.
  const refusal = await confirmRun(ctx, data, `[${id}] ${data.replace(/\n/g, '⏎')}`);
  if (refusal) return refusal;

  ctx.terminals.write(id, data);
  return {
    ok: true,
    summary: `отправлено в ${id}`,
    detail: `В сессию ${id} отправлено символов: ${data.length}. Прочитай вывод через terminal (action read).`,
  };
}

export function terminalStop(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.terminals) return { ok: false, summary: 'Терминал недоступен' };

  const id = requireString(args, 'id');
  ctx.terminals.kill(id);
  return {
    ok: true,
    summary: `${id} остановлен`,
    detail: `Сессия ${id} остановлена.`,
  };
}

/**
 * Читалка ли это — по одной лишь команде, до разрешения папки.
 *
 * Нужна только для выбора ветки `background`: разобрать по-настоящему можно лишь
 * зная `cwd`, а решать, запускать ли задание, надо раньше. Поэтому проверка
 * нарочно дешёвая: `asLookupCall` уже отделяет «не читалка» (`null`) и «сломано»
 * (`broken`) от настоящей читалки, но ему нужна папка. Здесь папка не нужна:
 * разбор зависит только от текста команды, а `cwdDir` влияет на разрешение путей
 * уже потом. Пустой `cwdDir` даёт только `relative` — его здесь не смотрим.
 */
export function looksLikeReadCommand(args: Record<string, unknown>): boolean {
  const raw = optionalString(args, 'command');
  if (!raw) return false;
  // Сломанную команду чтением не считаем: пусть разбирает `terminalRunForeground`.
  // Там на неё есть внятный ответ, а в фоне она была бы заданием без смысла.
  const call = asLookupCall(raw.trim(), '');
  return call !== null && !('broken' in call);
}

export async function terminalRun(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  // `background` — про долгие процессы (`npm run dev`, вотчер), а не про чтение.
  // Читалка с ним всё равно выполняется структурно и сразу: `cat` не «работает в
  // фоне», он отвечает. Раньше флаг слепо уводил в ветку заданий, и `cat file` с
  // `background: true` падал «Задания недоступны» / «В песочнице фон не
  // поддерживается» — отказ ни о чём. Поэтому сначала смотрим, читалка ли это.
  if (optionalBoolean(args, 'background') === true && !looksLikeReadCommand(args)) {
    return await terminalRunBackground(ctx, args);
  }
  return await terminalRunForeground(ctx, args);
}

/**
 * Отпускать ли текст команды из истории после исполнения.
 *
 * Только у успешной и только у длинной: короткую модель перепишет по памяти, а
 * у упавшей текст нужен целиком — по нему правят и её запускают заново. Порог
 * в четыреста символов: heredoc на две тысячи в живом прогоне давал 40 663
 * символа аргументов из 56 658 — треть всей истории.
 */
export function didWork(result: { code: number | null; timedOut?: boolean }, command: string): boolean {
  if (result.code !== 0 || result.timedOut) return false;
  return command.length >= 400 || command.includes('\n');
}

/** Обычный запуск: шаг ждёт команду и возвращает её вывод. */
export async function terminalRunForeground(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolOutcome> {
  const lifted = await liftCdPrefix(ctx, requireString(rawArgs, 'command').trim(), rawArgs);
  const args = lifted.args;
  const command = lifted.command;
  if (command.length > MAX_COMMAND_CHARS) {
    // Не только «нельзя», но и «как надо»: замер на живом прогоне дал пять
    // потерянных шагов на heredoc, каждый — заново написанный текст. Длинная
    // логика должна жить в файле, а не в команде.
    throw new Error(
      `Команда длиннее ${MAX_COMMAND_CHARS} символов (${command.length}): такое не проходит ` +
        'через терминал. Положи текст в файл инструментом `file` (action create) или `edit` и запусти файл — ' +
        'или сократи команду.',
    );
  }
  // Предел времени — необязательный аргумент: у большинства команд хватает
  // значения по умолчанию, а заведомо долгой (сборка, установка) нужно больше.
  const timeoutSeconds = optionalInteger(args, 'timeout');
  const timeoutMs = timeoutSeconds !== undefined ? Math.min(Math.max(timeoutSeconds, 1), 1800) * 1000 : undefined;
  const runOptions = {
    signal: ctx.signal,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  const cwd = await commandCwd(ctx, args);
  if (!cwd) return { ok: false, summary: 'Проект не открыт' };

  // `cat`/`head`/`sed -n`/`grep` — это чтение, а не запуск: 43% вызовов `terminal`
  // в переписи (TASKS.md, п.43) были именно такими. Разобрали — делаем структурно:
  // номера строк, потолок вывода, без `cd` и без подтверждения.
  // Папка вне проекта: пусть решает проверка пути дальше, а не наш разбор.
  const lookup = cwd.relative.startsWith('..') ? null : asLookupCall(command, cwd.path);
  // Сломанная команда — ответ, а не повод идти в шелл: там её ждёт код 0 и пустой
  // вывод, то есть «(пустой вывод)» вместо ошибки разбора.
  if (lookup && 'broken' in lookup) {
    return {
      ok: false,
      summary: `Команда не разобрана: ${lookup.broken}`,
      detail:
        `Команда не разобрана: ${lookup.broken}.\n\n` +
        'Шелл на такой команде вернёт пустой вывод с кодом 0, и это будет прочитано как «ничего не найдено». ' +
        'Проверьте пары кавычек: у образца и у пути своя пара, вложенные кавычки того же вида не поддерживаются.',
    };
  }
  const shortcut = lookup ? await lookupOutcome(ctx, lookup) : null;
  if (shortcut) return shortcut;

  // Обычный агент спрашивает всегда; полный доступ — только если включена страховка.
  const refusal = await confirmRun(ctx, command);
  if (refusal) return refusal;

  if (ctx.sandbox && !ctx.sandbox.available) return sandboxUnavailable(ctx.sandbox);
  // В песочнице та же команда идёт в контейнер: агент об этом не просит отдельно,
  // режим задаёт человек настройкой.
  const spillStream = ctx.spillDir ? createSpillStream(ctx.spillDir, 'terminal') : null;
  const options: RunOptions = spillStream ? { ...runOptions, spill: (chunk) => spillStream.write(chunk) } : runOptions;
  // В песочнице монтируется только корень проекта, поэтому подпапка — это `cd`
  // внутри контейнера, а не второй том.
  const result = ctx.sandbox
    ? await ctx.sandbox.run(insideProject(cwd.relative, command), cwd.root, options)
    : await runShellCommand(command, cwd.path, options);
  // Файл оставляем только тогда, когда вывод действительно не поместился в потолок.
  const full = spillStream?.close(result.truncated) ?? null;
  // Причёсываем и держим хвост: один `npm install` иначе завалит контекст логом.
  const condensed = foldPassedTests(ctx, 'terminal', condenseOutput(result.output));
  const output = full ? trimCommandTail(ctx, condensed, full) : clipTail(ctx, 'terminal', condensed);
  const notes: string[] = [];
  if (result.timedOut) notes.push('превышено время выполнения');
  // Пустой код без причины агент читает как сбой связи: «код выхода —» в трёх
  // живых вызовах `python3 …` был убит сигналом, а не сломанным инструментом.
  else if (result.signal) notes.push(`убит сигналом ${result.signal}`);
  if (result.truncated) notes.push('вывод обрезан');

  return {
    ok: result.code === 0 && !result.timedOut,
    summary: `код выхода ${result.code ?? '—'}${notes.length ? ` (${notes.join(', ')})` : ''}`,
    detail: `${commandLine(ctx, command, cwd.relative)}\n${output.length ? output : '(пустой вывод)'}${spillNote(full)}`,
    ...(didWork(result, command) ? { applied: true } : {}),
  };
}

/* ── долгие команды: задания ─────────────────────────────────────────────── */

/** Предел времени задания — тот же, что у команды: больше 30 минут незачем. */
export const MAX_JOB_TIMEOUT_SECONDS = 1800;

/**
 * Запуск с `background: true` — та же команда, но шаг она не держит.
 *
 * Возвращается номер задания, а не вывод: сборка на пять минут иначе держала бы
 * агента всё это время, и он не мог бы даже сказать, что там происходит. Вывод
 * читается действием `output`.
 */
export async function terminalRunBackground(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolOutcome> {
  if (!ctx.jobs) return { ok: false, summary: 'Задания недоступны' };

  const lifted = await liftCdPrefix(ctx, requireString(rawArgs, 'command').trim(), rawArgs);
  const args = lifted.args;
  const command = lifted.command;
  if (command.length > MAX_COMMAND_CHARS) {
    throw new Error(`Команда длиннее ${MAX_COMMAND_CHARS} символов`);
  }
  const timeoutSeconds = optionalInteger(args, 'timeout');
  const cwd = await commandCwd(ctx, args);
  if (!cwd) return { ok: false, summary: 'Проект не открыт' };

  // Подтверждение то же, что у обычного запуска: команда есть команда, и то, что
  // она уходит в фон, ничего не смягчает.
  const refusal = await confirmRun(ctx, command);
  if (refusal) return refusal;

  // Задание — это процесс на хосте. В песочнице контейнер живёт на время команды,
  // и «фон» в нём пришлось бы держать открытым, поэтому честно отказываем.
  if (ctx.sandbox) {
    return {
      ok: false,
      summary: 'В песочнице фоновая команда не поддерживается',
      detail:
        `Песочница включена (${ctx.sandbox.label}), а контейнер живёт ровно на время команды. ` +
        'Запусти команду через terminal (action run) без background и с бо́льшим пределом времени либо выключи песочницу.',
    };
  }

  const limitMs =
    timeoutSeconds !== undefined ? Math.min(Math.max(timeoutSeconds, 1), MAX_JOB_TIMEOUT_SECONDS) * 1000 : undefined;

  let job: JobHandle;
  try {
    job = ctx.jobs.start({
      command,
      cwd: cwd.path,
      ...(ctx.spillDir ? { spillDir: ctx.spillDir } : {}),
      ...(limitMs !== undefined ? { timeoutMs: limitMs } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
    };
  }

  const snapshot = job.snapshot();
  return {
    ok: true,
    summary: `задание ${snapshot.id}: ${command} (идёт в фоне)`,
    detail: [
      `id: ${snapshot.id}`,
      `команда: ${command}`,
      'состояние: идёт',
      '',
      `Читай вывод через terminal { action: "output", id: "${snapshot.id}" }, снять — action "cancel".`,
      'Не запускай эту же команду второй раз: задание уже работает.',
    ].join('\n'),
  };
}

/** Строка о состоянии задания: что с ним и чем кончилось. */
export function jobState(snapshot: JobSnapshot): string {
  if (snapshot.status === 'running') return 'идёт';
  if (snapshot.status === 'stopping') return 'останавливается';
  const code = snapshot.code ?? '—';
  const notes: string[] = [];
  if (snapshot.timedOut) notes.push('превышено время');
  if (snapshot.signal) notes.push(`сигнал ${snapshot.signal}`);
  return `${snapshot.status === 'completed' ? 'готово' : 'упало'}, код ${code}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/**
 * `output` — состояние задания и новый вывод. Без `id` — список заданий:
 * чтобы не гадать, что вообще запущено, после перезапуска хода.
 */
// Курсор привязан к самому заданию, а не к id (в новом реестре id повторяются).
export const jobOutputOffsets = new WeakMap<JobHandle, number>();

export function terminalOutput(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.jobs) return { ok: false, summary: 'Задания недоступны' };

  const id = optionalString(args, 'id')?.trim();
  if (!id) {
    const all = ctx.jobs.list();
    if (all.length === 0)
      return {
        ok: true,
        summary: 'заданий нет',
        detail: 'Ни одного запуска в фоне не было.',
      };
    const lines = all.map((snapshot) => `${snapshot.id}: ${jobState(snapshot)} — ${snapshot.command}`);
    return {
      ok: true,
      summary: `заданий: ${all.length}`,
      detail: lines.join('\n'),
    };
  }

  const job = ctx.jobs.get(id);
  if (!job) {
    return {
      ok: false,
      summary: `задание ${id} не найдено`,
      detail:
        'Такого задания нет: номер берётся из ответа terminal с action run и background: true, а завершённые ' +
        'убираются, когда набирается много новых. Запусти команду заново, если результат нужен.',
    };
  }

  const from = optionalInteger(args, 'from');
  const result = job.read(from ?? jobOutputOffsets.get(job) ?? 0);
  const snapshot = result.snapshot;
  const running = snapshot.status === 'running' || snapshot.status === 'stopping';
  let data = result.data;
  let offset = result.offset;
  // Незавершённая строка остаётся на следующий опрос: куски stdout не границы строк.
  if (running && data.length > 0) {
    const end = data.lastIndexOf('\n') + 1;
    offset -= data.length - end;
    data = data.slice(0, end);
  }
  jobOutputOffsets.set(job, Math.max(jobOutputOffsets.get(job) ?? 0, offset));
  const condensed = condenseOutput(data);
  const folded = running ? condensed : foldPassedTests(ctx, 'terminal', condensed, snapshot.file);
  const output = folded.length > 0 ? clipTail(ctx, 'terminal', folded) : '';
  // Смещение относится к сырому выводу, не к свёрнутому тексту.
  const notes = [`offset: ${offset}`, `состояние: ${jobState(snapshot)}`];
  if (snapshot.file) notes.push(`полностью — в файле ${snapshot.file}`);

  return {
    ok: snapshot.status !== 'failed',
    summary: `${snapshot.id}: ${jobState(snapshot)}${output ? ` · нового вывода: ${output.split('\n').length} строк` : ''}`,
    detail: [
      ...notes,
      '',
      output || (running ? '(пока ничего не напечатано)' : '(вывод пуст)'),
      ...(running ? [`Потом дочитай: terminal { action: "output", id: "${snapshot.id}", from: ${offset} }`] : []),
    ].join('\n'),
  };
}

/** `cancel` — снять задание: брошенная сборка продолжает жечь процессор. */
export function terminalCancel(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  if (!ctx.jobs) return { ok: false, summary: 'Задания недоступны' };
  const id = requireString(args, 'id');
  const job = ctx.jobs.get(id);
  if (!job) return { ok: false, summary: `задание ${id} не найдено` };

  const before = job.snapshot();
  if (before.status !== 'running' && before.status !== 'stopping') {
    return {
      ok: true,
      summary: `${id}: уже ${jobState(before)}`,
      detail: 'Останавливать нечего — задание завершилось.',
    };
  }
  job.stop();
  return {
    ok: true,
    summary: `${id}: остановлено`,
    detail: 'Процесс убит вместе с дочерними. Вывод, который успел прийти, можно дочитать действием output.',
  };
}
