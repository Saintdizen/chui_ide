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

import { AGENT_TOOLS, type AgentToolName } from './tools';

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
  apply_edit: {},
  apply_patch: {},

  /* ── команды, задания, терминалы ────────────────────────────────────── */
  run_terminal: {},
  run_output: { readOnly: true, plan: true },
  run_stop: {},
  terminal_list: {},
  terminal_start: {},
  terminal_read: {},
  terminal_write: {},
  terminal_stop: {},

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
  git_status: { readOnly: true, plan: true, subagent: true },
  git_diff: { readOnly: true, plan: true, subagent: true },
  git_log: { readOnly: true, plan: true, subagent: true },
  git_blame: { readOnly: true, plan: true, subagent: true },
  git_stage: {},
  git_unstage: {},
  git_commit: {},
  git_checkout: {},
  git_discard: {},
  git_fetch: {},
  git_pull: {},
  git_push: {},

  /* ── расписание ─────────────────────────────────────────────────────── */
  // В плане — только чтение: заводить и править задачи будет исполнение.
  schedule_list: { plan: true },
  schedule_create: {},
  schedule_update: {},
  schedule_delete: {},

  /* ── память проекта: заметка обратима, спрашивать не у кого ─────────── */
  remember: { alwaysAvailable: true },
  forget: { alwaysAvailable: true },

  /* ── встроенный браузер ─────────────────────────────────────────────── */
  // Снимок читает состояние страницы; после действия (клик, переход, ввод)
  // кэш всё равно сбрасывается — те инструменты меняют мир.
  browser_snapshot: { readOnly: true },
  browser_open: {},
  browser_click: {},
  browser_type: {},
  browser_evaluate: {},
  browser_zoom: {},
  browser_close: {},

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
