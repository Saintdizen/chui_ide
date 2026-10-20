/**
 * Наборы инструментов агента: что именно модели предлагается в запросе.
 *
 * Схемы инструментов едут в КАЖДОМ запросе, и полный набор — это около 7 850 токенов
 * (замер `tests/token-budget.test.ts`): прогон в восемь шагов платит их восемь раз.
 * Задаче «объясни, что тут происходит» не нужны ни git-push, ни браузер, ни
 * терминал: чтения хватает. Поэтому набор собирается под задачу — коротким
 * выбором в композере, а по умолчанию берётся `auto`.
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
 * Набор — это цена, а не права: кого из набора вообще можно позвать, решают
 * `canRun` (есть ли git, терминалы, языковой сервер), режим плана и права.
 * Пресет сужает набор сверху. Набор, выбранный человеком, — жёсткая граница;
 * `auto` — мягкая: скрытое в нём подключается вызовом по имени (`widen`).
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
export type ToolPresetId = 'auto' | 'full' | 'edit' | 'read' | 'minimal';

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
      'edit',
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
    // Команда, задание в фоне и живая сессия — действия одного инструмента:
    // run, output, cancel, list, start, read, write, stop.
    names: ['terminal'],
  },
  {
    id: 'git-read',
    label: 'Git: чтение',
    names: ['git_read'],
  },
  {
    id: 'git-write',
    label: 'Git: изменения',
    // Действия внутри: stage, unstage, commit, checkout, discard, fetch, pull, push.
    names: ['git_write'],
  },
  {
    id: 'web',
    label: 'Сеть',
    names: ['web_search', 'web_fetch'],
  },
  {
    id: 'browser',
    label: 'Браузер',
    names: ['browser'],
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
      'agents',
      'remember',
      'forget',
    ],
  },
  {
    id: 'schedule',
    label: 'Расписание',
    // Задача живёт в файле проекта (`.chui/schedules.json`) и запускает агента сама:
    // в «только чтение» и «минимуме» её нет — там ничего не меняют.
    names: ['schedule_list', 'schedule'],
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
  /**
   * Набор расширяется сам: если модели понадобился инструмент вне групп, он
   * выполнится и появится в наборе со следующего шага. Это не права, а цена:
   * скрыт он ради токенов, и отказ тут только тратил бы шаг. У наборов,
   * выбранных человеком, флага нет — там сужение осознанное.
   */
  widen?: boolean;
  /**
   * Имена, вынутые из набора, хотя их группа входит. Работает только вместе с
   * `widen`: иначе инструмент пропал бы совсем. Нужно для тех, что нужны редко:
   * схема в каждом запросе дороже, чем вызов по имени в одном прогоне из многих.
   */
  except?: readonly string[];
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
 *
 * Ростер вычитается: без этого подсказка врала бы на 1 900 токенов в полном
 * наборе — ровно на то, что спрятано в имя.
 */
function fullSetTokens(): number {
  const roster = new Set(ROSTER_TOOLS);
  const tools = AGENT_TOOLS.filter((tool) => !roster.has(tool.name));
  return Math.round(estimateTextTokens(JSON.stringify(toOpenAiTools(tools))) / 100) * 100;
}

/**
 * Инструменты, у которых схема дороже вызова.
 *
 * Две причины попасть сюда, обе про цену, а не про права: редкие (зовут раз в
 * несколько прогонов) и простые (форма вызова угадывается по имени — путь, имя
 * символа, запрос). Из блока `tools` они убраны, но не запрещены: имя, форма
 * вызова и значения `action` едут строкой ростера (замер — 14 токенов на имя), а вызов
 * по имени выполняется сразу.
 *
 * Один список на два набора, «Авто» и «Все инструменты»: разница между ними —
 * в группах, а не в том, стоит ли схема `forget` 138 токенов в каждом запросе.
 * Замер — `tests/token-budget.test.ts`.
 */
export const ROSTER_TOOLS: readonly string[] = [
  'rename_symbol',
  'forget',
  'session_search',
  // Не редкие, а простые: вызов у них короткий и угадывается по имени.
  'file_outline',
  'open_file',
  'get_diagnostics',
  'go_to_definition',
  'find_references',
  'run_linter',
  'codebase_search',
  'replace_in_files',
  'project_map',
  'search_docs',
  'read_skill',
];

/** Варианты от полного к самому узкому: в списке идут именно так. */
export const TOOL_PRESETS: readonly ToolPresetSpec[] = [
  {
    id: 'auto',
    label: 'Авто',
    icon: 'wrench',
    hint: 'Чтение, правки и проверки; редкое — по имени, без схемы',
    groups: ['core', 'read', 'edit', 'verify', 'work'],
    widen: true,
    // Редкие и простые инструменты — одной строкой вместо схем (см. `ROSTER_TOOLS`):
    // схема каждого стоит 90–205 токенов в КАЖДОМ запросе, а вызов по имени
    // выполняется сразу. Схема при этом в набор не вернётся: `widen` касается того,
    // чего в этом списке нет.
    //
    // Сверх общего ростера — три инструмента с `action`: имя без действия не говорит
    // ничего, а строка называет все значения (`agents(action: spawn|…)`).
    // Ресурсы MCP тоже здесь: их схемы и так появляются только при живом сервере.
    except: ['agents', 'list_mcp_resources', 'read_mcp_resource', ...ROSTER_TOOLS],
  },
  {
    id: 'full',
    label: 'Все инструменты',
    icon: 'wrench',
    // «Без ограничения» — про права, а не про цену: группы берутся все (забытого
    // в группе не потеряем), но редкое и простое уходит в тот же ростер, что и в
    // «Авто». Способность остаётся: вызов по имени выполняется здесь сразу, без
    // расширения набора.
    hint: `Всё, что может эта сборка; редкое и простое — по имени (≈${fullSetTokens()} токенов схем в каждом запросе)`,
    groups: null,
    except: ROSTER_TOOLS,
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
 * Набор по умолчанию — «Авто»: полный набор стоит токенов в КАЖДОМ запросе
 * (≈7 300 — больше, чем сжатый вывод шага), и платить за терминал, браузер
 * и расписание в задаче «посмотри и поправь» незачем. Возможность не отнята:
 * скрытое выполняется по имени, а кто хочет всего сразу — выбирает
 * «Все инструменты» в композере.
 */
export const DEFAULT_TOOL_PRESET: ToolPresetId = 'auto';

export function toolPresetSpec(preset: ToolPresetId): ToolPresetSpec {
  return TOOL_PRESETS.find((item) => item.id === preset) ?? TOOL_PRESETS[0]!;
}

/** Привести значение из настроек или запроса к известному виду. Непонятное — полный набор. */
export function sanitizeToolPreset(raw: unknown): ToolPresetId {
  if (raw === 'auto' || raw === 'full' || raw === 'edit' || raw === 'read' || raw === 'minimal') return raw;
  // Непонятное — «все»: в старой беседе или настройке сужение на угад отняло бы
  // возможность, о которой человек не просил. Умолчание для новых — `auto`,
  // но это осознанный выбор при первом запуске, а не подмена чужого значения.
  return 'full';
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
  for (const name of toolPresetSpec(preset).except ?? []) names.delete(name);
  return names;
}

/**
 * Инструмент спрятан в ростер: он в наборе не значится, но зовётся по имени.
 *
 * Нужен там, где решают, расширять ли набор после вызова. Расширять не надо:
 * схема, добавленная один раз, поедет в каждом следующем запросе прогона.
 */
export function isRosterTool(preset: ToolPresetId, name: string): boolean {
  return rosterNames(preset).includes(name);
}

/**
 * Имена ростера для набора: разрешены, но едут строкой, а не схемой.
 *
 * Считается от групп, а не от `presetToolNames`: в «Авто» они из набора удалены (и
 * исполняются расширением на месте), в узких наборах — разрешены, но скрыты из блока
 * `tools`. Модели обе вещи выглядят одинаково: имя есть, схемы нет — зовётся по имени.
 */
export function rosterNames(preset: ToolPresetId): readonly string[] {
  const spec = toolPresetSpec(preset);
  const names = new Set<string>(spec.except ?? []);
  for (const group of TOOL_GROUPS) {
    if (spec.groups !== null && !spec.groups.includes(group.id)) continue;
    for (const name of group.names) if (ROSTER_TOOLS.includes(name)) names.add(name);
  }
  return [...names];
}

/** Входит ли инструмент в набор. Имя не из наших — не входит: чужого мы не предлагаем. */
export function toolPresetAllows(preset: ToolPresetId, name: string): boolean {
  const names = presetToolNames(preset);
  return names === null || names.has(name);
}

/**
 * Строка-ростер: имена скрытых инструментов вместо их схем.
 *
 * С обязательными аргументами, иначе первый вызов идёт наугад и экономия
 * уходит на шаг переделки. Аргументы берём из самих схем — список не разойдётся.
 * У обязательного поля с `enum` печатаем допустимые значения (`agents(action: spawn|…)`):
 * имя инструмента со `action` без них не говорит, какие действия бывают.
 */
function rosterLine(names: readonly string[]): string {
  if (names.length === 0) return '';
  const items = names.map((name) => {
    const tool = AGENT_TOOLS.find((item) => item.name === name);
    const required = tool?.inputSchema.required ?? [];
    // Допустимые значения обязательного поля — часть формы вызова: без них
    // `agents(action)` не говорит, как называется действие.
    const shown = required.map((key) => {
      const values = tool?.inputSchema.properties?.[key]?.enum;
      return values && values.length > 0 ? `${key}: ${values.join('|')}` : key;
    });
    return shown.length > 0 ? `${name}(${shown.join(', ')})` : `${name}()`;
  });
  return ` Скрыты ради цены, но есть — вызов по имени, аргументы в скобках: ${items.join(', ')}.`;
}

/**
 * Строка для модели о том, что набор сужен. Без неё агент молча упирается в
 * «нет такого инструмента» и начинает выдумывать обходные пути вместо того,
 * чтобы сказать человеку, чего ему не хватает.
 *
 * Полному набору тоже есть что сказать с тех пор, как в нём есть ростер: групп
 * не отнято, но часть схем скрыта по цене, и без строки эти инструменты для
 * модели просто не существуют.
 */
export function toolPresetNote(preset: ToolPresetId): string {
  const spec = toolPresetSpec(preset);
  if (spec.groups === null) {
    const roster = rosterLine(rosterNames(preset));
    if (roster === '') return '';
    return (
      `Набор инструментов: «${spec.label}» — всё, что может эта сборка. Ничего не запрещено: ` +
      `нужен инструмент, которого не видно в списке, — вызови его по имени, он выполнится.${roster}`
    );
  }
  const labels = TOOL_GROUPS.filter((group) => spec.groups?.includes(group.id))
    .map((group) => group.label)
    .join(', ');
  // Набор, который расширяется сам, говорит об этом прямо: иначе агент
  // упрётся в «нет такого инструмента» и пойдёт обходным путём там, где
  // достаточно назвать нужное.
  if (spec.widen) {
    const roster = rosterLine(rosterNames(preset));
    return (
      `Набор инструментов: «${spec.label}» (${labels}). Скрытого в нём нет запрета: нужен ` +
      'инструмент, которого не видно в списке, — вызови его по имени, он выполнится, и ' +
      `спрашивать человека не нужно.${roster}`
    );
  }
  const roster = rosterLine(rosterNames(preset));
  return (
    `Набор инструментов сужен человеком: «${spec.label}» (${labels}). Если для задачи нужен ` +
    'инструмент, которого нет ни в списке, ни в ростере, — скажи об этом человеку и предложи ' +
    `сменить набор в композере, а не ищи обходной путь.${roster}`
  );
}
