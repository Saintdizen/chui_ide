import type { LspChip } from '../../shared/lsp-status';
import { lspOriginLabel } from '../../shared/lsp-status';
import { h, svgIcon } from './dom';
import { statusMeter } from './status-meter';
import type { CheckProgressInput } from './check-progress';
import { problemsWidget } from './problems-widget';
import type { ProjectProblemCounts } from './problems-widget';
import type { VimMode } from '../editor/input/vim';
import { highlightOffChip, type HighlightOffReason } from '../../shared/large-file';
import type { WhitespaceMode } from '../../shared/whitespace';

/** Подписи для чипа: коротко, чтобы не толкать соседей вправо. */
const WHITESPACE_LABELS: Record<WhitespaceMode, string> = {
  none: 'П· ',
  trailing: '· ',
  all: '¶· ',
};

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
  /** Подпись концов строк: `LF` / `CRLF`. `null` — не текст, виджет скрыт. */
  eol: string | null;
  /** Режим невидимых: `none` / `trailing` / `all`. `null` — не текст, чип скрыт. */
  whitespace: WhitespaceMode | null;
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
  /**
   * Подсветка выключена из-за размера файла и почему. `null` — подсветка есть
   * (или языка нет — про это молчит другой виджет). Клик по чипу включает всё равно.
   */
  highlightOff: HighlightOffReason | null;
  /** Чем файл отформатируется и выключено ли это для него. `null` — не знаем. */
  formatter: { name: string; off: boolean } | null;
  /** Есть ли у файла линзы и включены ли они. */
  lenses: { on: boolean } | null;
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
  /** Человек нажал «включить всё равно»: подсветить крупный файл несмотря на порог. */
  forceHighlight: () => void;
  /** Включить/выключить форматирование при сохранении для этого файла. */
  toggleFormatter?: () => void;
  /** Показать/спрятать код-линзы для этого файла. */
  toggleLenses?: () => void;
  /**
   * Нажатие на полосу долгой работы: прервать её. Доступно, только когда полоса
   * говорит `cancellable` — молчаливый клик по «просто показателю» обманывает.
   */
  cancelWork: () => void;
  /** Клик по чипу языкового сервера — попап со списком серверов и действиями. */
  openLsp(anchor: HTMLElement): void;
  /**
   * Выполнить команду по клику на слот статус-бара.
   *
   * Слот, у которого есть действие, должен им пользоваться: полоса из одних
   * подписей — это справка, а не орган управления.
   */
  runCommand(id: string, anchor: HTMLElement): void;
  /**
   * Клик по кодировке, отступам или языку — выбор из списка у кнопки.
   *
   * Отдельный канал, а не `runCommand`: варианты приходят не из реестра команд, а
   * из состояния документа (её кодировка, её отступ, язык по расширению), и
   * рисовать их должен тот же попап, что у остальных списков окна.
   */
  openChoice(kind: StatusChoiceKind, anchor: HTMLElement): void;
}

/** Что именно выбираем кликом по слоту. */
export type StatusChoiceKind = 'encoding' | 'indent' | 'language';

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
    eol: null,
    whitespace: null,
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
    highlightOff: null,
    formatter: null,
    lenses: null,
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
  // Слоты с действием — кнопки, без действия — текст. Так полоса не обещает
  // клика там, где его нет: кодировку пока менять нечем (команды нет), и слот
  // честно остаётся подписью.
  const positionItem = h('button', {
    class: 'status-item',
    type: 'button',
    title: 'Перейти к строке (Ctrl+G)',
    onClick: (event: Event) => deps.runCommand('editor.gotoLine', event.currentTarget as HTMLElement),
  });
  // Редкие чипы живут свёрнутыми в «…» (см. `sparseItem` ниже): EOL, кодировка,
  // отступы, невидимые символы и read-only меняются раз в правку, а место в
  // строке занимали каждый день.
  //
  // Конец строк переключается существующей командой; какой сейчас — решает
  // состояние, поэтому клик зовёт ту, которая НЕ текущая.
  const eolItem = h('button', {
    class: 'status-item',
    type: 'button',
    onClick: (event: Event) =>
      deps.runCommand(
        state.eol === 'CRLF' ? 'format.lineEnding.lf' : 'format.lineEnding.crlf',
        event.currentTarget as HTMLElement,
      ),
  });
  const encodingItem = h('button', {
    class: 'status-item',
    type: 'button',
    title: 'Выбрать кодировку',
    onClick: (event: Event) => deps.openChoice('encoding', event.currentTarget as HTMLElement),
  });
  const indentItem = h('button', {
    class: 'status-item',
    type: 'button',
    title: 'Выбрать отступы',
    onClick: (event: Event) => deps.openChoice('indent', event.currentTarget as HTMLElement),
  });
  // Невидимые символы: одна кнопка листает три положения (нет → хвостовые → все).
  // Три положения в чипе, а не три пункта меню: сюда заглядывают на секунду.
  const whitespaceItem = h('button', {
    class: 'status-item',
    type: 'button',
    onClick: (event: Event) =>
      deps.runCommand('editor.cycleWhitespace', event.currentTarget as HTMLElement),
  });
  const languageItem = h('button', {
    class: 'status-item',
    type: 'button',
    title: 'Сменить язык файла',
    onClick: (event: Event) => deps.openChoice('language', event.currentTarget as HTMLElement),
  });
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
  // Одна полоса на все долгие работы окна: языковый сервер, чтение проекта, проверка
  // проекта. Раньше их было три, и две обычно стояли на нуле, дожидаясь первой —
  // рядом это читалось как зависание. Очередь решает чистый модуль: `ui/status-meter.ts`.
  // Долгая работа: роль «прогресс» нужна, чтобы читалка говорила «сколько прошло»,
  // а не читала подпись как обычный текст. `aria-valuenow` обновляет `update`:
  // у бегущей без процента работы значения нет — тогда она `busy` без числа.
  const meterItem = h(
    'span',
    { class: 'status-item status-meter is-metered', role: 'progressbar', 'aria-live': 'polite' },
    h(
      'span',
      { class: 'status-meter-track' },
      h('span', { class: 'status-meter-fill' }),
      h('span', { class: 'status-meter-run' }),
    ),
    h('span', { class: 'status-meter-label' }),
  );
  const meterFill = meterItem.querySelector<HTMLElement>('.status-meter-fill')!;
  const meterLabel = meterItem.querySelector<HTMLElement>('.status-meter-label')!;
  meterItem.onclick = (event) => {
    // Прерываем только когда это правда можно: иначе клик по показателю выглядел бы
    // кнопкой, которая ничего не делает. Признак приходит из состояния (`cancellable`).
    if (!meterItem.classList.contains('is-cancellable')) return;
    // Нажатие на саму полосу не должно утекать в разметку вокруг.
    event.stopPropagation();
    deps.cancelWork();
  };
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

  /**
   * Профиль форматирования файла: чем он будет отформатирован при сохранении.
   *
   * Зачем в строке состояния: «почему файл переформатировался не тем» — вопрос,
   * который задают уже после. Клик переключает между «как настроено» и
   * «не форматировать»: это два состояния, между которыми человек и мечется.
   */
  const formatterItem = h('button', {
    class: 'status-item status-formatter',
    type: 'button',
    hidden: true,
    title: 'Профиль форматирования — клик: вкл/выкл для этого файла',
    onClick: () => deps.toggleFormatter?.(),
  });

  /**
   * Линзы: одним щелчком спрятать подписи-действия над объявлениями, не уходя
   * в настройки. Показываем только когда линзы есть — иначе чип про пустоту.
   */
  const lensItem = h('button', {
    class: 'status-item status-lenses',
    type: 'button',
    hidden: true,
    title: 'Код-линзы — клик: показать/скрыть',
    onClick: () => deps.toggleLenses?.(),
  });
  // Подсветка выключена из-за размера файла. Нарочно КЛИКАБЕЛЬНЫЙ: сказать «почему
  // её нет» мало — человек пришёл читать код, и ему нужен выход (``включить всё равно``).
  const highlightItem = h('button', {
    class: 'status-item status-no-highlight',
    type: 'button',
  });
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
  // «…» — ящик для редкого. Пять чипов (EOL, кодировка, отступы, невидимые
  // символы, read-only) меняются раз в правку, но место в полосе держали каждый
  // день. Свёрнуты в одну кнопку, а раскрытые стоят на своих местах: ничего не
  // пропало, просто не кричит. Кнопка одна и не растёт: сколько бы чипов ни
  // добавилось, ширина строки от этого не шевелится.
  const sparseSlot = h('span', { class: 'status-sparse-slot', hidden: true });
  const sparseItem = h(
    'button',
    {
      class: 'status-item status-sparse',
      type: 'button',
      title: 'Ещё состояние файла: концы строк, кодировка, отступы',
      'aria-label': 'Ещё состояние файла',
      'aria-expanded': 'false',
      // Клик раскрывает редкие чипы рядом с кнопкой, а не открывает меню: у EOL,
      // отступов и кодировки свои попапы, и второй слой меню над ними не нужен.
      onClick: () => toggleSparse(),
    },
    '…',
  );

  /** Раскрыть или свернуть редкие чипы. */
  function toggleSparse(): void {
    const open = sparseSlot.hidden;
    sparseSlot.hidden = !open;
    sparseItem.setAttribute('aria-expanded', String(open));
  }

  // Редкие чипы живут в слоте с самого начала: показать их — это снять `hidden`
  // с обёртки, а не собирать дом заново. Раскрытые стоят на своих местах.
  sparseSlot.append(eolItem, whitespaceItem, encodingItem, indentItem, readOnlyItem);

  const element = h(
    'div',
    // Полоса — это набор действий одной строкой. Без роли читалка видела набор кнопок
    // в общем потоке страницы и не говорила, что это *всё* управление окном после
    // редактора. `aria-label` даёт им общее имя, а `aria-keyshortcuts` внизу — клавиши.
    { class: 'statusbar', role: 'toolbar', 'aria-label': 'Состояние и действия окна' },
    h('div', { class: 'status-group', role: 'presentation' }, gitItem, fileSlot),
    h(
      'div',
      { class: 'status-group', role: 'presentation' },
      vimItem,
      formatterItem,
      lensItem,
      highlightItem,
      meterItem,
      macroItem,
      problemsItem,
      versionItem,
      positionItem,
      languageItem,
      lspItem,
      sparseItem,
      sparseSlot,
      // Окружение — прямо перед кнопкой «Информация о сессии»: так она стоит
      // крайней справа, а чип интерпретатора — слева от неё.
      envItem,
      chatSlot,
    ),
  );

  const render = (): void => {
    positionItem.textContent = `${state.line}:${state.column}`;
    // Курсор читается как «12:3» — читалке нужны слова, и с толком: вместе с именем
    // файла строка/столбец — это «где я стою».
    positionItem.setAttribute('aria-label', `Строка ${state.line}, столбец ${state.column}`);
    encodingItem.setAttribute('aria-label', `Кодировка: ${state.encoding}`);
    // У картинки и документа Office концов строк нет — виджет не показываем,
    // иначе человек читает «LF» у PNG.
    eolItem.hidden = state.eol === null;
    eolItem.textContent = state.eol ?? '';
    eolItem.title = state.eol === null ? '' : `Концы строк: ${state.eol}`;
    // Имя — словами, а не «LF»: кнопка без имени читается как текст на ней.
    eolItem.setAttribute(
      'aria-label',
      state.eol === null ? 'Концы строк' : `Концы строк: ${state.eol}. Выбрать`,
    );
    encodingItem.textContent = state.encoding;
    // Невидимые: три положения в одном чипе — пиктограмма и текущее словами.
    // У картинок и документов пробелов нет: чип скрыт, как и концы строк.
    whitespaceItem.hidden = state.whitespace === null;
    if (state.whitespace !== null) {
      whitespaceItem.textContent = WHITESPACE_LABELS[state.whitespace];
      whitespaceItem.classList.toggle('is-on', state.whitespace !== 'none');
      whitespaceItem.title =
        state.whitespace === 'none'
          ? 'Невидимые символы скрыты. Показать все'
          : state.whitespace === 'trailing'
            ? 'Показаны только хвостовые пробелы. Показать все'
            : 'Показаны все невидимые символы. Скрыть';
      whitespaceItem.setAttribute('aria-label', `${whitespaceItem.title}`);
    }
    // Буква вместо слова: «2 пробела» против «2 с» — пять символов на каждое
    // нажатие, а смысл несёт подсказка (`aria-label` ниже говорит словами).
    indentItem.textContent = state.useTabs ? `таб ${state.tabSize}` : `${state.tabSize} с`;
    indentItem.setAttribute(
      'aria-label',
      state.useTabs
        ? `Отступы: табуляция, ${state.tabSize}. Выбрать`
        : `Отступы: ${state.tabSize} пробела. Выбрать`,
    );
    languageItem.textContent = state.language ?? '—';
    languageItem.setAttribute('aria-label', `Язык: ${state.language ?? 'не определён'}. Сменить`);
    const lsp = state.lsp;
    lspItem.hidden = lsp === null;
    lspItem.classList.toggle('is-failed', Boolean(lsp?.failed));
    if (lsp) {
      // В полосе — только имя сервера. Слово «нет сервера» было длиннее самого
      // имени и повторяло цвет `is-failed`; подробности ждут в подсказке.
      lspLabel.textContent = lsp.label;
      lspItem.title = lsp.failed
        ? `Языковой сервер для «${lsp.language}» не поднялся: ${lsp.failed}`
        : `Языковой сервер: ${lsp.label} (${lsp.origin ? lspOriginLabel(lsp.origin) : 'источник неизвестен'})`;
    }
    const meter = statusMeter(state);
    meterItem.hidden = meter.hidden;
    meterItem.classList.toggle('is-busy', meter.busy);
    meterLabel.textContent = meter.label;
    meterFill.style.width = `${Math.round(meter.fill * 100)}%`;
    // Число для читалки — только когда его правда есть: у бегущей без процента
    // работы значения нет, и атрибут уходит — иначе полоса обещает проценты,
    // которых мы не знаем. Пустая подпись тоже не годится: `aria-valuetext`
    // заменяет чтение числа, и пустой строкой читалка замолчала бы совсем.
    const percent = Math.round(meter.fill * 100);
    const known = !(meter.busy && meter.fill === 0);
    meterItem.setAttribute('aria-valuemin', '0');
    meterItem.setAttribute('aria-valuemax', '100');
    if (!meter.hidden && known) meterItem.setAttribute('aria-valuenow', String(percent));
    else meterItem.removeAttribute('aria-valuenow');
    if (!meter.hidden && meter.label) meterItem.setAttribute('aria-valuetext', meter.label);
    else meterItem.removeAttribute('aria-valuetext');
    meterItem.classList.toggle('is-cancellable', meter.cancellable === true);
    meterItem.title = meter.cancellable ? `${meter.title} — нажмите, чтобы прервать` : meter.title;
    const macro = state.macro;
    macroItem.hidden = macro === null;
    macroCount.textContent = macro ? `МАКРО ${macro.steps}` : '';
    macroItem.title = macro ? `Идёт запись макроса: действий ${macro.steps}` : '';
    // Режим Vim: короткое слово. Показывается, когда режим включён.
    const vim = state.vim;
    vimItem.hidden = vim === null;
    vimItem.textContent = vim ? VIM_LABEL[vim] : '';
    vimItem.title = vim ? `Vim: ${VIM_TITLE[vim]}` : '';

    // Подсветка выключена размером — говорим почему и даём выход. Текст короткий:
    // место в полосе дорогое, а причина — в подсказке.
    // Профиль форматирования: видно, КТО это сделает и выключено ли. Пусто —
    // форматировать нечем, и чип молчит, а не показывает прочерк.
    const formatter = state.formatter;
    formatterItem.hidden = formatter === null;
    if (formatter) {
      // «(выкл)» ушло в подсказку: у чипа с форматтером есть цвет `is-off`,
      // а слово занимало в полосе место дороже, чем давало.
      formatterItem.textContent = `\u269b ${formatter.name}`;
      formatterItem.title = formatter.off
        ? `Профиль форматирования ${formatter.name} — выключен для этого файла. Клик: вкл/выкл`
        : `Профиль форматирования ${formatter.name}. Клик: вкл/выкл для этого файла`;
      formatterItem.classList.toggle('is-off', formatter.off);
    }

    const lenses = state.lenses;
    lensItem.hidden = lenses === null;
    if (lenses) {
      // Выключенное состояние видно цветом: слово в скобках забирало ровно
      // столько же места, сколько сам чип.
      lensItem.textContent = '\u276f линзы';
      lensItem.title = lenses.on ? 'Код-линзы показаны. Клик: скрыть' : 'Код-линзы скрыты. Клик: показать';
      lensItem.classList.toggle('is-off', !lenses.on);
    }

    const off = state.highlightOff;
    highlightItem.hidden = off === null;
    if (off) {
      const chip = highlightOffChip(off);
      highlightItem.textContent = chip.label;
      highlightItem.title = chip.title;
      highlightItem.onclick = () => deps.forceHighlight();
    }
    readOnlyItem.textContent = state.readOnly ? 'Только чтение' : '';
    readOnlyItem.hidden = !state.readOnly;
    readOnlyItem.title = state.readOnly ? 'Файл слишком большой для правки — открыт только для чтения' : '';
    // Пустой чип — это кнопка без подписи и без имени: убираем её совсем, а не
    // оставляем невидимую кнопку в порядке обхода.
    envItem.textContent = state.env ?? '';
    envItem.hidden = !state.env;
    envItem.title = state.env
      ? state.projectKindId === 'node'
        ? `Node-окружение: ${state.env}`
        : `Python-окружение: ${state.env}`
      : '';
    // Имя окна окружения — словами: чип «.venv» или «node» без них читается как аббревиатура,
    // а кнопка без имени хуже ссылки.
    envItem.setAttribute(
      'aria-label',
      state.env
        ? state.projectKindId === 'node'
          ? `Node-окружение: ${state.env}. Выбрать`
          : `Python-окружение: ${state.env}. Выбрать`
        : 'Окружение проекта не найдено. Выбрать',
    );
    versionItem.textContent = state.version ? `v${state.version}` : '';
    // Версия — тоже кнопка: без имени из «v20.11» читалка не поймёт, что это язык проекта.
    versionItem.setAttribute(
      'aria-label',
      state.version ? `Версия: ${state.version}. Выбрать` : 'Версия не известна',
    );
    // Вид виджета решает чистый модуль: ноль — не всегда «чисто» (правила там).
    const problems = problemsWidget(state.problems);
    problemsItem.hidden = problems.hidden;
    problemsItem.classList.toggle('is-checking', problems.tone === 'checking');
    problemsItem.classList.toggle('is-unchecked', problems.tone === 'unchecked');
    problemsItem.classList.toggle('has-errors', problems.tone === 'errors');
    problemsItem.classList.toggle('has-warnings', problems.tone === 'warnings');
    problemsCounts.textContent = problems.text;
    problemsItem.title = problems.title;
    // Сводка проблем цифрами без слов не читается — имя берём у того же виджета.
    problemsItem.setAttribute('aria-label', `Проблемы: ${problems.title}`);
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
