import type {
  ChatMessage,
  ChatTitleResult,
  CommitMessageResult,
  InlineCompletionRequest,
  InlineCompletionResult,
  TestGenerationResult,
} from '../../shared/api';
import { RpcErrorCode } from '../../shared/api';
import type { ReviewVerdict } from '../../shared/approval-review';
import { REVIEW_SYSTEM_PROMPT, buildReviewPrompt, parseReviewVerdict } from '../../shared/approval-review';
import {
  buildTitlePrompt,
  cleanChatTitle,
  CHAT_TITLE_MAX_TOKENS,
  CHAT_TITLE_SYSTEM_PROMPT,
  type ChatTitleParts,
} from '../../shared/chat-title';
import {
  buildCommitPrompt,
  cleanCommitMessage,
  COMMIT_MAX_CHARS,
  COMMIT_MAX_TOKENS,
  COMMIT_SYSTEM_PROMPT,
  type CommitPromptParts,
} from '../../shared/commit-message';
import {
  cleanCompletion,
  INLINE_MAX_CHARS,
  INLINE_MAX_TOKENS,
  INLINE_SYSTEM_PROMPT,
  renderInlinePrompt,
} from '../../shared/inline-ai';
import {
  buildTestPrompt,
  cleanTestCode,
  TEST_MAX_CHARS,
  TEST_MAX_TOKENS,
  TEST_SYSTEM_PROMPT,
  type TestPromptParts,
} from '../../shared/test-generation';
import { RpcFailure } from '../ipc/router';
import type { AiProvider } from './provider';

/**
 * Модель, которая выбирается для коротких ответов: своя (`quickModel`), а без неё —
 * активная. Отдельной настройки «для мелочей» не заводим: это одна и та же работа.
 */
export interface QuickModelChoice {
  providerId: string;
  model: string;
}

/**
 * Что коротким запросам нужно от сервиса. Ключи и провайдеры остаются в
 * `AiService` — сюда приходят готовые ответы двух функций.
 */
export interface AiQueriesPorts {
  /** Активный провайдер, дешёвая модель и она же как запасная; `null` — не выбраны. */
  quickModel(): QuickModelChoice | null;
  /** Модель проверки команд (`reviewModel`), иначе активная. */
  reviewModel(): QuickModelChoice | null;
  /** Готовый провайдер по id. Ключ, отсутствие провайдера и baseUrl — забота сервиса. */
  provider(providerId: string): AiProvider;
}

/**
 * Короткие запросы к модели: подсказка в строке, сообщение коммита, тест к
 * выделению, название беседы и второе мнение о команде.
 *
 * Все они устроены одинаково, и это не совпадение: один запрос — один короткий
 * ответ. Ни истории беседы, ни инструментов, ни карты проекта — платить за
 * разговор там, где нужна строка, незачем. Дорого здесь только то, что общее
 * для всех: провайдер и ключ, а их поставляет `AiService`.
 */
export function createAiQueries(ports: AiQueriesPorts): {
  completeInline(request: InlineCompletionRequest, signal: AbortSignal): Promise<InlineCompletionResult>;
  reviewCommand(command: string, cwd: string | null, signal: AbortSignal): Promise<ReviewVerdict | null>;
  commitMessage(request: CommitPromptParts, signal: AbortSignal): Promise<CommitMessageResult>;
  generateTest(request: TestPromptParts, signal: AbortSignal): Promise<TestGenerationResult>;
  suggestTitle(request: ChatTitleParts, signal: AbortSignal): Promise<ChatTitleResult>;
} {
  const { quickModel, reviewModel, provider } = ports;

  /** Выбранная модель или отказ: у коротких запросов нет режима «без модели». */
  function requireQuick(whenMissing: string): { provider: AiProvider; model: string } {
    const choice = quickModel();
    if (!choice) throw new RpcFailure(RpcErrorCode.InvalidParams, whenMissing);
    return { provider: provider(choice.providerId), model: choice.model };
  }

  return {
    /**
     * Подсказка для inline-автодополнения: продолжить код в месте курсора.
     *
     * В отличие от `chat` здесь нет ни истории, ни инструментов — только контекст
     * вокруг курсора и короткий ответ. Модель берём дешёвую (`quickModel`), а
     * без неё — активную: отдельной настройки для подсказок не заводим.
     */
    async completeInline(request: InlineCompletionRequest, signal: AbortSignal): Promise<InlineCompletionResult> {
      const { provider: ai, model } = requireQuick('Не выбрана модель для подсказок (панель AI)');

      const messages: ChatMessage[] = [
        { role: 'system', content: INLINE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: renderInlinePrompt({
            language: request.language,
            relativePath: request.path,
            prefix: request.prefix,
            suffix: request.suffix,
          }),
        },
      ];

      let text = '';
      try {
        await ai.streamChat(
          { model, messages, temperature: 0.1, maxTokens: INLINE_MAX_TOKENS },
          {
            onDelta: (piece) => {
              // Потолок по символам: `maxTokens` — просьба, а не гарантия.
              if (text.length < INLINE_MAX_CHARS) text += piece;
            },
          },
          signal,
        );
      } catch (error) {
        // Отмена — это человек печатает дальше, а не сбой. Отдаём пусто: подсказка
        // не нужна, а ошибку в редакторе показывать негде.
        if (signal.aborted) return { text: '' };
        throw error;
      }

      return { text: cleanCompletion(text) };
    },

    /**
     * Проверка команды перед подтверждением: второе мнение модели.
     *
     * Обычный режим прав спрашивает обо всём, и на безобидных командах человек
     * начинает нажимать не читая. Этот запрос отвечает на один вопрос: можно ли
     * выполнить команду без спроса. Разбор ответа — в `shared/approval-review.ts`,
     * и он склонён к вопросу: непонятный ответ, обрыв и ошибка сети означают
     * «спросить человека», а не «разрешить».
     *
     * Своего предела времени здесь нет: прогон уже ограничен отменой (человек закрыл
     * карточку или остановил ответ), а жёсткий таймаут на подсказке грозил бы обрывом
     * нормального, но медленного ответа.
     *
     * `null` — проверять нечем или незачем (нет провайдера, нет модели, не
     * дождались). Это не отказ и не разрешение: решение остаётся за человеком,
     * и вызывающий просто показывает карточку.
     */
    async reviewCommand(command: string, cwd: string | null, signal: AbortSignal): Promise<ReviewVerdict | null> {
      const choice = reviewModel();
      if (!choice) return null;
      const ai = provider(choice.providerId);

      const messages: ChatMessage[] = [
        { role: 'system', content: REVIEW_SYSTEM_PROMPT },
        { role: 'user', content: buildReviewPrompt(command, cwd ?? undefined) },
      ];

      let text = '';
      try {
        await ai.streamChat(
          { model: choice.model, messages, temperature: 0, maxTokens: 60 },
          {
            onDelta: (piece) => {
              // Потолок и здесь: `maxTokens` — просьба, а не гарантия.
              if (text.length < 400) text += piece;
            },
          },
          signal,
        );
      } catch {
        // Сеть, таймаут, отказ провайдера — ни одного повода разрешить молча.
        return null;
      }

      return parseReviewVerdict(text);
    },

    /**
     * Сообщение коммита по diff.
     *
     * Один запрос — один короткий ответ, как у inline-подсказок: ни истории, ни
     * инструментов, ни карты проекта. Сообщение коммита — это не беседа, и платить
     * за беседу здесь незачем. Модель берём дешёвую (`quickModel`), а без неё —
     * активную: отдельной настройки для сообщений не заводим.
     */
    async commitMessage(request: CommitPromptParts, signal: AbortSignal): Promise<CommitMessageResult> {
      const { provider: ai, model } = requireQuick('Не выбрана модель (панель AI)');

      const messages: ChatMessage[] = [
        { role: 'system', content: COMMIT_SYSTEM_PROMPT },
        { role: 'user', content: buildCommitPrompt(request) },
      ];

      let text = '';
      await ai.streamChat(
        { model, messages, temperature: 0.2, maxTokens: COMMIT_MAX_TOKENS },
        {
          onDelta: (piece) => {
            // Потолок по символам: `maxTokens` — просьба, а не гарантия.
            if (text.length < COMMIT_MAX_CHARS) text += piece;
          },
        },
        signal,
      );

      return { message: cleanCommitMessage(text) };
    },

    /**
     * Тест к выделенному коду.
     *
     * Один запрос — один ответ, как у inline-подсказок и сообщения коммита: ни истории,
     * ни инструментов, ни карты проекта — платить за беседу тут незачем. Модель
     * берём дешёвую (`quickModel`), а без неё — активную.
     */
    async generateTest(request: TestPromptParts, signal: AbortSignal): Promise<TestGenerationResult> {
      const { provider: ai, model } = requireQuick('Не выбрана модель (панель AI)');

      const messages: ChatMessage[] = [
        { role: 'system', content: TEST_SYSTEM_PROMPT },
        { role: 'user', content: buildTestPrompt(request) },
      ];

      let text = '';
      await ai.streamChat(
        { model, messages, temperature: 0.2, maxTokens: TEST_MAX_TOKENS },
        {
          onDelta: (piece) => {
            // Потолок по символам: `maxTokens` — просьба, а не гарантия.
            if (text.length < TEST_MAX_CHARS) text += piece;
          },
        },
        signal,
      );

      return { code: cleanTestCode(text) };
    },

    /**
     * Название беседы по первому обмену.
     *
     * Один короткий запрос без истории, инструментов и карты проекта — как у
     * подсказок, сообщения коммита и генерации теста: название это строка, а не
     * разговор. Модель берём активную (выбранную в панели AI), отдельной настройки
     * для названий не заводим.
     *
     * Ошибку наверх не отдаём: не получилось — вкладка останется с заголовком по
     * вопросу, и это нормальный вид, а не сбой.
     */
    async suggestTitle(request: ChatTitleParts, signal: AbortSignal): Promise<ChatTitleResult> {
      const choice = quickModel();
      if (!choice) return { title: '' };

      let text = '';
      try {
        const ai = provider(choice.providerId);
        const messages: ChatMessage[] = [
          { role: 'system', content: CHAT_TITLE_SYSTEM_PROMPT },
          { role: 'user', content: buildTitlePrompt(request) },
        ];
        await ai.streamChat(
          {
            model: choice.model,
            messages,
            temperature: 0.2,
            maxTokens: CHAT_TITLE_MAX_TOKENS,
            // Название — одна строка. Обрываем на переводе строки: без него модель
            // договаривает пояснение, а каждый такой токен платный.
            stop: ['\n', '\n\n'],
          },
          {
            onDelta: (piece) => {
              // Потолок по символам: `maxTokens` — просьба, а не гарантия.
              if (text.length < 400) text += piece;
            },
          },
          signal,
        );
      } catch {
        // Молча: название — украшение, а не работа. Отменённый прогон тоже здесь.
        return { title: '' };
      }

      return { title: cleanChatTitle(text) };
    },
  };
}
