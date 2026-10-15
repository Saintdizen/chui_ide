import type { GitCommit } from '../../shared/api';
import {
  REBASE_ACTIONS,
  rebaseActionLabel,
  validateRebaseTodo,
  type RebaseAction,
  type RebaseTodoItem,
} from '../../shared/git-rebase';
import type { GitModel } from '../core/git-model';
import { clear, h, svgIcon } from './dom';
import { createModal } from './modal';
import { createSelect } from './select';

export interface RebaseModalDeps {
  git: GitModel;
  /** Спросить новое сообщение для `reword` (в приложении — окно ввода строки). */
  askMessage(subject: string): Promise<string | null>;
  /** Показать итог: успех, конфликт или отказ. */
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface RebaseModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/** Сколько последних коммитов показывать по умолчанию. */
const DEFAULT_DEPTH = 10;

/**
 * Экран интерактивного rebase: список последних коммитов, который человек
 * переставляет, склеивает и выбрасывает — как в файле `git rebase -i`, только
 * своим окном. Готовый список уходит в модель git, а та отдаёт его git через
 * свой редактор последовательности (`main/git/git.ts`).
 *
 * Порядок строк — тот, в котором коммиты пойдут в истории: сверху самый ранний.
 * Само окно репозиторий не трогает: только собирает список и зовёт модель.
 */
export function createRebaseModal(deps: RebaseModalDeps): RebaseModalView {
  let items: RebaseTodoItem[] = [];
  let depth = DEFAULT_DEPTH;
  let busy = false;
  /** Что тянем мышью прямо сейчас: индекс строки или -1. */
  let dragging = -1;

  const list = h('div', { class: 'rebase-list' });
  const hint = h('div', { class: 'field-hint rebase-hint' });
  const depthInput = h('input', {
    class: 'field-input rebase-depth',
    type: 'number',
    min: 2,
    max: 50,
    step: 1,
    value: String(DEFAULT_DEPTH),
  });

  const startButton = h('button', { class: 'btn btn-primary', type: 'button' }, 'Перестроить');

  const modal = createModal({
    className: 'rebase-modal',
    title: 'Перестроить историю (interactive rebase)',
    footer: h(
      'footer',
      { class: 'modal-footer' },
      h('span', { class: 'rebase-note' }, 'Base — коммит перед первым в списке.'),
      startButton,
    ),
  });
  modal.body.append(
    h(
      'div',
      { class: 'rebase-toolbar' },
      h('span', { class: 'field-label' }, 'Сколько последних коммитов:'),
      depthInput,
      h(
        'span',
        { class: 'field-hint' },
        'Выше — раньше в истории. Порядок меняется перетаскиванием строки или стрелками, ' +
          'действие — в списке слева.',
      ),
    ),
    list,
    hint,
  );

  const close = (): void => modal.close();

  startButton.addEventListener('click', () => void run());
  depthInput.addEventListener('change', () => {
    const next = Math.min(Math.max(Math.trunc(Number(depthInput.value)) || DEFAULT_DEPTH, 2), 50);
    depthInput.value = String(next);
    depth = next;
    void load();
  });

  /** Переставить элемент списка с одной позиции на другую. */
  const moveItem = (from: number, to: number): void => {
    if (from === to || from < 0 || from >= items.length || to < 0 || to > items.length) return;
    const [item] = items.splice(from, 1);
    if (!item) return;
    items.splice(to, 0, item);
    render();
  };

  /** Переставить шаг вверх или вниз (стрелками). */
  const move = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const [item] = items.splice(index, 1);
    items.splice(target, 0, item);
    render();
  };

  const setAction = async (index: number, action: RebaseAction): Promise<void> => {
    const item = items[index];
    if (item.action === 'reword' && action !== 'reword') item.message = undefined;
    item.action = action;
    // Новое сообщение спрашиваем сразу: без него список не пройдёт проверку.
    if (action === 'reword' && !item.message) {
      const message = await deps.askMessage(item.subject);
      if (message === null) {
        item.action = 'pick';
        render();
        return;
      }
      item.message = message;
    }
    render();
  };

  /** Снять пометки перетаскивания со всех строк — и с цели, и с той, что тянут. */
  const clearDropMarks = (): void => {
    for (const node of list.querySelectorAll('.rebase-row')) {
      node.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
    }
  };

  /** Одна строка: перестановка, действие, хеш и тема. */
  const row = (item: RebaseTodoItem, index: number): HTMLElement => {
    const moveButton = (direction: -1 | 1, glyph: Parameters<typeof svgIcon>[0], title: string): HTMLElement => {
      const button = h(
        'button',
        { class: 'icon-btn rebase-move', type: 'button', title, onClick: () => move(index, direction) },
        svgIcon(glyph, 13),
      );
      return button;
    };

    const select = createSelect({});
    select.setOptions(REBASE_ACTIONS.map((action) => ({ value: action, label: rebaseActionLabel(action) })));
    select.setValue(item.action);
    select.onChange((value) => void setAction(index, value as RebaseAction));

    const subject = h('span', { class: 'rebase-subject' }, item.subject);
    if (item.action === 'reword' && item.message) {
      subject.classList.add('is-reword');
      subject.title = `Новое сообщение: ${item.message}`;
    }

    // Перетаскивание — тот же перенос, что стрелками, только мышью. `draggable` на
    // строке; куда встанет — решает середина строки под курсором (выше/ниже неё).
    const node = h(
      'div',
      { class: 'rebase-row', draggable: 'true' },
      h(
        'div',
        { class: 'rebase-move-group' },
        moveButton(-1, 'chevronUp', 'Выше'),
        moveButton(1, 'chevronDown', 'Ниже'),
      ),
      h('div', { class: 'rebase-action' }, select.element),
      h('span', { class: 'rebase-hash' }, item.commit),
      subject,
    );

    node.addEventListener('dragstart', (event) => {
      // Тянем строку за неё саму; потянув за поле действия, человек его настраивает.
      dragging = index;
      node.classList.add('is-dragging');
      // Иначе браузер не начнёт перетаскивание, а часть его испугается пустого набора.
      event.dataTransfer?.setData('text/plain', item.commit);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });

    node.addEventListener('dragover', (event) => {
      if (dragging < 0) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      // Ниже середины — вставляем после строки, выше — перед ней.
      const rect = node.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      for (const each of list.querySelectorAll('.rebase-row')) {
        each.classList.remove('is-drop-before', 'is-drop-after');
      }
      node.classList.add(after ? 'is-drop-after' : 'is-drop-before');
    });

    node.addEventListener('drop', (event) => {
      if (dragging < 0) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      let target = index + (after ? 1 : 0);
      // Из списка элемент сперва вынимается: если он стоял выше цели, цель поднимается на одну.
      if (dragging < target) target -= 1;
      const from = dragging;
      dragging = -1;
      clearDropMarks();
      moveItem(from, target);
    });

    node.addEventListener('dragend', () => {
      dragging = -1;
      clearDropMarks();
    });

    return node;
  };

  const render = (): void => {
    clear(list);
    if (items.length === 0) {
      list.append(h('p', { class: 'rebase-empty' }, 'Коммитов для перестройки нет.'));
      startButton.disabled = true;
      hint.textContent = '';
      return;
    }
    items.forEach((item, index) => {
      list.append(row(item, index));
    });
    const problem = validateRebaseTodo(items);
    hint.textContent = problem ?? '';
    hint.classList.toggle('is-error', Boolean(problem));
    startButton.disabled = Boolean(problem) || busy;
  };

  const load = async (): Promise<void> => {
    try {
      const commits: GitCommit[] = await deps.git.log(undefined, depth);
      // git отдаёт коммиты от новых к старым, а список шагов идёт от ранних к поздним.
      items = commits
        .slice()
        .reverse()
        .map((commit) => ({ action: 'pick', commit: commit.hash, subject: commit.summary }));
    } catch (error) {
      items = [];
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    render();
  };

  const run = async (): Promise<void> => {
    if (busy) return;
    const problem = validateRebaseTodo(items);
    if (problem) {
      deps.notify(problem, 'error');
      return;
    }
    busy = true;
    render();
    try {
      const result = await deps.git.rebase(depth, items);
      if (result.conflict) {
        deps.notify('Конфликт при перестройке — разрешите его и выполните «Продолжить rebase»', 'error');
      } else if (result.inProgress) {
        deps.notify('Rebase остановлен на шаге правки — исправьте коммит и продолжите', 'info');
      } else if (result.ok) {
        deps.notify('История перестроена');
      } else {
        deps.notify(result.message, 'error');
      }
      close();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
      render();
    }
  };

  async function open(): Promise<void> {
    modal.open();
    depthInput.value = String(depth);
    await load();
  }

  return { element: modal.element, open, close };
}
