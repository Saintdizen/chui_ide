import { isReadOnlyCall } from './tool-policy';

/**
 * Что можно исполнять вместе с соседом, а что — только по очереди.
 *
 * Замер по `telemetry/counts.jsonl` (685 прогонов): 40 829 шагов и 42 716 вызовов,
 * то есть 1.05 вызова на шаг и лишь 2 033 шага из 40 829 с несколькими вызовами —
 * модель почти всегда просит одно действие. Когда несколько всё-таки приходят,
 * исполнять их можно только вместе, если они друг друга не видят: правка и чтение
 * того же файла зависят от порядка, а команда может создать файл, который читают.
 */
export type CallOrder = 'alone' | 'group';

/**
 * Файл целиком читает `read` без диапазона и без `paths`: именно такие вызовы
 * имеет смысл собирать в одну пачку. С диапазоном — нельзя: у каждого своё окно,
 * и склеивать их в один список значило бы отдавать лишнее.
 */
export function wholeFileRead(name: string, argumentsText: string): string | undefined {
  if (name !== 'read' && name !== 'read_file') return undefined;
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    if (parsed.paths !== undefined) return undefined;
    if (parsed.startLine !== undefined || parsed.endLine !== undefined) return undefined;
    const path = parsed.path ?? parsed.file ?? parsed.filePath;
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Путь вызова чтения без условий на диапазон: нужен, чтобы отдать из пачки. */
export function readPathOf(argumentsText: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    const path = parsed.path ?? parsed.file ?? parsed.filePath;
    if (typeof path === 'string' && path.length > 0) return path;
    // Пачка путей: берём первый — он и держит весь вызов.
    const paths = parsed.paths;
    const first = Array.isArray(paths) ? paths[0] : undefined;
    return typeof first === 'string' && first.length > 0 ? first : undefined;
  } catch {
    return undefined;
  }
}

/** Цель вызова — файл, к которому он обращается. Пусто — не видно, трогать нельзя. */
export function callTarget(argumentsText: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    const path = parsed.path ?? parsed.file ?? parsed.filePath;
    return typeof path === 'string' && path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Может ли вызов идти вместе с соседями шага.
 *
 * Правила подобраны так, чтобы пачка никогда не меняла результат:
 * - только чтение (`isReadOnlyCall`: имя + действие, а не одно имя);
 * - `terminal` по очереди всегда: две команды в одном каталоге делят
 *   состояние — даже `action: read` смотрит в тот же файл;
 * - `lsp` и `checks` по очереди: они ходят к одному серверу и могут писать
 *   в его состояние (открытие документа);
 * - картинки только по одной (`read_image`): они едут отдельным сообщением
 *   модели.
 */
export function callOrder(name: string, argumentsText: string): CallOrder {
  if (!isReadOnlyCall(name, argumentsText)) return 'alone';
  if (name === 'terminal' || name === 'terminalOutput' || name === 'terminalList') return 'alone';
  if (name === 'read_image' || name === 'lsp' || name === 'checks') return 'alone';
  if (name === 'mind' || name === 'ask' || name === 'skill') return 'alone';
  return 'group';
}

/**
 * Разбивает вызовы шага на подряд идущие группы: внутри группы всё можно
 * исполнять вместе, между группами порядок сохраняется.
 *
 * Соседи попадают в одну группу, только если оба разрешены к совместному
 * запуску и у них разные цели. Одинаковый путь — повод развести: пачка
 * `read` одного файла и правка его же требует чтения ДО правки.
 */
export function planStepCalls(
  calls: readonly { id: string; name: string; arguments: string }[],
  target: (argumentsText: string) => string | undefined = callTarget,
): { id: string; name: string; arguments: string }[][] {
  const groups: { id: string; name: string; arguments: string }[][] = [];
  let current: { id: string; name: string; arguments: string }[] = [];
  let targets = new Set<string>();

  for (const call of calls) {
    const alone = callOrder(call.name, call.arguments) === 'alone';
    if (alone) {
      // Одиночный вызов разрывает пачку с обеих сторон: он мог изменить мир.
      if (current.length > 0) groups.push(current);
      groups.push([call]);
      current = [];
      targets = new Set<string>();
      continue;
    }
    const key = target(call.arguments);
    // Файл без имени цели не сталкивается ни с кем: разобрать такой вызов
    // глубже `callTarget` не умеет, а склейка ради этого — гадание.
    if (key !== undefined && targets.has(key)) {
      groups.push(current);
      current = [];
      targets = new Set<string>();
    }
    current.push(call);
    if (key !== undefined) targets.add(key);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
