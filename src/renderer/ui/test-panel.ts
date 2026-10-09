import { buildTestTree, type CollectedSuite, type TestFolder } from '../../shared/python-tests';
import type { RpcClient } from '../core/rpc';
import { clear, h } from './dom';

/**
 * Панель тестов: дерево собранных тестов и запуск любого узла.
 *
 * Тестов может быть сотни, и плоский список из них бесполезен — человек ищет по
 * файлу и классу. Поэтому дерево файл → класс → тест, а запуск — по любому узлу:
 * отдельный тест, класс целиком или файл. Сбор идёт через main (`python.tests`),
 * а запуск — обычной командой в терминале: тесты должны быть видны и прерываемы.
 *
 * Пересобираем при открытии и по кнопке: список меняется, когда правят код,
 * и держать его актуальным в фоне дороже, чем спросить заново.
 */

export interface TestPanelDeps {
  rpc: RpcClient;
  /** Проект не открыт — собирать нечего. */
  root: () => string | null;
  /** Запустить тесты: селектор pytest или null — все. */
  onRun: (selector: string | null) => void;
}

export interface TestPanelView {
  element: HTMLElement;
  /** Пересобрать список тестов; вызывается при открытии панели. */
  refresh(): Promise<void>;
  focus(): void;
}

export function createTestPanel(deps: TestPanelDeps): TestPanelView {
  const summary = h('span', { class: 'tests-summary' });
  const refreshButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Пересобрать список', onClick: () => void refresh() },
    '⟳',
  );
  const runAllButton = h(
    'button',
    { class: 'btn btn-small', type: 'button', title: 'Запустить все тесты', onClick: () => deps.onRun(null) },
    'Запустить все',
  );

  const body = h('div', { class: 'tests-body' });
  const element = h(
    'div',
    { class: 'tests-panel' },
    h('div', { class: 'tests-toolbar' }, summary, h('div', { class: 'toolbar-spacer' }), runAllButton, refreshButton),
    body,
  );

  let loading = false;
  let suite: CollectedSuite | null = null;

  /** Кнопка запуска узла: клик по ней не должен сворачивать ветку. */
  function runButton(node: TestFolder): HTMLElement {
    return h(
      'button',
      {
        class: 'tests-run',
        type: 'button',
        title: 'Запустить это',
        onClick: (event: Event) => {
          event.stopPropagation();
          deps.onRun(node.id ?? null);
        },
      },
      '▶',
    );
  }

  /** Строка узла: отступ по глубине, стрелка, подпись и кнопка запуска. */
  function row(node: TestFolder, depth: number, arrow: string): { head: HTMLElement; marker: HTMLElement } {
    const marker = h('span', { class: `tests-arrow${arrow ? ' is-toggle' : ''}` }, arrow);
    const head = h(
      'div',
      { class: `tests-row tests-${node.kind}`, style: { paddingLeft: `${depth * 14 + 8}px` } },
      marker,
      h('span', { class: 'tests-label' }, node.label),
      runButton(node),
    );
    return { head, marker };
  }

  /** Тест — лист: сворачивать нечего. */
  function leaf(node: TestFolder, depth: number): HTMLElement {
    return row(node, depth, '').head;
  }

  /** Файл или класс: раскрыт сразу — список тестов читают глазами, а не сворачивают. */
  function branch(node: TestFolder, depth: number): HTMLElement {
    const children = h('div', { class: 'tests-children' });
    for (const child of node.children) {
      children.appendChild(child.kind === 'test' ? leaf(child, depth + 1) : branch(child, depth + 1));
    }

    const { head, marker } = row(node, depth, '▾');
    let expanded = true;
    head.addEventListener('click', () => {
      expanded = !expanded;
      children.hidden = !expanded;
      marker.textContent = expanded ? '▾' : '▸';
    });

    return h('div', { class: 'tests-node' }, head, children);
  }

  function renderErrors(errors: readonly string[]): void {
    const box = h('div', { class: 'tests-errors' }, h('div', { class: 'tests-error-title' }, 'Сбор не удался'));
    for (const line of errors) box.appendChild(h('div', { class: 'tests-error-line' }, line));
    body.appendChild(box);
  }

  function render(): void {
    clear(body);

    if (loading) {
      summary.textContent = 'Собираю…';
      body.appendChild(h('div', { class: 'tests-empty' }, 'Ищу тесты…'));
      return;
    }

    if (!suite) {
      summary.textContent = '';
      body.appendChild(h('div', { class: 'tests-empty' }, 'Проект не открыт.'));
      return;
    }

    if (suite.tests.length === 0) {
      summary.textContent = 'Тестов не найдено';
      if (suite.errors.length > 0) renderErrors(suite.errors);
      else body.appendChild(h('div', { class: 'tests-empty' }, 'pytest не нашёл тестов в этом проекте.'));
      return;
    }

    summary.textContent = `Тестов: ${suite.total}`;
    if (suite.errors.length > 0) renderErrors(suite.errors);

    for (const node of buildTestTree(suite.tests)) body.appendChild(branch(node, 0));
  }

  async function refresh(): Promise<void> {
    const root = deps.root();
    if (!root) {
      suite = null;
      render();
      return;
    }

    loading = true;
    render();
    // Ошибку сбора отдаёт сам метод (список `errors`), поэтому сбой запроса — отдельный случай.
    suite = await deps.rpc.request('python.tests').catch(() => ({ tests: [], total: 0, errors: [] }));
    loading = false;
    render();
  }

  render();
  return { element, refresh, focus: () => refreshButton.focus() };
}
