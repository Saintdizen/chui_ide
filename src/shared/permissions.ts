/**
 * Права ассистента: один выбор на три состояния.
 *
 * Раньше это был тумблер «полный доступ»: включён — и правки, и команды идут без
 * вопросов, выключен — спрашиваем обо всём. Между этими краями есть середина, и
 * она нужнее всего: правки хочется видеть сделанными сразу (их видно в панели
 * изменений и можно отменить), а команды — всё же спрашивать, потому что
 * `npm install` и `rm` отменять нечем.
 *
 * Поэтому прав два независимых рычага, а показываем их одним выбором:
 *
 *     правки без ревью   │ команды без вопросов
 *     ───────────────────┼─────────────────────
 *     нет                │ нет                → «Спрашивать»
 *     да                 │ нет                → «Правки»
 *     да                 │ да                 → «Полный доступ»
 *
 * Четвёртого сочетания нет намеренно: спрашивать про правку и в то же время
 * молча запускать команды — это худший из режимов, а не полезный.
 *
 * Страховка полного доступа (`settings.ai.confirmDangerous`) живёт отдельно и
 * поверх этого: необратимые команды могут спрашиваться даже при полном доступе.
 *
 * Модуль чистый: таблица и перевод её в два флага. Кто именно спрашивает —
 * renderer (ревью правок) или main (подтверждение команды) — решают они.
 */

/** Состояние прав. Идентификатор — то, что хранится и едет по RPC. */
export type PermissionPreset = 'ask' | 'edits' | 'full';

/** Один вариант выбора прав. */
export interface PermissionSpec {
  id: PermissionPreset;
  /** Подпись в списке композера: короткая, в узкой панели места мало. */
  label: string;
  /** Значок из `ICON_PATHS`: замок закрытый, карандаш, замок открытый. */
  icon: string;
  /** Одна строка пояснения — в подсказке пункта списка. */
  hint: string;
  /** Правки применяются сразу, без карточки ревью. */
  approveEdits: boolean;
  /** Команды, git и действия браузера — без подтверждений. */
  allowCommands: boolean;
}

/**
 * Варианты по возрастанию свободы: в списке они идут именно так, и первым стоит
 * безопасный — тот, что действует, пока человек ничего не выбрал.
 */
export const PERMISSION_PRESETS: readonly PermissionSpec[] = [
  {
    id: 'ask',
    label: 'Спрашивать',
    icon: 'lock',
    hint: 'Правки — через ревью, команды — с подтверждением',
    approveEdits: false,
    allowCommands: false,
  },
  {
    id: 'edits',
    label: 'Правки',
    icon: 'pencil',
    hint: 'Правки применяются сразу, команды — с подтверждением',
    approveEdits: true,
    allowCommands: false,
  },
  {
    id: 'full',
    label: 'Полный доступ',
    icon: 'unlock',
    hint: 'Правки и команды без подтверждений (опасные команды — по страховке)',
    approveEdits: true,
    allowCommands: true,
  },
];

/** Настройки по умолчанию: спрашивать обо всём. Тот же выбор, что был у тумблера выключенным. */
export const DEFAULT_PERMISSION: PermissionPreset = 'ask';

export function permissionSpec(preset: PermissionPreset): PermissionSpec {
  return PERMISSION_PRESETS.find((item) => item.id === preset) ?? PERMISSION_PRESETS[0]!;
}

/**
 * Привести значение из настроек или запроса к известному виду.
 *
 * Непонятное значение — не повод гадать в сторону свободы: неизвестное считается
 * «спрашивать». Ошибка в эту сторону стоит одного лишнего вопроса, в обратную —
 * изменённого без спроса файла.
 */
export function sanitizePermission(raw: unknown): PermissionPreset {
  if (raw === 'ask' || raw === 'edits' || raw === 'full') return raw;
  return DEFAULT_PERMISSION;
}

/**
 * Права из старых запросов: раньше ехал один флаг `autoApprove`, и `true` в нём
 * означало ровно полный доступ.
 */
export function permissionFromAutoApprove(autoApprove: unknown): PermissionPreset {
  return autoApprove === true ? 'full' : DEFAULT_PERMISSION;
}

/** Флаги для инструментов: то, что main кладёт в `ToolContext`. */
export function permissionFlags(preset: PermissionPreset): { autoApprove: boolean; allowAll: boolean } {
  const spec = permissionSpec(preset);
  return { autoApprove: spec.approveEdits, allowAll: spec.allowCommands };
}

/* ── режимы исполнения ─────────────────────────────────────────────────── */

/**
 * Режимы исполнения — политика по КЛАССУ действия, а не по инструменту.
 *
 * Три состояния прав выше отвечают «спрашивать ли вообще», и они бинарны по
 * классу: либо правки без ревью, либо с ним. Здесь тот же вопрос, но с третьим
 * ответом — «спросить и не делать», и по каждому классу отдельно. Это и есть
 * run-modes: не «полный доступ», а «файлы писать можно, команды — только
 * читать, сеть — нельзя вовсе».
 *
 *     класс          что в нём                    по умолчанию
 *     ───────────────┼───────────────────────────┼─────────────
 *     read           чтение, поиск, LSP          разрешено
 *     write          правки, перенос, удаление   по правам
 *     command        терминал, тесты, run        по правам
 *     network        web, fetch, браузер         спросить
 *
 * «По правам» — значит режим ничего не меняет и решает выбранный пресет: так
 * новая настройка не может незаметно оказаться строже или мягче старого
 * поведения, пока её не трогали.
 */
export type ActionClass = 'read' | 'write' | 'command' | 'network';

/** Что делать с действием этого класса. */
export type RunModeRule = 'allow' | 'ask' | 'deny' | 'inherit';

/** Режимы исполнения: по правилу на класс. */
export type RunModes = Readonly<Record<ActionClass, RunModeRule>>;

/**
 * По умолчанию — `inherit` везде: старое поведение, ничего не спрятано.
 * Именно по умолчанию, а не «разрешено»: иначе обновление молча сняло бы ревью.
 */
export const DEFAULT_RUN_MODES: RunModes = {
  read: 'inherit',
  write: 'inherit',
  command: 'inherit',
  network: 'inherit',
};

const RULES: readonly RunModeRule[] = ['allow', 'ask', 'deny', 'inherit'];

/**
 * Привести настройку к известному виду. Непонятное правило — `inherit`, а не
 * `allow`: ошибка в эту сторону стоит лишнего вопроса, в обратную — молча
 * выполненного действия.
 */
export function sanitizeRunModes(raw: unknown): RunModes {
  if (!raw || typeof raw !== 'object') return DEFAULT_RUN_MODES;
  const source = raw as Record<string, unknown>;
  const result = { ...DEFAULT_RUN_MODES };
  for (const key of Object.keys(result) as ActionClass[]) {
    const value = source[key];
    if (typeof value === 'string' && (RULES as readonly string[]).includes(value)) {
      result[key] = value as RunModeRule;
    }
  }
  return result;
}

/** Есть ли хоть одно правило, отличное от `inherit`: тогда настройка о чём-то говорит. */
export function runModesTouched(modes: RunModes): boolean {
  return (Object.keys(modes) as ActionClass[]).some((key) => modes[key] !== 'inherit');
}

/**
 * Итог политики для одного действия. `undefined` — политика молчит, решает
 * право доступа, как раньше; `true` — разрешено мимо пресета; `false` — запрещено
 * мимо пресета (так же жёстко, как опасная команда без подтверждения).
 */
export function runModeAllows(modes: RunModes | undefined, action: ActionClass): boolean | undefined {
  const rule = modes?.[action] ?? 'inherit';
  if (rule === 'allow') return true;
  if (rule === 'deny') return false;
  // `ask` — тот же вопрос, что задаёт пресет: свой ответ политики не нужен.
  return undefined;
}

/** `deny` жёстче `ask`: такой класс не выполняется вовсе, даже с разрешения пресета. */
export function runModeDenied(modes: RunModes | undefined, action: ActionClass): boolean {
  return (modes?.[action] ?? 'inherit') === 'deny';
}

/**
 * К какому классу относится инструмент. По умолчанию — `read`: если инструмент
 * забыли разнести, он должен стать безопаснее, а не опаснее.
 *
 * `command` важнее `write` у `run` и `run_tests`: они и правят, и запускают.
 * Класс один, и выбирать надо тот, который опаснее.
 */
export const TOOL_ACTION_CLASS: Readonly<Record<string, ActionClass>> = {
  // Чтение и разведка.
  list: 'read',
  read: 'read',
  search: 'read',
  history: 'read',
  read_image: 'read',
  lsp: 'read',
  checks: 'read',
  project_map: 'read',
  skill: 'read',
  open_files: 'read',
  todo: 'read',
  symbols: 'read',

  // Правки: `edit` меняет файлы, `file` — переносит и удаляет, `mind` — план.
  edit: 'write',
  file: 'write',

  // Команды: терминал, тесты, отладка.
  run: 'command',
  run_tests: 'command',
  terminal: 'command',
  debug: 'command',

  // Сеть и чужие программы.
  web: 'network',
  browser: 'network',
  fetch: 'network',
};

/** Класс действия инструмента. Неизвестный — `read` (см. выше). */
export function actionClassOf(toolName: string): ActionClass {
  return TOOL_ACTION_CLASS[toolName] ?? 'read';
}
