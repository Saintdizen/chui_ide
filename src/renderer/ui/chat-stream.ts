import {
  ChatStreamEvent,
  type ChatAttachment,
  type ChatDeltaPayload,
  type ChatPlanPayload,
  type ChatReasoningPayload,
  type ChatStreamDone,
  type ChatToolResultPayload,
  type ChatToolStartPayload,
} from '../../shared/api';
import type { RpcClient } from '../core/rpc';
import { RpcError } from '../core/rpc';
import type { createMarkdownRenderer } from './chat-markdown';
import type { ChatSession } from './chat-session';
import { createToolFeed, toolLabel, type ReasoningRowView, type ToolCardView } from './chat-tools';
import { clear, h, svgIcon } from './dom';
import { showToast } from './toast';

/**
 * Стриминг ответа ассистента в ленту беседы.
 *
 * Ответ — это последовательность «текст → карточка инструмента → текст», поэтому
 * внутри одного сообщения живёт несколько текстовых сегментов; между ними —
 * индикатор работы и лента вызовов. Раньше всё это было внутри `chat.ts`; вынесено
 * отдельным модулем, потому что это самая крупная и самая самодостаточная часть
 * панели (она умеет всё сама и лишь просит хозяина про прокрутку, занятость и
 * панели — см. `StreamHost`).
 *
 * Стриминг тесно сшит с панелью, поэтому хозяин передаёт сюда не состояние, а
 * действия: чем отрисовать markdown, куда подвинуть ленту, как показать план.
 */

/** Сколько раз автоматически достраиваем ответ, оборвавшийся по лимиту токенов. */
export const MAX_AUTO_CONTINUE = 2;
/** Запрос продолжения: ответ оборвался — просим дописать без повторов. */
export const CONTINUE_PROMPT =
  'Ответ оборвался по лимиту токенов. Продолжи ровно с того места, где остановился, без повторов.';

/** Режим отладки/инструментов на момент прогона: показываем его адаптеру как есть. */
export interface StreamModes {
  useTools: boolean;
  autoApprove: boolean;
  planMode: boolean;
}

/**
 * Что стримингу нужно от панели. Специально действия, а не объекты: сам стриминг
 * не хранит ни состояние беседы, ни панели — он только рисует ответ.
 */
export interface StreamHost {
  rpc: RpcClient;
  markdown: ReturnType<typeof createMarkdownRenderer>;
  /** Куда положить сообщение ассистента: текущий ход беседы. */
  messageHost(session: ChatSession): HTMLElement;
  /** Подтянуть ленту к низу (если пользователь её не читает). */
  scrollToEnd(session: ChatSession): void;
  /** Показать шаги плана агента. */
  renderPlan(steps: ChatPlanPayload['steps']): void;
  /** Спрятать план (генерация кончилась). */
  hidePlan(): void;
  /** Перерисовать панель изменений после файловых операций инструмента. */
  renderChanges(): void;
  /** Переключить «занято»: панель по этому гасит ввод и меняет кнопку. */
  setBusy(value: boolean, session: ChatSession): void;
  /** Закрыть открытые ожидания подтверждений (ревью правок, команда). */
  closeApprovals(): void;
  /** Записать на диск то, что правил агент (страховка после стрима). */
  persist(paths: Iterable<string>): Promise<void>;
  /** Сессия, которая сейчас стримит; `null` — стрим закончился. */
  setStreaming(session: ChatSession | null): void;
  /** Действия под готовым ответом: копировать, повторить, оценить. */
  attachActions(messageEl: HTMLElement, session: ChatSession): void;
  /** Кнопка «Продолжить» при обрыве: тот же путь, что обычный вопрос. */
  continueAnswer(): void;
  /** Пост-обработка конца потока: вкладки, инфо о сессии, сохранение. */
  afterStream(session: ChatSession): void;
  /** Текущий режим (вопрос / агент / план) — уходит провайдеру. */
  modes(): StreamModes;
}

export interface StreamRunner {
  /** Отрисовать ответ на текущую историю беседы. */
  run(session: ChatSession, providerId: string, model: string, attachments: ChatAttachment[]): Promise<void>;
}

export function createStreamRunner(host: StreamHost): StreamRunner {
  /**
   * Буфер текущего текстового сегмента и кадр отложенной отрисовки. Живут в
   * модуле, а не в панели: вне стрима они не нужны никому.
   */
  let buffer = '';
  let frame = 0;

  /** Индикатор работы ассистента: живёт внизу сообщения всю генерацию. */
  function createActivity(): {
    element: HTMLElement;
    state(label: string): void;
    hide(): void;
    dispose(): void;
  } {
    const label = h('span', { class: 'msg-activity-label' });
    const dots = h('span', { class: 'msg-activity-dots' }, h('i', {}), h('i', {}), h('i', {}));
    const element = h('div', { class: 'msg-activity', hidden: true }, dots, label);
    return {
      element,
      state(text: string) {
        label.textContent = text;
        element.hidden = false;
      },
      hide() {
        element.hidden = true;
      },
      dispose() {
        element.remove();
      },
    };
  }

  async function run(
    session: ChatSession,
    providerId: string,
    model: string,
    attachments: ChatAttachment[],
  ): Promise<void> {
    // Ответ ассистента — это последовательность «текст → карточка инструмента →
    // текст», поэтому внутри одного сообщения живёт несколько текстовых сегментов.
    const messageEl = h('div', { class: 'msg msg-assistant' });
    host.messageHost(session).appendChild(messageEl);
    let segment = h('div', { class: 'msg-body' });
    messageEl.appendChild(segment);
    // Индикатор работы держим внизу сообщения: новые сегменты вставляем перед ним.
    const activity = createActivity();
    messageEl.appendChild(activity.element);
    activity.state('думает…');
    // Подряд идущие вызовы инструментов живут одной группой — см. createToolFeed.
    const tools = createToolFeed(messageEl, activity.element, () => host.scrollToEnd(session));
    /** Размышления текущего шага: строка живёт в той же ленте, что и вызовы. */
    let reasoningView: ReasoningRowView | null = null;
    const toolCards = new Map<string, ToolCardView>();
    /** Размышления: строка живёт в ленте действий — заводим её лениво. */
    const pushReasoning = (text: string): void => {
      (reasoningView ??= tools.reasoning()).push(text);
    };
    /** Ответ начался или закончился — сворачиваем строку размышлений. */
    const collapseReasoning = (): void => {
      reasoningView?.collapse();
      reasoningView = null;
    };
    /** Замер скорости ответа: от первого текстового фрагмента до конца потока. */
    let firstDeltaAt = 0;
    let lastDeltaAt = 0;

    buffer = '';
    host.hidePlan();
    host.scrollToEnd(session);
    host.setStreaming(session);

    const flushSegment = (): void => {
      cancelFrame();
      host.markdown.renderInto(segment, buffer);
    };

    host.setBusy(true, session);

    let continues = 0;
    let done: ChatStreamDone;

    try {
      for (;;) {
        const modes = host.modes();
        done = await host.rpc.stream(
          'ai.chat',
          {
            providerId,
            model,
            messages: session.history.map((message) => ({ ...message })),
            useTools: modes.useTools,
            autoApprove: modes.autoApprove,
            planMode: modes.planMode,
            attachments,
          },
          (event, payload) => {
            if (event === ChatStreamEvent.Reasoning) {
              pushReasoning((payload as ChatReasoningPayload).text);
              activity.state('размышляет…');
              return;
            }
            if (event === ChatStreamEvent.Plan) {
              host.renderPlan((payload as ChatPlanPayload).steps);
              activity.state('строит план…');
              return;
            }
            if (event === ChatStreamEvent.Delta) {
              cancelFrame();
              collapseReasoning();
              activity.hide();
              // Пошёл текст ответа — цепочка вызовов закончилась.
              tools.seal();
              const now = performance.now();
              if (firstDeltaAt === 0) firstDeltaAt = now;
              lastDeltaAt = now;
              buffer += (payload as ChatDeltaPayload).text;
              scheduleRender(segment, session);
              return;
            }
            if (event === ChatStreamEvent.ToolStart) {
              const call = payload as ChatToolStartPayload;
              flushSegment();
              // Текст, после которого пошёл вызов инструмента, — промежуточный:
              // показываем пузырём, чтобы он не сливался со строками действий.
              segment.classList.add('msg-note');
              // Новый вызов — новый текстовый сегмент. Буфер держит текст ТОЛЬКО
              // текущего шага: иначе в следующий сегмент выльется весь предыдущий
              // текст и ответ будет повторяться в каждом пузыре.
              buffer = '';
              // Размышления пошаговые: закрываем текущую часть, следующая врезка
              // ляжет отдельным абзацем в ту же строку ленты.
              reasoningView?.part();
              toolCards.set(call.id, tools.add(call));
              activity.state(`выполняю: ${toolLabel(call.name)}`);
              segment = h('div', { class: 'msg-body' });
              messageEl.insertBefore(segment, activity.element);
              host.scrollToEnd(session);
              return;
            }
            if (event === ChatStreamEvent.ToolResult) {
              const result = payload as ChatToolResultPayload;
              toolCards.get(result.id)?.finish(result);
              activity.state('думает…');
              // Создание, удаление и перенос не идут через документы: панель
              // изменений узнаёт о них из результата инструмента.
              if (result.ok && result.changes?.length) {
                for (const change of result.changes) {
                  const at = session.files.findIndex((item) => item.path === change.path);
                  if (at >= 0) session.files[at] = change;
                  else session.files.push(change);
                }
                host.renderChanges();
              }
            }
          },
        );

        flushSegment();
        collapseReasoning();
        tools.seal();
        session.history.push(...(done.agentMessages ?? [{ role: 'assistant', content: done.text }]));
        session.usage = done.usage;

        // Скорость ответа: токены / время потока. Без обоих чисел не показываем.
        const completion = done.usage?.completionTokens;
        session.speed =
          completion !== undefined && firstDeltaAt > 0 && lastDeltaAt > firstDeltaAt
            ? completion / ((lastDeltaAt - firstDeltaAt) / 1000)
            : undefined;

        // Обрезано по лимиту — достраиваем сами, пока есть бюджет продолжений.
        if (done.finishReason !== 'length' || continues >= MAX_AUTO_CONTINUE) break;

        continues += 1;
        messageEl.insertBefore(
          h(
            'div',
            { class: 'finish-note is-continue' },
            svgIcon('refresh', 12),
            h('span', {}, `Продолжаю ответ · ${continues}/${MAX_AUTO_CONTINUE}`),
          ),
          activity.element,
        );
        session.history.push({ role: 'user', content: CONTINUE_PROMPT });
        // Продолжение — часть ТОГО ЖЕ ответа: новый сегмент в том же пузыре.
        segment = h('div', { class: 'msg-body' });
        messageEl.insertBefore(segment, activity.element);
        buffer = '';
        host.scrollToEnd(session);
      }

      // Дошли до предела продолжений, а ответ всё обрезан — оставляем ручную кнопку.
      if (done.finishReason === 'length') {
        messageEl.insertBefore(
          h(
            'div',
            { class: 'finish-note' },
            svgIcon('warning', 12),
            h('span', {}, 'Ответ обрезан по лимиту токенов'),
            h('button', { class: 'link-btn', type: 'button', onClick: () => host.continueAnswer() }, 'Продолжить'),
          ),
          activity.element,
        );
      }

      host.attachActions(messageEl, session);
      host.scrollToEnd(session);
    } catch (error) {
      flushSegment();
      tools.seal();
      host.closeApprovals();
      if (error instanceof RpcError && error.cancelled) {
        segment.appendChild(h('div', { class: 'field-hint' }, 'генерация остановлена'));
        session.history.push({ role: 'assistant', content: buffer });
      } else {
        clear(segment);
        segment.appendChild(h('p', { class: 'msg-error' }, error instanceof Error ? error.message : String(error)));
        showToast('Не удалось получить ответ модели', 'error');
      }
    } finally {
      host.hidePlan();
      activity.dispose();
      host.setStreaming(null);
      host.setBusy(false, session);
      // Правки уже на диске: их записал applyHostEdits сразу после применения.
      // Здесь остаётся только подстраховка — добить то, что не записалось.
      if (session.touched.size > 0) await host.persist(session.touched.keys());
      host.afterStream(session);
      void host.rpc
        .request('settings.update', { ai: { activeProviderId: providerId, activeModel: model } })
        .catch(() => undefined);
    }
  }

  function scheduleRender(target: HTMLElement, session: ChatSession): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      host.markdown.renderInto(target, buffer);
      host.scrollToEnd(session);
    });
  }

  function cancelFrame(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  return { run };
}
