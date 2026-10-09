import type { DebugFrame, DebugScope, DebugVariable } from '../../shared/api';
import type { DebugController, DebugState } from '../core/debug';
import { clear, h } from './dom';
import { showToast } from './toast';

/**
 * Панель отладки: управление сессией, стек вызовов и переменные.
 *
 * Сессия живёт в main, сюда приходят только её состояние и события. Панель не
 * хранит правду о процессе: фазу, стек и переменные берёт из контроллера (main
 * их прислал), а сама лишь рисует и просит действия — продолжить, шагнуть, стоп.
 *
 * Переменные грузятся лениво: у остановки виден только стек, а значения читаются
 * при раскрытии — большие коллекции иначе тянулись бы целиком на каждый шаг.
 */

export interface DebugPanelDeps {
  debug: DebugController;
  /** Кадр выбрали — показать его в редакторе и поставить там курсор. */
  onRevealFrame: (frame: DebugFrame) => void;
  /** Наблюдение изменилось — рабочее место стоит сохранить. */
  onWatchChange?: () => void;
  /** Спросить у человека новое значение; `null` — отменили ввод. */
  promptValue?: (input: { title: string; label: string; value: string }) => Promise<string | null>;
}

export interface DebugPanelView {
  element: HTMLElement;
  /** Перерисовать по текущему состоянию (панель открыли заново). */
  refresh(): void;
  focus(): void;
  /** Наблюдаемые выражения: рабочее место помнит их между запусками проекта. */
  getWatch(): string[];
  /** Задать выражения из сессии проекта. */
  setWatch(expressions: readonly string[]): void;
}

/** Что показывает панель, когда отладка не идёт. */
const IDLE_HINT = 'Отладка не запущена. Точка останова — клик по полю номеров строк (или F9), запуск — F5.';

export function createDebugPanel(deps: DebugPanelDeps): DebugPanelView {
  const toolbar = h('div', { class: 'debug-toolbar' });
  const body = h('div', { class: 'debug-body' });
  const element = h('div', { class: 'debug-panel' }, toolbar, body);

  /** Кадр, для которого показаны переменные; по умолчанию — верхний. */
  let selectedFrameId: number | null = null;
  /** Наблюдаемые выражения и их последние значения. Живут, пока открыта панель. */
  let watchExpressions: string[] = [];
  const watchValues = new Map<string, DebugVariable>();
  /** Раскрытые узлы переменных и их загруженные дети: ссылка → значения. */
  const loadedVariables = new Map<number, DebugVariable[]>();
  const expanded = new Set<number>();
  /** Загруженные области выбранного кадра. */
  let scopes: DebugScope[] = [];
  let scopesForFrame: number | null = null;

  function control(label: string, title: string, enabled: boolean, onClick: () => void): HTMLElement {
    return h(
      'button',
      { class: 'btn btn-small', type: 'button', title, disabled: !enabled, onClick: () => onClick() },
      label,
    );
  }

  function renderToolbar(state: DebugState): void {
    clear(toolbar);
    const stopped = state.phase === 'stopped';
    const active = state.phase === 'stopped' || state.phase === 'running';
    toolbar.append(
      control('Продолжить', 'Продолжить выполнение (F5)', stopped, () => void deps.debug.resume()),
      control('Шаг', 'Шаг с обходом (F10)', stopped, () => void deps.debug.step('over')),
      control('Заход', 'Шаг с заходом (F11)', stopped, () => void deps.debug.step('into')),
      control('Выход', 'Шаг из функции (Shift+F11)', stopped, () => void deps.debug.step('out')),
      control('Пауза', 'Остановить выполнение', state.phase === 'running', () => void deps.debug.pause()),
      control('Стоп', 'Завершить отладку (Shift+F5)', active, () => void deps.debug.stop()),
    );
  }

  /**
   * Строка переменной: имя, значение и раскрытие, если у значения есть дети.
   * `reference` — контейнер, в котором лежит переменная: по нему её и правят
   * (`setVariable`), потому что DAP адресует значение парой «контейнер + имя».
   */
  function variableRow(variable: DebugVariable, depth: number, reference: number): HTMLElement {
    const hasChildren = variable.variablesReference > 0;
    const isOpen = expanded.has(variable.variablesReference);
    const toggle = h(
      'span',
      { class: `debug-toggle${hasChildren ? ' is-active' : ''}` },
      hasChildren ? (isOpen ? '▾' : '▸') : '',
    );
    const row = h(
      'div',
      {
        class: 'debug-row',
        style: { paddingLeft: `${depth * 14 + 6}px` },
        title: 'Двойной клик — изменить значение',
      },
      toggle,
      h('span', { class: 'debug-var-name' }, variable.name),
      // Значение показываем отдельным элементом с подсказкой: длинные строки
      // обрезаются многоточием, и при наведении видно их целиком.
      h(
        'span',
        { class: 'debug-var-value', title: `${variable.name} = ${variable.value}` },
        variable.value,
      ),
      variable.type ? h('span', { class: 'debug-var-type' }, variable.type) : null,
    );

    if (hasChildren) {
      row.addEventListener('click', () => void toggleReference(variable.variablesReference));
    }
    if (deps.promptValue) {
      row.addEventListener('dblclick', () => void editVariable(reference, variable));
    }
    return row;
  }

  /**
   * Правка значения переменной прямо в панели. Отладчик может привести значение
   * к типу, поэтому строку обновляем тем, что он вернул, а не тем, что ввели.
   */
  async function editVariable(reference: number, variable: DebugVariable): Promise<void> {
    const prompt = deps.promptValue;
    if (!prompt) return;
    const next = await prompt({ title: 'Изменить значение', label: variable.name, value: variable.value });
    if (next === null) return;

    const result = await deps.debug.setVariable(reference, variable.name, next);
    if (!result) {
      showToast(`Не удалось изменить ${variable.name}`, 'error');
      return;
    }
    const list = loadedVariables.get(reference);
    if (list) {
      loadedVariables.set(reference, list.map((item) => (item.name === variable.name ? result : item)));
    }
    render(stateSnapshot);
  }

  /** Раскрыть или свернуть узел: значения грузятся один раз и запоминаются. */
  async function toggleReference(reference: number): Promise<void> {
    if (expanded.has(reference)) {
      expanded.delete(reference);
      render(stateSnapshot);
      return;
    }
    expanded.add(reference);
    if (!loadedVariables.has(reference)) {
      loadedVariables.set(reference, await deps.debug.variables(reference));
    }
    render(stateSnapshot);
  }

  function variableTree(variables: readonly DebugVariable[], depth: number, reference: number): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    for (const variable of variables) {
      nodes.push(variableRow(variable, depth, reference));
      if (expanded.has(variable.variablesReference)) {
        const children = loadedVariables.get(variable.variablesReference) ?? [];
        // Дети лежат в контейнере самой переменной — он и есть их reference.
        nodes.push(...variableTree(children, depth + 1, variable.variablesReference));
      }
    }
    return nodes;
  }

  function renderStack(state: DebugState): void {
    const list = h('div', { class: 'debug-list' });
    if (state.frames.length === 0) {
      list.appendChild(h('div', { class: 'debug-empty' }, 'Стек пуст.'));
    }
    for (const frame of state.frames) {
      const active = frame.id === selectedFrameId;
      const row = h(
        'div',
        { class: `debug-frame${active ? ' is-active' : ''}`, title: frame.path ?? '' },
        h('span', { class: 'debug-frame-name' }, frame.name),
        h('span', { class: 'debug-frame-line' }, `${frame.path ? frame.path.split(/[/\\]/).pop() : '?'}:${frame.line}`),
      );
      row.addEventListener('click', () => void selectFrame(frame));
      list.appendChild(row);
    }
    body.appendChild(h('section', { class: 'debug-section' }, h('h3', { class: 'debug-heading' }, 'Стек вызовов'), list));
  }

  /** Выбрать кадр: показать его в редакторе и перечитать переменные именно его. */
  async function selectFrame(frame: DebugFrame): Promise<void> {
    selectedFrameId = frame.id;
    deps.onRevealFrame(frame);
    await loadScopes(frame.id);
    render(stateSnapshot);
  }

  async function loadScopes(frameId: number): Promise<void> {
    scopes = await deps.debug.scopes(frameId);
    scopesForFrame = frameId;
    loadedVariables.clear();
    expanded.clear();
    // Значения верхнего уровня грузим сразу: ради них панель и открывают.
    for (const scope of scopes) {
      if (scope.variablesReference > 0) loadedVariables.set(scope.variablesReference, await deps.debug.variables(scope.variablesReference));
    }
  }

  function renderVariables(): void {
    const box = h('div', { class: 'debug-list' });
    if (scopesForFrame === null) {
      box.appendChild(h('div', { class: 'debug-empty' }, 'Переменных нет.'));
    }
    for (const scope of scopes) {
      box.appendChild(h('div', { class: 'debug-scope' }, scope.name));
      const values = loadedVariables.get(scope.variablesReference) ?? [];
      if (values.length === 0) box.appendChild(h('div', { class: 'debug-empty' }, '—'));
      else for (const node of variableTree(values, 1, scope.variablesReference)) box.appendChild(node);
    }
    body.appendChild(h('section', { class: 'debug-section' }, h('h3', { class: 'debug-heading' }, 'Переменные'), box));
  }

  /**
   * Наблюдение: выражения, которые человек вводит сам (`n * 2`, `len(items)`).
   * Значения пересчитываются на каждом останове в контексте верхнего кадра,
   * а сами выражения живут в панели, пока её не закрыли.
   */
  function renderWatch(): void {
    const list = h('div', { class: 'debug-list' });

    for (const expression of watchExpressions) {
      const result = watchValues.get(expression);
      const row = h(
        'div',
        { class: 'debug-row', title: 'Двойной клик — изменить значение' },
        h('span', { class: 'debug-var-name' }, expression),
        h(
          'span',
          { class: 'debug-var-value', title: result ? `${expression} = ${result.value}` : expression },
          result ? result.value : '…',
        ),
        result?.type ? h('span', { class: 'debug-var-type' }, result.type) : null,
        h(
          'button',
          {
            class: 'icon-btn debug-watch-remove',
            type: 'button',
            title: 'Убрать из наблюдения',
            onClick: (event: Event) => {
              event.stopPropagation();
              removeWatch(expression);
            },
          },
          '×',
        ),
      );
      // Двойной клик правит значение выражения (`setExpression`): «убрать» переехало
      // на кнопку, иначе одиночный клик гасил бы строку до двойного.
      if (deps.promptValue) row.addEventListener('dblclick', () => void editWatch(expression));
      list.appendChild(row);
    }

    if (watchExpressions.length === 0) {
      const hint = stateSnapshot.phase === 'stopped' ? 'Выражений нет.' : 'Выражения посчитаются на останове.';
      list.appendChild(h('div', { class: 'debug-empty' }, hint));
    }

    // Поле ввода: Enter добавляет выражение и сразу считает его.
    const input = h('input', {
      class: 'field-input debug-watch-input',
      type: 'text',
      placeholder: 'выражение, например len(items)',
      spellcheck: 'false',
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const expression = input.value.trim();
      if (!expression || watchExpressions.includes(expression)) return;
      input.value = '';
      watchExpressions.push(expression);
      deps.onWatchChange?.();
      void evaluateWatch().then(() => render(stateSnapshot));
    });

    body.appendChild(
      h('section', { class: 'debug-section' }, h('h3', { class: 'debug-heading' }, 'Наблюдение'), list, input),
    );
  }

  /** Убрать выражение из наблюдения. */
  function removeWatch(expression: string): void {
    watchExpressions = watchExpressions.filter((item) => item !== expression);
    watchValues.delete(expression);
    deps.onWatchChange?.();
    render(stateSnapshot);
  }

  /**
   * Правка значения наблюдаемого выражения (`setExpression`). В отличие от правки
   * переменной, тут человек задаёт любое выражение (`items[0]`, `config.debug`),
   * которое в дереве переменных отдельной строкой не показано.
   */
  async function editWatch(expression: string): Promise<void> {
    const prompt = deps.promptValue;
    if (!prompt) return;
    const current = watchValues.get(expression);
    const next = await prompt({ title: 'Изменить значение', label: expression, value: current?.value ?? '' });
    if (next === null) return;

    const frameId = selectedFrameId ?? stateSnapshot.topFrame?.id;
    if (frameId === undefined || frameId === null) {
      showToast('Значение меняют на останове', 'error');
      return;
    }
    const result = await deps.debug.setExpression(expression, next, frameId);
    if (!result) {
      showToast(`Не удалось изменить ${expression}`, 'error');
      return;
    }
    watchValues.set(expression, result);
    render(stateSnapshot);
  }

  /** Пересчитать все наблюдаемые выражения в контексте выбранного кадра. */
  async function evaluateWatch(): Promise<void> {
    // В контексте кадра считать можно только на останове: пока программа идёт,
    // вычислять нечего, и «нет остановленной программы» вместо значения было бы
    // шумом — оставляем заглушку до первого останова.
    const frameId = selectedFrameId ?? stateSnapshot.topFrame?.id;
    if (stateSnapshot.phase !== 'stopped' || frameId === undefined || frameId === null) return;

    for (const expression of watchExpressions) {
      watchValues.set(expression, await deps.debug.evaluate(expression, frameId));
    }
  }

  /** Последнее отрисованное состояние: обработчики кликов перерисовывают по нему. */
  let stateSnapshot: DebugState = { phase: 'idle', reason: null, frames: [], topFrame: null };

  function render(state: DebugState): void {
    stateSnapshot = state;
    clear(body);
    renderToolbar(state);

    if (state.phase === 'idle') {
      body.appendChild(h('div', { class: 'debug-empty debug-idle' }, IDLE_HINT));
      return;
    }

    // Сменился останов — выбираем верхний кадр и грузим его переменные.
    const topId = state.topFrame?.id ?? null;
    if (state.phase === 'stopped' && topId !== selectedFrameId) {
      selectedFrameId = topId;
      if (topId !== null) {
        void loadScopes(topId)
          // Наблюдаемые выражения считаем в том же кадре: иначе они смотрели бы
          // на другой фрейм, чем переменные, и значения расходились бы.
          .then(() => evaluateWatch())
          .then(() => render(stateSnapshot));
      }
    }

    renderStack(state);
    if (state.phase === 'stopped') renderVariables();
    else body.appendChild(h('div', { class: 'debug-empty' }, 'Программа выполняется…'));

    // Наблюдение показываем и пока программа идёт: выражения удобно заготовить
    // заранее — они посчитаются на ближайшем останове. Без сессии раздел не нужен.
    renderWatch();
  }

  deps.debug.onDidChange(render);
  render(deps.debug.get());

  return {
    element,
    refresh: () => {
      selectedFrameId = null;
      scopesForFrame = null;
      scopes = [];
      loadedVariables.clear();
      expanded.clear();
      render(deps.debug.get());
    },
    focus: () => void 0,
    getWatch: () => [...watchExpressions],
    setWatch: (expressions) => {
      // Значения не переносим: выражения из сессии ещё не считались в этой сессии
      // отладки — они посчитаются на ближайшем останове.
      watchExpressions = [...new Set(expressions)];
      watchValues.clear();
      render(stateSnapshot);
    },
  };
}
