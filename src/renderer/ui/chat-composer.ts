import type { ReasoningEffort } from '../../shared/api';
import { PERMISSION_PRESETS, permissionSpec, type PermissionPreset } from '../../shared/permissions';
import { DEFAULT_TOOL_PRESET, TOOL_PRESETS, toolPresetSpec, type ToolPresetId } from '../../shared/tool-presets';
import type { RpcClient } from '../core/rpc';
import { clear, h, svgIcon, type IconName } from './dom';
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
  /** Сменили набор инструментов: какие схемы уедут модели в запросе. */
  onToolPresetChange(preset: ToolPresetId): void;
}

/** Режим и права: их читает прогон ответа, чтобы решить, какими инструментами пользоваться. */
export interface ComposerModes {
  mode: ChatMode;
  useTools: boolean;
  planMode: boolean;
  /** Права одним выбором: что спрашивать у человека, а что делать сразу. */
  permission: PermissionPreset;
}

export interface ChatComposerView {
  /** Панель ввода целиком: поле вопроса и тулбар. */
  element: HTMLElement;
  /**
   * Слот над полем внутри карточки: сюда панель чата кладёт план, изменённые файлы
   * и чипы приложенного контекста. Они про набираемый вопрос, а не про ленту.
   */
  extras: HTMLElement;
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
  /** Набор инструментов: хранят его настройки, композер только показывает выбор. */
  setToolPreset(preset: ToolPresetId): void;
}

export function createChatComposer(deps: ChatComposerDeps): ChatComposerView {
  /** Режим панели: ответ на вопрос, агент с подтверждениями или план без изменений. */
  let mode: ChatMode = 'ask';
  let useTools = false;
  let planMode = false;
  // Права: выбор в композере. По умолчанию спрашиваем обо всём — как и было у тумблера.
  let permission: PermissionPreset = 'ask';
  // Набор инструментов: по умолчанию полный — как и в настройках.
  let toolPreset: ToolPresetId = DEFAULT_TOOL_PRESET;
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
    // Отправка подписана клавишей Enter (↵), а не стрелкой вверх: стрелка читалась
    // как «поднять/увеличить», хотя кнопка отправляет набранное.
    actionButton.appendChild(svgIcon(busy ? 'stop' : 'enter', 16));
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

  /** Подпись модели держим ссылкой: искомый «последний ребёнок» — хрупко. */
  const modelLabel = h('span', {}, 'модель не выбрана');
  const modelButton = h(
    'button',
    {
      class: 'composer-model',
      type: 'button',
      title: 'Провайдер, модель, ключ',
      onClick: () => deps.onOpenSettings(),
    },
    svgIcon('sparkle', 12),
    modelLabel,
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
   * Права — свой выбор, а не часть режима: «Агент» только разрешает инструменты, а
   * что из их действий делать без вопросов — отдельное решение. Пунктов три, потому
   * что рычагов два (правки и команды) и середина между ними нужнее всего: правки
   * видно в панели изменений и можно отменить, а `npm install` отменять нечем.
   * В «Вопросе» и «Плане» менять нечего — выбор недоступен.
   */
  const permSelect = createSelect({ class: 'composer-select composer-perm' });
  permSelect.setOptions(
    PERMISSION_PRESETS.map((item) => ({
      value: item.id,
      label: item.label,
      icon: item.icon as IconName,
      hint: item.hint,
    })),
  );
  permSelect.onChange((value) => {
    permission = value as PermissionPreset;
    syncPerm();
    // Сообщаем main: если агент уже работает, следующее действие возьмёт новые права.
    void deps.rpc.request('ai.setPermission', { permission }).catch(() => undefined);
  });

  /** Состояние выбора прав: подсказка и вид — по текущему режиму. */
  function syncPerm(): void {
    // Только в «Агенте» есть что разрешать: в «Вопросе» и «Плане» изменений нет.
    const canChoose = mode === 'agent';
    permSelect.setDisabled(!canChoose);
    permSelect.setValue(permission);
    // Подсветка у всего, что снимает вопрос; «Спрашивать» — обычный вид.
    permSelect.element.classList.toggle('is-active', canChoose && permission !== 'ask');
    permSelect.element.title = !canChoose
      ? 'Права доступа: доступно в режиме «Агент»'
      : `Права доступа: ${permissionSpec(permission).hint}`;
  }

  /**
   * Набор инструментов: схемы едут в КАЖДОМ запросе, и полный набор — это 11 000
   * токенов. Задаче «прочитай и объясни» нет причин платить за терминал, браузер и
   * git-push. Устроено как права: отдельный выбор рядом, действует в «Агенте».
   */
  const presetSelect = createSelect({ class: 'composer-select composer-preset' });
  presetSelect.setOptions(
    TOOL_PRESETS.map((item) => ({
      value: item.id,
      label: item.label,
      icon: item.icon as IconName,
      hint: item.hint,
    })),
  );
  presetSelect.onChange((value) => {
    toolPreset = value as ToolPresetId;
    syncPreset();
    deps.onToolPresetChange(toolPreset);
  });

  /**
   * Состояние выбора набора: подсказка и вид — по режиму. В «Вопросе» инструментов
   * нет, в «Плане» набор и так сужен до чтения — выбирать нечего.
   */
  function syncPreset(): void {
    const canChoose = mode === 'agent';
    presetSelect.setDisabled(!canChoose);
    presetSelect.setValue(toolPreset);
    // Суженный набор видно не раскрыв список: это важное состояние, а не мелочь.
    presetSelect.element.classList.toggle('is-active', canChoose && toolPreset !== 'full');
    presetSelect.element.title = !canChoose
      ? 'Набор инструментов: доступен в режиме «Агент»'
      : `Набор инструментов: ${toolPresetSpec(toolPreset).hint}`;
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
    syncPerm();
    syncPreset();
  }

  function setBusy(value: boolean): void {
    busy = value;
    input.disabled = value;
    syncActionButton();
  }

  /** Подпись кнопки модели — «Провайдер - Модель»: где и чем спрашиваем, видно сразу. */
  function setModel(providerLabel: string, model: string): void {
    modelLabel.textContent = `${providerLabel} - ${model}`;
    modelButton.title = `${providerLabel} · ${model}\nНажмите, чтобы сменить провайдера, модель или ключ`;
  }

  function setEffort(effort: ReasoningEffort, disabled: boolean, title: string): void {
    effortSelect.setValue(effort);
    effortSelect.setDisabled(disabled);
    effortField.title = title;
  }

  /** Набор пришёл из настроек: его мог сменить и композер, и другое окно. */
  function setToolPreset(preset: ToolPresetId): void {
    toolPreset = preset;
    syncPreset();
  }

  /**
   * Слот над полем ввода: панель плана, изменённые файлы и чипы приложенного
   * контекста. Всё это относится к ВОПРОСУ, который человек набирает, а не к ленте
   * беседы, поэтому живёт в самой карточке композера. Раскладку стопки держит
   * карточка (flex-колонка с шагом 5 px), а `hidden` у невидимых панелей убирает их
   * из потока — пустых полос над полем не остаётся.
   */
  const extras = h('div', { class: 'composer-extras' });

  const element = h(
    'div',
    { class: 'composer-box' },
    extras,
    input,
    h(
      'div',
      { class: 'composer-toolbar' },
      h(
        'div',
        { class: 'composer-group' },
        modeSelect.element,
        permSelect.element,
        presetSelect.element,
        modelButton,
        effortField,
      ),
      h('div', { class: 'composer-group composer-group-end' }, contextButton, actionButton),
    ),
  );

  syncMode();
  syncActionButton();

  return {
    element,
    /** Куда панель чата кладёт свои надстройки над полем (план, изменения, чипы). */
    extras,
    input,
    modeBadge,
    modes: () => ({ mode, useTools, planMode, permission }),
    setBusy,
    setModel,
    setEffort,
    setToolPreset,
  };
}
