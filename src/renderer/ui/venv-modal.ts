import { VenvEvent, type VenvProgressPayload } from '../../shared/api';
import {
  DEFAULT_VENV_DIR,
  VENV_INSTALL_OPTIONS,
  type PythonEnvironment,
  type PythonInterpreter,
  type VenvInstallPreset,
} from '../../shared/python-env';
import type { RpcClient } from '../core/rpc';
import { clear, h, svgIcon } from './dom';
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
  /** Окружение создано: запуск, подсказки и статусбар должны увидеть его сразу. */
  onCreated?: () => void;
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

  const presetHint = h('div', { class: 'venv-hint' });

  const requirementsRow = h('label', { class: 'venv-check', hidden: true });
  const requirementsBox = h('input', { type: 'checkbox', checked: true });

  const log = h('pre', { class: 'venv-log', hidden: true });

  const createButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button', onClick: () => void create() },
    'Создать окружение',
  );
  const cancelButton = h(
    'button',
    { class: 'link-btn', type: 'button', hidden: true, onClick: () => cancel() },
    'Отмена',
  );

  const title = h('span', { class: 'modal-title' }, 'Python-окружения');
  const closeButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Закрыть (Esc)', onClick: () => close() },
    svgIcon('close', 15),
  );

  const element = h(
    'div',
    { class: 'modal-backdrop', hidden: true },
    h(
      'div',
      { class: 'modal venv-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Виртуальные окружения Python' },
      h('header', { class: 'modal-header' }, svgIcon('terminal', 15), title, closeButton),
      h(
        'div',
        { class: 'modal-body venv-body' },
        h('section', { class: 'venv-section' }, h('h3', { class: 'venv-heading' }, 'Найдено в проекте'), list),
        h(
          'section',
          { class: 'venv-section' },
          h('h3', { class: 'venv-heading' }, 'Создать новое'),
          h('div', { class: 'venv-field' }, h('label', { class: 'venv-label' }, 'Каталог'), nameInput),
          h('div', { class: 'venv-field' }, h('label', { class: 'venv-label' }, 'Интерпретатор'), baseSelect.element),
          h('div', { class: 'venv-field' }, h('label', { class: 'venv-label' }, 'Пакеты'), presetSelect.element),
          presetHint,
          requirementsRow,
          log,
        ),
      ),
      h('footer', { class: 'modal-footer' }, cancelButton, createButton),
    ),
  );

  presetSelect.onChange(() => updatePresetHint());
  updatePresetHint();

  /* ── инфраструктура окна ───────────────────────────────────────────────── */

  function isOpen(): boolean {
    return !element.hidden;
  }

  function close(): void {
    if (!isOpen()) return;
    if (creating) cancel();
    element.hidden = true;
    document.removeEventListener('keydown', onKeyDown, true);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  }

  function updatePresetHint(): void {
    const option = VENV_INSTALL_OPTIONS.find((item) => item.id === presetSelect.value);
    presetHint.textContent = option?.hint ?? '';
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
    element.hidden = false;
    document.addEventListener('keydown', onKeyDown, true);
    nameInput.value = DEFAULT_VENV_DIR;
    log.hidden = true;
    clear(log);
    await refresh();
    nameInput.focus();
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
    for (const environment of environments) {
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
    baseSelect.setDisabled(busy);
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
      const result = await deps.rpc.stream('python.createVenv', {
        name: nameInput.value.trim() || DEFAULT_VENV_DIR,
        // Пусто — создаём тем, что в системе по умолчанию (`python3`), иначе — выбранной версией.
        base: baseSelect.value || undefined,
        preset: presetSelect.value as VenvInstallPreset,
        installRequirements: hasRequirements && requirementsBox.checked,
      }, (event, payload) => {
        if (event !== VenvEvent.Progress) return;
        appendLog((payload as VenvProgressPayload).message);
      });

      const installed = result.installed.length > 0 ? ` В него поставлено: ${result.installed.join(', ')}.` : '';
      showToast(`Окружение ${result.environment.label} создано.${installed}`, 'info');
      await refresh();
      // Новое окружение становится основным — закрываем окно, работа продолжается в нём.
      close();
      // Окружение появилось: запуск, статусбар и языковой сервер должны увидеть его сразу.
      deps.onCreated?.();
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

  return { element, open, close };
}
