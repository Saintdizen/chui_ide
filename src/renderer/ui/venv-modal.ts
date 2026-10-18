import { VenvEvent, type VenvProgressPayload } from '../../shared/api';
import {
  DEFAULT_VENV_DIR,
  VENV_INSTALL_OPTIONS,
  VENV_LOCATIONS,
  type PythonEnvironment,
  type PythonInterpreter,
  type VenvInstallPreset,
  type VenvLocation,
} from '../../shared/python-env';
import { envList } from '../core/python-view';
import type { RpcClient } from '../core/rpc';
import { clear, h } from './dom';
import { createModal } from './modal';
import { createSelect, type SelectOption } from './select';
import { showToast } from './toast';

/**
 * Окно Python-окружений проекта.
 *
 * Показывает уже найденные venv и создаёт новое. Держим всё в одном окне:
 * человеку важно видеть, какое окружение главное (его берут запуск и подсказки),
 * и тут же завести новое, если подходящего нет.
 *
 * Создание — долгий процесс: вывод `python -m venv` и `pip install` идёт
 * событиями и рисуется в лог, иначе окно выглядит зависшим.
 */

export interface VenvModalDeps {
  rpc: RpcClient;
  /** Корень проекта: окружения ищем в нём. */
  root: () => string | null;
  /**
   * Окружение создано. Место могло быть и вне проекта — тогда вызывающий назначает его
   * интерпретатором проекта: поиск окружений в проекте такое окружение не найдёт никогда.
   */
  onCreated?: (environment: PythonEnvironment) => void;
  /**
   * Указать уже созданное окружение на диске. Окно для этого закрывается: диалог
   * папок — отдельное системное окно поверх IDE.
   */
  onPickExisting?: () => void;
}

export interface VenvModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

export function createVenvModal(deps: VenvModalDeps): VenvModalView {
  let environments: PythonEnvironment[] = [];
  let interpreters: PythonInterpreter[] = [];
  let hasRequirements = false;
  let creating = false;
  /** Отмена создания: кнопка «Отмена» прерывает вызов на стороне main. */
  let cancelRequested = false;

  const list = h('div', { class: 'venv-list' });
  const nameInput = h('input', {
    class: 'field-input',
    type: 'text',
    value: DEFAULT_VENV_DIR,
    spellcheck: 'false',
    placeholder: DEFAULT_VENV_DIR,
  });

  const presetSelect = createSelect({ title: 'Что поставить в новое окружение' });
  presetSelect.setOptions(VENV_INSTALL_OPTIONS.map((option) => ({ value: option.id, label: option.label })));
  presetSelect.setValue('pytest');
  presetSelect.onChange(() => updatePresetHint());

  // Выбор версии питона: у некоторых установленных нет модуля venv, и окружение
  // из них не создаётся — человек должен видеть список, а не получать ошибку.
  const baseSelect = createSelect({ title: 'Каким интерпретатором создавать окружение' });
  baseSelect.setOptions([{ value: '', label: 'Как в системе (по умолчанию)' }]);

  // Где создавать: рядом с кодом (обычный случай) или вне проекта — в `~/.venvs` либо
  // в своей папке. Общее окружение на несколько проектов внутри одного из них не сделать.
  const locationSelect = createSelect({ title: 'Где создать окружение' });
  locationSelect.setOptions(VENV_LOCATIONS.map((option) => ({ value: option.id, label: option.label })));
  locationSelect.setValue('project');
  const locationHint = h('div', { class: 'venv-hint' });

  const nameField = h('div', { class: 'venv-field' }, h('label', { class: 'venv-label' }, 'Каталог'), nameInput);

  const pathInput = h('input', {
    class: 'field-input',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'например, ~/.venvs/общий или /opt/venvs/проект',
  });
  const pickPathButton = h(
    'button',
    { class: 'btn btn-small', type: 'button', title: 'Выбрать папку на диске', onClick: () => void pickPath() },
    'Выбрать…',
  );
  const pathField = h(
    'div',
    { class: 'venv-field', hidden: true },
    h('label', { class: 'venv-label' }, 'Папка'),
    h('div', { class: 'venv-path-row' }, pathInput, pickPathButton),
  );

  const presetHint = h('div', { class: 'venv-hint' });

  const requirementsRow = h('label', { class: 'venv-check', hidden: true });
  const requirementsBox = h('input', { type: 'checkbox', checked: true });

  const log = h('pre', { class: 'venv-log', hidden: true });

  const createButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', onClick: () => void create() },
    'Создать окружение',
  );
  const cancelButton = h('button', { class: 'btn', type: 'button', hidden: true, onClick: () => cancel() }, 'Отмена');

  const modal = createModal({
    className: 'venv-modal',
    title: 'Python-окружения',
    headerIcon: 'terminal',
    footer: h('footer', { class: 'modal-footer' }, cancelButton, createButton),
    // Закрытие во время создания — это отмена: подрядчик обязан её получить.
    onClose: () => {
      if (creating) cancel();
    },
  });
  modal.body.classList.add('venv-body');
  modal.body.append(
    h(
      'section',
      { class: 'venv-section' },
      h('h3', { class: 'venv-heading' }, 'Найдено в проекте'),
      list,
      // Список — только окружения проекта. Своё, созданное раньше и, может быть, общее
      // на несколько проектов, тут не появится: его указывают вручную (см. `python.venvAt`).
      h(
        'button',
        {
          class: 'btn btn-small venv-pick',
          type: 'button',
          title: 'Взять окружение, которое уже есть на диске',
          onClick: () => {
            close();
            deps.onPickExisting?.();
          },
        },
        'Указать существующее…',
      ),
    ),
    h(
      'section',
      { class: 'venv-section' },
      h('h3', { class: 'venv-heading' }, 'Создать новое'),
      h('div', { class: 'venv-field' }, h('label', { class: 'venv-label' }, 'Где'), locationSelect.element),
      locationHint,
      nameField,
      pathField,
      h('div', { class: 'venv-field' }, h('label', { class: 'venv-label' }, 'Интерпретатор'), baseSelect.element),
      h('div', { class: 'venv-field' }, h('label', { class: 'venv-label' }, 'Пакеты'), presetSelect.element),
      presetHint,
      requirementsRow,
      log,
    ),
  );

  presetSelect.onChange(() => updatePresetHint());
  updatePresetHint();
  locationSelect.onChange(() => updateLocation());
  updateLocation();

  /* ── инфраструктура окна ───────────────────────────────────────────────── */

  function close(): void {
    modal.close();
  }

  function updatePresetHint(): void {
    const option = VENV_INSTALL_OPTIONS.find((item) => item.id === presetSelect.value);
    presetHint.textContent = option?.hint ?? '';
  }

  /**
   * Показывает только то, что относится к выбранному месту: имя каталога — для проекта
   * и `~/.venvs`, путь — для своей папки. Подсказка объясняет, что будет с окружением
   * после создания (найдут ли его запуск и подсказки сами).
   */
  function updateLocation(): void {
    const location = locationSelect.value as VenvLocation;
    const option = VENV_LOCATIONS.find((item) => item.id === location);
    locationHint.textContent = option?.hint ?? '';
    pathField.hidden = location !== 'custom';
    nameField.hidden = location === 'custom';
  }

  /** Выбрать папку окружения на диске — тот же диалог, что у стартового окна. */
  async function pickPath(): Promise<void> {
    const picked = await deps.rpc.request('dialog.pickFolder', { title: 'Где создать окружение' }).catch(() => null);
    if (!picked?.path) return;
    pathInput.value = picked.path;
  }

  /** Варианты интерпретаторов: найденные в системе плюс «как по умолчанию». */
  function renderInterpreters(): void {
    const options: SelectOption[] = [{ value: '', label: 'Как в системе (по умолчанию)' }];
    for (const interpreter of interpreters) {
      options.push({ value: interpreter.command, label: interpreter.label, hint: interpreter.command });
    }
    baseSelect.setOptions(options);
  }

  async function open(): Promise<void> {
    modal.open(nameInput);
    nameInput.value = DEFAULT_VENV_DIR;
    log.hidden = true;
    clear(log);
    await refresh();
    nameInput.focus();
    nameInput.select();
  }

  /** Перечитать окружения и наличие requirements.txt. */
  async function refresh(): Promise<void> {
    const root = deps.root();
    if (!root) {
      renderList();
      return;
    }
    const [foundEnvironments, foundInterpreters] = await Promise.all([
      deps.rpc.request('python.environments').catch(() => []),
      deps.rpc.request('python.interpreters').catch(() => []),
    ]);
    environments = foundEnvironments;
    interpreters = foundInterpreters;
    renderInterpreters();
    hasRequirements = await deps.rpc
      .request('workspace.stat', { path: `${root}/requirements.txt` })
      .then(() => true)
      .catch(() => false);
    requirementsRow.hidden = !hasRequirements;
    clear(requirementsRow);
    requirementsRow.append(requirementsBox, document.createTextNode(' Поставить зависимости из requirements.txt'));
    renderList();
  }

  function renderList(): void {
    clear(list);
    if (environments.length === 0) {
      list.appendChild(h('div', { class: 'venv-empty' }, 'Окружений нет. Создайте первое — оно станет основным.'));
      return;
    }
    for (const environment of envList(environments)) {
      list.appendChild(
        h(
          'div',
          { class: `venv-item${environment.primary ? ' is-primary' : ''}` },
          h('span', { class: 'venv-name' }, environment.label),
          environment.version ? h('span', { class: 'venv-version' }, `Python ${environment.version}`) : null,
          environment.primary ? h('span', { class: 'venv-badge' }, 'основное') : null,
          h('span', { class: 'venv-path' }, environment.relative),
        ),
      );
    }
  }

  function appendLog(message: string): void {
    log.hidden = false;
    log.textContent += `${message}\n`;
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(busy: boolean): void {
    creating = busy;
    createButton.toggleAttribute('disabled', busy);
    cancelButton.hidden = !busy;
    nameInput.toggleAttribute('disabled', busy);
    pathInput.toggleAttribute('disabled', busy);
    baseSelect.setDisabled(busy);
    locationSelect.setDisabled(busy);
  }

  function cancel(): void {
    if (!creating) return;
    cancelRequested = true;
    deps.rpc.cancelActive();
    appendLog('— отмена —');
  }

  async function create(): Promise<void> {
    const root = deps.root();
    if (!root || creating) return;

    clear(log);
    log.hidden = false;
    cancelRequested = false;
    setBusy(true);

    try {
      const result = await deps.rpc.stream(
        'python.createVenv',
        {
          name: nameInput.value.trim() || DEFAULT_VENV_DIR,
          location: locationSelect.value as VenvLocation,
          // Пусто — создаём в проекте рядом с кодом.
          path: locationSelect.value === 'custom' ? pathInput.value.trim() : undefined,
          // Пусто — создаём тем, что в системе по умолчанию (`python3`), иначе — выбранной версией.
          base: baseSelect.value || undefined,
          preset: presetSelect.value as VenvInstallPreset,
          installRequirements: hasRequirements && requirementsBox.checked,
        },
        (event, payload) => {
          if (event !== VenvEvent.Progress) return;
          appendLog((payload as VenvProgressPayload).message);
        },
      );

      const installed = result.installed.length > 0 ? ` В него поставлено: ${result.installed.join(', ')}.` : '';
      showToast(`Окружение ${result.environment.label} создано.${installed}`, 'info');
      await refresh();
      // Новое окружение становится основным — закрываем окно, работа продолжается в нём.
      close();
      // Окружение появилось: запуск, статусбар и языковой сервер должны увидеть его сразу.
      // Вне проекта его ещё надо назначить интерпретатором проекта — это решает вызывающий.
      deps.onCreated?.(result.environment);
    } catch (error) {
      if (cancelRequested) {
        showToast('Создание окружения отменено', 'info');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        appendLog(`Ошибка: ${message}`);
        showToast(message, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return { element: modal.element, open, close };
}
