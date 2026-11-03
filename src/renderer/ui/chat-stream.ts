import {
  ChatStreamEvent,
  type ChatAttachment,
  type ChatDeltaPayload,
  type ChatGoalPayload,
  type ChatMessage,
  type ChatPausedPayload,
  type ChatPlanPayload,
  type ChatReasoningPayload,
  type ChatStepPayload,
  type ChatStreamDone,
  type ChatToolResultPayload,
  type ChatToolStartPayload,
} from '../../shared/api';
import { perf } from '../../shared/perf';
import type { PermissionPreset } from '../../shared/permissions';
import type { ToolPresetId } from '../../shared/tool-presets';
import { addRunTrace } from '../../shared/usage';
import { describeRun, type ChatRunLog } from '../../shared/run-log';
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
  /** Права одним выбором: что агент делает без вопросов, а о чём спрашивает. */
  permission: PermissionPreset;
  planMode: boolean;
  /** Набор инструментов беседы: едет в запрос, иначе main возьмёт общий из настроек. */
  toolPreset: ToolPresetId;
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
  renderPlan(steps: ChatPlanPayload['steps'], session: ChatSession): void;
  /** Показать цель работы (или спрятать, когда она закрыта). */
  setGoal(goal: ChatGoalPayload['goal'], session: ChatSession): void;
  /** Спрятать план (генерация кончилась). */
  hidePlan(session: ChatSession): void;
  /** Перерисовать панель изменений после файловых операций инструмента. */
  renderChanges(): void;
  /**
   * Файлы, которые агент предъявил по итогам вызова (`presented`): лента
   * показывает карточку, а панель артефактов — постоянный список.
   */
  presentArtifacts(items: NonNullable<ChatToolResultPayload['presented']>, session: ChatSession): void;
  /** Чем агент занят прямо сейчас (`null` — работа кончилась). */
  busyHint(hint: string | null): void;
  /** Переключить «занято»: панель по этому гасит ввод и меняет кнопку. */
  setBusy(value: boolean, session: ChatSession): void;
  /** Прогон встал на паузу или снялся с неё (кнопка в композере и строка статуса). */
  setPaused(value: boolean, session: ChatSession): void;
  /** Закрыть открытые ожидания подтверждений (ревью правок, команда). */
  closeApprovals(): void;
  /** Сессия, которая сейчас стримит; `null` — стрим закончился. */
  setStreaming(session: ChatSession | null): void;
  /** Действия под готовым ответом: копировать, повторить, оценить. */
  attachActions(messageEl: HTMLElement, session: ChatSession): void;
  /** Кнопка «Продолжить» при обрыве: тот же путь, что обычный вопрос. */
  continueAnswer(): void;
  /** Пост-обработка конца потока: вкладки, инфо о сессии, сохранение. */
  afterStream(session: ChatSession): void;
  /**
   * Открыть файл-результат агента (show с action present) — как клик по файлу.
   * Место необязательно: `present` его присылает, только если модель назвала строку.
   */
  openFile(path: string, position?: { line?: number; column?: number }): Promise<void>;
  /** Открыть окно «Прогон» с трассой последнего прогона этой беседы. */
  openRunLog(session: ChatSession): void;
  /** Текущий режим (вопрос / агент / план) — уходит провайдеру. */
  modes(): StreamModes;
}

/** Чем кончился прогон: ответ дошёл, модель отказала или человек остановил. */
export type StreamOutcome = 'done' | 'failed' | 'stopped';

export interface StreamRunner {
  /** Отрисовать ответ на текущую историю беседы. */
  run(session: ChatSession, providerId: string, model: string, attachments: ChatAttachment[]): Promise<StreamOutcome>;
  /**
   * Пауза принята mainом — сообщить ленте СРАЗУ, не дожидаясь границы шага.
   *
   * Событие `paused` внутри стрима приходит только на границе шага: во время
   * длинного вызова или терминала это минута, и всё это время в ленте висело
   * «думает…», то есть строка продолжала утверждать, что работа идёт.
   */
  notePause(value: boolean): void;
}

/**
 * Сообщение истории без картинок. Картинки лежат в истории ради показа в ленте
 * (и повторной отрисовки), но на провод уходит только текущий вопрос: старые
 * изображения из истории повторно не шлём — иначе каждый ход нёс бы все
 * картинки беседы, раздувая контекст. Картинки текущего вопроса прикладывает
 * main из вложений (см. `attachImages` в `ai/service.ts`).
 */
function toWireMessage(message: ChatMessage): ChatMessage {
  if (!message.images?.length) return { ...message };
  const copy: ChatMessage = { role: message.role, content: message.content };
  if (message.name) copy.name = message.name;
  if (message.toolCallId) copy.toolCallId = message.toolCallId;
  if (message.toolCalls?.length) copy.toolCalls = message.toolCalls;
  return copy;
}

export function createStreamRunner(host: StreamHost): StreamRunner {
  /**
   * Буфер текущего текстового сегмента и кадр отложенной отрисовки. Живут в
   * модуле, а не в панели: вне стрима они не нужны никому.
   */
  let buffer = '';
  let frame = 0;
  /**
   * Живая строка работы текущего прогона. Нужна вне `run`: пауза приходит
   * отдельным уведомлением из main, а не событием стрима, и должна попасть
   * в ту же строку, не дожидаясь границы шага.
   */
  let liveActivity: ReturnType<typeof createActivity> | null = null;

  /** Индикатор работы ассистента: живёт внизу сообщения всю генерацию. */
  function createActivity(): {
    element: HTMLElement;
    /** Сменное действие: «думает…», «выполняю: read_file». */
    state(label: string): void;
    /** Постоянная часть: «шаг 7 из 24». Не перебивается действием. */
    step(label: string | null): void;
    hide(): void;
    dispose(): void;
  } {
    const stepLabel = h('span', { class: 'msg-activity-step', hidden: true });
    const label = h('span', { class: 'msg-activity-label' });
    const dots = h('span', { class: 'msg-activity-dots' }, h('i', {}), h('i', {}), h('i', {}));
    const element = h('div', { class: 'msg-activity', hidden: true }, dots, stepLabel, label);
    return {
      element,
      state(text: string) {
        label.textContent = text;
        element.hidden = false;
      },
      step(text: string | null) {
        // Шаг и действие живут в РАЗНЫХ узлах намеренно. Одним полем их не свести:
        // каждое событие действия (`выполняю…`, «думает…») затирало бы номер шага,
        // и «шаг 7 из 24» мелькал бы на мгновение вместо того, чтобы стоять весь шаг.
        stepLabel.textContent = text ?? '';
        stepLabel.hidden = !text;
        if (text) element.hidden = false;
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
  ): Promise<StreamOutcome> {
    // Ответ ассистента — это последовательность «текст → карточка инструмента →
    // текст», поэтому внутри одного сообщения живёт несколько текстовых сегментов.
    const messageEl = h('div', { class: 'msg msg-assistant' });
    host.messageHost(session).appendChild(messageEl);
    let segment = h('div', { class: 'msg-body' });
    messageEl.appendChild(segment);
    // Индикатор работы держим внизу сообщения: новые сегменты вставляем перед ним.
    const activity = createActivity();
    liveActivity = activity;
    messageEl.appendChild(activity.element);
    activity.state('думает…');
    // Сессия прогона — ДО ленты вызовов: первый же `tool_start` зовёт
    // `host.busyHint`, а тот ищет её в `streamingSession`. Ниже (строка 235)
    // `setStreaming` стоит уже после создания `tools`, и подсказка о первом
    // инструменте терялась бы или уходила не в ту вкладку.
    host.setStreaming(session);
    // Подряд идущие вызовы инструментов живут одной группой — см. createToolFeed.
    const tools = createToolFeed(
      messageEl,
      activity.element,
      () => host.scrollToEnd(session),
      (path, position) => host.openFile(path, position),
      // «Что именно идёт» — наружу, в шапку панели и док: свёрнутую группу
      // видит только тот, кто смотрит на ленту.
      (hint) => host.busyHint(hint),
    );
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

    buffer = '';
    host.hidePlan(session);
    host.scrollToEnd(session);
    // Ждём первого куска текста: ожидание человека видно в замерax.
    perf.begin('chat:first-token');
    let firstTokenSeen = false;

    const flushSegment = (): void => {
      cancelFrame();
      host.markdown.renderInto(segment, buffer);
    };

    host.setBusy(true, session);

    let continues = 0;
    let done: ChatStreamDone;
    // Итог прогона наружу: отказ модели и остановка человека — разные исходы.
    let outcome: StreamOutcome = 'failed';

    try {
      for (;;) {
        const modes = host.modes();
        done = await host.rpc.stream(
          'ai.chat',
          {
            providerId,
            model,
            messages: session.history.map(toWireMessage),
            useTools: modes.useTools,
            permission: modes.permission,
            planMode: modes.planMode,
            toolPreset: modes.toolPreset,
            // Открытая цель едет с каждым шагом прогона: агент мог поставить её
            // сам на первом шаге, и продолжение обязано её видеть.
            ...(session.goal && !session.goal.done ? { goal: session.goal.text } : {}),
            attachments,
            // Память чтений: без неё новый ход заново читал бы прочитанное (замер —
            // треть всех токенов чтений). Приходит обратно в `done`.
            ...(session.reads ? { reads: session.reads } : {}),
            // Беседа — для журнала прогонов: по ней строки одного разговора собираются вместе.
            conversationUid: session.uid,
          },
          (event, payload) => {
            if (event === ChatStreamEvent.Reasoning) {
              pushReasoning((payload as ChatReasoningPayload).text);
              activity.state('размышляет…');
              return;
            }
            if (event === ChatStreamEvent.Plan) {
              host.renderPlan((payload as ChatPlanPayload).steps, session);
              activity.state('строит план…');
              return;
            }
            if (event === ChatStreamEvent.Goal) {
              const update = payload as ChatGoalPayload;
              host.setGoal(update.goal, session);
              // Продолжение по цели: ответ уже был, но работа не закрыта —
              // индикатор говорит, что это не новый вопрос, а тот же.
              if (update.continued && update.limit) {
                activity.state(`продолжаю · ${update.continued}/${update.limit}`);
                // Текст продолжения — отдельный сегмент: иначе два ответа
                // слипнутся в один абзац, и будет не видно, где модель
                // останавливалась.
                flushSegment();
                buffer = '';
                segment = h('div', { class: 'msg-body' });
                messageEl.insertBefore(segment, activity.element);
                host.scrollToEnd(session);
              }
              return;
            }
            if (event === ChatStreamEvent.Step) {
              const { index, limit } = payload as ChatStepPayload;
              // Номер шага — с потолком, а не сам по себе: «шаг 7» ничего не говорит,
              // «шаг 7 из 24» говорит, сколько ещё ждать и когда рука должна лечь
              // на «стоп». Именно этого требует правило части — агент не должен
              // быть невидимым.
              activity.step(`шаг ${index} из ${limit}`);
              return;
            }
            if (event === ChatStreamEvent.Paused) {
              const { paused } = payload as ChatPausedPayload;
              host.setPaused(paused, session);
              // Строка статуса — рядом с «выполняю…»: видно, на чём именно встали.
              activity.state(paused ? 'пауза · продолжить — кнопка внизу' : 'думает…');
              return;
            }
            if (event === ChatStreamEvent.Delta) {
              cancelFrame();
              collapseReasoning();
              activity.hide();
              // Пошёл текст ответа — цепочка вызовов закончилась.
              tools.seal();
              // Замер «ожидание человека» закрываем один раз — на первом куске.
              if (!firstTokenSeen) {
                firstTokenSeen = true;
                perf.end('chat:first-token');
              }
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
              activity.state(`выполняю: ${toolLabel(call.name, call.args)}`);
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
              if (result.ok && result.presented?.length) host.presentArtifacts(result.presented, session);
            }
          },
        );

        flushSegment();
        collapseReasoning();
        tools.seal();
        // Пустой ответ в историю не кладём: он ничего не говорит, а следующий
        // запрос понёс бы его как реплику модели. Вызовы инструментов — другое
        // дело: даже с пустым текстом это часть хода, и без них история разойдётся
        // с лентой, которая карточки показывает.
        const messages = done.agentMessages ?? [{ role: 'assistant' as const, content: done.text }];
        if (messages.some((message) => message.content || message.toolCalls?.length)) {
          // Контекст и переписка пополняются одним и тем же: разойдутся они только
          // при сжатии — тогда контекст заменится резюме, а переписка останется.
          session.history.push(...messages);
          session.transcript.push(...messages);
        }
        session.usage = done.usage;
        // Этот расход — про текущую историю: именно по нему судим, попадает ли
        // кеш префикса, а не по прошлому ответу до сжатия.
        session.usageFresh = true;
        // След прогона копим в беседе: расход и число шагов видны за всё время,
        // а не только за последний шаг (см. «Информацию о сессии»).
        session.trace = addRunTrace(session.trace, done.trace);
        // Память чтений вернулась из прогона: кладём в беседу, чтобы следующий ход
        // знал, что уже прочитано, и не читал это снова.
        if (done.reads) session.reads = done.reads;

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
            h('button', { class: 'btn btn-small', type: 'button', onClick: () => host.continueAnswer() }, 'Продолжить'),
          ),
          activity.element,
        );
      }

      // Трасса прогона — в беседу, а под ответом короткая строка о нём: сколько
      // шло и из чего состояло. Подробности открываются окном «Прогон», но сама
      // строка отвечает на вопрос «почему так долго» без единого клика.
      if (done.run) {
        session.run = done.run;
        messageEl.insertBefore(
          runSummaryLine(done.run, () => host.openRunLog(session)),
          activity.element,
        );
      }

      host.attachActions(messageEl, session);
      host.scrollToEnd(session);
      outcome = 'done';
    } catch (error) {
      flushSegment();
      tools.seal();
      host.closeApprovals();
      if (error instanceof RpcError && error.cancelled) {
        outcome = 'stopped';
        segment.appendChild(h('div', { class: 'field-hint' }, 'генерация остановлена'));
        // Оборвали с самого начала — текста нет, и пустой реплике в истории не место.
        if (buffer) session.history.push({ role: 'assistant', content: buffer });
      } else {
        clear(segment);
        segment.appendChild(h('p', { class: 'msg-error' }, error instanceof Error ? error.message : String(error)));
        showToast('Не удалось получить ответ модели', 'error');
      }
    } finally {
      host.hidePlan(session);
      activity.dispose();
      // Строка ушла вместе с прогоном: пауза, пришедшая после конца, ей не адресована.
      if (liveActivity === activity) liveActivity = null;
      // ПОРЯДОК ВАЖЕН: `setStreaming(null)` обнуляет сессию прогона, а
      // `setBusy(false)` по ней решает, звать ли `finishRun` (заметка о конце
      // прогона, метка в доке, заголовок окна). Поменяй местами — и `finishRun`
      // не сработает никогда: условие `session === streamingSession` уже ложно.
      host.setBusy(false, session);
      host.setStreaming(null);
      // Правки агента на диск не пишем: сохранение — решение человека (кнопка
      // «Сохранить» в панели изменений). Здесь только обновляем вид панели.
      host.afterStream(session);
      void host.rpc
        .request('settings.update', { ai: { activeProviderId: providerId, activeModel: model } })
        .catch(() => undefined);
    }

    return outcome;
  }

  /**
   * Строка «заняло 5 м 24 с · 6 шагов · 14 вызовов» под ответом.
   *
   * Кнопка, а не просто текст: из строки видно порядок, а из окна — подробности.
   * Ведёт себя как остальные строки действий: та же высота, тот же кегль.
   */
  function runSummaryLine(run: ChatRunLog, open: () => void): HTMLElement {
    return h(
      'button',
      { class: 'run-summary', type: 'button', title: 'Показать прогон: шаги, вызовы и время', onClick: open },
      svgIcon('sparkle', 11),
      h('span', {}, describeRun(run)),
      h('span', { class: 'run-summary-more' }, 'прогон'),
    );
  }

  function scheduleRender(target: HTMLElement, session: ChatSession): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // Промежуточный кадр: незакрытый блок кода показываем без подсветки.
      host.markdown.renderInto(target, buffer, { streaming: true });
      host.scrollToEnd(session);
    });
  }

  function cancelFrame(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  return {
    run,
    notePause(value: boolean) {
      if (!liveActivity) return;
      liveActivity.state(value ? 'пауза · продолжить — кнопка внизу' : 'думает…');
    },
  };
}
