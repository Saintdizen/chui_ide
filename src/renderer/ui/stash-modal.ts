import type { GitStashEntry } from '../../shared/git-stash';
import type { GitModel } from '../core/git-model';
import { clear, h, svgIcon } from './dom';

export interface StashModalDeps {
  git: GitModel;
  /** Спросить подтверждение у человека (системным диалогом). */
  confirm(options: { title: string; message: string; detail?: string; confirmLabel?: string }): Promise<boolean>;
  /** Сообщить о сбое операции. */
  notify?(message: string): void;
}

export interface StashModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/**
 * Экран отложенных изменений (stash): список записей и действия над ними.
 *
 * Живёт отдельным окном, а не в панели изменений: записи — это не текущие правки,
 * а отдельная полка, и мешать их с рабочим деревом не стоит. Своих операций над
 * репозиторием окно не делает — только зовёт модель git.
 *
 * Содержимое записи показывается её патчем: клик по строке раскрывает текст под
 * ней. Так видно, что именно отложено, не выходя из окна.
 */
export function createStashModal(deps: StashModalDeps): StashModalView {
  const list = h('div', { class: 'stash-list' });
  const empty = h('p', { class: 'stash-empty' }, 'Отложенных изменений нет.');
  const messageInput = h('input', {
    class: 'field-input stash-message-input',
    type: 'text',
    placeholder: 'Сообщение (необязательно)',
    spellcheck: false,
  });
  const untrackedBox = h('input', { class: 'stash-untracked-box', type: 'checkbox' });
  const untrackedRow = h(
    'label',
    { class: 'stash-untracked', title: 'В запись попадут и новые, ещё не отслеживаемые файлы' },
    untrackedBox,
    h('span', {}, 'включая новые файлы'),
  );
  const saveButton = h('button', { class: 'btn btn-primary', type: 'button' }, 'Отложить');
  const busy = { value: false };

  const close = (): void => {
    element.hidden = true;
  };

  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: close },
    svgIcon('close', 15),
  );

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal stash-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Отложенные изменения' },
      h(
        'header',
        { class: 'modal-header' },
        h('span', { class: 'modal-title' }, 'Отложенные изменения (stash)'),
        closeButton,
      ),
      h('div', { class: 'modal-body' }, list, empty),
      h('footer', { class: 'modal-footer' }, h('div', { class: 'stash-save' }, messageInput, untrackedRow), saveButton),
    ),
  );

  // Esc и клик по затемнению закрывают окно — как у прочих наших модалок.
  document.addEventListener('keydown', (event) => {
    if (!element.hidden && event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  element.addEventListener('pointerdown', (event) => {
    if (event.target === element) close();
  });

  /** Одна запись: заголовок с метаданными, действия и раскрывающийся патч. */
  const row = (entry: GitStashEntry): HTMLElement => {
    const patch = h('pre', { class: 'stash-patch', hidden: true });
    let loaded = false;

    const togglePreview = async (): Promise<void> => {
      if (!patch.hidden) {
        patch.hidden = true;
        return;
      }
      patch.hidden = false;
      if (loaded) return;
      patch.textContent = 'Загружаю…';
      try {
        patch.textContent = await deps.git.stashShow(entry.index);
        loaded = true;
      } catch (error) {
        patch.textContent = error instanceof Error ? error.message : String(error);
      }
    };

    const action = (label: string, title: string, run: () => Promise<unknown>, danger = false): HTMLElement => {
      const button = h('button', { class: `btn btn-small${danger ? ' is-danger' : ''}`, type: 'button', title }, label);
      button.addEventListener('click', async () => {
        if (busy.value) return;
        busy.value = true;
        try {
          await run();
          await refresh();
        } catch (error) {
          deps.notify?.(error instanceof Error ? error.message : String(error));
        } finally {
          busy.value = false;
        }
      });
      return button;
    };

    const info = h(
      'button',
      { class: 'stash-info', type: 'button', title: 'Показать содержимое записи', onClick: () => void togglePreview() },
      h('span', { class: 'stash-ref' }, entry.ref),
      h('span', { class: 'stash-message' }, entry.message),
      entry.branch ? h('span', { class: 'stash-branch' }, entry.branch) : null,
    );

    return h(
      'div',
      { class: 'stash-row' },
      h(
        'div',
        { class: 'stash-head' },
        info,
        h(
          'div',
          { class: 'stash-actions' },
          action('Применить', 'Вернуть изменения в рабочее дерево, оставив запись', () =>
            deps.git.stashApply(entry.index),
          ),
          action('Всплыть', 'Вернуть изменения и убрать запись', () => deps.git.stashPop(entry.index)),
          action(
            'Удалить',
            'Удалить запись, не трогая рабочее дерево',
            async () => {
              const ok = await deps.confirm({
                title: 'Удалить запись stash',
                message: `Удалить ${entry.ref}?`,
                detail: entry.message,
                confirmLabel: 'Удалить',
              });
              if (ok) await deps.git.stashDrop(entry.index);
            },
            true,
          ),
        ),
      ),
      patch,
    );
  };

  async function refresh(): Promise<void> {
    let entries: GitStashEntry[] = [];
    try {
      entries = await deps.git.stashList();
    } catch (error) {
      deps.notify?.(error instanceof Error ? error.message : String(error));
    }
    clear(list);
    empty.hidden = entries.length > 0;
    for (const entry of entries) list.appendChild(row(entry));
  }

  saveButton.addEventListener('click', async () => {
    if (busy.value) return;
    busy.value = true;
    saveButton.disabled = true;
    try {
      await deps.git.stashSave({ message: messageInput.value, includeUntracked: untrackedBox.checked });
      messageInput.value = '';
      untrackedBox.checked = false;
      await refresh();
    } catch (error) {
      deps.notify?.(error instanceof Error ? error.message : String(error));
    } finally {
      busy.value = false;
      saveButton.disabled = false;
    }
  });

  return {
    element,
    async open() {
      element.hidden = false;
      messageInput.focus();
      await refresh();
    },
    close,
  };
}
