import { buildTestTree, parseCoverageReport, parseResultMarker, type CollectedSuite, type CoverageReport, type CoverageRow, type TestFolder } from '../../shared/python-tests';
import { isTestFile } from '../../shared/project-scan';
import { PushTopic, type TerminalDataPayload } from '../../shared/api';
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
 * Пересобираем при открытии, по кнопке и по правке тестового файла — но не на
 * каждое нажатие и не в фоне: с задержкой и только когда панель на виду (см.
 * `notifyChange`). Иначе pytest дёргался бы на каждый символ.
 *
 * Исход прогона берём из вывода терминала (см. `resultMarkerCommand`): оболочка
 * после pytest не завершается, поэтому кода выхода из события процесса не
 * получить. Запуская узел, панель помнит, чей это прогон, и по маркеру красит
 * узел зелёным или красным.
 */

export interface TestPanelDeps {
  rpc: RpcClient;
  /** Проект не открыт — собирать нечего. */
  root: () => string | null;
  /**
   * Запустить тесты: селектор pytest или null — все. `report` просит дописать в
   * команду печать кода выхода — панель использует его, чтобы узнать исход.
   */
  onRun: (selector: string | null, options?: { report?: boolean }) => void;
  /** Запустить с покрытием (`pytest --cov`). */
  onCoverage: (selector: string | null) => void;
  /** Панель на виду: пересобирать список по правке имеет смысл только тогда. */
  isVisible: () => boolean;
  /** Пришёл отчёт покрытия — по нему редактор подсвечивает непокрытые строки. */
  onCoverageReport?: (report: CoverageReport) => void;
}

/** Исход последнего прогона узла. */
type TestOutcome = 'running' | 'passed' | 'failed';
/** Ключ для узла «все тесты»: у него нет собственного id в дереве. */
const ALL_KEY = 'pytest:all';
/** Пауза перед авто-перечитыванием: пока человек печатает, pytest не зовём. */
const AUTO_REFRESH_DELAY = 1500;
/** Сколько файлов покрытия показываем: список должен оставаться обозримым. */
const MAX_COVERAGE_ROWS = 12;

export interface TestPanelView {
  element: HTMLElement;
  /** Пересобрать список тестов; вызывается при открытии панели. */
  refresh(): Promise<void>;
  /** Сообщить о правке файла: панель сама решит, надо ли пересобирать. */
  notifyChange(path: string): void;
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
    { class: 'btn btn-small', type: 'button', title: 'Запустить все тесты', onClick: () => run(ALL_KEY, null) },
    'Запустить все',
  );
  const coverageButton = h(
    'button',
    { class: 'btn btn-small', type: 'button', title: 'Запустить все тесты с покрытием', onClick: () => run(ALL_KEY, null, true) },
    'С покрытием',
  );

  const body = h('div', { class: 'tests-body' });
  const element = h(
    'div',
    { class: 'tests-panel' },
    h('div', { class: 'tests-toolbar' }, summary, h('div', { class: 'toolbar-spacer' }), runAllButton, coverageButton, refreshButton),
    body,
  );

  let loading = false;
  let suite: CollectedSuite | null = null;
  /** Исход последнего прогона по ключу узла (id теста/класса/файла или ALL_KEY). */
  const outcomes = new Map<string, TestOutcome>();
  /** Ключ узла, прогон которого сейчас ждём по маркеру. null — ничего не ждём. */
  let pendingKey: string | null = null;
  /**
   * Хвост вывода терминала. Копим его, а не смотрим каждый кусок отдельно:
   * маркер может прийти разорванным между двумя порциями, а строка покрытия —
   * вообще задолго до маркера, поэтому хвост держим длиннее.
   */
  let outputTail = '';
  /** Ждём ли от текущего прогона покрытие (кнопка «С покрытием»). */
  let pendingCoverage = false;
  /** Итог покрытия последнего прогона с покрытием, в процентах. */
  /** Отчёт покрытия последнего прогона с `--cov`: итог и разбивка по файлам. */
  let coverage: CoverageReport | null = null;

  // Исход приходит из общего потока вывода терминала: своего канала у прогона нет.
  deps.rpc.onPush((message) => {
    if (message.topic !== PushTopic.TerminalData || pendingKey === null) return;
    const payload = message.payload as TerminalDataPayload;
    outputTail = (outputTail + payload.data).slice(-4000);
    const code = parseResultMarker(outputTail);
    if (code === null) return;
    outcomes.set(pendingKey, code === 0 ? 'passed' : 'failed');
    // Строку покрытия печатает pytest-cov перед нашим маркером — берём её отсюда же.
    if (pendingCoverage) {
      coverage = parseCoverageReport(outputTail);
      // Построчную разбивку отдаём наружу: редактор подсветит непокрытые строки.
      deps.onCoverageReport?.(coverage);
    }
    pendingKey = null;
    pendingCoverage = false;
    outputTail = '';
    render();
  });

  /**
   * Начать прогон узла: запомнить, чей исход ждём, и попросить отчёт. Покрытие —
   * отдельный путь: там нужен `pytest --cov`, а отчёт печатает сам pytest-cov.
   */
  function run(key: string, selector: string | null, withCoverage = false): void {
    pendingKey = key;
    pendingCoverage = withCoverage;
    outcomes.set(key, 'running');
    outputTail = '';
    render();
    if (withCoverage) deps.onCoverage(selector);
    else deps.onRun(selector, { report: true });
  }

  /** Значок исхода узла: точка, галочка или крестик. */
  function statusBadge(key: string | undefined): HTMLElement | null {
    const outcome = key ? outcomes.get(key) : undefined;
    if (!outcome) return null;
    const label = outcome === 'running' ? '…' : outcome === 'passed' ? '✓' : '✗';
    const title = outcome === 'running' ? 'Идёт прогон' : outcome === 'passed' ? 'Прошёл' : 'Упал';
    return h('span', { class: `tests-status is-${outcome}`, title }, label);
  }

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
          run(node.id ?? ALL_KEY, node.id ?? null);
        },
      },
      '▶',
    );
  }

  /** Строка узла: отступ по глубине, стрелка, подпись, исход и кнопка запуска. */
  function row(node: TestFolder, depth: number, arrow: string): { head: HTMLElement; marker: HTMLElement } {
    const marker = h('span', { class: `tests-arrow${arrow ? ' is-toggle' : ''}` }, arrow);
    const outcome = node.id ? outcomes.get(node.id) : undefined;
    const head = h(
      'div',
      { class: `tests-row tests-${node.kind}${outcome ? ` is-${outcome}` : ''}`, style: { paddingLeft: `${depth * 14 + 8}px` } },
      marker,
      h('span', { class: 'tests-label' }, node.label),
      statusBadge(node.id),
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

    // Сводка несёт исход прогона всех тестов, если он был.
    const outcome = outcomes.get(ALL_KEY);
    const suffix =
      outcome === 'passed'
        ? ' · прогон прошёл'
        : outcome === 'failed'
          ? ' · прогон упал'
          : outcome === 'running'
            ? ' · идёт прогон'
            : '';
    const total = coverage?.total ?? null;
    const cover = total === null ? '' : ` · покрытие ${total}%`;
    summary.textContent = `Тестов: ${suite.total}${suffix}${cover}`;
    if (suite.errors.length > 0) renderErrors(suite.errors);

    for (const node of buildTestTree(suite.tests)) body.appendChild(branch(node, 0));

    // Разбивку по файлам показываем отдельным списком: в дереве видны только
    // тестовые файлы, а покрытие часто считают по исходникам (`--cov=src`), и
    // искать их по дереву тестов было бы негде.
    renderCoverageFiles();
  }

  /** Подсказка строки покрытия: строки и, если считали, ветви. */
  function coverageTitle(file: CoverageRow): string {
    const parts = [`Непокрытых строк: ${file.missing} из ${file.statements}`];
    if (file.branches > 0) parts.push(`ветвей пройдено не полностью: ${file.branchPartial} из ${file.branches}`);
    return parts.join(' · ');
  }

  /** Покрытие по файлам: сначала те, где больше непокрытых строк. */
  function renderCoverageFiles(): void {
    const files = coverage?.files;
    if (!files || files.length === 0) return;

    const list = h('div', { class: 'tests-coverage' });
    for (const file of files.slice(0, MAX_COVERAGE_ROWS)) {
      list.appendChild(
        h(
          'div',
          { class: `tests-cov-row${file.percent === 0 ? ' is-bad' : ''}`, title: coverageTitle(file) },
          h('span', { class: 'tests-cov-path' }, file.path),
          h('span', { class: 'tests-cov-percent' }, `${file.percent}%`),
          // Колонку ветвей показываем, только когда прогон был с `--cov-branch`:
          // иначе «ветвей: 0» путало бы — их просто не считали.
          file.branches > 0
            ? h('span', { class: 'tests-cov-branch' }, `ветви ${file.branches - file.branchPartial}/${file.branches}`)
            : null,
        ),
      );
    }
    if (files.length > MAX_COVERAGE_ROWS) {
      list.appendChild(h('div', { class: 'tests-cov-row is-more' }, `… ещё файлов: ${files.length - MAX_COVERAGE_ROWS}`));
    }
    body.appendChild(h('section', { class: 'tests-coverage-box' }, h('div', { class: 'tests-cov-title' }, 'Покрытие по файлам'), list));
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

  /** Таймер отложенного перечитывания: новое изменение сбрасывает старое. */
  let autoTimer: number | null = null;

  /**
   * Файл изменился. Пересобираем дерево только если это тестовый файл и панель
   * на виду, да ещё и с паузой: правка кода идёт посимвольно, а pytest на каждый
   * символ запускать нельзя.
   */
  function notifyChange(path: string): void {
    if (!deps.isVisible() || !isTestFile(path)) return;
    if (autoTimer !== null) window.clearTimeout(autoTimer);
    autoTimer = window.setTimeout(() => {
      autoTimer = null;
      void refresh();
    }, AUTO_REFRESH_DELAY);
  }

  render();
  return { element, refresh, notifyChange, focus: () => refreshButton.focus() };
}
