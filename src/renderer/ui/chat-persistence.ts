import type { ChatConversation, ChatHistory, ChatMessage } from '../../shared/api';
import type { RpcClient } from '../core/rpc';
import type { WorkspaceModel } from '../core/workspace-model';
import type { ChatSession } from './chat-session';

/**
 * Сохранение и восстановление бесед.
 *
 * Источник истины — renderer: он собирает ленту и историю, а main только пишет и
 * читает файл по корню проекта. Здесь живёт вся эта возня, а панель лишь отдаёт
 * снимок бесед и принимает восстановленную историю: иначе переключение папок,
 * задержка записи и разбор чужого файла мешались бы с разговором с моделью.
 *
 * Пишем с задержкой: история меняется пачкой (вопрос → ответ → инструменты), а
 * файл нужен один на всю пачку. При смене папки прежняя записывается сразу —
 * иначе её правки уехали бы уже под новым корнем.
 */

/** Пауза перед записью: одна пачка правок — один файл. */
const SAVE_DELAY = 400;

let uidSeq = 0;

/**
 * Идентификатор беседы. Переживает перезапуск, поэтому не равен номеру вкладки:
 * после старта номера раздаются заново, а uid остаётся тем же — по нему беседа и
 * находится в сохранённой истории.
 */
export function newChatUid(): string {
  return `chat_${Date.now().toString(36)}_${((uidSeq += 1)).toString(36)}`;
}

/**
 * Сериализация беседы: лента DOM и незаписанные правки на диск не уходят —
 * сохраняем только то, что имеет смысл показать после перезапуска.
 */
export function serializeSession(session: ChatSession): ChatConversation {
  const copy = (message: ChatMessage): ChatMessage => {
    const item: ChatMessage = { role: message.role, content: message.content };
    if (message.name) item.name = message.name;
    if (message.toolCallId) item.toolCallId = message.toolCallId;
    if (message.rating) item.rating = message.rating;
    if (message.toolCalls?.length) item.toolCalls = message.toolCalls.map((call) => ({ ...call }));
    return item;
  };
  // Сжатие контекста не должно стирать переписку: `messages` — то, что читают,
  // `context` — то, что уйдёт модели. Пишем сжатый контекст только тогда, когда он
  // и правда отличается от переписки, иначе файл распух бы вдвое без причины.
  const compacted = session.history.length !== session.transcript.length;
  return {
    uid: session.uid,
    title: session.title,
    updatedAt: Date.now(),
    messages: session.transcript.map(copy),
    ...(compacted || session.transcript.length === 0 ? { context: session.history.map(copy) } : {}),
    // Набор инструментов — свойство беседы, а не общая настройка: иначе выбор в
    // одной вкладке менял бы поведение всех остальных.
    ...(session.toolPreset ? { toolPreset: session.toolPreset } : {}),
    // Перенесённый через сжатие контекст: без него после перезапуска следующий
    // пересказ потерял бы присланные файлы.
    ...(session.kept && session.kept.length > 0 ? { keptAttachments: session.kept.map((item) => ({ ...item })) } : {}),
    ...(session.usage ? { usage: { ...session.usage } } : {}),
    ...(session.trace ? { trace: { ...session.trace, usage: { ...session.trace.usage } } } : {}),
    // Цель переживает перезапуск: иначе окно, закрытое посреди работы, теряло бы
    // условие, ради которого она шла, и агент начинал бы следующий ход с нуля.
    ...(session.goal ? { goal: { ...session.goal } } : {}),
  };
}

export interface ChatPersistenceDeps {
  rpc: RpcClient;
  /** Рабочая папка: её корень — ключ, по которому main находит историю бесед. */
  workspace: WorkspaceModel;
  /** Снимок бесед панели: номер активной нужен, чтобы восстановить её же. */
  snapshot(): { sessions: readonly ChatSession[]; activeUid?: string };
  /** Восстановить беседы: построить вкладки и ленты — дело панели. */
  restore(history: ChatHistory): void;
  /** Корень сменился после старта (для подсказки `@` и прочего приданого). */
  onRootChanged(): void;
}

export interface ChatPersistence {
  /** Записать при следующей паузе: история меняется пачкой. */
  schedule(): void;
  /** Записать немедленно и снять отложенную запись. */
  flush(): void;
  /** Подхватить текущий корень и слушать его смену. */
  start(): void;
  /** Корень, к которому привязана история; null — проект ещё не открыт. */
  root(): string | null;
}

export function createChatPersistence(deps: ChatPersistenceDeps): ChatPersistence {
  /** Корень папки, к которой привязана текущая история: ключ сохранения. */
  let chatRoot: string | null = null;
  let saveTimer = 0;

  /** Записать беседы этой папки немедленно: снимок берём синхронно, до отправки. */
  function persistTo(root: string): void {
    const { sessions, activeUid } = deps.snapshot();
    const conversations = sessions.map(serializeSession);
    void deps.rpc
      .request('ai.chats.save', { root, conversations, ...(activeUid ? { activeUid } : {}) })
      .catch(() => undefined); // не сохранилось — не повод показывать ошибку в чате
  }

  function flush(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    if (chatRoot) persistTo(chatRoot);
  }

  function schedule(): void {
    if (!chatRoot) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      if (chatRoot) persistTo(chatRoot);
    }, SAVE_DELAY);
  }

  async function loadChats(root: string): Promise<void> {
    let history: ChatHistory;
    try {
      history = await deps.rpc.request('ai.chats.load', { root });
    } catch {
      return; // история — не то, ради чего стоит ломать открытие проекта
    }
    if (chatRoot !== root) return; // проект сменился, пока грузили
    deps.restore(history);
  }

  /**
   * Перейти к другой папке: сперва записать прежнюю, потом загрузить новую.
   * Пишем до смены `chatRoot` — сессии ещё принадлежат прежней папке.
   */
  function applyRoot(root: string | null): void {
    if (root === chatRoot) return;
    flush();
    chatRoot = root;
    if (root) void loadChats(root);
  }

  return {
    schedule,
    flush,
    root: () => chatRoot,
    start: () => {
      applyRoot(deps.workspace.root);
      deps.workspace.onDidChange(({ info }) => {
        applyRoot(info?.root ?? null);
        // Смена корня случилась уже после старта: панель обновляет производное
        // (список путей для `@`), а сама загрузка истории уже запущена выше.
        deps.onRootChanged();
      });
    },
  };
}
