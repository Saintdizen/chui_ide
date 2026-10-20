/**
 * Признаки инструмента, от которых зависит не «что он делает», а «где его можно
 * позвать».
 *
 * Раньше одни и те же сведения были размазаны по пяти спискам в трёх файлах:
 * повтор вызова не исполнялся по `READ_ONLY_TOOLS` (service), режим плана
 * отбирал `PLAN_MODE_TOOLS` (service), подзадача ходила по `SUBAGENT_TOOLS`
 * (tools), программа не звала `DENIED_IN_PROGRAM` (run-code), а «доступен без
 * условий» решался дефолтом `canRun`. Новый инструмент надо было вспомнить в
 * каждом — и забыть хотя бы в одном было тихо: тесты этого не видели.
 *
 * Теперь сведения об одном инструменте лежат одной строкой, а наборы собираются
 * из таблицы. Таблица типизирована как `Record<AgentToolName, …>`: инструмент,
 * добавленный в `AGENT_TOOLS` без строки здесь, — ошибка компиляции, а не
 * загадка «почему он молчит».
 */

import { AGENT_TOOLS, parseToolArguments, type AgentToolName } from './tools';

export interface ToolPolicy {
  /**
   * Только читает состояние: повтор того же вызова в этом ходе ничего не даёт
   * (это признак зацикливания) и не исполняется.
   */
  readonly readOnly?: boolean;
  /** Предлагается и исполняется в режиме «План»: ничего не меняет или меняет только сам план. */
  readonly plan?: boolean;
  /** Доступен подзадаче (`task`) — и тем самым предел глубины: ни `task`, ни `workflow` здесь нет. */
  readonly subagent?: boolean;
  /** Запрещён внутри программы (`run_code`): ей это не по силам или обманывает обещание. */
  readonly deniedInProgram?: boolean;
  /**
   * Доступен всегда: ни настроек, ни моста окна не требует. Всё остальное
   * решает `canRun` — и по умолчанию отказывает, чтобы новый инструмент не
   * открывался модели сам собой.
   */
  readonly alwaysAvailable?: boolean;
  /**
   * Действия, которые только читают состояние. Нужны слитым инструментам:
   * `terminal` целиком мир меняет (запускает команды), а `terminal` с
   * `action: read` — нет, и повтор такого вызова так же бесполезен, как повтор
   * `read_file`. Без этого признака слияние молча отключило бы защиту от
   * зацикливания на чтении вывода.
   */
  readonly readOnlyActions?: readonly string[];
}

export const TOOL_POLICIES: Readonly<Record<AgentToolName, ToolPolicy>> = {
  /* ── чтение проекта ─────────────────────────────────────────────────── */
  list_dir: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  read_file: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  read_files: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  search: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  search_docs: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  project_map: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  find_files: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  read_image: { readOnly: true, plan: true, alwaysAvailable: true, deniedInProgram: true },

  /* Символы и языковой сервер: без него эти инструменты не предлагаются. */
  codebase_search: { readOnly: true, plan: true, subagent: true },
  find_references: { readOnly: true, plan: true, subagent: true },
  go_to_definition: { readOnly: true, plan: true, subagent: true },
  file_outline: { readOnly: true, plan: true, subagent: true },
  rename_symbol: {},

  /* Проверки: мир не меняют, поэтому они и в плане, и у подзадачи. */
  run_linter: { readOnly: true, plan: true, subagent: true },
  run_tests: {},

  /*
   * Сеть. `web_search` в повторах не кэшируется (выдача меняется и стоит
   * денег), но подзадаче доступен: без сети разведка проекта неполна.
   */
  web_search: { plan: true, subagent: true },
  web_fetch: { readOnly: true, plan: true, subagent: true },

  session_search: { readOnly: true, plan: true, subagent: true },
  read_skill: { readOnly: true, plan: true, subagent: true },
  get_diagnostics: { readOnly: true, plan: true, subagent: true },
  list_mcp_resources: { plan: true },
  read_mcp_resource: { plan: true },

  /* ── правки файлов ──────────────────────────────────────────────────── */
  replace_in_files: { alwaysAvailable: true },
  create_file: { alwaysAvailable: true },
  delete_file: { alwaysAvailable: true },
  move_file: { alwaysAvailable: true },
  // Правка файлов: две формы (по якорю и по позициям) — один инструмент.
  // Права у форм одни: обе идут через ревью и undo в renderer.
  edit: {},

  /* ── команды, задания, терминалы ────────────────────────────────────── */
  // Один инструмент на всё, что запускает процессы: команда, задание в фоне,
  // живая сессия. Целиком он мир меняет, поэтому не `readOnly` и не в плане;
  // чтение вывода и список — отдельные действия, и они тоже только читают.
  terminal: { readOnlyActions: ['list', 'read', 'output'] },

  /* ── программа и сценарий ───────────────────────────────────────────── */
  run_code: { deniedInProgram: true },
  workflow: { deniedInProgram: true },

  /* ── состояние беседы ───────────────────────────────────────────────── */
  update_plan: { plan: true, alwaysAvailable: true, deniedInProgram: true },
  update_goal: { alwaysAvailable: true, deniedInProgram: true },
  exit_plan_mode: { plan: true, deniedInProgram: true },
  // Вопрос человеку: в плане законен, внутри программы — нет (она ждала бы ответа).
  ask: { plan: true, deniedInProgram: true },
  task: { readOnly: true, plan: true, alwaysAvailable: true },

  /* ── агенты в фоне: план они не меняют, они читают проект ───────────── */
  spawn_agent: { plan: true },
  list_agents: { plan: true, alwaysAvailable: true },
  wait_agent: { plan: true, alwaysAvailable: true },
  send_message: { plan: true, alwaysAvailable: true },
  interrupt_agent: { plan: true, alwaysAvailable: true },

  /* ── git ────────────────────────────────────────────────────────────── */
  // Два имени, а не одно: граница «чтение / запись» — то самое различие,
  // от которого зависит, где инструмент можно позвать. Слить в один `git`
  // значило бы отдать `push` набору «Только чтение».
  git_read: { readOnly: true, plan: true, subagent: true },
  git_write: {},

  /* ── расписание ─────────────────────────────────────────────────────── */
  // В плане — только чтение: `schedule` меняет расписание (create, update,
  // delete), `schedule_list` его только показывает. Именно поэтому они не слиты
  // в один: слитое пришлось бы либо запретить в плане целиком — и там не
  // посмотреть расписание, — либо разрешить, и в плане заводились бы задачи.
  schedule_list: { plan: true },
  schedule: {},

  /* ── память проекта: заметка обратима, спрашивать не у кого ─────────── */
  remember: { alwaysAvailable: true },
  forget: { alwaysAvailable: true },

  /* ── браузер ────────────────────────────────────────────────────────── */
  // Одно имя на все действия: снимок читает состояние страницы, но остальные
  // действия её меняют — повторы такого инструмента не глушим.
  browser: {},

  /* ── окно редактора ─────────────────────────────────────────────────── */
  open_file: { plan: true },
  present: { alwaysAvailable: true },
};

/** Имена инструментов, отмеченных признаком. */
function namesWhere(flag: keyof ToolPolicy): ReadonlySet<string> {
  return new Set(AGENT_TOOLS.filter((tool) => TOOL_POLICIES[tool.name][flag] === true).map((tool) => tool.name));
}

/**
 * Инструменты, которые только читают состояние. Их повтор без нового
 * результата — признак зацикливания, и повторный вызов можно не исполнять.
 * Правки и команды сюда не входят: они меняют мир, и повторить их бывает нужно.
 */
export const READ_ONLY_TOOLS = namesWhere('readOnly');

/** Действия, которые только читают: имя инструмента → набор действий. */
const READ_ONLY_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  (Object.entries(TOOL_POLICIES) as [AgentToolName, ToolPolicy][])
    .filter(([, policy]) => (policy.readOnlyActions?.length ?? 0) > 0)
    .map(([name, policy]) => [name, new Set(policy.readOnlyActions)]),
);

/**
 * Только ли читает этот вызов. Смотрит и на инструмент, и на его действие:
 * повтор `terminal` с `action: read` ничего нового не даст, а `action: run` —
 * это новая команда, и глушить её нельзя.
 */
export function isReadOnlyCall(name: string, rawArguments: string): boolean {
  if (READ_ONLY_TOOLS.has(name)) return true;
  const actions = READ_ONLY_ACTIONS.get(name);
  if (!actions) return false;
  const parsed = parseToolArguments(rawArguments);
  if (!parsed.ok) return false;
  const action = parsed.value.action;
  return typeof action === 'string' && actions.has(action);
}

/**
 * Инструменты режима «План»: только чтение проекта и ведение плана. Всё, что
 * меняет мир (правки, файловые операции, команды), здесь и не предлагается,
 * и не исполняется — даже если модель вызовет такой инструмент по имени.
 */
export const PLAN_MODE_TOOLS = namesWhere('plan');

/**
 * Инструменты подзадачи (`task`) — и тем самым предел глубины работы агентов.
 *
 * Только чтение: правки и команды остаются за основным агентом, который
 * показывает ревью и спрашивает человека. Здесь же лежит ответ на «а может ли
 * агент запустить агента»: ни `task`, ни `workflow` в наборе нет, поэтому
 * глубина всегда 1 (см. `WORKFLOW_MAX_DEPTH`). Иначе один вопрос человека
 * превращался бы в дерево прогонов модели, за которое никто не считал.
 */
export const SUBAGENT_TOOLS = namesWhere('subagent');

/**
 * Инструменты, которые программа (`run_code`) не зовёт.
 *
 * `run_code` и `workflow` — сами себя (рекурсия съела бы и время, и контекст).
 * `ask` — вопрос человеку: программа ждала бы ответа, а человек видел бы только
 * крутящуюся карточку. `update_plan` и `update_goal` — состояние беседы, а не
 * действие: его разбирает service, и из программы оно ничего не поменяет.
 * `read_image` — картинка уходит модели отдельным сообщением прогона, а из
 * программы такого сообщения нет: она получила бы текст «картинку отправили»,
 * которой модель не видит.
 */
export const DENIED_IN_PROGRAM = namesWhere('deniedInProgram');

/**
 * Доступны всегда: ни настроек, ни моста подтверждений им не нужно. Всё
 * остальное решают условия в `canRun`, а по умолчанию он отказывает — тогда
 * забытый инструмент просто не предложится модели (это видно в пробе), а не
 * откроется ей молча.
 */
export const ALWAYS_AVAILABLE = namesWhere('alwaysAvailable');
