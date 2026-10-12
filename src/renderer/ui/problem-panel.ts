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

import { countProblems, groupProblems, problemsSummary, type ProblemCounts } from '../../shared/problem-list';
import type { DiagnosticItem } from '../../shared/api';
import { clear, h } from './dom';

export interface ProblemPanelDeps {
  /** Пометки по всем открытым файлам (отсортированы по пути и месту). */
  markers: () => DiagnosticItem[];
  /** Показать проблему: открыть файл и встать на место. */
  reveal: (path: string, line: number, column: number) => void;
  /** Короткая подпись файла — в приложении путь от корня проекта. */
  label: (path: string) => string;
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

export function createProblemPanel(deps: ProblemPanelDeps): ProblemPanel {
  const summary = h('span', { class: 'problems-summary' });
  const filter = h('input', {
    class: 'problems-filter',
    type: 'search',
    placeholder: 'Фильтр…',
    title: 'Отбор по тексту сообщения, источнику или файлу',
  });
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
    ),
    list,
  );

  filter.addEventListener('input', () => render());

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

  const render = (): void => {
    clear(list);
    const markers = deps.markers();
    const counts = countProblems(markers);
    // Итог — по всем пометкам, а не по отобранным: фильтр сужает список, но число
    // найденных проблем не должно от него зависеть (иначе оно просто исчезает).
    summary.textContent = problemsSummary(counts);

    if (markers.length === 0) {
      list.appendChild(h('div', { class: 'problems-empty' }, 'Проблем нет.'));
      return;
    }

    const groups = groupProblems(markers, filter.value, deps.label);
    if (groups.length === 0) {
      list.appendChild(h('div', { class: 'problems-empty' }, 'Ничего не найдено по фильтру.'));
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
