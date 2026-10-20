import type { ChatRunLog, RunCallLog, RunCost, RunStepLog } from '../../shared/run-log';
import {
  callSharePercent,
  describeRun,
  formatClock,
  formatDuration,
  formatThousands,
  plural,
  prettyJson,
  runCost,
  runTruncated,
} from '../../shared/run-log';
import { permissionSpec } from '../../shared/permissions';
import { clear, h, svgIcon } from './dom';
import { createModal } from './modal';

/**
 * Окно «Прогон»: что ушло модели и на что ушло время.
 *
 * Карточки в ленте показывают каждый вызов по отдельности и по ходу дела. Когда
 * прогон занял минуту или сорок тысяч токенов, вопрос «где именно» по ним не
 * решается: нужно целое — сколько было шагов, что стояло в системных инструкциях,
 * какие вызовы заняли время. Это окно и есть целое.
 *
 * Данные собирает main (`ChatRunLog`): только он знает настоящие системные
 * сообщения, состав предложенных инструментов и время каждой остановки модели.
 * Окно ничего не досчитывает — оно показывает то, что было.
 */
export interface RunInspectorView {
  element: HTMLElement;
  /** Показать трассу; `null` — прогонов ещё не было. */
  open(log: ChatRunLog | null, title?: string): void;
  close(): void;
}

/** Чем кончился прогон — словами, а не кодом. */
const FINISH_LABEL: Record<ChatRunLog['finished'], string> = {
  answer: 'завершён ответом',
  limit: 'остановлен по лимиту шагов',
  aborted: 'прерван',
};

/** Режим, в котором шёл прогон. */
const MODE_LABEL: Record<ChatRunLog['system']['mode'], string> = {
  question: 'Вопрос',
  agent: 'Агент',
  plan: 'План',
};

/**
 * Вкладки одного вызова. У вызова несколько разных сущностей: что он сделал,
 * с чем его позвали, что он вернул, какая форма аргументов была разрешена и
 * сколько это заняло. Сваленные в один список, они теряются; по вкладкам
 * видно сразу и только нужное.
 */
const CALL_TABS = [
  { id: 'summary', label: 'Сводка' },
  { id: 'payload', label: 'Аргументы' },
  { id: 'result', label: 'Результат' },
  { id: 'schema', label: 'Схема' },
  { id: 'timing', label: 'Время' },
] as const;

type CallTabId = (typeof CALL_TABS)[number]['id'];

export function createRunInspector(): RunInspectorView {
  const modal = createModal({
    className: 'run-modal',
    title: 'Прогон агента',
    headerIcon: 'sparkle',
  });

  /** Трасса, которую показываем сейчас: схемы инструментов лежат в ней. */
  let currentRun: ChatRunLog | null = null;

  /** Итоговая строка: длительность, шаги, вызовы, токены. */
  const summary = h('div', { class: 'run-total' });
  /** Что ушло модели: инструкции, контекст проекта, рамка запроса. */
  const systemBox = h('div', { class: 'run-system' });
  /** Шаги прогона. */
  const stepsBox = h('div', { class: 'run-steps' });
  const emptyBox = h('p', { class: 'run-empty' }, 'Прогонов ещё не было: спросите что-нибудь у ассистента.');

  modal.body.append(summary, systemBox, stepsBox, emptyBox);

  /** Раскрывающийся блок: свёрнутое — заголовок, внутри — текст. */
  const fold = (title: string, body: Node, options: { open?: boolean; className?: string } = {}): HTMLElement =>
    h(
      'details',
      { class: options.className ?? 'run-fold', ...(options.open ? { open: true } : {}) },
      h('summary', { class: 'run-fold-head' }, svgIcon('chevron', 12), title),
      h('div', { class: 'run-fold-body' }, body),
    );

  /** Текст без разметки: в трассе он нужен как есть, переносы важны. */
  const pre = (text: string, className = 'run-text'): HTMLElement => h('pre', { class: className }, text);

  /** Строка «ключ: значение» для вкладки времени. */
  const timingRow = (key: string, value: string): HTMLElement =>
    h(
      'div',
      { class: 'run-timing-row' },
      h('span', { class: 'run-timing-key' }, key),
      h('span', { class: 'run-timing-value' }, value),
    );

  /** Пояснение вместо содержимого: пустая вкладка без объяснения выглядит поломкой. */
  const hint = (text: string): HTMLElement => h('p', { class: 'run-call-hint' }, text);

  /** Вкладка «Время»: когда начался, сколько занял и какую часть шага составил. */
  const timingPanel = (call: RunCallLog, step: RunStepLog, ordinal: number): HTMLElement => {
    const rows: Node[] = [
      timingRow('начало', call.startedAt ? formatClock(call.startedAt) : 'не записано'),
      timingRow('длительность', call.ms !== undefined ? formatDuration(call.ms) : 'не измерена'),
    ];
    const share = callSharePercent(call.ms, step.ms);
    if (share !== null && call.ms !== undefined) {
      rows.push(timingRow('доля шага', `${share} % (весь шаг — ${formatDuration(step.ms)})`));
    }
    rows.push(timingRow('иерархия', `Шаг ${step.index} → вызов ${ordinal} из ${step.calls.length}`));
    if (call.note) rows.push(timingRow('пометка', call.note));
    return h('div', { class: 'run-call-panel' }, ...rows);
  };

  /**
   * Один вызов: имя, время и вкладки с его содержимым.
   *
   * Сводка открыта сразу — по ней решают, лезть ли дальше. Остальные вкладки
   * показывают то, чего в карточке ленты не было: аргументы по полям, полный
   * результат, форму аргументов, которую разрешал инструмент, и разбор времени.
   */
  const callRow = (call: RunCallLog, step: RunStepLog, ordinal: number): HTMLElement => {
    const head = h(
      'div',
      { class: `run-call-head${call.ok ? '' : ' is-fail'}` },
      svgIcon(call.ok ? 'check' : 'close', 11),
      h('span', { class: 'run-call-name' }, call.name),
      call.note ? h('span', { class: 'run-call-note' }, call.note) : null,
      call.ms !== undefined ? h('span', { class: 'run-call-time' }, formatDuration(call.ms)) : null,
    );

    const schemaText = currentRun?.schemas?.[call.name];
    const panels: Record<CallTabId, HTMLElement> = {
      summary: h('div', { class: 'run-call-panel' }, h('div', { class: 'run-call-summary' }, call.summary)),
      payload: h(
        'div',
        { class: 'run-call-panel' },
        call.args.trim() === '' ? hint('Аргументов не было.') : pre(prettyJson(call.args)),
      ),
      result: h(
        'div',
        { class: 'run-call-panel' },
        call.detail ? pre(call.detail) : hint('Подробностей не было: только сводка, она во вкладке «Сводка».'),
      ),
      schema: h(
        'div',
        { class: 'run-call-panel' },
        schemaText
          ? pre(prettyJson(schemaText))
          : hint('Схема в трассу не попала: модель не получала её в этом прогоне.'),
      ),
      timing: timingPanel(call, step, ordinal),
    };

    const strip = h('div', { class: 'run-call-tabs', role: 'tablist' });
    const buttons = new Map<CallTabId, HTMLElement>();
    const show = (tab: CallTabId): void => {
      for (const { id } of CALL_TABS) {
        panels[id].hidden = id !== tab;
        buttons.get(id)?.classList.toggle('is-active', id === tab);
      }
    };
    for (const { id, label } of CALL_TABS) {
      const button = h('button', { class: 'run-call-tab', type: 'button' }, label);
      button.addEventListener('click', () => show(id));
      buttons.set(id, button);
      strip.append(button);
    }
    show('summary');

    return h('div', { class: 'run-call' }, head, strip, ...CALL_TABS.map(({ id }) => panels[id]));
  };

  /** Один шаг: номер, время, сводка, что модель говорила и что звала. */
  const stepBlock = (step: RunStepLog): HTMLElement => {
    const callWord = plural(step.calls.length, 'вызов', 'вызова', 'вызовов');
    const head = [
      h('span', { class: 'run-step-index' }, `Шаг ${step.index}`),
      h('span', { class: 'run-step-time' }, formatDuration(step.ms)),
      h('span', { class: 'run-step-calls' }, callWord),
    ];

    const body: Node[] = [];
    if (step.note) body.push(h('p', { class: 'run-step-note' }, step.note));
    if (step.reasoning) body.push(fold('Размышления', pre(step.reasoning)));
    if (step.text?.trim()) body.push(h('div', { class: 'run-step-text' }, pre(step.text)));
    if (step.hiddenCalls) {
      body.push(h('p', { class: 'run-step-note' }, `ещё вызовов не показано: ${step.hiddenCalls}`));
    }
    for (const [position, call] of step.calls.entries()) body.push(callRow(call, step, position + 1));

    // Шаг раскрыт, только если в нём что-то есть: пустой шаг — это строка и всё.
    const open = step.calls.length > 0 || Boolean(step.text?.trim());
    return h(
      'details',
      { class: 'run-step', ...(open ? { open: true } : {}) },
      h('summary', { class: 'run-step-head' }, svgIcon('chevron', 12), ...head),
      h('div', { class: 'run-step-body' }, ...body),
    );
  };

  /**
   * Две статьи расхода одной строкой: схемы заплачены один раз и лежат в кеше
   * префикса, а результаты инструментов едут в контексте до конца прогона — они и
   * делают длинный прогон дорогим. Показываем рядом, чтобы это было видно.
   */
  function costLine(cost: RunCost): string {
    const per = cost.perStep === null ? '' : ` (в среднем ${formatThousands(cost.perStep)} на шаг)`;
    return (
      `схемы: ${formatThousands(cost.toolsTokens)} ток. · выводы: ` +
      `${formatThousands(cost.outputTokens)} ток. за ${cost.steps} шаг.${per}`
    );
  }

  function renderSystem(log: ChatRunLog): void {
    const system = log.system;
    const rows: Node[] = [
      h(
        'div',
        { class: 'run-frame' },
        h('span', {}, `модель: ${system.model}`),
        h('span', {}, `режим: ${MODE_LABEL[system.mode]}`),
        h('span', {}, `права: ${permissionSpec(system.permission).label}`),
        h('span', {}, `инструментов: ${system.tools}`),
      ),
    ];

    if (system.goal) rows.push(h('p', { class: 'run-frame-goal' }, `Цель: ${system.goal}`));
    if (system.attachments?.length) {
      rows.push(
        h(
          'div',
          { class: 'run-attachments' },
          h('span', { class: 'run-attachments-label' }, 'приложено:'),
          ...system.attachments.map((item) => h('span', { class: 'run-attachment' }, item)),
        ),
      );
    }
    if (system.instructions) rows.push(fold('Системные инструкции', pre(system.instructions)));
    else rows.push(h('p', { class: 'run-step-note' }, 'Системных инструкций не было.'));
    if (system.context) rows.push(fold('Контекст проекта', pre(system.context)));

    // Разделение важнее самих чисел: схемы дальше в префиксе запроса (их кеширует
    // провайдер), а выводы растут с каждым шагом. Здесь видно, что именно дорого.
    const cost = runCost(log);
    if (cost.outputTokens > 0) rows.push(h('p', { class: 'run-step-note' }, costLine(cost)));

    clear(systemBox);
    systemBox.append(h('div', { class: 'run-section-title' }, 'Что ушло модели'), ...rows);
  }

  function render(log: ChatRunLog | null, title?: string): void {
    currentRun = log;
    clear(summary);
    clear(systemBox);
    clear(stepsBox);
    emptyBox.hidden = Boolean(log);
    if (!log) return;

    summary.append(
      h('div', { class: 'run-total-text' }, describeRun(log)),
      h('div', { class: 'run-total-finish' }, FINISH_LABEL[log.finished]),
      ...(runTruncated(log) ? [h('div', { class: 'run-total-note' }, 'трасса обрезана по потолкам')] : []),
      ...(log.subagents ?? []).map((sub) =>
        h(
          'div',
          { class: 'run-subagent' },
          `подзадача «${sub.description}»: ${plural(sub.steps, 'шаг', 'шага', 'шагов')}, ` +
            `${plural(sub.toolCalls, 'вызов', 'вызова', 'вызовов')}`,
        ),
      ),
    );
    if (title) summary.append(h('div', { class: 'run-total-note' }, title));

    renderSystem(log);
    stepsBox.append(h('div', { class: 'run-section-title' }, 'Шаги прогона'));
    for (const step of log.steps) stepsBox.append(stepBlock(step));
    if (log.steps.length === 0) stepsBox.append(h('p', { class: 'run-step-note' }, 'Шагов не было.'));
  }

  return {
    element: modal.element,
    open: (log, title) => {
      render(log, title);
      modal.open();
    },
    close: () => modal.close(),
  };
}
