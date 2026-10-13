import { h, svgIcon } from './dom';

export interface StatusState {
  file: string | null;
  dirty: boolean;
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
}

export interface StatusBarView {
  element: HTMLElement;
  /**
   * Куда монтируется статус ассистента: режим работы и заполнение контекста.
   * Композер отдаёт сюда свою строку статуса, чтобы она жила в общей полосе окна,
   * а не занимала высоту панели чата.
   */
  chatSlot: HTMLElement;
  update(patch: Partial<StatusState>): void;
}

export interface StatusBarDeps {
  /** Открыть менеджер git у указанной кнопки — так работает кнопка ветки. */
  openGitManager(anchor: HTMLElement): void;
  /** Открыть попап Python-окружения у кнопки окружения. */
  openPythonEnv(anchor: HTMLElement): void;
  /** Открыть попап Node-окружения у кнопки окружения. */
  openNodeEnv(anchor: HTMLElement): void;
  /** Клик по пути файла — быстрый переход к другому файлу. */
  openFilePicker(): void;
  /** Клик по счётчику проблем — переход к первой пометке. */
  openProblems(anchor: HTMLElement): void;
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
    file: null,
    dirty: false,
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
  const fileItem = h('button', {
    class: 'status-item status-file',
    type: 'button',
    title: 'Быстрый переход к файлу',
    onClick: () => deps.openFilePicker(),
  });
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
  const gitLabel = h('span', { class: 'status-git-label' });
  gitItem.appendChild(gitLabel);
  const positionItem = h('span', { class: 'status-item' });
  const eolItem = h('span', { class: 'status-item' });
  const encodingItem = h('span', { class: 'status-item' });
  const indentItem = h('span', { class: 'status-item' });
  const languageItem = h('span', { class: 'status-item' });
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
    h('div', { class: 'status-group' }, gitItem, fileItem),
    h(
      'div',
      { class: 'status-group' },
      problemsItem,
      versionItem,
      positionItem,
      eolItem,
      encodingItem,
      indentItem,
      envItem,
      readOnlyItem,
      languageItem,
      chatSlot,
    ),
  );

  const render = (): void => {
    fileItem.textContent = state.file ? `${state.dirty ? '● ' : ''}${state.file}` : '';
    fileItem.hidden = !state.file;
    positionItem.textContent = `${state.line}:${state.column}`;
    eolItem.textContent = state.eol;
    encodingItem.textContent = state.encoding;
    indentItem.textContent = state.useTabs ? `таб ${state.tabSize}` : `${state.tabSize} пробела`;
    languageItem.textContent = state.language ?? '—';
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
    update(patch) {
      Object.assign(state, patch);
      render();
    },
  };
}
