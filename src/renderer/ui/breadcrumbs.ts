import { joinPath, splitPath } from '../../shared/paths';
import type { CommandRegistry } from '../core/commands';
import type { DocumentStore } from '../core/document-store';
import type { OpenEditors } from '../core/open-editors';
import type { WorkspaceModel } from '../core/workspace-model';
import { clear, h, svgIcon } from './dom';

export interface BreadcrumbsDeps {
  openEditors: OpenEditors;
  documents: DocumentStore;
  workspace: WorkspaceModel;
  commands: CommandRegistry;
}

/**
 * Хлебные крошки под вкладками, как в PyCharm: путь от корня проекта до файла.
 * Клик по сегменту-папке раскрывает её в проводнике.
 */
export function createBreadcrumbs(deps: BreadcrumbsDeps): HTMLElement {
  const element = h('div', { class: 'breadcrumbs' });

  const render = (): void => {
    clear(element);

    // Путь считаем только от корня проекта: открыть файл вне корня нельзя (safePath).
    const document = deps.openEditors.active;
    const root = deps.workspace.root;
    const relative = document && root ? deps.workspace.relative(document.path) : null;
    const local = relative && relative !== document?.path ? relative : null;
    // Пути приходят в родных разделителях (на Windows — обратные), поэтому режем по обоим.
    const segments = local ? splitPath(local) : [];

    // Крошки нужны, только когда есть куда идти: для файла в корне проекта путь — одно имя,
    // и оно уже есть во вкладке и в статусбаре.
    element.hidden = segments.length < 2;
    if (element.hidden) return;

    let walking = root ?? '';
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const isFile = index === segments.length - 1;
      // Собираем обратно тем же разделителем, что у корня: путь уходит в revealPath.
      walking = joinPath(walking, segment);
      const target = walking;

      const crumb = h(
        'button',
        { class: `crumb${isFile ? ' is-file' : ''}`, type: 'button', title: isFile ? target : `${target}\nКлик — быстрый переход к файлу` },
        index > 0 ? svgIcon('chevron', 10) : null,
        isFile ? svgIcon('file', 12) : svgIcon('folder', 12),
        h('span', {}, segment),
      );

      // Клик по крошке открывает палитру быстрого перехода: у папки — с её путём
      // как отбором (файлы рядом), у файла — без отбора. Раскрыть папку в дереве
      // по-прежнему можно двойным кликом.
      const query = isFile ? '' : `${segments.slice(0, index + 1).join('/')}/`;
      crumb.addEventListener('click', () => void deps.commands.execute('file.quickOpen', query));
      if (!isFile) {
        crumb.addEventListener('dblclick', () => void deps.commands.execute('workspace.revealPath', target));
      }

      element.appendChild(crumb);
    }
  };

  deps.openEditors.onDidChange(render);
  deps.workspace.onDidChange(render);
  render();

  return element;
}
