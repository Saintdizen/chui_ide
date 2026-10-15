import type { ReasoningEffort } from '../../shared/api';
import type { RpcClient } from '../core/rpc';
import { clear, h, svgIcon } from './dom';
import { createSelect } from './select';

/**
 * Панель ввода ассистента: поле вопроса, режим, права, модель и усилие
 * размышления.
 *
 * Вынесено из `chat.ts`: панель ведёт беседу, а сборка и индикация композера —
 * отдельная забота. Модуль владеет только своим состоянием (режим и права);
 * отправка, остановка, настройки и прикладывание контекста приходят колбэками.
 * Режим и права отдаются наружу через `modes()` — их читает прогон ответа.
 */

/** Режим работы панели: спросить, поработать с подтверждениями или наметить план. */
export type ChatMode = 'ask' | 'agent' | 'plan';

/** Что композеру нужно от панели. */
export interface ChatComposerDeps {
  rpc: RpcClient;
  /** Отправить набранное — Enter или кнопка. */
  onSend(text: string): void;
  /** Остановить генерацию. */
  onStop(): void;
  /** Открыть окно настроек (кнопка модели). */
  onOpenSettings(): void;
  /** Приложить контекст (скрепка — тот же список, что и «#»). */
  onContext(): void;
  /** Картинки из буфера вставки. */
  onPasteImages(files: File[]): void;
  /** Сменили усилие размышления. */
  onEffortChange(effort: ReasoningEffort): void;
}

/** Режим и права: их читает прогон ответа, чтобы решить, какими инструментами пользоваться. */
export interface ComposerModes {
  mode: ChatMode;
  useTools: boolean;
  planMode: boolean;
  autoApprove: boolean;
}

export interface ChatComposerView {
  /** Панель ввода целиком: поле вопроса и тулбар. */
  element: HTMLElement;
  /** Поле вопроса: панель пишет в него черновик и читает текст для отправки. */
  input: HTMLTextAreaElement;
  /** Значок режима для полосы статуса окна. */
  modeBadge: HTMLElement;
  /** Текущие режим и права. */
  modes(): ComposerModes;
  /** Идёт генерация: кнопка отправки превращается в «стоп», поле гаснет. */
  setBusy(busy: boolean): void;
  /** Подпись кнопки модели — «Провайдер - Модель». */
  setModel(providerLabel: string, model: string): void;
  /** Доступность усилия размышления — по возможностям выбранной модели. */
  setEffort(effort: ReasoningEffort, disabled: boolean, title: string): void;
}

export function createChatComposer(deps: ChatComposerDeps): ChatComposerView {
  /** Режим панели: ответ на вопрос, агент с подтверждениями или план без изменений. */
  let mode: ChatMode = 'ask';
  let useTools = false;
  let planMode = false;
  // Права доступа: кнопка в композере. Включено — команды и правки без вопросов.
  let autoApprove = false;
  let busy = false;

  const input = h('textarea', {
    class: 'chat-input',
    rows: 3,
    placeholder: 'Спросите о коде. «/» — команды, «#» — контекст, «@» — файл проекта (Enter — отправить)',
    spellcheck: false,
  });

  const actionButton = h('button', {
    class: 'icon-btn composer-action',
    type: 'button',
    onClick: () => {
      if (busy) deps.onStop();
      else deps.onSend(input.value);
    },
  });

  /**
   * Отправка и остановка — одна кнопка: во время генерации она превращается
   * в «стоп». Двух кнопок рядом не бывает: нажимать их одновременно нельзя.
   */
  function syncActionButton(): void {
    clear(actionButton);
    actionButton.appendChild(svgIcon(busy ? 'stop' : 'arrowUp', 16));
    actionButton.title = busy ? 'Остановить генерацию' : 'Отправить (Enter)';
    actionButton.classList.toggle('composer-action-send', !busy);
    actionButton.classList.toggle('composer-action-stop', busy);
  }

  const modeSelect = createSelect({
    class: 'composer-select',
    title:
      'Вопрос — просто ответ без инструментов. Агент — сам читает проект, правит файлы и запускает команды, ' +
      'но действия подтверждаете вы (права — кнопкой рядом). План — только читает проект и составляет план, ничего не меняя.',
  });
  modeSelect.setOptions([
    { value: 'ask', label: 'Вопрос', icon: 'bubble' },
    { value: 'agent', label: 'Агент', icon: 'wrench' },
    { value: 'plan', label: 'План', icon: 'checklist' },
  ]);
  modeSelect.onChange((value) => {
    mode = value as ChatMode;
    syncMode();
  });

  const modelButton = h(
    'button',
    {
      class: 'composer-model',
      type: 'button',
      title: 'Провайдер, модель, ключ',
      onClick: () => deps.onOpenSettings(),
    },
    svgIcon('sparkle', 12),
    h('span', {}, 'модель не выбрана'),
  );

  const effortSelect = createSelect({
    class: 'composer-select',
    title: 'Усилие размышления: сколько модель думает перед ответом',
  });
  effortSelect.setOptions([
    { value: 'off', label: 'Без размышлений' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ]);
  effortSelect.onChange((value) => deps.onEffortChange(value as ReasoningEffort));

  /**
   * Подсказку вешаем на обёртку: у выключенного контрола браузер не показывает
   * `title`, а именно там и нужно объяснить, почему он выключен.
   */
  const effortField = h('span', { class: 'composer-field' }, effortSelect.element);

  /** Значок статуса — тот же, что у режима в селекте: картинка и подпись совпадают. */
  const modeIcon = h('span', { class: 'composer-status-icon' }, svgIcon('bubble', 12));
  // Режим — только значком: слово («Инструменты выключены» и т. п.) висело в полосе
  // всегда и дублировало селект режима. Смысл остаётся в значке и в подсказке.
  const modeBadge = h('span', { class: 'composer-status-item' }, modeIcon);

  /**
   * Права доступа — отдельный тумблер, а не часть режима: включён — команды и правки
   * выполняются без вопросов, выключен — на каждое действие спрашиваем. В «Вопросе»
   * и «Плане» смысла не имеет: там менять нечего, поэтому кнопка недоступна.
   */
  const permButton = h('button', {
    class: 'icon-btn composer-perm',
    type: 'button',
    onClick: () => {
      autoApprove = !autoApprove;
      syncPermButton();
      // Сообщаем main: если агент уже работает, следующее действие возьмёт новые права.
      void deps.rpc.request('ai.setPermission', { autoApprove }).catch(() => undefined);
    },
  });

  /** Состояние кнопки прав: значок, подпись и активный вид — по текущему режиму. */
  function syncPermButton(): void {
    // Только в «Агенте» есть что разрешать: в «Вопросе» и «Плане» изменений нет.
    const canToggle = mode === 'agent';
    permButton.disabled = !canToggle;
    clear(permButton);
    permButton.appendChild(svgIcon(canToggle && autoApprove ? 'unlock' : 'lock', 14));
    permButton.classList.toggle('is-active', canToggle && autoApprove);
    permButton.title = !canToggle
      ? 'Права доступа: доступно в режиме «Агент»'
      : autoApprove
        ? 'Полный доступ: команды и правки выполняются без подтверждений'
        : 'Спрашивать разрешение на каждое действие';
  }

  /** Скрепка открывает тот же список контекста, что и «#»: его видно и без подсказки. */
  const contextButton = h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      title: 'Приложить контекст (или «#»)',
      onClick: () => deps.onContext(),
    },
    svgIcon('attach', 16),
  );

  // Вставка из буфера: screenshot в буфере — самое частое, что прикладывают к
  // вопросу. Текст с картинкой вместе вставляется как текст: картинку берём только
  // тогда, когда она в буфере есть отдельным файлом.
  input.addEventListener('paste', (event) => {
    const items = [...(event.clipboardData?.items ?? [])];
    const files = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;

    event.preventDefault();
    deps.onPasteImages(files);
  });

  /** Режим задаёт доступ к инструментам; права на изменения — отдельный тумблер. */
  function syncMode(): void {
    useTools = mode !== 'ask';
    planMode = mode === 'plan';
    modeSelect.setValue(mode);
    // Класс режима красит и селект, и статус одним цветом — см. main.css.
    for (const name of ['ask', 'agent', 'plan'] as const) {
      modeSelect.element.classList.toggle(`is-mode-${name}`, mode === name);
      modeBadge.classList.toggle(`is-mode-${name}`, mode === name);
    }
    // Значок статуса повторяет значок режима: «Вопрос» — реплика, «Агент» — ключ,
    // «План» — чек-лист. Раньше здесь всегда висел предупреждающий треугольник.
    const badgeIcon = mode === 'plan' ? 'checklist' : mode === 'agent' ? 'wrench' : 'bubble';
    clear(modeIcon);
    modeIcon.appendChild(svgIcon(badgeIcon, 12));
    modeBadge.title =
      mode === 'plan'
        ? 'План: только чтение, без изменений'
        : mode === 'agent'
          ? 'Инструменты разрешены'
          : 'Инструменты выключены';
    syncPermButton();
  }

  function setBusy(value: boolean): void {
    busy = value;
    input.disabled = value;
    syncActionButton();
  }

  /** Подпись кнопки модели — «Провайдер - Модель»: где и чем спрашиваем, видно сразу. */
  function setModel(providerLabel: string, model: string): void {
    const text = modelButton.lastElementChild;
    if (text) text.textContent = `${providerLabel} - ${model}`;
    modelButton.title = `${providerLabel} · ${model}\nНажмите, чтобы сменить провайдера, модель или ключ`;
  }

  function setEffort(effort: ReasoningEffort, disabled: boolean, title: string): void {
    effortSelect.setValue(effort);
    effortSelect.setDisabled(disabled);
    effortField.title = title;
  }

  const element = h(
    'div',
    { class: 'composer-box' },
    input,
    h(
      'div',
      { class: 'composer-toolbar' },
      h('div', { class: 'composer-group' }, modeSelect.element, permButton, modelButton, effortField),
      h('div', { class: 'composer-group composer-group-end' }, contextButton, actionButton),
    ),
  );

  syncMode();
  syncActionButton();

  return {
    element,
    input,
    modeBadge,
    modes: () => ({ mode, useTools, planMode, autoApprove }),
    setBusy,
    setModel,
    setEffort,
  };
}
