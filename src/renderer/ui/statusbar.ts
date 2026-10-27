import type { LspChip } from '../../shared/lsp-status';
import { lspOriginLabel } from '../../shared/lsp-status';
import { h, svgIcon } from './dom';
import { checkProgress } from './check-progress';
import type { CheckProgressInput } from './check-progress';
import { problemsWidget } from './problems-widget';
import type { ProjectProblemCounts } from './problems-widget';
import type { VimMode } from '../editor/input/vim';

// Вид счётчиков живёт в чистом модуле, а тип — там же: его читают тесты без DOM.
export type { ProjectProblemCounts };

/** Короткое слово режима Vim для строки состояния. */
const VIM_LABEL: Record<VimMode, string> = {
  normal: 'НОРМ',
  insert: 'ВСТАВКА',
  visual: 'ВИЗУАЛ',
  'visual-line': 'ВСТРОЧНО',
};

/** Подпись режима Vim для всплывающей подсказки. */
const VIM_TITLE: Record<VimMode, string> = {
  normal: 'нормальный режим',
  insert: 'режим вставки',
  visual: 'визуальный режим',
  'visual-line': 'визуально-строчный режим',
};

export interface StatusState {
  /** Файл открыт только для чтения (большой): показываем это словом. */
  readOnly: boolean;
  line: number;
  column: number;
  language: string | null;
  version: number;
  tabSize: number;
  /** Отступ символом табуляции — так у языков вроде Makefile. */
  useTabs: boolean;
  eol: string;
  encoding: string;
  /** Ветка или null, если репозитория нет. */
  branch: string | null;
  /** Сколько файлов с правками: показывает виджет ветки. */
  changes: number;
  /** Ключ вида проекта (`python`, `node`, …): выбирает, какой попап открыть. */
  projectKindId: string | null;
  /** Пометки в открытых файлах: числа ошибок и предупреждений для виджета проблем. */
  problems: ProjectProblemCounts;
  /**
   * Идёт проверка проекта: сколько шагов сделано (см. `check-progress.ts`). `null` — прохода
   * нет. Числа здесь — шаги, а не проценты: середину шага не знает никто.
   */
  check: CheckProgressInput | null;
  /** Выбранное Python-окружение (`.venv`, `python3`); null — виджет скрыт. */
  env: string | null;
  /**
   * Языковой сервер активного файла: какой, откуда и не поднялся ли. `null` — языка
   * нет или про него ничего не известно (молчать честнее, чем висеть пустым чипом).
   */
  lsp: LspChip | null;
  /**
   * Чем занят языковой сервер (индексация, поиск ссылок): подпись и процент. `null` —
   * сервер молчит, и виджета нет (`$/progress`, см. `shared/lsp-progress.ts`).
   */
  progress: { label: string; percentage: number | null } | null;
  /**
   * Карта символов собирается: подпись и, если известно «сколько всего», доля
   * прочитанных файлов для полосы. `null` — карта готова (её сборка — фон, а не событие).
   */
  symbols: { text: string; title: string; progress: { done: number; total: number } | null } | null;
  /**
   * Идёт запись макроса: сколько действий уже записано. `null` — записи нет.
   * Показываем точкой и числом: забыть про идущую запись легко.
   */
  macro: { steps: number } | null;
  /**
   * Режим Vim (`editor.vimMode`). `null` — режим выключен. В режиме вставки чип показываем
   * тоже: он говорит, что модальность включена и что дальше можно набирать текст.
   */
  vim: VimMode | null;
}

export interface StatusBarView {
  element: HTMLElement;
  /**
   * Кнопка ветки git в полосе: к ней привязывается поповер менеджера git — и по клику,
   * и командой «Показать изменения», когда вкладки в нижней панели больше нет.
   */
  readonly gitAnchor: HTMLElement;
  /**
   * Куда монтируется статус ассистента: режим работы и заполнение контекста.
   * Композер отдаёт сюда свою строку статуса, чтобы она жила в общей полосе окна,
   * а не занимала высоту панели чата.
   */
  chatSlot: HTMLElement;
  /**
   * Куда встают хлебные крошки — путь к открытому файлу. Раньше путь рисовала
   * сама полоса ссылкой на файл, но те же сегменты показывали крошки под
   * вкладками: одно дублировало другое. Теперь крошки одни и живут здесь.
   */
  fileSlot: HTMLElement;
  update(patch: Partial<StatusState>): void;
}

export interface StatusBarDeps {
  /** Открыть менеджер git у указанной кнопки — так работает кнопка ветки. */
  openGitManager(anchor: HTMLElement): void;
  /** Открыть попап Python-окружения у кнопки окружения. */
  openPythonEnv(anchor: HTMLElement): void;
  /** Открыть попап Node-окружения у кнопки окружения. */
  openNodeEnv(anchor: HTMLElement): void;
  /** Клик по счётчику проблем — переход к первой пометке. */
  openProblems(anchor: HTMLElement): void;
  /** Клик по чипу языкового сервера — попап со списком серверов и действиями. */
  openLsp(anchor: HTMLElement): void;
}

/** Русское склонение по числу: 1 ошибка, 2 ошибки, 5 ошибок. */
/**
 * Статусбар: слева путь к активному файлу и ветка git,
 * справа «строка:столбец», перевод строки, кодировка, отступ, окружение и язык.
 * Полоса плоская, без «острова» — на фоне приложения.
 */
export function createStatusBar(deps: StatusBarDeps): StatusBarView {
  const state: StatusState = {
    readOnly: false,
    line: 1,
    column: 1,
    language: null,
    version: 0,
    tabSize: 2,
    useTabs: false,
    eol: 'LF',
    encoding: 'UTF-8',
    branch: null,
    changes: 0,
    projectKindId: null,
    env: null,
    lsp: null,
    progress: null,
    symbols: null,
    macro: null,
    vim: null,
    problems: { errors: 0, warnings: 0 },
    check: null,
  };

  // Виджет окружения один, а попапов два: у Node открываем Node, иначе Python.
  const envItem = h('button', {
    class: 'status-item status-env',
    type: 'button',
    onClick: (event: Event) => {
      const anchor = event.currentTarget as HTMLElement;
      if (state.projectKindId === 'node') deps.openNodeEnv(anchor);
      else deps.openPythonEnv(anchor);
    },
  });
  /** Слот под крошки: путь к файлу рисует `ui/breadcrumbs.ts`. */
  const fileSlot = h('div', { class: 'status-breadcrumbs' });
  const gitItem = h(
    'button',
    {
      class: 'status-item status-git',
      type: 'button',
      title: 'Менеджер git',
      onClick: (event: Event) => deps.openGitManager(event.currentTarget as HTMLElement),
    },
    svgIcon('branch', 12),
  );
  // Подпись ветки — обычным текстом полосы: своего шрифта у неё нет.
  const gitLabel = h('span', {});
  gitItem.appendChild(gitLabel);
  const positionItem = h('span', { class: 'status-item' });
  const eolItem = h('span', { class: 'status-item' });
  const encodingItem = h('span', { class: 'status-item' });
  const indentItem = h('span', { class: 'status-item' });
  const languageItem = h('span', { class: 'status-item' });
  // Языковой сервер: какой обслуживает открытый язык и откуда он взят. Упавший сервер
  // показываем тоже — это и есть ответ на вопрос «почему тут нет подсказок».
  const lspItem = h(
    'button',
    {
      class: 'status-item status-lsp',
      type: 'button',
      title: 'Языковой сервер',
      onClick: (event: Event) => deps.openLsp(event.currentTarget as HTMLElement),
    },
    svgIcon('server', 12),
  );
  const lspLabel = h('span', {});
  lspItem.appendChild(lspLabel);
  // Прогресс языкового сервера (индексация, поиск ссылок): полоса с процентом, если
  // сервер его назвал, иначе бегущий штрих. Занятый сервер молчать не должен.
  const progressItem = h(
    'span',
    { class: 'status-item status-meter is-metered' },
    h(
      'span',
      { class: 'status-meter-track' },
      h('span', { class: 'status-meter-fill' }),
      h('span', { class: 'status-meter-run' }),
    ),
    h('span', { class: 'status-meter-label' }),
  );
  const progressFill = progressItem.querySelector<HTMLElement>('.status-meter-fill')!;
  const progressLabel = progressItem.querySelector<HTMLElement>('.status-meter-label')!;
  // Карта символов собирается: полоса с числом пройденных файлов. Числа — файлы,
  // а не проценты: обход идёт файл за файлом, и это единственное, что известно точно.
  const symbolsItem = h(
    'span',
    { class: 'status-item status-meter' },
    h(
      'span',
      { class: 'status-meter-track' },
      h('span', { class: 'status-meter-fill' }),
      h('span', { class: 'status-meter-run' }),
    ),
    h('span', { class: 'status-meter-label' }),
  );
  const symbolsFill = symbolsItem.querySelector<HTMLElement>('.status-meter-fill')!;
  const symbolsLabel = symbolsItem.querySelector<HTMLElement>('.status-meter-label')!;
  // Идёт запись макроса: точка и число действий. Молчит, когда записи нет.
  const macroItem = h(
    'span',
    { class: 'status-item status-macro', title: 'Идёт запись макроса' },
    h('span', { class: 'status-macro-dot' }),
    h('span', { class: 'status-macro-count' }),
  );
  const macroCount = macroItem.querySelector<HTMLElement>('.status-macro-count')!;
  // Режим Vim: короткое слово (НОРМ, ВСТАВКА, ВИЗУАЛ) в левой части полосы.
  const vimItem = h('span', { class: 'status-item status-vim' });
  const readOnlyItem = h('span', { class: 'status-item status-readonly' });
  const versionItem = h('span', { class: 'status-item status-muted' });
  // Проблемы — значок и числа: цвет различает ошибку и предупреждение, а количество
  // читается и без него. Пусто — виджет скрыт (нет проблем, нет и шума).
  const problemsItem = h(
    'button',
    {
      class: 'status-item status-problems',
      type: 'button',
      title: 'Ошибки и предупреждения в открытых файлах',
      onClick: (event: Event) => deps.openProblems(event.currentTarget as HTMLElement),
    },
    svgIcon('warning', 12),
    h('span', { class: 'status-problems-counts' }),
  );
  const problemsCounts = problemsItem.querySelector<HTMLElement>('.status-problems-counts')!;
  // Полоса проверки проекта: заливка — завершённые шаги, бегущий штрих — работа идёт.
  // Цифры только про шаги: проценты внутри шага были бы выдуманными.
  const checkItem = h(
    'span',
    { class: 'status-item status-meter is-metered' },
    h(
      'span',
      { class: 'status-meter-track' },
      h('span', { class: 'status-meter-fill' }),
      h('span', { class: 'status-meter-run' }),
    ),
    h('span', { class: 'status-meter-label' }),
  );
  const checkFill = checkItem.querySelector<HTMLElement>('.status-meter-fill')!;
  const checkLabel = checkItem.querySelector<HTMLElement>('.status-meter-label')!;

  // Статус ассистента (одна кнопка «Информация о сессии»: значок режима, кольцо
  // контекста, искра) приходит из чата и встаёт последним — в правом углу полосы.
  const chatSlot = h('div', { class: 'status-chat' });
  const element = h(
    'div',
    { class: 'statusbar' },
    h('div', { class: 'status-group' }, gitItem, fileSlot),
    h(
      'div',
      { class: 'status-group' },
      vimItem,
      progressItem,
      symbolsItem,
      macroItem,
      checkItem,
      problemsItem,
      versionItem,
      positionItem,
      eolItem,
      encodingItem,
      indentItem,
      readOnlyItem,
      languageItem,
      lspItem,
      // Окружение — прямо перед кнопкой «Информация о сессии»: так она стоит
      // крайней справа, а чип интерпретатора — слева от неё.
      envItem,
      chatSlot,
    ),
  );

  const render = (): void => {
    positionItem.textContent = `${state.line}:${state.column}`;
    eolItem.textContent = state.eol;
    encodingItem.textContent = state.encoding;
    indentItem.textContent = state.useTabs ? `таб ${state.tabSize}` : `${state.tabSize} пробела`;
    languageItem.textContent = state.language ?? '—';
    const lsp = state.lsp;
    lspItem.hidden = lsp === null;
    lspItem.classList.toggle('is-failed', Boolean(lsp?.failed));
    if (lsp) {
      lspLabel.textContent = lsp.failed ? `${lsp.label}: нет сервера` : lsp.label;
      lspItem.title = lsp.failed
        ? `Языковой сервер для «${lsp.language}» не поднялся: ${lsp.failed}`
        : `Языковой сервер: ${lsp.label} (${lsp.origin ? lspOriginLabel(lsp.origin) : 'источник неизвестен'})`;
    }
    const progress = state.progress;
    progressItem.hidden = progress === null;
    progressLabel.textContent =
      progress === null
        ? ''
        : progress.percentage === null
          ? progress.label
          : `${progress.label} ${Math.round(progress.percentage)}%`;
    progressItem.title = progress ? `Языковой сервер: ${progress.label}` : '';
    // Процент сервер сообщает сам ($/progress); без него — бегущий штрих.
    progressItem.classList.toggle('is-busy', progress !== null && progress.percentage === null);
    progressFill.style.width = `${Math.round(progress?.percentage ?? 0)}%`;
    const symbols = state.symbols;
    symbolsItem.hidden = symbols === null;
    symbolsLabel.textContent = symbols?.text ?? '';
    symbolsItem.title = symbols?.title ?? '';
    // Дорожка нужна там, где есть что мерить: у одного числа делить нечего.
    const meter = symbols?.progress ?? null;
    symbolsItem.classList.toggle('is-metered', meter !== null);
    symbolsItem.classList.toggle('is-busy', meter !== null);
    symbolsFill.style.width = meter ? `${Math.round((meter.done / Math.max(1, meter.total)) * 100)}%` : '0';
    const macro = state.macro;
    macroItem.hidden = macro === null;
    macroCount.textContent = macro ? `МАКРО ${macro.steps}` : '';
    macroItem.title = macro ? `Идёт запись макроса: действий ${macro.steps}` : '';
    // Режим Vim: короткое слово. Показывается, когда режим включён.
    const vim = state.vim;
    vimItem.hidden = vim === null;
    vimItem.textContent = vim ? VIM_LABEL[vim] : '';
    vimItem.title = vim ? `Vim: ${VIM_TITLE[vim]}` : '';
    readOnlyItem.textContent = state.readOnly ? 'Только чтение' : '';
    readOnlyItem.hidden = !state.readOnly;
    readOnlyItem.title = state.readOnly ? 'Файл слишком большой для правки — открыт только для чтения' : '';
    envItem.textContent = state.env ?? '';
    envItem.hidden = !state.env;
    envItem.title = state.env
      ? state.projectKindId === 'node'
        ? `Node-окружение: ${state.env}`
        : `Python-окружение: ${state.env}`
      : '';
    versionItem.textContent = state.version ? `v${state.version}` : '';
    // Вид виджета решает чистый модуль: ноль — не всегда «чисто» (правила там).
    const problems = problemsWidget(state.problems);
    problemsItem.hidden = problems.hidden;
    problemsItem.classList.toggle('is-checking', problems.tone === 'checking');
    problemsItem.classList.toggle('is-unchecked', problems.tone === 'unchecked');
    problemsItem.classList.toggle('has-errors', problems.tone === 'errors');
    problemsItem.classList.toggle('has-warnings', problems.tone === 'warnings');
    problemsCounts.textContent = problems.text;
    problemsItem.title = problems.title;
    const check = checkProgress(state.check);
    checkItem.hidden = check.hidden;
    checkItem.classList.toggle('is-busy', check.busy);
    checkFill.style.width = `${Math.round(check.fill * 100)}%`;
    checkLabel.textContent = check.label;
    checkItem.title = check.title;
    gitItem.hidden = state.branch === null;
    gitLabel.textContent = state.branch ? `${state.branch}${state.changes > 0 ? `  ±${state.changes}` : ''}` : '';
    gitItem.title = state.branch
      ? `Ветка ${state.branch}${state.changes > 0 ? `, файлов с правками: ${state.changes}` : ', изменений нет'}`
      : '';
  };

  render();

  return {
    element,
    gitAnchor: gitItem,
    chatSlot,
    fileSlot,
    update(patch) {
      Object.assign(state, patch);
      render();
    },
  };
}
