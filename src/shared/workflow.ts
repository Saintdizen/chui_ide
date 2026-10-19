/**
 * `workflow`: сценарий, который сам запускает подчинённых агентов и ветвит по ним.
 *
 * `task` отдаёт работу агентам пачкой, но пачка задаётся заранее: модель называет
 * три задания и получает три отчёта. Настоящая оркестрация выглядит иначе — «сходи
 * туда, а по тому, что найдёшь, реши, куда идти дальше». Такая работа не
 * описывается списком аргументов, зато хорошо описывается скриптом: в нём есть
 * `if`, цикл и `Promise.all`, а результат одного агента можно отфильтровать,
 * сравнить и передать следующему.
 *
 * Модуль чистый: что считается годным сценарием, как выглядит ответ и как
 * ограничивается число одновременных агентов. Запуск (отдельный процесс, права,
 * обрыв) — тот же, что у `run_code`: `main/ai/run-code.ts`, режим `workflow`.
 *
 * Чего в сценарии НЕТ и почему:
 *
 *   - `tools` — иначе это был бы `run_code` с другим названием. Сценарий раздаёт
 *     работу, а читают и правят агенты, которым он её раздал.
 *   - вложенности — подзадача не видит ни `task`, ни `workflow` (см.
 *     `SUBAGENT_TOOLS`), поэтому глубина всегда `WORKFLOW_MAX_DEPTH`. Иначе один
 *     вопрос человека превращался бы в дерево прогонов, за которое никто не считал.
 *   - `ask` — вопрос человеку из скрипта: скрипт ждал бы ответа в невидимом
 *     процессе (та же причина, что в `shared/run-code.ts`).
 */

import type { RunCodeAgentCall, RunCodeOutcome } from './run-code';

/** Потолок исходника: сценарий — это раздача работы, а не программа на тысячу строк. */
export const WORKFLOW_MAX_CHARS = 20_000;

/**
 * Сколько агентов сценарий может запустить за раз.
 *
 * Каждый агент — отдельный прогон модели, то есть деньги; `task` за вызов берёт не
 * больше четырёх, а здесь в распоряжении цикл, и без потолка одна опечатка в
 * `while` стоила бы сотни прогонов.
 */
export const WORKFLOW_MAX_AGENTS = 6;

/** Сколько агентов идут одновременно: как у пачки подзадач (`MAX_PARALLEL`). */
export const WORKFLOW_MAX_PARALLEL = 3;

/** Глубина: сценарий раздаёт работу агентам, а агенты уже не раздают её дальше. */
export const WORKFLOW_MAX_DEPTH = 1;

/** Сколько ждём сценарий по умолчанию и сколько — по просьбе модели. */
export const WORKFLOW_DEFAULT_TIMEOUT_MS = 300_000;
export const WORKFLOW_MAX_TIMEOUT_MS = 600_000;

/** Один агент, которого просит сценарий. */
export interface WorkflowAgentRequest {
  description?: string;
  prompt: string;
}

/**
 * Что сценарий должен получить с негодным исходником — или `null`, если он годен.
 *
 * Проверка до запуска: пустой ответ модели иначе выглядел бы как «сценарий ничего
 * не сделал», а сценарий без единого агента — как дорогой способ сказать «я ничего
 * не запускал».
 */
export function workflowProblem(source: string): string | null {
  const text = source.trim();
  if (!text) {
    return 'Сценарий пустой: нужен JavaScript, который зовёт agents.run({ prompt }) или agents.parallel([...]).';
  }
  if (text.length > WORKFLOW_MAX_CHARS) {
    return `Сценарий слишком длинный: ${text.length} символов при пределе ${WORKFLOW_MAX_CHARS}.`;
  }
  // Динамический `import('node:fs')` — законная часть сценария, а объявления
  // `import x from …` и `export …` на верхнем уровне внутри функции невозможны.
  if (/^\s*(export\s|import\s+[\w{*'"])/m.test(text)) {
    return (
      'Сценарий — это тело функции, а не модуль: `import` и `export` в нём не нужны. ' +
      'Агенты уже лежат в `agents`, а результат возвращается через `return`.'
    );
  }
  const code = withoutStrings(text) ?? text;
  if (/\btools\s*\./.test(code)) {
    return (
      'В сценарии нет `tools`: он только раздаёт работу агентам и ветвит по их отчётам ' +
      '(agents.run / agents.parallel). Читать и править проект умеет run_code и сами агенты.'
    );
  }
  if (!/\bagents\s*[.[]/.test(code)) {
    return (
      'В сценарии нет ни одного вызова агента. Он нужен, чтобы раздать работу подчинённым ' +
      'агентам (agents.run({ prompt }) или agents.parallel([...])); для чтения и правок есть run_code.'
    );
  }
  return null;
}

/**
 * Текст без содержимого строковых литералов: `tools` внутри строки — не вызов.
 * `null` — строки не сошлись (незакрытый литерал): тогда проверять по этому
 * тексту нельзя, и вызывающий берёт исходник как есть. Отказать годному
 * сценарию хуже, чем пропустить странную подсказку в строке.
 */
function withoutStrings(text: string): string | null {
  let out = '';
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        out += char;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      continue;
    }
    out += char;
  }
  return quote === null ? out : null;
}

/**
 * Очередь на одновременность: не больше `limit` работ разом.
 *
 * Ограничение нужно живому сценарию, а не разбору аргументов: `Promise.all` в
 * скрипте запускает всё, что в него положили, а каждый агент — прогон модели. Пусть
 * лучше ждут в очереди, чем упираются в предел провайдера.
 */
export function createAgentGate(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(limit) || 1);
  let active = 0;
  const queue: Array<() => void> = [];

  return async function through<T>(run: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      // Освободившееся место отдаём одному ждущему: остальные останутся в очереди.
      queue.shift()?.();
    }
  };
}

/** Склонение: «1 агент», «2 агента», «5 агентов». */
function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word =
    mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${count} ${word}`;
}

/** Длительность коротко: «820 мс», «12 с», «1 м 20 с». */
function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} м ${rest} с` : `${minutes} м`;
}

/**
 * Ответ инструмента: сводка для карточки и разбор для модели.
 *
 * Порядок тот же, что у `run_code`: сперва кто работал, потом что вернул сценарий,
 * потом его вывод. Модель читает сверху вниз и на результате останавливается —
 * пересказывать отчёты агентов ей уже не нужно, сценарий это сделал сам.
 */
export function formatWorkflow(outcome: RunCodeOutcome): { summary: string; detail: string } {
  const agents = outcome.agents ?? [];
  const failed = agents.filter((agent) => !agent.ok).length;
  const tally = `${plural(agents.length, 'агент', 'агента', 'агентов')}${failed > 0 ? `, с ошибкой ${failed}` : ''}`;

  const head: string[] = [];
  if (outcome.error) {
    head.push(`Сценарий упал: ${outcome.error}`);
  } else if (outcome.timedOut) {
    head.push('Сценарий не уложился в отведённое время и был остановлен.');
  } else {
    head.push(`Сценарий отработал за ${duration(outcome.ms)}: ${tally}.`);
  }
  if (outcome.agentsExceeded) {
    head.push(
      `Агентов больше предела (${WORKFLOW_MAX_AGENTS}): остальные не запускались. ` +
        'Раздели работу на несколько вызовов или обойдись отчётами уже запущенных.',
    );
  }
  if (outcome.truncated) head.push('Часть ответа не показана — она не поместилась в потолок.');

  const parts: string[] = [head.join(' '), ''];

  if (agents.length > 0) {
    parts.push('Агенты сценария:');
    for (const [index, agent] of agents.entries()) {
      parts.push(describeAgent(index, agent));
    }
    parts.push('');
  }

  if (outcome.value !== undefined) {
    parts.push('Что вернул сценарий:', outcome.value === '' ? '(пусто)' : outcome.value, '');
  }
  if (outcome.logs) {
    parts.push('Вывод сценария (console):', outcome.logs, '');
  }
  if (outcome.error && outcome.stack) {
    parts.push('Стек:', outcome.stack, '');
  }

  parts.push(
    outcome.error
      ? 'Исправь сценарий и вызови workflow снова — или сделай это обычными инструментами.'
      : 'Ответ ниже — то, что сценарий собрал из отчётов агентов: их содержимое уже учтено, пересказывать его незачем.',
  );

  const summary = outcome.error
    ? `workflow: ошибка — ${outcome.error.slice(0, 140)}`
    : outcome.timedOut
      ? `workflow: остановлен по времени (${tally})`
      : `workflow: ${tally} за ${duration(outcome.ms)}`;

  return { summary, detail: parts.join('\n').trimEnd() };
}

/** Одна строка про агента: кто, сколько работал и чем кончилось. */
function describeAgent(index: number, agent: RunCodeAgentCall): string {
  const head = `${index + 1}. ${agent.ok ? '' : '✗ '}«${agent.description}» — ${duration(agent.ms)}`;
  const note = agent.summary.trim();
  return note ? `${head}: ${note}` : head;
}
