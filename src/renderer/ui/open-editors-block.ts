import { parentOf } from '../../shared/paths';
import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { OpenEditors } from '../core/open-editors';
import { basename, clear, h } from './dom';

export interface OpenEditorsBlockDeps {
  openEditors: OpenEditors;
  documents: DocumentStore;
  commands: CommandRegistry;
}

export interface OpenEditorsBlock {
  element: HTMLElement;
}

/**
 * «Открытые редакторы» над деревом — тот же набор, что в полосе вкладок, но списком:
 * видно сразу, что открыто и что не сохранено, не глядя наверх к вкладкам.
 *
 * Файлы в списке — те же пути, что у вкладок (`openEditors.paths`), и порядок тот же:
 * новое открывается сверху, как в VS Code. Пусто — блок не занимает места.
 */
export function createOpenEditorsBlock(deps: OpenEditorsBlockDeps): OpenEditorsBlock {
  const list = h('div', { class: 'open-editors-list', role: 'list' });
  const count = h('span', { class: 'open-editors-count' });
  const element = h(
    'div',
    { class: 'open-editors' },
    h('div', { class: 'open-editors-head' }, h('span', { class: 'open-editors-title' }, 'Открытые редакторы'), count),
    list,
  );

  const activate = (path: string): void => {
    void deps.commands.execute('file.activate', path);
  };

  const render = (): void => {
    const paths = deps.openEditors.paths;
    element.hidden = paths.length === 0;
    count.textContent = String(paths.length);

    // Одинаковые имена (index.ts в разных папках) различаем подписью родителя —
    // иначе в списке две одинаковые строки и непонятно, какую брать.
    const names = paths.map((path) => basename(path));
    const repeated = new Set(names.filter((name, index) => names.indexOf(name) !== index));

    const rows = paths.map((path) => {
      const document = deps.documents.get(path);
      const dirty = document?.dirty === true;
      const active = deps.openEditors.active?.path === path;
      const preview = deps.openEditors.isPreview(path);
      const name = basename(path);
      const classes = ['open-editor'];
      if (active) classes.push('is-active');
      if (dirty) classes.push('is-dirty');
      if (preview) classes.push('is-preview');

      const close = h('button', {
        class: 'open-editor-close',
        type: 'button',
        title: 'Закрыть (Ctrl+W)',
        'aria-label': `Закрыть ${name}`,
      });
      close.append('✕');
      close.addEventListener('click', (event) => {
        // Иначе клик по крестику ещё и активирует файл — он вспыхнет и погаснет.
        event.stopPropagation();
        void deps.commands.execute('file.close', path);
      });

      const row = h(
        'div',
        {
          class: classes.join(' '),
          role: 'listitem',
          tabindex: '0',
          title: path,
          'aria-current': active ? 'true' : 'false',
        },
        h('span', { class: 'open-editor-dot' }, dirty ? '●' : ''),
        h('span', { class: 'open-editor-name' }, name),
        repeated.has(name) ? h('span', { class: 'open-editor-hint' }, basename(parentOf(path))) : null,
        close,
      );
      row.addEventListener('click', () => activate(path));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate(path);
        } else if (event.key === 'Delete') {
          event.preventDefault();
          void deps.commands.execute('file.close', path);
        }
      });
      return row;
    });

    clear(list);
    list.append(...rows);
  };

  render();
  deps.openEditors.onDidChange(render);
  // Пометка «не сохранён» живёт в документе, а не в списке вкладок.
  deps.documents.onDidChangeDirty(render);

  return { element };
}
