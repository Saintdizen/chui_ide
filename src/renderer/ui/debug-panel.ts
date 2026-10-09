import type { DebugFrame, DebugScope, DebugVariable } from '../../shared/api';
import type { DebugController, DebugState } from '../core/debug';
import { clear, h } from './dom';

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
}

export interface DebugPanelView {
  element: HTMLElement;
  /** Перерисовать по текущему состоянию (панель открыли заново). */
  refresh(): void;
  focus(): void;
}

/** Что показывает панель, когда отладка не идёт. */
const IDLE_HINT = 'Отладка не запущена. Точка останова — клик по полю номеров строк (или F9), запуск — F5.';

export function createDebugPanel(deps: DebugPanelDeps): DebugPanelView {
  const toolbar = h('div', { class: 'debug-toolbar' });
  const body = h('div', { class: 'debug-body' });
  const element = h('div', { class: 'debug-panel' }, toolbar, body);

  /** Кадр, для которого показаны переменные; по умолчанию — верхний. */
  let selectedFrameId: number | null = null;
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

  /** Строка переменной: имя, значение и раскрытие, если у значения есть дети. */
  function variableRow(variable: DebugVariable, depth: number): HTMLElement {
    const hasChildren = variable.variablesReference > 0;
    const isOpen = expanded.has(variable.variablesReference);
    const toggle = h(
      'span',
      { class: `debug-toggle${hasChildren ? ' is-active' : ''}` },
      hasChildren ? (isOpen ? '▾' : '▸') : '',
    );
    const row = h(
      'div',
      { class: 'debug-row', style: { paddingLeft: `${depth * 14 + 6}px` } },
      toggle,
      h('span', { class: 'debug-var-name' }, variable.name),
      h('span', { class: 'debug-var-value' }, variable.value),
      variable.type ? h('span', { class: 'debug-var-type' }, variable.type) : null,
    );

    if (hasChildren) {
      row.addEventListener('click', () => void toggleReference(variable.variablesReference));
    }
    return row;
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

  function variableTree(variables: readonly DebugVariable[], depth: number): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    for (const variable of variables) {
      nodes.push(variableRow(variable, depth));
      if (expanded.has(variable.variablesReference)) {
        const children = loadedVariables.get(variable.variablesReference) ?? [];
        nodes.push(...variableTree(children, depth + 1));
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
      else for (const node of variableTree(values, 1)) box.appendChild(node);
    }
    body.appendChild(h('section', { class: 'debug-section' }, h('h3', { class: 'debug-heading' }, 'Переменные'), box));
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
      if (topId !== null) void loadScopes(topId).then(() => render(stateSnapshot));
    }

    renderStack(state);
    if (state.phase === 'stopped') renderVariables();
    else body.appendChild(h('div', { class: 'debug-empty' }, 'Программа выполняется…'));
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
  };
}
