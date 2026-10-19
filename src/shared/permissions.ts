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
