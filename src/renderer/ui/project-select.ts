import type { RpcClient } from '../core/rpc';
import type { WorkspaceModel } from '../core/workspace-model';
import { h } from './dom';
import { createSelect, type SelectOption, type SelectView } from './select';

/** Что нужно селекту проекта из внешнего мира: всё остальное он делает сам. */
export interface ProjectSelectDeps {
  rpc: Pick<RpcClient, 'request'>;
  workspace: WorkspaceModel;
}

/**
 * Селект проекта для шапки приложения: имя текущего и недавние для переключения.
 *
 * Живёт в шапке окна, а не в крыле проводника: проект — то, обо что решается всё
 * прочее (дерево, поиск, терминал, задачи), и переключать его надо откуда угодно,
 * не открывая панель.
 *
 * Список недавних читает main (`app.recentProjects`) — тот же, что у стартового окна.
 * Папку, которой больше нет, оставляем в списке с пометкой: путь в ней цены не
 * теряет, а прятать пропавшее — худший способ напомнить о нём.
 */
export function createProjectSelect(deps: ProjectSelectDeps, root: string | null): SelectView {
  const select = createSelect({ title: root ?? 'Проект не открыт', class: 'project-select' });
  select.onChange((path) => {
    // Выбран другой проект — открываем его. Отказ (папки нет, чужой домен)
    // покажет штатный путь workspace: наш обработчик его не глушит.
    if (!path || path === deps.workspace.current?.root) return;
    void deps.workspace.open(path).catch(() => undefined);
  });
  select.setValueIcon('folder');
  select.setOptions(root ? [{ value: root, label: deps.workspace.label, hint: root }] : []);
  // Недавние приходят асинхронно: шапка рисуется сразу, список догоняет.
  // Ответ прошлой перерисовки не должен перебить свежую шапку — сверяемся с тем,
  // чей проект сейчас открыт, а не с тем, для кого строили эту строку.
  void deps.rpc
    .request('app.recentProjects', undefined)
    .then((recent) => {
      if (root !== (deps.workspace.current?.root ?? null)) return;
      const options: SelectOption[] = recent.map((item) => ({
        value: item.path,
        label: item.name,
        hint: item.exists ? item.path : 'папки больше нет',
      }));
      if (root && !options.some((option) => option.value === root)) {
        options.unshift({ value: root, label: deps.workspace.label, hint: root });
      }
      select.setOptions(options);
      select.setValue(root ?? '');
    })
    .catch(() => undefined);
  return select;
}

/**
 * Селект шапки на всю сессию: живёт один и при смене проекта только перечитывает
 * имя и недавние. Пересоздавать его значило бы мигать раскрытым списком и терять
 * фокус ровно в тот момент, когда по нему только что щёлкнули.
 */
export function mountProjectSelect(deps: ProjectSelectDeps): {
  element: HTMLElement;
  sync(root: string | null): void;
} {
  const element = h('span', { class: 'project-slot' });
  let current: SelectView | null = null;

  const sync = (root: string | null): void => {
    if (!current) {
      current = createProjectSelect(deps, root);
      element.appendChild(current.element);
      return;
    }
    const next = createProjectSelect(deps, root);
    // Подменяем узел на месте: обёртка держит раскладку шапки, а селект меняется
    // целиком — у него своя кнопка, свой список и своя подписка на недавние.
    current.element.replaceWith(next.element);
    current = next;
  };

  sync(deps.workspace.root ?? null);
  return { element, sync };
}
