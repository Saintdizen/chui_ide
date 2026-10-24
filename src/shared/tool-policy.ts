/**
 * Признаки инструмента, от которых зависит не «что он делает», а «где его можно
 * позвать».
 *
 * Раньше одни и те же сведения были размазаны по пяти спискам в трёх файлах:
 * повтор вызова не исполнялся по `READ_ONLY_TOOLS` (service), режим плана
 * отбирал `PLAN_MODE_TOOLS` (service), подзадача ходила по `SUBAGENT_TOOLS`
 * (tools), а «доступен без условий» решался дефолтом `canRun`. Новый инструмент надо было вспомнить в
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
  /** Доступен подзадаче (`task`) — и тем самым предел глубины: ни `task` здесь нет. */
  readonly subagent?: boolean;
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
   * `read`. Без этого признака слияние молча отключило бы защиту от
   * зацикливания на чтении вывода.
   */
  readonly readOnlyActions?: readonly string[];
  /**
   * Действия, которые ПИШУТ, хотя сам инструмент записан как читающий. Сейчас
   * единственный случай — `lsp` действие `rename`: остальные три только смотрят
   * в языковой сервер, а это меняет код. Отдельным именем такое действие стоило
   * бы схемы в каждом запросе и лишнего слова в ростере, а разница все равно в
   * действии. `isReadOnlyCall` возвращает false для них раньше проверки
   * `readOnly`, а `isWriteCall` держит отказ в режиме плана и у подзадачи
   * (`canRun` в service) — второго имени ради этого не надо.
   */
  readonly writeActions?: readonly string[];
}

export const TOOL_POLICIES: Readonly<Record<AgentToolName, ToolPolicy>> = {
  /* ── чтение проекта ─────────────────────────────────────────────────── */
  // Одно имя на папку и на маску: без `glob` — что в каталоге, с ним — найденные
  // файлы. Оба действия только читают, поэтому право на них одно.
  list: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  // Одно имя на один файл и на пачку (`path` | `paths`).
  read: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  search: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  // Прошлые беседы и следы прогонов: журнал только читают, проекта не касаются.
  history: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  project_map: { readOnly: true, plan: true, subagent: true, alwaysAvailable: true },
  read_image: { readOnly: true, plan: true, alwaysAvailable: true },

  /* Символы и языковой сервер: без него эти инструменты не предлагаются. */
  // Одно имя на все запросы к серверу: ссылки, объявление и скелет файла читают
  // одно и то же состояние, и прав у них одни. Переименование живёт здесь же —
  // действие `rename`: оно ПИШЕТ код, и его держит `writeActions`, а не имя.
  lsp: { readOnly: true, plan: true, subagent: true, writeActions: ['rename'] },

  /* Проверки: мир не меняют, поэтому они и в плане, и у подзадачи. */
  run_tests: {},

  /*
   * Сеть: `search` в повторах не кэшируется (выдача меняется и стоит денег),
   * а `fetch` только читает — отсюда `readOnlyActions`. Подзадаче нужен целиком.
   */
  web: { plan: true, subagent: true, readOnlyActions: ['fetch'] },

  checks: { readOnly: true, plan: true, subagent: true },
  mcp: { plan: true },

  /* ── правки файлов ──────────────────────────────────────────────────── */
  // Одно имя на создание, перемещение, удаление и замену по проекту: все четыре
  // меняют диск одинаково и прав у них одни.
  file: { alwaysAvailable: true },
  // Правка файлов: две формы (по якорю и по позициям) — один инструмент.
  // Права у форм одни: обе идут через ревью и undo в renderer.
  edit: {},

  /* ── команды, задания, терминалы ────────────────────────────────────── */
  // Семья терминала — пять имён, потому что действие видно из имени: схема
  // `terminal(action: …)` весила 370 токенов на каждом шаге и требовала помнить
  // пару «действие + id». Запуск и запись мир меняют; чтение вывода и список — нет.
  terminal: {},
  terminalOpen: {},
  terminalWrite: {},
  terminalStop: {},
  terminalOutput: { readOnly: true },
  // Список сессий и заданий ничего не меняет — ему в плане можно, как `read`.
  terminalList: { readOnly: true, alwaysAvailable: true, plan: true },

  /* ── состояние беседы ───────────────────────────────────────────────── */
  // Одно имя на всё разговорное: заметки, вопрос, план, цель, утверждение
  // плана. Пять имён стоили пяти строк ростера и трёх схем в режиме плана.
  // План и вопрос в плане законны, а `remember`/`forget` ПИШУТ память — их
  // держит `writeActions`, а не имя.
  mind: { plan: true, alwaysAvailable: true, writeActions: ['remember', 'forget'] },
  task: { readOnly: true, plan: true, alwaysAvailable: true },

  /* ── агенты в фоне: план они не меняют, они читают проект ───────────── */
  // Одно имя на все пять действий: `spawn` и три разговора с живым агентом
  // различались только первой строкой описания, а стоили пяти схем (≈535 токенов
  // в каждом запросе). `list` ничего не меняет — повтор в том же шаге не нужен.
  // Шаб не в ALWAYS_AVAILABLE: в «Авто» он есть строкой ростера (имя, действие,
  // аргументы), и схема 310 токенов в каждом запросе того не стоит.

  /* ── браузер ────────────────────────────────────────────────────────── */
  // Одно имя на все действия: снимок читает состояние страницы, но остальные
  // действия её меняют — повторы такого инструмента не глушим.
  browser: {},

  /* ── окно редактора ─────────────────────────────────────────────────── */
  // Открыть файл и предложить результат кнопками — одна вещь («вот здесь»).
  // В плане законно, показывать же безопасно и без подключённого окна.
  show: { plan: true, alwaysAvailable: true },
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
 * Действия, которые пишут: имя инструмента → набор действий. Сейчас только
 * `lsp` с действием `rename`.
 */
const WRITE_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  (Object.entries(TOOL_POLICIES) as [AgentToolName, ToolPolicy][])
    .filter(([, policy]) => (policy.writeActions?.length ?? 0) > 0)
    .map(([name, policy]) => [name, new Set(policy.writeActions)]),
);

/**
 * Только ли читает этот вызов. Смотрит и на инструмент, и на его действие:
 * повтор `terminal` с `action: read` ничего нового не даст, а `action: run` —
 * это новая команда, и глушить её нельзя. Действие из `writeActions` пишет,
 * даже если весь инструмент помечен как читающий.
 */
export function isReadOnlyCall(name: string, rawArguments: string): boolean {
  if (isWriteCall(name, rawArguments)) return false;
  if (READ_ONLY_TOOLS.has(name)) return true;
  const actions = READ_ONLY_ACTIONS.get(name);
  if (!actions) return false;
  const parsed = parseToolArguments(rawArguments);
  if (!parsed.ok) return false;
  const action = parsed.value.action;
  return typeof action === 'string' && actions.has(action);
}

/** Чтение живого процесса и явное force нельзя подавлять как буквальный повтор. */
export function isCacheableReadCall(name: string, rawArguments: string): boolean {
  if (!isReadOnlyCall(name, rawArguments)) return false;
  // `terminalOutput` опрашивает живой процесс: повтор вправе принести новый вывод.
  if (name === 'terminalOutput') return false;
  if (name !== 'read') return true;
  const parsed = parseToolArguments(rawArguments);
  return parsed.ok && parsed.value.force !== true && parsed.value.force !== 'true';
}

/**
 * Меняет ли вызов мир — по действию, а не только по имени. Нужно режиму плана,
 * где даже такой инструмент по имени не исполнится.
 */
export function isWriteCall(name: string, rawArguments: string): boolean {
  const actions = WRITE_ACTIONS.get(name);
  if (!actions) return false;
  const parsed = parseToolArguments(rawArguments);
  if (!parsed.ok) return true;
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
 * агент запустить агента»: ни `task` в наборе нет, поэтому
 * глубина всегда 1. Иначе один вопрос человека
 * превращался бы в дерево прогонов модели, за которое никто не считал.
 */
export const SUBAGENT_TOOLS = namesWhere('subagent');

/**
 * Доступны всегда: ни настроек, ни моста подтверждений им не нужно. Всё
 * остальное решают условия в `canRun`, а по умолчанию он отказывает — тогда
 * забытый инструмент просто не предложится модели (это видно в пробе), а не
 * откроется ей молча.
 */
export const ALWAYS_AVAILABLE = namesWhere('alwaysAvailable');
