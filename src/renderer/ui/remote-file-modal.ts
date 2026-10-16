import { fsAddressLabel, parseFsAddress } from '../../shared/fs-address';
import type { RpcClient } from '../core/rpc';
import { h } from './dom';
import { createModal } from './modal';

export interface RemoteFileModalDeps {
  rpc: RpcClient;
  notify(message: string, kind?: 'info' | 'error'): void;
}

export interface RemoteFileModalView {
  element: HTMLElement;
  open(address: string): Promise<void>;
  close(): void;
}

/**
 * Файл удалённой папки: посмотреть и поправить прямо в окне.
 *
 * Почему отдельное окно, а не вкладка редактора. Вкладка — это документ со своей
 * жизнью: его проверяет языковой сервер, за ним следит git, его правки складывает
 * undo, а «сохранить» пишет через `workspace.writeFile` — и всё это про ЛОКАЛЬНУЮ
 * файловую систему (`safePath`, наблюдатели за папкой). Удалённый файл живёт в
 * другом мире: там нет ни сервера, ни наблюдения, а запись идёт клиентом системы
 * (`ssh`, `wsl`, `docker`). Притвориться, что разницы нет, — значит получить
 * вкладку, которая молча не работает по половине операций. Поэтому здесь честный
 * отдельный просмотр с записью кнопкой.
 *
 * Что видно в заголовке: полный адрес. По нему сразу понятно, куда и куда именно
 * пойдёт сохранение — ошибиться хостом или папкой тут дорого.
 */
export function createRemoteFileModal(deps: RemoteFileModalDeps): RemoteFileModalView {
  let address = '';
  let busy = false;

  const note = h('div', { class: 'field-hint' });
  const editor = h('textarea', { class: 'field-input remote-file-text', spellcheck: false });
  const saveButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', disabled: true, onClick: () => void save() },
    'Сохранить',
  );

  // «Сохранить» — подвал окна: поле тянется по телу, кнопка держится внизу.
  const modal = createModal({
    className: 'remote-file-modal',
    title: 'Удалённый файл',
    footer: h('footer', { class: 'modal-footer is-end' }, saveButton),
  });
  modal.body.append(
    note,
    editor,
    h(
      'div',
      { class: 'field-hint' },
      'Запись идёт клиентом системы (ssh, wsl или docker) — сеть должна быть доступна, а ключи настроены. ' +
        'Языковой сервер, git-пометки и наблюдение за папкой на удалённые файлы не действуют.',
    ),
  );

  const close = (): void => modal.close();

  async function load(): Promise<void> {
    editor.value = '';
    editor.disabled = true;
    saveButton.disabled = true;
    note.textContent = `Читаю ${address}…`;
    try {
      const result = await deps.rpc.request('remote.readFile', { address });
      editor.value = result.text;
      editor.disabled = false;
      note.textContent = result.truncated
        ? `${address} — файл показан не целиком: сохранение такого текста перезапишет файл обрезанным.`
        : address;
      // Обрезку писать нельзя: это была бы тихая потеря части файла.
      saveButton.disabled = result.truncated;
    } catch (error) {
      note.textContent = error instanceof Error ? error.message : String(error);
      deps.notify('Не удалось прочитать удалённый файл', 'error');
    }
  }

  async function save(): Promise<void> {
    if (busy || saveButton.disabled) return;
    busy = true;
    try {
      await deps.rpc.request('remote.writeFile', { address, text: editor.value });
      deps.notify('Удалённый файл записан');
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  }

  return {
    element: modal.element,
    close,
    async open(target) {
      const parsed = parseFsAddress(target);
      address = target;
      modal.title.textContent = parsed ? fsAddressLabel(parsed) : 'Удалённый файл';
      modal.open();
      await load();
    },
  };
}
