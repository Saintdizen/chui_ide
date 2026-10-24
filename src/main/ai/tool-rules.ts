/**
 * Страховка полного доступа: какие команды спрашивают человека.
 *
 * Правило одно на всё приложение: `agent-tools.ts` зовёт `needsConfirmation` и
 * `confirmRun` на каждом запуске, UI — `isDangerousCommand` для подсветки. Здесь
 * же `failureText` — текст отказа, где `detail` (совет) важнее `summary`.
 *
 * Вынесено из `agent-tools.ts`: это правила, а не механика инструментов, и живут
 * они дольше любого из них.
 */
import type { ToolContext, ToolOutcome } from './tool-context';

/**
 * Команда длиннее — это уже не команда, а попытка спрятать скрипт.
 *
 * Было 2000: по переписи отказов три вызова из 200 упирались именно в предел —
 * то есть три шага уходили на переписывание команды, и это дороже, чем
 * пропустить лишнюю тысячу символов в терминал. 4000 — ещё отсекает скрипт
 * через heredoc, но пропускает длинный `node -e`.
 */
export const MAX_COMMAND_CHARS = 4000;
/**
 * Сколько символов команды повторять в ответе. Короткая команда полезна в
 * выводе (видно, что запускалось), длинная — нет: она уже есть в вызове.
 */
export const ECHO_COMMAND_CHARS = 120;

/**
 * Необратимые команды — на них и срабатывает страховка полного доступа
 * (`settings.ai.confirmDangerous`). Список не защита от злого умысла, а страховка
 * от ошибки: цена промаха выше выигрыша от автоматизации. Ловим опасные глаголы
 * в любом месте строки (после `;`, `&&`, `|`), а не только в начале, и намеренно
 * склонны спросить лишний раз: страховка включается вручную, и промах в сторону
 * вопроса дешевле пропущенного `rm -rf`.
 */
export const DANGEROUS_COMMAND = new RegExp(
  [
    String.raw`(^|[\s;&|])(sudo|doas|su)\s`,
    String.raw`(^|[\s;&|])(rm|rmdir|shred|wipefs|mkfs\S*|fdisk|sfdisk|parted|shutdown|reboot|poweroff|halt|killall|pkill)\s`,
    String.raw`(^|[\s;&|])dd\s+[^\n]*\bif=`,
    String.raw`>\s*\/dev\/(sd|nvme|hd|disk)`,
    String.raw`>\s*(\/etc\/|\/boot\/|\/usr\/|~?\/?\.ssh\/|~?\/?\.bashrc|~?\/?\.zshrc)`,
    String.raw`:\s*\(\s*\)\s*\{`,
    String.raw`chmod\s+-R\s+(777|666)\s+\/(\s|$)`,
    String.raw`chown\s+-R\s+\S+\s+\/(\s|$)`,
    // git меняет репозиторий только через `terminal run` — инструмента git у
    // ассистента нет. Поэтому здесь ловятся и записи в историю, и сеть: иначе
    // полный доступ молча пушил бы и коммитил. Чтение (`status`, `diff`, `log`)
    // остаётся без вопроса — этот ряд про необратимое.
    String.raw`(^|[\s;&|])git\s+(-[cC]\s+\S+\s+|--\S+\s+)*(push|commit|pull|fetch|merge|rebase|reset|restore|revert|am|apply|cherry-pick|stash\s+(drop|clear|pop)|checkout\s+--|switch|branch\s+(-D|-d)|tag\s+-d|clean\s+-[a-z]*f[a-z]*d)(?![\w-])`,
    String.raw`(curl|wget)\b[^\n|]*\|\s*(ba|z|fi|da)?sh\b`,
    `--no-preserve-root`,
  ].join('|'),
  'i',
);

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND.test(command);
}

/**
 * Спрашивать ли разрешение на команду. Обычный агент спрашивает всегда; при
 * полном доступе — только если включена страховка `confirmDangerous`
 * и команда необратима. По умолчанию страховка включена; человек может её
 * снять, и тогда полный доступ исполняет всё без вопросов.
 */
export function needsConfirmation(ctx: ToolContext, command: string): boolean {
  if (!ctx.allowAll) return true;
  return ctx.confirmDangerous === true && isDangerousCommand(command);
}

/** Отказ «команду спросить не у кого»: окно редактора не подключено. */
export function noCommandBridge(): ToolOutcome {
  return {
    ok: false,
    summary: 'Запуск команд недоступен: окно редактора не подключено',
    detail: 'Команду должен подтвердить человек, а моста подтверждений нет. Не повторяй вызов.',
  };
}

/** Человек не разрешил — одним текстом на всех путях запуска. */
export function commandDenied(): ToolOutcome {
  return {
    ok: false,
    summary: 'Пользователь запретил выполнение команды',
    detail: 'Пользователь не разрешил выполнить эту команду. Не повторяй её — предложи другое решение.',
  };
}

/**
 * Спросить разрешение на команду: null — можно выполнять.
 *
 * Путей запуска три — `terminal` с `action: run` (в том числе с `background: true`),
 * `action: start` и `action: write` — и раньше каждый отвечал своими словами («запретил команду»,
 * «запретил ввод», «недоступен»). Модель не понимала, отличается ли отказ от
 * отказа, и пробовала снова. Теперь и вопрос, и отказ одни на всех.
 */
export async function confirmRun(ctx: ToolContext, command: string, prompt = command): Promise<ToolOutcome | null> {
  if (!ctx.confirmCommand) return noCommandBridge();
  if (!needsConfirmation(ctx, command)) return null;
  const allowed = await ctx.confirmCommand(prompt);
  return allowed ? null : commandDenied();
}

/**
 * Текст отказа для модели: не только «что не так», но и совет.
 *
 * Раньше брался один `summary`, а `detail` выбрасывался — при том что советы
 * живут как раз в нём («это не текстовый файл — если нужны метаданные, возьми
 * list»). Модель видела «Ошибка: бинарный файл» и шла угадывать, а это не
 * токены, а потерянный шаг.
 */
export function failureText(outcome: ToolOutcome): string {
  const head = `Ошибка: ${outcome.summary}`;
  return outcome.detail ? `${head}\n${outcome.detail}` : head;
}

/**
 * Сколько путей отдаём в `search filesOnly`, если модель не попросила иначе.
 * Две тысячи строк — это около 11 900 символов (≈3 400 токенов) ради ответа
 * «где встречается»: по сотне путей уже видно, где искать, остальное добирается
 * сужением запроса или папки.
 */
export const DEFAULT_FILES_ONLY_PATHS = 80;
export const MAX_DIR_ENTRIES = 500;
