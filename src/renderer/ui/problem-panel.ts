/**
 * Панель «Проблемы» в нижнем доке: ошибки, предупреждения и замечания по всем файлам.
 *
 * Панель только показывает и переходит: список ей отдаёт вызывающий (в приложении —
 * рабочее место редактора, `editors.markers()`), а сборка, отбор и группировка —
 * чистое правило из `shared/problem-list.ts`. Поэтому здесь нет ни разбора пометок,
 * ни знания, откуда они взялись (языковой сервер, проверка импортов).
 *
 * Список пересобирается по событию «пометки изменились», но только когда панель на
 * виду: она в доке, а док бывает свёрнут, и собирать впрок сотни строк незачем.
 * Фильтр и прокрутка при пересборке не сбрасываются — в поле фильтра продолжается
 * ввод, и терять его на каждой правке файла нельзя.
 */

import {
  countProblems,
  groupProblems,
  problemsSummary,
  type ProblemCounts,
  type ProblemFilter,
} from '../../shared/problem-list';
import type { DiagnosticItem } from '../../shared/api';
import { clear, h } from './dom';

export interface ProblemPanelDeps {
  /** Пометки по всем открытым файлам (отсортированы по пути и месту). */
  markers: () => DiagnosticItem[];
  /** Показать проблему: открыть файл и встать на место. */
  reveal: (path: string, line: number, column: number) => void;
  /** Короткая подпись файла — в приложении путь от корня проекта. */
  label: (path: string) => string;
  /**
   * Почему пусто — по мнению прохода проверки (строка с причиной) или `null`.
   * `ProjectCheck.unchecked()` уже умеет отличить «ещё не проверяли», «проверка
   * упала» и «проверять нечем»: выдумывать свой признак незачем.
   */
  unchecked?: () => string | null;
  /**
   * Запустить проверку проекта — действие пустого состояния (п.10).
   * Без него «Проблем нет» не отличить от «ещё не проверяли».
   */
  check?: () => void;
}

export interface ProblemPanel {
  element: HTMLElement;
  /** Пересобрать список (при показе вкладки и по изменению пометок). */
  refresh(): void;
  /** Счётчики для значка на вкладке дока — считаются по тем же пометкам. */
  counts(): ProblemCounts;
}

/**
 * Сколько строк проблем рисуем. Список на несколько тысяч пометок — уже не список:
 * в DOM едут сотни узлов, а читают всё равно первые. Остальное честно сосчитано в
 * заголовке и видно по счётчикам, но построчно не рисуется.
 */
const MAX_ROWS = 500;

export interface ProblemEmptyState {
  markers: number;
  filter: string;
  /**
   * Проверка проекта уже проходила. Без этого признака «Проблем нет» —
   * утверждение, которое нечем подтвердить: до первого прохода список пуст
   * просто потому, что его никто не заполнял.
   */
  checked?: boolean;
  /** Готовая причина от прохода проверки: важнее нашего «ещё не шла». */
  uncheckedNote?: string | null;
  /** Сброс фильтра — действие пустого состояния по фильтру. */
  reset?: () => void;
  /** Запуск проверки — действие пустого состояния до первой проверки. */
  check?: () => void;
}

/**
 * Что показать в пустой панели проблем (п.10).
 *
 * Три разных исхода — три разных текста и три разных действия: «до проверки»,
 * «фильтр отсёк всё», «всё чисто». Одна строка «Проблем нет.» на все три
 * утверждала чистоту, не посмотрев ни одного файла.
 */
export function problemEmptyPlan(state: ProblemEmptyState): {
  text: string;
  action: string;
  run(): void;
} {
  if (state.markers === 0) {
    if (!state.checked) {
      return {
        // Причину знает проход проверки (`ProjectCheck.unchecked`): «ещё не
        // проверяли», «проверка упала» и «проверять нечем» — три разных беды,
        // и совет «Запустить проверку» верен не для всех.
        text: state.uncheckedNote ?? 'Проверка ещё не шла.',
        action: 'Проверить проект',
        run: () => state.check?.(),
      };
    }
    return { text: 'Проблем нет.', action: '', run: () => undefined };
  }
  return {
    text: 'Ничего не найдено по фильтру.',
    action: 'Сбросить фильтр',
    run: () => state.reset?.(),
  };
}

export function createProblemPanel(deps: ProblemPanelDeps): ProblemPanel {
  const summary = h('span', { class: 'problems-summary' });
  const filter = h('input', {
    class: 'field-input problems-filter',
    type: 'search',
    placeholder: 'Фильтр…',
    title: 'Отбор по тексту сообщения, источнику или файлу',
  });
  const severitySelect = h('select', { class: 'field-input problems-severity', title: 'Отбор по виду' });
  const sourceSelect = h('select', { class: 'field-input problems-source', title: 'Отбор по серверу' });
  const list = h('div', { class: 'problems-list' });
  const element = h(
    'div',
    { class: 'problems-panel' },
    h(
      'div',
      { class: 'problems-toolbar' },
      h('span', { class: 'problems-title' }, 'Проблемы'),
      summary,
      h('div', { class: 'toolbar-spacer' }),
      filter,
      severitySelect,
      sourceSelect,
    ),
    list,
  );

  filter.addEventListener('input', () => render());
  severitySelect.addEventListener('change', () => render());
  sourceSelect.addEventListener('change', () => render());

  /** Строка проблемы: значок вида, сообщение, источник и место — как в списке IDE. */
  const problemRow = (problem: DiagnosticItem): HTMLElement => {
    const row = h(
      'button',
      {
        class: 'problem-row',
        type: 'button',
        title: `${problem.message}${problem.source ? ` (${problem.source})` : ''} — строка ${problem.line}`,
        onClick: () => deps.reveal(problem.path, problem.line, problem.column),
      },
      h('span', { class: `problem-severity is-${problem.severity}` }, severityGlyph(problem.severity)),
      h('span', { class: 'problem-message' }, problem.message),
      problem.source ? h('span', { class: 'problem-source' }, problem.source) : null,
      h('span', { class: 'problem-position' }, `${problem.line}:${problem.column}`),
    );
    return row;
  };

  /** Наполнить список отбора: первый вариант — «все» (значение пустое). */
  const fillOptions = (select: HTMLSelectElement, allLabel: string, values: readonly string[]): void => {
    const keep = select.value;
    clear(select);
    select.appendChild(h('option', { value: '' }, allLabel));
    for (const value of values) select.appendChild(h('option', { value }, value));
    // Выбор не теряем, если он ещё законен; иначе — «все».
    select.value = values.includes(keep) ? keep : '';
  };

  // Виды пометок в порядке важности: ошибки, предупреждения, замечания.
  const severityOrder = ['error', 'warning', 'info'] as const;

  const activeFilter = (): ProblemFilter => {
    const severity = severitySelect.value as '' | 'error' | 'warning' | 'info';
    const source = sourceSelect.value;
    const filterValue: ProblemFilter = {};
    if (severity) filterValue.severities = [severity];
    if (source) filterValue.sources = [source];
    return filterValue;
  };

  const render = (): void => {
    clear(list);
    const markers = deps.markers();
    const counts = countProblems(markers);
    // Отбор по виду и серверу: списки собираем из самих пометок — что не пришло,
    // то и не предлагаем (нет смысла выбирать пустой сервер).
    fillOptions(
      severitySelect,
      'Все виды',
      severityOrder.filter((s) => markers.some((m) => m.severity === s)),
    );
    fillOptions(sourceSelect, 'Все серверы', [...new Set(markers.map((m) => m.source))].sort());
    // Итог — по всем пометкам, а не по отобранным: фильтр сужает список, но число
    // найденных проблем не должно от него зависеть (иначе оно просто исчезает).
    summary.textContent = problemsSummary(counts);

    if (markers.length === 0) {
      // Текст и действие берём из плана: до первой проверки это не «проблем нет»,
      // а «ещё не смотрели» — утверждать чистоту, не посмотрев файлов, нельзя.
      const plan = problemEmptyPlan({
        markers: 0,
        filter: '',
        // «Не проверено» — не наша догадка, а состояние прохода (`ProjectCheck`).
        uncheckedNote: deps.unchecked?.() ?? null,
        check: deps.check,
      });
      const box = h('div', { class: 'problems-empty' }, plan.text);
      if (plan.action) {
        box.appendChild(
          h('button', { class: 'problems-empty-action', type: 'button', onClick: plan.run }, plan.action),
        );
      }
      list.appendChild(box);
      return;
    }

    const groups = groupProblems(markers, filter.value, deps.label, activeFilter());
    if (groups.length === 0) {
      // Сброс фильтра — прямо здесь: «Ничего не найдено» без выхода из
      // этого состояния заставляло искать причину глазами по панели.
      const plan = problemEmptyPlan({
        markers: markers.length,
        filter: filter.value,
        reset: () => {
          filter.value = '';
          render();
        },
      });
      const box = h('div', { class: 'problems-empty' }, plan.text);
      box.appendChild(h('button', { class: 'problems-empty-action', type: 'button', onClick: plan.run }, plan.action));
      list.appendChild(box);
      return;
    }

    let drawn = 0;
    for (const group of groups) {
      list.appendChild(
        h(
          'div',
          { class: 'problem-group-head' },
          h('span', { class: 'problem-file', title: group.path }, group.label),
          h('span', { class: 'problem-group-counts' }, problemsSummary(group.counts)),
        ),
      );
      for (const problem of group.items) {
        if (drawn >= MAX_ROWS) break;
        list.appendChild(problemRow(problem));
        drawn += 1;
      }
      if (drawn >= MAX_ROWS) break;
    }
    if (drawn >= MAX_ROWS) {
      list.appendChild(h('div', { class: 'problems-empty' }, `Показаны первые ${MAX_ROWS} проблем.`));
    }
  };

  render();

  return {
    element,
    refresh: render,
    counts: () => countProblems(deps.markers()),
  };
}

/** Значок вида проблемы: буква-знак в цвете — читается и без легенды. */
function severityGlyph(severity: DiagnosticItem['severity']): string {
  if (severity === 'error') return '✕';
  if (severity === 'warning') return '!';
  return 'i';
}
