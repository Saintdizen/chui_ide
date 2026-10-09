import {
  diffNodeDependencies,
  installCommand,
  parseNodeManifest,
  type NodeEnvironmentHealth,
  type NodeInfo,
  type NodePackage,
} from '../../shared/node-env';
import type { ProjectTools } from '../core/project-tools';
import type { RpcClient } from '../core/rpc';
import { clear, h } from './dom';

/**
 * Попап Node-окружения в статусбаре.
 *
 * Аналог Python-попапа, но окружение другое: у Node нет виртуального окружения —
 * есть версия Node в PATH, менеджер пакетов проекта и `node_modules` рядом с корнем.
 * Поэтому показываем именно это: чем запускается код, чем ставятся зависимости и
 * всё ли из `package.json` на месте. Раньше про Node-проект в интерфейсе не было
 * ничего, кроме чипа в полосе.
 *
 * Данные спрашиваем при каждом открытии: `node_modules` и версия Node меняются и
 * вне приложения (git pull, npm install), а попап мог провисеть часами.
 */

export interface NodeEnvPopoverDeps {
  rpc: RpcClient;
  /** Корень проекта: `node_modules` и `package.json` ищем в нём. */
  root: () => string | null;
  /** Текущие инструменты проекта: оттуда менеджер пакетов. */
  tools: () => ProjectTools;
  /** Вид проекта — показываем рядом, чтобы было понятно, «тот ли это» проект. */
  projectKind?: () => string | null;
  /** Поставить зависимости проекта менеджером из `package.json`. */
  onInstall: () => void;
}

export interface NodeEnvPopoverView {
  element: HTMLElement;
  refresh(): Promise<void>;
}

export function createNodeEnvPopover(deps: NodeEnvPopoverDeps): NodeEnvPopoverView {
  const body = h('div', { class: 'python-env-body' });
  const element = h(
    'div',
    { class: 'python-env' },
    h('div', { class: 'python-env-title' }, 'Node-окружение'),
    body,
  );

  // Разметка и классы общие с Python-попапом: это тот же виджет «окружение»,
  // отличается только содержимым. Дублировать стили незачем.
  function row(label: string, value: string, mono = true): HTMLElement {
    return h(
      'div',
      { class: 'python-env-row' },
      h('span', { class: 'python-env-key' }, label),
      h('span', { class: mono ? 'python-env-value' : 'python-env-value python-env-plain' }, value),
    );
  }

  function section(title: string, ...children: (Node | null)[]): HTMLElement {
    return h('section', { class: 'python-env-section' }, h('h3', { class: 'python-env-heading' }, title), ...children);
  }

  function button(label: string, onClick: () => void): HTMLElement {
    return h('button', { class: 'python-env-manage', type: 'button', onClick: () => onClick() }, label);
  }

  // Данные спрашиваются асинхронно, а тело общее: без стража два наложившихся
  // refresh (открыли, закрыли, открыли) дописали бы контент дважды.
  let generation = 0;

  async function refresh(): Promise<void> {
    const mine = ++generation;
    const root = deps.root();
    const manager = deps.tools().packageManager;
    clear(body);

    if (!root) {
      body.appendChild(h('div', { class: 'python-env-empty' }, 'Проект не открыт.'));
      return;
    }

    const [info, packages, health, manifestText] = await Promise.all([
      deps.rpc.request('node.info').catch(() => null as NodeInfo | null),
      deps.rpc.request('node.packages').catch(() => [] as NodePackage[]),
      deps.rpc.request('node.envHealth').catch(() => [] as NodeEnvironmentHealth[]),
      // Читаем файл, а не проверяем его наличие: диапазоны нужны для сверки с установленным.
      deps.rpc
        .request('workspace.readFile', { path: `${root}/package.json` })
        .then((file) => file.text)
        .catch(() => null),
    ]);
    // Кто-то отрисовался после нас — наш результат уже неактуален.
    if (mine !== generation) return;

    // Чем запускается код и чем ставятся зависимости — это первое, что нужно.
    body.appendChild(row('Node', info?.runtime.label ?? 'не найден'));
    const managerLabel = info
      ? `${info.packageManager.name}${info.packageManager.version ? ` ${info.packageManager.version}` : ''}`
      : manager;
    body.appendChild(row('Менеджер', managerLabel, false));
    const kind = deps.projectKind?.();
    if (kind) body.appendChild(row('Проект', kind, false));

    const manifest = manifestText === null ? null : parseNodeManifest(manifestText);
    // Версию Node проверяет main (engines.node), но показать диапазон полезно и тут.
    if (manifest?.engines) body.appendChild(row('engines.node', manifest.engines));

    // Поломки окружения — сразу под версией: это важнее списка пакетов.
    if (health.length > 0) {
      const box = h('div', { class: 'python-env-health' });
      for (const entry of health) {
        for (const issue of entry.issues) {
          box.appendChild(
            h(
              'div',
              { class: `python-env-issue is-${issue.severity}` },
              h('span', { class: 'python-env-issue-dot' }),
              issue.message,
            ),
          );
        }
      }
      body.appendChild(box);
    }

    // Зависимости: сколько стоит и всё ли из `package.json` установлено.
    const extras: HTMLElement[] = [];
    if (manifest && manifest.dependencies.length > 0) {
      const diff = diffNodeDependencies(manifest.dependencies, packages);
      extras.push(h('div', { class: 'python-env-requirements' }, nodeDependenciesNote(diff.missing.length, diff.present.length)));
      extras.push(button(`Установить зависимости (${installCommand(manager)})`, () => deps.onInstall()));
    }
    body.appendChild(
      section(
        'Пакеты',
        h(
          'div',
          { class: 'python-env-note' },
          packages.length > 0 ? `Установлено: ${packages.length}` : 'node_modules пуст или не найден',
        ),
        ...extras,
      ),
    );
  }

  return { element, refresh };
}

/** Что сказать про сверку `package.json` с `node_modules`. */
function nodeDependenciesNote(missing: number, present: number): string {
  if (missing === 0) return `Все объявленные зависимости на месте (${present})`;
  return `Не установлено: ${missing} из ${missing + present}`;
}
