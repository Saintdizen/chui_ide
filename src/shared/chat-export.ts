import type { ChatMessage } from './api';

/**
 * Беседа в Markdown — чтобы её можно было показать тому, у кого этой IDE нет.
 *
 * Модуль __чистый__: ни DOM, ни RPC, ни времени. Из-за этого его можно проверить
 * тестом, а файл получается одинаковым при повторном экспорте — иначе диффы
 * двух экспортов одной беседы шумели бы датой.
 */

/** Что известно о беседе помимо сообщений. Всё необязательно: экспорт — не отчёт. */
export interface ChatExportMeta {
  title: string;
  /** Когда сделан экспорт: `YYYY-MM-DD`. Пусто — строки с датой не будет. */
  date?: string;
  /** Модель, которой шла беседа. */
  model?: string;
  /** Рабочая папка, в которой всё происходило. */
  workspace?: string;
}

export interface ChatExportOptions {
  /**
   * Чьи сообщения выгружать. `transcript` — вся переписка (то, что человек видит);
   * `history` — только то, что уходит модели (после сжатия там резюме).
   *
   * Разница не косметическая: по умолчанию нужен `transcript`. Сжатие
   * выбрасывает из `history` прочитанное, и экспорт по нему дал бы файл, в
   * котором половины разговора нет — а именно её и хотят показать.
   */
  source?: 'transcript' | 'history';
  /** Вставлять картинки ссылками на data-URL. По умолчанию — да. */
  images?: boolean;
}

/** Чем кончается файл: видно, что переписка кончилась, а не обрезалась. */
const FOOTER = '---\n\nСгенерировано chui_iDE.';

/**
 * Служебный дострой обрезанного ответа — не текст человека и не текст модели.
 * В экспорт не идёт: в файле он выглядел бы как вопрос, которого не задавали.
 */
const CONTINUE_PROMPT = 'Продолжи с того места, где остановился.';

/**
 * Заголовки по ролям. Системных сообщений в переписке не бывает (они собираются
 * на отправке), а `tool` — это результат вызова; его место отдельной плашкой,
 * а не репликой диалога.
 */
const ROLE_HEADING: Record<string, string> = {
  user: 'Вы',
  assistant: 'Ассистент',
  tool: 'Результат инструмента',
  system: 'Система',
};

export function chatToMarkdown(
  messages: readonly ChatMessage[],
  meta: ChatExportMeta,
  options: ChatExportOptions = {},
): string {
  const withImages = options.images !== false;
  const lines: string[] = [];

  lines.push(`# ${meta.title.trim() || 'Беседа'}`, '');

  // Сведения о беседе — списком. Пустые поля не выводим: «Модель: —» в файле
  // выглядит как отсутствие данных, а не как их ненужность.
  const facts: string[] = [];
  if (meta.date?.trim()) facts.push(`- **Дата:** ${meta.date.trim()}`);
  if (meta.model?.trim()) facts.push(`- **Модель:** ${meta.model.trim()}`);
  if (meta.workspace?.trim()) facts.push(`- **Папка:** \`${meta.workspace.trim()}\``);
  if (facts.length > 0) lines.push(...facts, '');

  const visible = messages.filter(
    (message) =>
      // Служебный дострой — не вопрос человека.
      !(message.role === 'user' && message.content === CONTINUE_PROMPT) &&
      // Пустое сообщение без вызовов, картинок и текста выводить нечего.
      (message.content.trim().length > 0 ||
        (message.toolCalls?.length ?? 0) > 0 ||
        (withImages && (message.images?.length ?? 0) > 0)),
  );

  if (visible.length === 0) lines.push('_В беседе ещё нет сообщений._', '');

  for (const message of visible) {
    lines.push(`## ${ROLE_HEADING[message.role] ?? message.role}`, '');

    if (message.content.trim().length > 0) lines.push(message.content.trimEnd(), '');

    if (withImages) {
      // Картинки — как есть, data-URL: файл должен открываться сам по себе, без
      // соседней папки.
      for (const image of message.images ?? []) {
        lines.push(`![Изображение к сообщению](${image})`, '');
      }
    }

    if ((message.toolCalls?.length ?? 0) > 0) {
      // Без этого файл терял бы суть агентной беседы: видно вопрос и ответ, а
      // между ними ничего — хотя агент правил файлы и запускал команды.
      lines.push('Вызвано:', '');
      for (const call of message.toolCalls!) {
        const args = call.arguments.trim().replace(/\n/g, ' ');
        lines.push(`- \`${call.name}\`${args ? ` — \`${args}\`` : ''}`);
      }
      lines.push('');
    }
  }

  lines.push(FOOTER);
  // Три пустые строки подряд — это уже вёрстка файла, а не содержание.
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/**
 * Имя файла для диалога сохранения: из заголовка, без запрещённых символов.
 *
 * Заголовок беседы — первая строка вопроса, и в нём запросто окажется `/` или
 * `:`. С таким именем диалог сохранения покажет пустое поле или того хуже
 * предложит неверный путь.
 */
export function chatExportFileName(title: string, date?: string): string {
  const clean = title
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Точка в конце недопустима в имени файла на Windows.
    .replace(/[. ]+$/, '');
  // Пустой заголовок — не повод для ошибки: диалогу нужно хоть какое-то имя.
  const base = clean.length > 0 ? clean.slice(0, 80) : 'Беседа';
  return date?.trim() ? `${base} (${date.trim()}).md` : `${base}.md`;
}
