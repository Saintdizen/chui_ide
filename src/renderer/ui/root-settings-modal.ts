import type { ExplorerSettings, ExplorerRootOverride, ExplorerRootOverrides } from '../../shared/api';
import {
  clearRootOverride,
  describeOverride,
  OVERRIDE_LABELS,
  ROOT_OVERRIDE_FLAGS,
  rootOverrideOf,
  setRootOverride,
} from '../../shared/explorer-settings';
import { nameOf } from '../../shared/paths';
import { clear, h } from './dom';
import { createModal } from './modal';
import { createSelect } from './select';

export interface RootSettingsModalDeps {
  /** Активный корень: его настройки показываем и правим. */
  root: () => string | null;
  /** Текущие настройки explorer (общие плюс карта отличий). */
  settings: () => ExplorerSettings;
  /** Записать получившуюся карту отличий. */
  save: (byRoot: ExplorerRootOverrides) => Promise<void> | void;
}

export interface RootSettingsModalView {
  element: HTMLElement;
  open(): void;
  close(): void;
}

/** Значение селекта: наследовать общее, включить или выключить. */
type TriState = 'inherit' | 'on' | 'off';

const TRI_OPTIONS = [
  { value: 'inherit', label: 'Как в области' },
  { value: 'on', label: 'Включено' },
  { value: 'off', label: 'Выключено' },
];

/**
 * «Настройки папки»: настройки вида дерева для ОДНОГО корня рабочей области.
 *
 * Зачем отдельное окно, а не строки в общих настройках. Отличий у корня обычно
 * немного (скрытые файлы, пометки git, исключения), а папок в области может быть
 * несколько: показывать все корни одной формой — простыня, в которой не видно, что
 * относится к кому. Здесь окно открывается на конкретной папке и говорит об этом
 * заголовком.
 *
 * Каждый ключ — три состояния: «как в области» (наследует общее значение),
 * «включено», «выключено». Так видно разницу между «я это менял» и «по умолчанию».
 */
export function createRootSettingsModal(deps: RootSettingsModalDeps): RootSettingsModalView {
  /** Черновик отличий: правим его, а сохраняем по кнопке — чтобы не писать на каждый клик. */
  let draft: ExplorerRootOverride = {};
  let currentRoot: string | null = null;

  const rows = h('div', { class: 'root-settings-rows' });
  const excluded = h('textarea', { class: 'field-input root-settings-exclude', rows: 4, spellcheck: false });
  const summary = h('div', { class: 'field-hint' });

  const resetButton = h(
    'button',
    { class: 'btn', type: 'button', title: 'Жить по общим настройкам', onClick: () => void reset() },
    'Сбросить настройки папки',
  );
  const doneButton = h('button', { class: 'btn btn-primary', type: 'button', onClick: () => void apply() }, 'Готово');
  // Действия — подвал окна: тело (строки настроек и исключения) растёт.
  const modal = createModal({
    className: 'root-settings-modal',
    title: 'Настройки папки',
    footer: h('footer', { class: 'modal-footer is-end' }, resetButton, doneButton),
  });
  modal.body.append(
    h(
      'div',
      { class: 'field-hint' },
      'Эти настройки относятся к одной папке области: в другом корне дерево может выглядеть иначе. ' +
        '«Как в области» — наследовать общую настройку.',
    ),
    rows,
    h('div', { class: 'settings-divider' }),
    h('div', { class: 'field-label' }, 'Исключения папки'),
    h(
      'div',
      { class: 'field-hint' },
      'Свои маски (`*.min.js`, `dist`, `generated/**`) — по строке на маску. Пусто — берутся ' +
        'исключения области. Это фильтр ДЕРЕВА: поиск и индексация им не пользуются.',
    ),
    excluded,
    h('div', { class: 'settings-divider' }),
    summary,
  );

  const close = (): void => modal.close();

  /** Собрать черновик отличий из значений формы. */
  const collect = (): ExplorerRootOverride => {
    const next: ExplorerRootOverride = {};
    for (const row of rows.querySelectorAll<HTMLElement>('[data-flag]')) {
      const flag = row.dataset.flag as (typeof ROOT_OVERRIDE_FLAGS)[number] | undefined;
      const state = (row.dataset.state ?? 'inherit') as TriState;
      if (!flag || state === 'inherit') continue;
      (next as Record<string, unknown>)[flag] = state === 'on';
    }
    const list = excluded.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (list.length > 0) next.exclude = list;
    return next;
  };

  const render = (): void => {
    clear(rows);
    const base = deps.settings();
    for (const flag of ROOT_OVERRIDE_FLAGS) {
      const own = draft[flag];
      const state: TriState = own === undefined ? 'inherit' : own ? 'on' : 'off';
      const select = createSelect({});
      select.setOptions(TRI_OPTIONS);
      select.setValue(state);
      select.onChange((value) => {
        const next = value as TriState;
        if (next === 'inherit') delete draft[flag];
        else draft[flag] = next === 'on';
        render();
      });
      const row = h(
        'div',
        { class: 'field field-between root-settings-row', dataset: { flag, state } },
        h(
          'span',
          {},
          OVERRIDE_LABELS[flag],
          // Подсказка: чему равно общее значение — видно, от чего отличается своё.
          h('span', { class: 'field-note' }, `область: ${String(base[flag as keyof ExplorerSettings])}`),
        ),
        select.element,
      );
      rows.appendChild(row);
    }
    excluded.value = (draft.exclude ?? []).join('\n');
    // «Есть ли отличия» решаем по собранным полям, а не по сохранённой карте: строка
    // показывает ЧЕРНОВИК — до нажатия «Готово» он и есть то, что видит человек.
    const own = collect();
    summary.textContent =
      Object.keys(own).length > 0
        ? `Отличия: ${describeOverride(own)}`
        : 'Отличий нет — папка живёт по общим настройкам.';
  };

  async function apply(): Promise<void> {
    if (!currentRoot) return close();
    const next = setRootOverride(deps.settings().byRoot, currentRoot, collect());
    await deps.save(next);
    close();
  }

  async function reset(): Promise<void> {
    if (!currentRoot) return close();
    await deps.save(clearRootOverride(deps.settings().byRoot, currentRoot));
    close();
  }

  return {
    element: modal.element,
    open() {
      currentRoot = deps.root();
      if (!currentRoot) return;
      // Копия: правки формы не должны менять сохранённую карту до нажатия «Готово».
      draft = { ...rootOverrideOf(deps.settings().byRoot, currentRoot) };
      if (draft.exclude) draft.exclude = [...draft.exclude];
      modal.title.textContent = `Настройки папки: ${nameOf(currentRoot)}`;
      render();
      modal.open(excluded);
    },
    close,
  };
}
