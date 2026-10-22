/** Старые имена инструментов: вызов по ним не должен упираться в тупик.
 *
 * Схемы сливаются, имена исчезают, а вызовы остаются — в сохранённых беседах, в
 * истории прогонов. Модель, продолжая такую беседу, копирует прошлый вызов
 * (`read_file`, `spawn_agent`) и получает «Инструмент недоступен»: тупик за целый
 * шаг, хотя инструмент есть — он просто называется иначе.
 */
export interface CanonicalCall {
  /** Имя, под которым инструмент живёт сейчас. */
  name: string;
  /** Аргументы: у агентов к ним дописано действие. */
  arguments: string;
  /** Имя отличалось от нынешнего. */
  renamed: boolean;
}

/** Старое имя → нынешнее. Совпадение точное. */
const NAME_ALIASES: Readonly<Record<string, string>> = {
  // Чтение и просмотр: пары слиты по кратности, аргументы у них те же.
  read_file: 'read',
  read_files: 'read',
  list_dir: 'list',
  find_files: 'list',
  // Живые агенты: пять имён стали одним инструментом с `action`.
  // Память: запись и уборку заметок различал только глагол.
  remember: 'mind',
  forget: 'mind',
  // Языковой сервер: ссылки, объявление, скелет файла и переименование —
  // вопросы к одному серверу. Переименование пишет код — его держит
  // `writeActions` в политике, а не отдельное имя.
  find_references: 'lsp',
  go_to_definition: 'lsp',
  file_outline: 'lsp',
  rename_symbol: 'lsp',
  // Сеть: поиск и чтение страницы — два шага одного пути.
  web_search: 'web',
  web_fetch: 'web',
  // Проверки: пометки редактора и линтер — обе стороны «что не так с кодом».
  get_diagnostics: 'checks',
  run_linter: 'checks',
  // Файлы: создание, перемещение, удаление и массовая замена — всё меняет диск.
  create_file: 'file',
  move_file: 'file',
  delete_file: 'file',
  replace_in_files: 'file',
  // Правка по якорю. `str_replace` приходит с той же плоской формой
  // (`path`/`oldText`/`newText`), что у `edit`, — переименовывать нечего.
  str_replace: 'edit',
  // `apply_patch` — старое имя той же правки: форма `patches[]`, её перекладывает
  // `ARGUMENT_REWRITES`. Без этого продолжение сохранённой беседы — тупик за шаг.
  apply_patch: 'edit',
  // Показ: открыть файл и предложить результат — две стороны «вот здесь».
  open_file: 'show',
  present: 'show',
  // Состояние беседы: чек-лист и цель — два поля одного инструмента.
  update_plan: 'mind',
  update_goal: 'mind',
  ask_user: 'mind',
  exit_plan_mode: 'mind',
  ralph: 'mind',
  // Поиск: два источника различались только первой строкой описания.
  codebase_search: 'search',
  search_docs: 'search',
  // Журнал разговоров переехал из `search` в своё имя: это не поиск по проекту.
  session_search: 'history',
  session_trace: 'history',
  // Ресурсы MCP: каталог и чтение — две половины одного похода.
  list_mcp_resources: 'mcp',
  read_mcp_resource: 'mcp',
  // Терминал: три имени слились в одно с действиями. `run_terminal` — самое частое
  // из старых (47 вызовов в трёх беседах): по переписи вывода оно попало в историю
  // под своим именем, то есть модель его называет до сих пор.
  run_terminal: 'terminal',
  run_output: 'terminal',
  run_stop: 'terminal',
};

/** Старое имя → аргументы, которые оно подразумевало: `action`. */
const ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {};

const ACTION_ALIASES: Readonly<Record<string, string>> = {
  run_terminal: 'run',
  run_output: 'output',
  run_stop: 'stop',
  spawn_agent: 'spawn',
  list_agents: 'list',
  wait_agent: 'wait',
  send_message: 'send',
  interrupt_agent: 'interrupt',
  remember: 'remember',
  forget: 'forget',
  find_references: 'references',
  go_to_definition: 'definition',
  file_outline: 'outline',
  rename_symbol: 'rename',
  web_search: 'search',
  web_fetch: 'fetch',
  get_diagnostics: 'diagnostics',
  run_linter: 'lint',
  create_file: 'create',
  move_file: 'move',
  delete_file: 'delete',
  list_mcp_resources: 'list',
  read_mcp_resource: 'read',
  replace_in_files: 'replace',
  open_file: 'open',
  present: 'present',
  update_plan: 'steps',
  update_goal: 'goal',
  codebase_search: 'code',
  search_docs: 'docs',
  session_search: 'sessions',
  session_trace: 'trace',
};

/**
 * Плоская правка (`path` + `oldText` + `newText`) → пакетная (`edits[]`).
 *
 * Схема возит одну форму: две параллельные стоили 96 токенов в каждом запросе.
 * Старые вызовы и привычка «один файл — один якорь» остаются рабочими: адрес
 * переносится элементом `edits[]`, верхние поля снимаются, чтобы не править
 * один и тот же якорь дважды.
 */
export function packFlatEdit(args: Record<string, unknown>): Record<string, unknown> {
  const path = typeof args.path === 'string' && args.path.trim() ? args.path : undefined;
  const hasAnchor = typeof args.oldText === 'string' || typeof args.newText === 'string';
  if (!path || !hasAnchor || args.edits !== undefined) return args;
  const { path: _path, oldText, newText, ...rest } = args;
  const item: Record<string, unknown> = { path };
  if (oldText !== undefined) item.oldText = oldText;
  if (newText !== undefined) item.newText = newText;
  return { ...rest, edits: [item] };
}

/** Старое имя → правка его аргументов: форма другая, а смысл тот же. */
const ARGUMENT_REWRITES: Readonly<Record<string, (args: Record<string, unknown>) => Record<string, unknown>>> = {
  // `apply_patch` называл правку «патчами» на двух уровнях: `patches[].patches[]`.
  // У `edit` те же поля, но имя `edits` — переименовываем ключ на всех уровнях.
  apply_patch: (args) => renameKey(args, 'patches', 'edits') as Record<string, unknown>,
};

/** Ключ `from` → `to` на всех уровнях объекта: `patches[]` старой правки → `edits[]`. */
function renameKey(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((item) => renameKey(item, from, to));
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key === from ? to : key] = renameKey(item, from, to);
  }
  return result;
}

/** Аргументы с переложенной формой. Битый JSON отдаём как есть: разберётся инструмент. */
function rewriteArguments(
  rawArguments: string,
  rewrite: (args: Record<string, unknown>) => Record<string, unknown>,
): string {
  try {
    const parsed: unknown = JSON.parse(rawArguments.trim() || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return rawArguments;
    return JSON.stringify(rewrite(parsed as Record<string, unknown>));
  } catch {
    return rawArguments;
  }
}

/** Незнакомое имя возвращается как есть: чужие (MCP) не наше дело. */
export function canonicalCall(name: string, rawArguments: string): CanonicalCall {
  // Своё имя `edit`: схема возит только `edits[]`, а плоская форма
  // (`path`+`oldText`+`newText`) ещё живёт в старых вызовах и в привычке модели.
  if (name === 'edit') {
    const packed = rewriteArguments(rawArguments, packFlatEdit);
    return { name, arguments: packed, renamed: packed !== rawArguments };
  }

  const target = NAME_ALIASES[name];
  if (!target) return { name, arguments: rawArguments, renamed: false };

  // Аргументы старого имени бывают другой формы: `patches` → `edits`.
  const rewrite = ARGUMENT_REWRITES[name];
  if (rewrite) {
    return { name: target, arguments: rewriteArguments(rawArguments, rewrite), renamed: true };
  }

  const action = ACTION_ALIASES[name];
  const fixed = ARG_ALIASES[name];
  const patch = fixed ?? (action ? { action } : undefined);
  if (!patch) return { name: target, arguments: rawArguments, renamed: true };

  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArguments.trim() || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { name: target, arguments: rawArguments, renamed: true };
    }
    value = parsed as Record<string, unknown>;
  } catch {
    return { name: target, arguments: rawArguments, renamed: true };
  }

  // Уже названное значение не перебиваем: вызов мог прийти от модели, которая
  // знает новые имена, и её выбор вернее нашего.
  const missing = Object.entries(patch).filter(
    ([key]) => typeof value[key] !== 'string' || (value[key] as string).trim() === '',
  );
  if (missing.length === 0) return { name: target, arguments: rawArguments, renamed: true };

  const merged = { ...value };
  for (const [key, entry] of missing) merged[key] = entry;
  return { name: target, arguments: JSON.stringify(merged), renamed: true };
}
