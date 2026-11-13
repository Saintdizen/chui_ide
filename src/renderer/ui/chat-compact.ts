import { keptContextMessage } from '../../shared/chat-attachments';
import { compactionFacts, type CompactionFacts } from '../../shared/compaction-facts';
import { splitTranscript } from '../../shared/context-fit';
import type { ChatSession } from './chat-session';
import { plural } from './chat-text';
import { h, svgIcon } from './dom';

/**
 * Сжатие беседы: старая история заменяется резюме. Пересказ просим у модели сжатия —
 * по умолчанию той же, что и беседа, но её можно задать в настройках (`ai.compactModel`).
 */
const COMPACT_PROMPT = [
  'Сожми нашу беседу в краткое резюме, чтобы продолжить работу с ним вместо истории.',
  'Сохрани: что просил пользователь, какие файлы менялись, принятые решения, найденные ошибки',
  'и что осталось сделать. Пиши по пунктам, без вступлений и без кода целиком.',
].join('\n');

/**
 * Второй проход и дальше: продолжаем уже начатое резюме, а не начинаем заново —
 * иначе каждый блок вытеснял бы из резюме предыдущий, и середина беседы терялась
 * ровно так же, как при старом «сжимаем только хвост».
 */
const COMPACT_CONTINUE_PROMPT = [
  'Дополни существующее резюме с учётом новой части беседы. Не пересказывай заново,',
  'добавь только то, что в резюме ещё нет: запросы пользователя, изменённые файлы,',
  'принятые решения, найденные ошибки, что осталось сделать. Пиши по пунктам, без кода целиком.',
].join('\n');

export interface ChatCompactDeps {
  /** Провайдер и модель сжатия; пустой провайдер или модель — сжимать нечем. */
  target: () => { providerId: string | null; model: string };
  /** Бюджет одного прохода сжатия, в символах. */
  budget: () => number;
  /** Один запрос к модели без инструментов; возвращает текст ответа. */
  complete: (args: { providerId: string; model: string; prompt: string }) => Promise<string>;
  notify: (text: string, kind?: 'info' | 'error') => void;
  /** Прогон начался/кончился: композер и диктор должны знать. */
  setBusy: (value: boolean) => void;
  /** Спрятать поповер сведений: он висит над лентой и мешает читать итог. */
  beforeStart: () => void;
  /** Записать беседы с задержкой. */
  save: () => void;
  /** Сводка для ленты: «что вошло в резюме» считается до замены истории. */
  renderSummary: (session: ChatSession, before: number, summary: string, facts: CompactionFacts) => void;
  /** Сжатие кончилось — пересобрать вкладки, кольцо контекста и сохранить файл. */
  afterFinally: (session: ChatSession) => void;
}

export interface ChatCompact {
  /** Сжать беседу: `true`, если резюме получено и история заменена. */
  compactSession(session: ChatSession): Promise<boolean>;
  /** Отметка в ленте «модель работает по резюме». */
  appendCompactedNote(session: ChatSession, tail?: HTMLElement | null): void;
}

/**
 * Сжатие беседы отдельным модулем.
 *
 * Внутри — три вещи, которые нельзя разорвать: нарезка истории на блоки, каскадная
 * достройка резюме и замена `history` (но не `transcript`). Пока они лежали внутри
 * `chat.ts`, любой проход по файлу грозил снести одно из двух — что уже случалось.
 */
export function createChatCompact(deps: ChatCompactDeps): ChatCompact {
  /**
   * Длинную историю сжимаем каскадом: режем на части (см. `splitTranscript`) и ведём
   * одно резюме, достраивая его на каждой части. Так в резюме попадает вся беседа, а
   * не только хвост, — раньше на сжатие уезжал лишь последний кусок, и всё, что было
   * до него, пропадало бесследно.
   */
  async function compactSession(session: ChatSession): Promise<boolean> {
    const { providerId, model } = deps.target();
    if (!providerId || !model) {
      deps.notify('Провайдер не настроен', 'error');
      return false;
    }

    const blocks = splitTranscript(session.history, deps.budget());
    if (blocks.length === 0) {
      deps.notify('Беседа пуста — сжимать нечего');
      return false;
    }

    deps.beforeStart();
    deps.setBusy(true);
    if (blocks.length > 1) {
      deps.notify(`Сжимаю беседу: ${blocks.length} ${plural(blocks.length, 'этап', 'этапа', 'этапов')}`);
    }
    try {
      let summary = '';
      for (let index = 0; index < blocks.length; index += 1) {
        // Первый проход — резюме с нуля; дальше достраиваем накопленное, чтобы
        // каждая новая часть не вытесняла предыдущие.
        const prompt =
          index === 0
            ? `${COMPACT_PROMPT}\n\n---\n${blocks[index]}`
            : `${COMPACT_CONTINUE_PROMPT}\n\n---\nТекущее резюме:\n${summary}\n\n---\nНовая часть беседы:\n${blocks[index]}`;

        summary = (await deps.complete({ providerId, model, prompt })).trim();
        if (!summary) {
          deps.notify('Модель не вернула резюме', 'error');
          return false;
        }
      }

      const before = session.history.length;
      // «Что вошло в сводку» считаем ДО замены: после неё останется только резюме,
      // а человек хочет видеть, из чего оно получилось.
      const forFacts = [...session.history];
      // Меняем ТОЛЬКО контекст: `transcript` (то, что человек читает) остаётся целым,
      // и после перезапуска лента соберётся из него же.
      session.history = [
        { role: 'user', content: `Контекст сжатой беседы:\n\n${summary}` },
        { role: 'assistant', content: 'Принято, продолжаем с этим контекстом.' },
      ];
      // Резюме пересказывает разговор, но не присланные файлы. История их не
      // несла и раньше (их прикладывал сам вопрос), поэтому возвращаем туда же.
      const kept = keptContextMessage(session.kept);
      if (kept) session.history.push(kept);
      // Факты — теперь, когда видно и «до», и «после»: освободились токены
      // именно на этой разнице.
      const facts = compactionFacts(forFacts, { files: session.touched.size, compacted: session.history });
      session.compacted = true;
      deps.renderSummary(session, before, summary, facts);
      // Сжатие перестроило всё, что модель видела до этого: старый счётчик
      // попадания в кеш больше ничего не значит, расписание начинается заново.
      session.usageFresh = false;
      session.turnsSinceCompact = 0;
      deps.notify(`Беседа сжата: ${before} ${plural(before, 'сообщение', 'сообщения', 'сообщений')}`);
      return true;
    } catch (error) {
      // Причину показываем как есть: лимит, ключ или сеть у провайдера важнее
      // общего «не получилось».
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
      return false;
    } finally {
      deps.setBusy(false);
      deps.afterFinally(session);
    }
  }

  /**
   * Отметка о сжатии для восстановленной беседы.
   *
   * Вешается внутрь последнего хода ленты: отметка относится к последнему сжатию и
   * должна стоять там, где реально сжали, а не только в начале ленты. Нет ходов
   * (сжали сразу после сводки) — отметка ложится в саму ленту.
   * `tail` — лента после первого кадра `renderHistory`: тот очищает `thread`.
   */
  function appendCompactedNote(session: ChatSession, tail: HTMLElement | null = null): void {
    const summary = session.history[0]?.content ?? '';
    const note = h(
      'details',
      { class: 'thread-summary' },
      h('summary', { class: 'thread-summary-head' }, svgIcon('collapse', 12), 'Контекст беседы сжат'),
      h(
        'div',
        { class: 'thread-summary-text' },
        'Выше — вся переписка, её можно перечитать. Модель дальше получает только это резюме:',
        h('div', { class: 'thread-summary-body' }, summary),
      ),
    );
    // Последний ход ленты — тот, с которого беседа продолжается. Нет ходов
    // (сжали сразу после сводки) — отметке место в ленте.
    const last = tail?.lastElementChild instanceof HTMLElement ? tail.lastElementChild : null;
    const host = last?.classList.contains('chat-turn') ? last : (tail ?? session.thread);
    host.appendChild(note);
  }

  return { compactSession, appendCompactedNote };
}
