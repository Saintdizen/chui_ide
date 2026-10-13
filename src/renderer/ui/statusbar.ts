import type { LspChip } from '../../shared/lsp-status';
import { lspOriginLabel } from '../../shared/lsp-status';
import { h, svgIcon } from './dom';

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
  problems: { errors: number; warnings: number };
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
}

export interface StatusBarView {
  element: HTMLElement;
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
function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Статусбар как в PyCharm: слева путь к активному файлу и ветка git,
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
    problems: { errors: 0, warnings: 0 },
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
  // Прогресс языкового сервера: значок-вертушка и подпись. Крутится, пока сервер занят, —
  // так долгая работа видна и не выглядит зависанием (см. `$/progress`).
  const progressItem = h(
    'span',
    { class: 'status-item status-progress' },
    svgIcon('spinner', 12),
    h('span', { class: 'status-progress-label' }),
  );
  const progressLabel = progressItem.querySelector<HTMLElement>('.status-progress-label')!;
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
      progressItem,
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
    const { errors, warnings } = state.problems;
    problemsItem.hidden = errors === 0 && warnings === 0;
    problemsItem.classList.toggle('has-errors', errors > 0);
    problemsItem.classList.toggle('has-warnings', errors === 0 && warnings > 0);
    problemsCounts.textContent = [
      errors > 0 ? `${errors} ${plural(errors, 'ошибка', 'ошибки', 'ошибок')}` : '',
      warnings > 0 ? `${warnings} ${plural(warnings, 'предупреждение', 'предупреждения', 'предупреждений')}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    problemsItem.title =
      errors === 0 && warnings === 0
        ? 'Ошибок и предупреждений нет'
        : `Ошибок: ${errors}, предупреждений: ${warnings}. Нажмите, чтобы перейти к первой`;
    gitItem.hidden = state.branch === null;
    gitLabel.textContent = state.branch ? `${state.branch}${state.changes > 0 ? `  ±${state.changes}` : ''}` : '';
    gitItem.title = state.branch
      ? `Ветка ${state.branch}${state.changes > 0 ? `, файлов с правками: ${state.changes}` : ', изменений нет'}`
      : '';
  };

  render();

  return {
    element,
    chatSlot,
    fileSlot,
    update(patch) {
      Object.assign(state, patch);
      render();
    },
  };
}
