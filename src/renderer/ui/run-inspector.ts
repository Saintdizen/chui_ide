import type { ChatRunLog, RunCallLog, RunStepLog } from '../../shared/run-log';
import { describeRun, formatDuration, plural, runTruncated } from '../../shared/run-log';
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

export function createRunInspector(): RunInspectorView {
  const modal = createModal({
    className: 'run-modal',
    title: 'Прогон агента',
    headerIcon: 'sparkle',
  });

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

  /** Один вызов: имя, время, аргументы, итог. */
  const callRow = (call: RunCallLog): HTMLElement => {
    const head = h(
      'div',
      { class: `run-call-head${call.ok ? '' : ' is-fail'}` },
      svgIcon(call.ok ? 'check' : 'close', 11),
      h('span', { class: 'run-call-name' }, call.name),
      call.note ? h('span', { class: 'run-call-note' }, call.note) : null,
      call.ms !== undefined ? h('span', { class: 'run-call-time' }, formatDuration(call.ms)) : null,
    );

    const body: Node[] = [h('div', { class: 'run-call-summary' }, call.summary)];
    if (call.detail) body.push(fold('Результат', pre(call.detail)));
    body.push(fold('Аргументы', pre(call.args)));

    return h('div', { class: 'run-call' }, head, ...body);
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
    for (const call of step.calls) body.push(callRow(call));

    // Шаг раскрыт, только если в нём что-то есть: пустой шаг — это строка и всё.
    const open = step.calls.length > 0 || Boolean(step.text?.trim());
    return h(
      'details',
      { class: 'run-step', ...(open ? { open: true } : {}) },
      h('summary', { class: 'run-step-head' }, svgIcon('chevron', 12), ...head),
      h('div', { class: 'run-step-body' }, ...body),
    );
  };

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

    clear(systemBox);
    systemBox.append(h('div', { class: 'run-section-title' }, 'Что ушло модели'), ...rows);
  }

  function render(log: ChatRunLog | null, title?: string): void {
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
