/**
 * Наборы инструментов агента: что именно модели предлагается в запросе.
 *
 * Схемы инструментов едут в КАЖДОМ запросе, и полный набор — это около 10 200 токенов:
 * прогон в восемь шагов платит их восемь раз. Но задаче «объясни, что тут
 * происходит» не нужны ни git-push, ни браузер, ни терминал: чтения хватает.
 * Поэтому набор собирается под задачу — коротким выбором в композере.
 *
 * Устроено в два слоя: группы (что за инструменты) и пресеты (какие группы
 * берём). Группа одна на смысл — «правки», «терминал», «git на запись» — потому
 * что пресеты отличаются друг от друга именно смыслом, а не списком имён:
 * новый инструмент git достаточно дописать в группу, и он сам появится во всех
 * наборах, где git на запись уже есть.
 *
 * `full` — не «объединение групп», а «без ограничения»: иначе инструмент,
 * забытый в группе, молча пропал бы из полного набора. Страж
 * (`tests/tool-presets.test.ts`) требует, чтобы группы покрывали весь
 * `AGENT_TOOLS`: забыть новый инструмент в узких наборах он не даст.
 *
 * Набор — это только «что предложить», а не права: кого из набора вообще можно
 * позвать, по-прежнему решают `canRun` (есть ли git, терминалы, языковой
 * сервер), режим плана и права. Пресет сужает набор сверху и ничего не расширяет.
 */

import { estimateTextTokens } from './context-fit';
import { AGENT_TOOLS, toOpenAiTools } from './tools';

/** Группа инструментов: смысл, а не место в списке. */
export type ToolGroupId =
  | 'core'
  | 'read'
  | 'edit'
  | 'verify'
  | 'shell'
  | 'git-read'
  | 'git-write'
  | 'web'
  | 'browser'
  | 'program'
  | 'work'
  | 'schedule';

/** Выбор набора. Идентификатор хранится в настройках и едет по RPC. */
export type ToolPresetId = 'full' | 'edit' | 'read' | 'minimal';

export interface ToolGroupSpec {
  id: ToolGroupId;
  label: string;
  /** Имена инструментов из `AgentToolName`. */
  names: readonly string[];
}

export const TOOL_GROUPS: readonly ToolGroupSpec[] = [
  {
    id: 'core',
    label: 'Основа',
    // Самое необходимое, чтобы вообще найти нужное место: шесть схем вместо
    // сорока. Столько стоит «просто спросил» — примерно вдесятеро дешевле полного.
    names: ['list_dir', 'read_file', 'search', 'find_files', 'codebase_search', 'project_map'],
  },
  {
    id: 'read',
    label: 'Чтение',
    names: [
      'read_files',
      'search_docs',
      'session_search',
      'read_skill',
      'read_image',
      'list_mcp_resources',
      'read_mcp_resource',
      'find_references',
      'go_to_definition',
      'file_outline',
      'get_diagnostics',
    ],
  },
  {
    id: 'edit',
    label: 'Правки',
    names: [
      'apply_edit',
      'apply_patch',
      'replace_in_files',
      'rename_symbol',
      'create_file',
      'delete_file',
      'move_file',
      'open_file',
      'present',
    ],
  },
  {
    id: 'verify',
    label: 'Проверки',
    // Линтер и тесты мир не меняют (это прогон уже существующего кода),
    // поэтому они есть и в наборе «только чтение»: правильность чтения ими
    // и проверяют чаще всего.
    names: ['run_linter', 'run_tests'],
  },
  {
    id: 'shell',
    label: 'Терминал',
    names: [
      'run_terminal',
      'run_output',
      'run_stop',
      'terminal_list',
      'terminal_start',
      'terminal_read',
      'terminal_write',
      'terminal_stop',
    ],
  },
  {
    id: 'git-read',
    label: 'Git: чтение',
    names: ['git_status', 'git_diff', 'git_log', 'git_blame'],
  },
  {
    id: 'git-write',
    label: 'Git: изменения',
    names: [
      'git_stage',
      'git_unstage',
      'git_commit',
      'git_checkout',
      'git_discard',
      'git_fetch',
      'git_pull',
      'git_push',
    ],
  },
  {
    id: 'web',
    label: 'Сеть',
    names: ['web_search', 'web_fetch'],
  },
  {
    id: 'browser',
    label: 'Браузер',
    names: [
      'browser_open',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_evaluate',
      'browser_zoom',
      'browser_close',
    ],
  },
  {
    id: 'program',
    label: 'Программа',
    // run_code зовёт инструменты сам, то есть стоит столько же, сколько набор
    // вокруг него; workflow к тому же запускает по прогону модели на каждого
    // агента. В узких наборах они не нужны: там и вызовов мало.
    names: ['run_code', 'workflow'],
  },
  {
    id: 'work',
    label: 'Ведение работы',
    // Не действия над проектом, а разговор о них: план, цель, вопрос человеку,
    // подзадача, память. Эти инструменты нужны в любом наборе — без `ask` агент
    // не сможет ничего уточнить, а без `update_plan` не покажет, что задумал.
    names: [
      'update_plan',
      'update_goal',
      'exit_plan_mode',
      'ask',
      'task',
      'spawn_agent',
      'list_agents',
      'wait_agent',
      'send_message',
      'interrupt_agent',
      'remember',
      'forget',
    ],
  },
  {
    id: 'schedule',
    label: 'Расписание',
    // Задача живёт в файле проекта (`.chui/schedules.json`) и запускает агента сама:
    // в «только чтение» и «минимуме» её нет — там ничего не меняют.
    names: ['schedule_list', 'schedule_create', 'schedule_update', 'schedule_delete'],
  },
];

export interface ToolPresetSpec {
  id: ToolPresetId;
  /** Подпись в списке композера: короткая, панель узкая. */
  label: string;
  /** Значок из `ICON_PATHS`. */
  icon: string;
  /** Одна строка пояснения — в подсказке пункта списка. */
  hint: string;
  /**
   * Какие группы входят. `null` — без ограничения (полный набор): так новый
   * инструмент, ещё не разложенный по группам, не пропадёт у тех, кто набор
   * не сужал.
   */
  groups: readonly ToolGroupId[] | null;
}

/**
 * Вес полного набора в токенах — считается, а не пишется руками.
 *
 * В подсказке списка наборов стояли «≈14 000 токенов» — цифра из тех времён,
 * когда описания ещё не сжали; на проводе было уже десять тысяч, и человек
 * выбирал набор по неверной цене. Цифру, которую видно в интерфейсе, надо
 * брать из того же расчёта, что и всё остальное (`estimateTextTokens` по тем же
 * схемам, что уезжают модели). Округление до сотни — чтобы подсказка не дёргалась
 * от каждой переписанной фразы.
 */
function fullSetTokens(): number {
  return Math.round(estimateTextTokens(JSON.stringify(toOpenAiTools(AGENT_TOOLS))) / 100) * 100;
}

/** Варианты от полного к самому узкому: в списке идут именно так. */
export const TOOL_PRESETS: readonly ToolPresetSpec[] = [
  {
    id: 'full',
    label: 'Все инструменты',
    icon: 'wrench',
    hint: `Всё, что может эта сборка (≈${fullSetTokens()} токенов схем в каждом запросе)`,
    groups: null,
  },
  {
    id: 'edit',
    label: 'Правка',
    icon: 'pencil',
    hint: 'Чтение, правки и проверки; без терминала, сети и браузера',
    groups: ['core', 'read', 'edit', 'verify', 'git-read', 'work', 'schedule'],
  },
  {
    id: 'read',
    label: 'Только чтение',
    icon: 'eye',
    hint: 'Чтение проекта и git, прогон проверок; изменений нет',
    groups: ['core', 'read', 'verify', 'git-read', 'work'],
  },
  {
    id: 'minimal',
    label: 'Минимум',
    icon: 'minimize',
    hint: 'Найти и прочитать, спросить, наметить план — для короткого вопроса',
    groups: ['core', 'work'],
  },
];

/**
 * Набор по умолчанию — полный. Так было до выбора: сузить набор значит отнять
 * у агента возможность, а это решение человека, а не значение по умолчанию.
 */
export const DEFAULT_TOOL_PRESET: ToolPresetId = 'full';

export function toolPresetSpec(preset: ToolPresetId): ToolPresetSpec {
  return TOOL_PRESETS.find((item) => item.id === preset) ?? TOOL_PRESETS[0]!;
}

/** Привести значение из настроек или запроса к известному виду. Непонятное — полный набор. */
export function sanitizeToolPreset(raw: unknown): ToolPresetId {
  if (raw === 'full' || raw === 'edit' || raw === 'read' || raw === 'minimal') return raw;
  return DEFAULT_TOOL_PRESET;
}

/**
 * Инструменты набора. `null` — ограничения нет: предлагаем всё, что исполняется.
 * Пустой набор вернулся бы пустым множеством, но такого пресета нет: каждый
 * включает хотя бы `work`, иначе модели нечем даже спросить.
 */
export function presetToolNames(preset: ToolPresetId): ReadonlySet<string> | null {
  const groups = toolPresetSpec(preset).groups;
  if (groups === null) return null;
  const names = new Set<string>();
  for (const group of TOOL_GROUPS) {
    if (!groups.includes(group.id)) continue;
    for (const name of group.names) names.add(name);
  }
  return names;
}

/** Входит ли инструмент в набор. Имя не из наших — не входит: чужого мы не предлагаем. */
export function toolPresetAllows(preset: ToolPresetId, name: string): boolean {
  const names = presetToolNames(preset);
  return names === null || names.has(name);
}

/**
 * Строка для модели о том, что набор сужен. Без неё агент молча упирается в
 * «нет такого инструмента» и начинает выдумывать обходные пути вместо того,
 * чтобы сказать человеку, чего ему не хватает. Полному набору говорить нечего.
 */
export function toolPresetNote(preset: ToolPresetId): string {
  const spec = toolPresetSpec(preset);
  if (spec.groups === null) return '';
  const labels = TOOL_GROUPS.filter((group) => spec.groups?.includes(group.id))
    .map((group) => group.label)
    .join(', ');
  return (
    `Набор инструментов сужен человеком: «${spec.label}» (${labels}). Если для задачи нужен ` +
    'инструмент, которого нет, — скажи об этом человеку и предложи сменить набор в композере, ' +
    'а не ищи обходной путь.'
  );
}
