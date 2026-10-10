import {
  diffRequirements,
  parseRequirements,
  requirementsNote,
  type InstalledPackage,
} from '../../shared/python-packages';
import type { PythonEnvironment, PythonInterpreter } from '../../shared/python-env';
import type { EnvironmentHealth } from '../../shared/python-health';
import type { ProjectTools } from '../core/project-tools';
import { envList, envShortLabel, envSource, envSourceLabel } from '../core/python-view';
import type { RpcClient } from '../core/rpc';
import { h } from './dom';
import { createSelect, type SelectOption } from './select';
import { showToast } from './toast';

/**
 * Попап Python-окружения в статусбаре.
 *
 * Здесь всё, что нужно знать про питон проекта, не уходя с места: чем запустится
 * код и откуда интерпретатор, сколько пакетов стоит, какие есть окружения и каким
 * интерпретатором работать в этом проекте. Раньше половина этого была разбросана
 * по настройкам и окну окружений.
 *
 * Снимок окружения читается при открытии проекта (app зовёт `refresh` тогда же),
 * а при каждом открытии попапа обновляется: попап мог провисеть часами, а окружение,
 * пакеты и интерпретаторы меняются и вне приложения (git pull, pip install). Пока
 * свежие данные едут, показано прошлое содержимое — тело не пустеет (см. refresh).
 */

export interface PythonEnvPopoverDeps {
  rpc: RpcClient;
  /** Корень проекта: окружения и пакеты ищем в нём. */
  root: () => string | null;
  /** Текущие инструменты проекта: оттуда готовый интерпретатор. */
  tools: () => ProjectTools;
  /** Значение `run.pythonPath` из настроек: пусто — настройка не задана. */
  configured: () => string;
  /** Платформа: нужна, чтобы показать путь к интерпретатору окружения. */
  platform?: () => string;
  /** Вид проекта — показываем рядом, чтобы было понятно, «тот ли это» проект. */
  projectKind?: () => string | null;
  /** Интерпретатор, выбранный именно для этого проекта ('' — не выбран). */
  projectPython?: () => string;
  /** Выбрать интерпретатор для проекта ('' — автоматически). */
  onSelect: (command: string) => void;
  /** Открыть окно создания окружения. */
  onCreate: () => void;
  /** Поставить зависимости из requirements.txt. */
  onInstallRequirements: () => void;
}

export interface PythonEnvPopoverView {
  element: HTMLElement;
  refresh(): Promise<void>;
}

export function createPythonEnvPopover(deps: PythonEnvPopoverDeps): PythonEnvPopoverView {
  const body = h('div', { class: 'python-env-body' });
  const interpreterSelect = createSelect({ title: 'Каким интерпретатором работать в этом проекте' });
  interpreterSelect.onChange(() => deps.onSelect(interpreterSelect.value));

  const element = h('div', { class: 'python-env' }, h('div', { class: 'python-env-title' }, 'Python-окружение'), body);

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

  // Данные спрашиваются асинхронно: без стража устаревший ответ (открыли, закрыли,
  // открыли — а первый ответ пришёл позже свежего) переписал бы тело поверх нового.
  let generation = 0;

  async function refresh(): Promise<void> {
    const mine = ++generation;
    const root = deps.root();
    const tools = deps.tools();
    // Прошлое содержимое не стираем: пока новые данные едут, на экране остаётся
    // прежний снимок — тело не «мигает» пустым. Узлы копим и подменяем тело
    // одним разом в конце (см. `body.replaceChildren`).
    const nodes: Node[] = [];

    if (!root || !tools.root) {
      nodes.push(h('div', { class: 'python-env-empty' }, 'Проект не открыт.'));
      body.replaceChildren(...nodes);
      return;
    }

    // Что за интерпретатор и откуда он взялся.
    const source = envSource(deps.configured(), tools);
    nodes.push(row('Интерпретатор', envShortLabel(tools)));
    nodes.push(row('Путь', tools.pythonCommand));
    nodes.push(row('Источник', envSourceLabel(source), false));
    const kind = deps.projectKind?.();
    if (kind) nodes.push(row('Проект', kind, false));

    const [environments, interpreters, packages, requirementsText, health, activation] = await Promise.all([
      deps.rpc.request('python.environments').catch(() => [] as PythonEnvironment[]),
      deps.rpc.request('python.interpreters').catch(() => [] as PythonInterpreter[]),
      deps.rpc.request('python.packages').catch(() => [] as InstalledPackage[]),
      // Читаем файл, а не проверяем его наличие: текст нужен для сравнения с
      // установленным. Нет файла — null, и никаких обещаний про зависимости.
      deps.rpc
        .request('workspace.readFile', { path: `${root}/requirements.txt` })
        .then((file) => file.text)
        .catch(() => null),
      deps.rpc.request('python.envHealth').catch(() => [] as EnvironmentHealth[]),
      // Команду активации собирает main: renderer не знает ни платформы, ни путей.
      deps.rpc.request('python.activateCommand').catch(() => ({ command: null })),
    ]);
    // Кто-то отрисовался после нас — наш результат уже неактуален.
    if (mine !== generation) return;
    // Поломки окружения показываем сразу под интерпретатором: это важнее списка пакетов.
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
      nodes.push(box);
    }

    // Пакеты: сколько стоит, всё ли на месте из requirements.txt и быстрый путь поставить.
    const packageExtras: HTMLElement[] = [];
    if (requirementsText !== null) {
      // Сверяем установленное с файлом: так видно, чего не хватает, не запуская pip.
      const diff = diffRequirements(parseRequirements(requirementsText), packages);
      packageExtras.push(h('div', { class: 'python-env-requirements' }, requirementsNote(diff)));
      packageExtras.push(button('Установить из requirements.txt', () => deps.onInstallRequirements()));
    }
    nodes.push(
      section(
        'Пакеты',
        h(
          'div',
          { class: 'python-env-note' },
          packages.length > 0 ? `Установлено: ${packages.length}` : 'Список пуст — окружение недоступно',
        ),
        ...packageExtras,
      ),
    );

    // Окружения проекта: главное — первым. Порядок от main уже такой, но полагаться
    // на это не стоит — envList расставляет приоритет сам.
    const list = h('div', { class: 'python-env-list' });
    if (environments.length === 0) {
      list.appendChild(h('div', { class: 'python-env-empty' }, 'Виртуальных окружений нет.'));
    } else {
      for (const environment of envList(environments)) {
        list.appendChild(
          h(
            'div',
            { class: `python-env-item${environment.primary ? ' is-primary' : ''}` },
            h('span', { class: 'python-env-name' }, environment.label),
            environment.version ? h('span', { class: 'python-env-version' }, `Python ${environment.version}`) : null,
            environment.primary ? h('span', { class: 'python-env-badge' }, 'основное') : null,
            h('span', { class: 'python-env-path' }, environment.relative),
          ),
        );
      }
    }
    // Команда активации — рядом с окружениями: её копируют в сторонний терминал,
    // чтобы работать в том же venv, когда IDE его не активирует (внешняя оболочка).
    const envActions: HTMLElement[] = [];
    if (activation.command) {
      const command = activation.command;
      envActions.push(
        button('Скопировать команду активации', () => {
          void navigator.clipboard.writeText(command).then(
            () => showToast('Команда активации скопирована'),
            () => showToast('Не удалось скопировать', 'error'),
          );
        }),
      );
    }
    nodes.push(
      section(
        'Окружения',
        list,
        ...envActions,
        button('Создать окружение…', () => deps.onCreate()),
      ),
    );

    // Интерпретатор для этого проекта: выбор важнее общего, когда проектов несколько.
    const options: SelectOption[] = [{ value: '', label: 'Автоматически (окружение проекта)' }];
    for (const interpreter of interpreters) {
      options.push({ value: interpreter.command, label: interpreter.label, hint: interpreter.command });
    }
    interpreterSelect.setOptions(options);
    interpreterSelect.setValue(deps.projectPython?.() ?? '');
    nodes.push(section('Интерпретатор проекта', interpreterSelect.element));

    body.replaceChildren(...nodes);
  }

  return { element, refresh };
}
