import path from 'node:path';
import { ChatStore } from '../../ai/chat-store';
import { loadCommands } from '../../ai/commands';
import { SessionIndexStore } from '../../ai/session-index-store';
import { PushTopic, RpcErrorCode, type ChatRequest } from '../../../shared/api';
import { shouldReview, type ReviewVerdict } from '../../../shared/approval-review';
import { sanitizePlanExitDecision } from '../../../shared/plan-exit';
import { isDangerousCommand } from '../../ai/tool-rules';
import { pushToRenderers } from '../push';
import type { RpcServices } from '../context';
import { RpcFailure, type RpcRouter } from '../router';

/**
 * Ассистент: разговор, подсказки по коду, ключи провайдеров, поиск по прошлым
 * беседам, журнал прогонов.
 *
 * Здесь же два решения, которые принимает main, а не renderer:
 * - мастер-тумблер (`requireAiEnabled`): выключенный ассистент не ходит в сеть
 *   и не тратит токены ни через панель, ни через команду;
 * - второе мнение перед командой (`reviewCommand`): модель смотрит команду
 *   только если человек включил проверку, и не судит необратимое.
 *
 * Перенесено из `register.ts` без правок логики.
 */
export function registerAiMethods(router: RpcRouter, deps: RpcServices): void {
  /**
   * Ассистент выключается мастер-тумблером в настройках. Проверяем на входе:
   * выключенный AI не должен ни ходить в сеть, ни тратить токены — ни через
   * панель, ни через команду. Сохранённые ключи и провайдеры при этом целы.
   */
  const requireAiEnabled = (): void => {
    if (!deps.settings.get().ai.enabled) {
      throw new RpcFailure(RpcErrorCode.Disabled, 'AI выключен в настройках');
    }
  };

  /**
   * Второе мнение перед подтверждением команды. `null` — проверять нечего или
   * незачем: проверка выключена, команда необратима, ассистент выключен, сети нет.
   * Во всех этих случаях решение остаётся за человеком.
   */
  const reviewCommand = async (
    command: string,
    cwd: string | null,
    signal: AbortSignal,
  ): Promise<ReviewVerdict | null> => {
    const settings = deps.settings.get();
    if (!settings.ai.enabled) return null;
    if (
      !shouldReview(command, { enabled: settings.ai.approvalReview === true, dangerous: isDangerousCommand(command) })
    ) {
      return null;
    }
    return deps.ai.reviewCommand(command, cwd, signal);
  };

  router.register('ai.setApiKey', (params) => deps.settings.setApiKey(params.providerId, params.apiKey));
  // Права агента меняются и во время ответа: main хранит их и перечитывает перед действием.
  router.register('ai.setPermission', (params) => {
    deps.ai.setPermission(params.permission);
  });
  router.register('ai.clearApiKey', (params) => deps.settings.clearApiKey(params.providerId));
  // Проверка серверов MCP из настроек: поднимаем их и показываем инструменты.
  // Без этого кнопка в настройках была бы слепой — об ошибке знал бы только stderr.
  router.register('ai.mcpTools', () => deps.mcp?.status() ?? []);
  router.register('ai.setWebSearchKey', (params) => deps.settings.setWebSearchKey(params.apiKey));
  router.register('ai.clearWebSearchKey', () => deps.settings.clearWebSearchKey());
  router.register('ai.test', (params, ctx) => {
    requireAiEnabled();
    return deps.ai.testConnection(params, ctx.signal);
  });
  // Деньги на счету — для окна «Информация о сессии». Отдельно от `ai.test`:
  // список моделей для этой цифры не нужен, а спрашивают её часто.
  router.register('ai.balance', (_params, ctx) => deps.ai.accountBalance(ctx.signal));

  router.register('ai.chat', (request: ChatRequest, ctx) => {
    requireAiEnabled();
    return deps.ai.chat(
      request,
      (event, payload) => ctx.emit(event, payload),
      ctx.signal,
      // Правки и подтверждения живут в renderer: там документная модель, undo и интерфейс.
      {
        applyEdits: (edits, autoApprove) =>
          deps.host.request(ctx.sender, 'ai.applyEdits', { edits, autoApprove }, ctx.signal),
        applyPatches: (patches, autoApprove) =>
          deps.host.request(ctx.sender, 'ai.applyPatches', { patches, autoApprove }, ctx.signal),
        // Команду сперва смотрит модель (если человек включил проверку), и только
        // если она не решилась — спрашиваем человека. Необратимые команды идут к
        // человеку сразу: `rm -rf` — не тот случай, где модель судья.
        confirmCommand: async (command) => {
          const verdict = await reviewCommand(command, deps.workspace.rootPath(), ctx.signal);
          if (verdict?.decision === 'allow') {
            // Молча выполненное действие всё равно должно быть видно: строка в ленте
            // говорит, что команду разрешила проверка и почему.
            pushToRenderers(PushTopic.ApprovalReview, { command, reason: verdict.reason });
            return true;
          }
          // Проверка не решилась — её причина едет в карточку подсказкой: человеку
          // полезно знать, что именно смутило модель.
          const decision = await deps.host.request(
            ctx.sender,
            'ai.confirmCommand',
            { command, review: verdict ?? undefined },
            ctx.signal,
          );
          return decision.allowed;
        },
        confirmBrowser: (action) =>
          deps.host
            .request(ctx.sender, 'ai.confirmBrowser', { action }, ctx.signal)
            .then((decision) => decision.allowed),
        ask: (question, options) =>
          deps.host.request(ctx.sender, 'ai.ask', { question, options }, ctx.signal).then((result) => result.answer),
        // Утверждение плана: решение принимает renderer (он же переключает режим), а
        // сюда оно возвращается уже проверенным — «да» только при явном `approved`.
        exitPlan: (plan) =>
          deps.host
            .request(ctx.sender, 'ai.exitPlan', { plan }, ctx.signal)
            .then((result) => sanitizePlanExitDecision(result)),
        getDiagnostics: (path) => deps.host.request(ctx.sender, 'ai.getDiagnostics', { path }, ctx.signal),
        openFile: (path, line, column) =>
          deps.host.request(ctx.sender, 'ai.openFile', { path, line, column }, ctx.signal).then((result) => result.ok),
      },
    );
  });

  // Inline-автодополнение: короткий запрос без истории и инструментов.
  router.register('ai.complete', (params, ctx) => {
    requireAiEnabled();
    return deps.ai.completeInline(params, ctx.signal);
  });

  // Сообщение коммита по diff: один запрос, без истории и инструментов — как у подсказок.
  router.register('ai.commitMessage', (params, ctx) => {
    requireAiEnabled();
    return deps.ai.commitMessage(params, ctx.signal);
  });

  // Название беседы: тот же вид запроса — одна строка, без истории и инструментов.
  // Пустое название не ошибка: вкладка останется с заголовком по первому вопросу.
  router.register('ai.chatTitle', (params, ctx) => deps.ai.suggestTitle(params, ctx.signal));

  // Тест к выделенному коду: тоже один запрос без истории и инструментов.
  router.register('ai.generateTest', (params, ctx) => {
    requireAiEnabled();
    return deps.ai.generateTest(params, ctx.signal);
  });

  // История бесед: renderer её собирает, main только хранит. Каталог — рядом
  // с настройками, по одному файлу на рабочую папку.
  const chatStore = deps.chatStore ?? new ChatStore();

  // Поиск по прошлым беседам (`search: sessions`, `search: trace`). Правда —
  // файл беседы, а индекс рядом с ним — копия для поиска: отстал, пропал или
  // собран другой версией — пересоберётся из бесед, разговоры не пострадают.
  // Ищем только по открытому проекту: это правда, а не поломка, и так и
  // написано в ответе инструмента.
  const sessions = new SessionIndexStore({
    conversations: async (root) => (await chatStore.load(root)).conversations,
    chatFile: (root) => chatStore.fileForRoot(root),
    journal: async (root) => {
      const tail = await deps.telemetry?.tail();
      if (!tail) return [];
      const resolved = path.resolve(root);
      return tail.records.filter((record) => !record.project || path.resolve(record.project) === resolved);
    },
  });
  deps.ai.attachSessions({
    // Проекта нет — бесед тоже: пустой корень даёт пустую историю, а не ошибку.
    search: (query, options) => sessions.search(deps.workspace.rootPath() ?? '', query, options),
    trace: (uid) => sessions.trace(deps.workspace.rootPath() ?? '', uid),
  });
  // Журнал прогонов: файл лежит в пользовательских данных, то есть вне рабочей
  // папки — открыть его вкладкой редактора нельзя. Поэтому читает main, а окно
  // показывает последние записи и путь к файлу.
  router.register('ai.telemetry', async () => {
    const store = deps.telemetry;
    if (!store) return { enabled: false, path: '', bytes: 0, records: [] };
    const tail = await store.tail();
    return { enabled: store.enabled, path: tail.path, bytes: tail.bytes, records: tail.records.slice(-50) };
  });
  router.register('ai.telemetryClear', async () => {
    await deps.telemetry?.clear();
    return { ok: true };
  });
  router.register('ai.chats.load', (params) => chatStore.load(params.root));
  router.register('ai.chats.save', async (params) => {
    await chatStore.save(params.root, { conversations: params.conversations, activeUid: params.activeUid });
    // Индекс прошлых бесед отстал от файла: пересоберётся при следующем поиске.
    sessions.invalidate(params.root);
  });

  // Команды проекта (`.chui/commands`): готовые запросы для меню композера.
  // Читаем на каждый запрос: файл мог появиться только что, а стоит это два
  // чтения каталога — держать кэш и промахиваться мимо правки дороже.
  router.register('ai.commands', () => loadCommands(deps.workspace.rootPath()));
}
