/**
 * Команды проекта: свой `/выпуск` в композере.
 *
 * Готовые запросы к ассистенту уже были, но жили списком в коде (`chat-composer-menu.ts`):
 * новая команда — это правка файла и сборка. А команда — это текст, который знает
 * человек, а не программа: «проверь дифф и напиши сообщение коммита», «прогони
 * проверки и почини, что упало».
 *
 * Файл команды лежит в `.chui/commands/<имя>.md` проекта (уезжает в репозиторий)
 * или в `~/.chui/commands/` домашнего каталога (общие для всех проектов). Имя
 * команды — имя файла, поэтому набирается после `/`.
 *
 * Тело файла — текст запроса. Хвост, набранный после имени команды, подставляется
 * на место `$ARGUMENTS` (коротко — `$ARG`); если места в тексте нет, хвост
 * дописывается отдельным абзацем. Так одна команда работает и без аргументов,
 * и с ними.
 *
 * Начало файла — необязательная шапка между строками `---`, как у навыков:
 *
 *     ---
 *     description: Проверить дифф и написать сообщение коммита
 *     ---
 *     Посмотри `git diff` и напиши сообщение коммита в стиле истории проекта.
 *
 * Без шапки описанием становится первый абзац. Описание нужно: строка в меню из
 * одного имени ничего не обещает.
 *
 * Здесь только правило и текст: чтение с диска — дело main (`main/ai/commands.ts`).
 * Поэтому модуль чистый и проверяется без Electron.
 */

import type { SkillScope } from './skills';

/** Одна команда проекта: как её зовут, что она делает и что подставить в поле. */
export interface ProjectCommand {
  /** Имя для набора после `/`: латиница, цифры, дефис. Приводится к нижнему регистру. */
  name: string;
  /** Одна строка в меню: по ней человек и выбирает. */
  description: string;
  /** Тело файла — текст запроса (с `$ARGUMENTS`, если ждёт хвост). */
  prompt: string;
  /** Абсолютный путь к файлу: по нему видно, откуда команда пришла. */
  path: string;
  scope: SkillScope;
}

/** Имя длиннее — это уже заголовок: после `/` его не набрать. */
export const MAX_COMMAND_NAME = 48;
/** Описание — одна строка меню. Длинное вытеснит остальные команды. */
export const MAX_COMMAND_DESCRIPTION = 160;
/** Сколько команд показываем: дальше список сам становится свалкой. */
export const MAX_COMMANDS = 60;
/** Потолок тела: команда — это запрос, а не книга. */
export const MAX_COMMAND_PROMPT_CHARS = 8_000;

/** Место подстановки хвоста. Короткая запись — чтобы не набирать длинное слово. */
export const ARGUMENTS_TOKEN = '$ARGUMENTS';
export const ARGUMENTS_SHORT_TOKEN = '$ARG';

/**
 * Привести имя к виду, в котором его набирают после `/`: нижний регистр,
 * пробелы и подчёркивания — дефисы, всё постороннее выброшено. `/Выпуск` и
 * `/release_notes` — это `выпуск` не станет: команды зовутся латиницей, потому
 * что набираются там же, где `/explain`.
 */
export function normalizeCommandName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_COMMAND_NAME);
}

/** Значение из шапки без кавычек и лишних пробелов: `description: "…"` — тоже описание. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Разделить файл на шапку и тело. Шапка — только если файл НАЧИНАЕТСЯ со строки
 * `---`: дефисы в середине текста (разделитель в markdown) шапкой не считаются.
 */
function splitFrontMatter(text: string): { fields: Map<string, string>; body: string } {
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const fields = new Map<string, string>();
  if ((lines[0] ?? '').trim() !== '---') return { fields, body: text };

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === '---') {
      end = index;
      break;
    }
    const line = lines[index]!;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!key) continue;
    fields.set(key, unquote(line.slice(colon + 1)));
  }
  // Шапка не закрыта — значит это не шапка, а обычный текст с дефисами.
  if (end < 0) return { fields: new Map(), body: text };
  return { fields, body: lines.slice(end + 1).join('\n') };
}

/**
 * Первый абзац тела как описание — для файлов без шапки. Заголовки пропускаем:
 * `# Выпуск` ничего не говорит о том, ЧТО команда делает.
 */
function firstParagraph(body: string): string {
  const parts: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) {
      if (parts.length > 0) break;
      continue;
    }
    if (line.startsWith('#') || line.startsWith('---') || line.startsWith('```')) continue;
    parts.push(line.replace(/^[-*+]\s+/, ''));
    if (parts.join(' ').length >= MAX_COMMAND_DESCRIPTION) break;
  }
  return parts.join(' ').trim();
}

/**
 * Разобрать файл команды. `fallbackName` — имя файла без расширения: им пользуемся,
 * когда в шапке не сказано имя.
 *
 * `null` — это не команда: нет ни имени, ни тела, либо пустое тело (такая команда
 * подставила бы в поле пустоту) или нет описания (её не выбрать в меню).
 */
export function parseCommandFile(
  text: string,
  options: { fallbackName: string; path: string; scope: SkillScope },
): ProjectCommand | null {
  const { fields, body } = splitFrontMatter(text);
  const prompt = body.trim().slice(0, MAX_COMMAND_PROMPT_CHARS);
  if (!prompt) return null;

  const rawName = fields.get('name') ?? options.fallbackName;
  const name = normalizeCommandName(rawName) || normalizeCommandName(options.fallbackName);
  if (!name) return null;

  const described = (fields.get('description') ?? '').replace(/\s+/g, ' ').trim();
  const description = (described || firstParagraph(body)).slice(0, MAX_COMMAND_DESCRIPTION);
  if (!description) return null;

  return { name, description, prompt, path: options.path, scope: options.scope };
}

/** Команда по имени: без учёта регистра и с той же нормализацией, что при разборе. */
export function findCommand(commands: readonly ProjectCommand[], name: string): ProjectCommand | null {
  const wanted = normalizeCommandName(name);
  if (!wanted) return null;
  return commands.find((command) => command.name === wanted) ?? null;
}

/**
 * Набранное в поле как вызов команды: `/имя` и хвост после него.
 * `null` — это не вызов (обычный вопрос, начинающийся не со слэша).
 */
export function parseCommandInvocation(value: string): { name: string; tail: string } | null {
  const text = value.trim();
  if (!text.startsWith('/')) return null;
  const space = text.search(/\s/);
  const name = normalizeCommandName(space < 0 ? text.slice(1) : text.slice(1, space));
  if (!name) return null;
  return { name, tail: space < 0 ? '' : text.slice(space).trim() };
}

/**
 * Текст запроса по команде и хвосту.
 *
 * Если в теле есть `$ARGUMENTS`, хвост встаёт на его место — в любом месте текста,
 * сколько раз, столько и подставится. Если места нет, хвост дописывается отдельным
 * абзацем: без этого «/ревью поправь ещё стиль» молча теряло бы вторую половину.
 */
export function expandCommandPrompt(command: ProjectCommand, tail = ''): string {
  const argument = tail.trim();
  const hasPlaceholder = command.prompt.includes(ARGUMENTS_TOKEN) || command.prompt.includes(ARGUMENTS_SHORT_TOKEN);
  if (!hasPlaceholder) return argument ? `${command.prompt}\n\n${argument}` : command.prompt;

  const filled = command.prompt.replaceAll(ARGUMENTS_TOKEN, argument).replaceAll(ARGUMENTS_SHORT_TOKEN, argument);
  return argument ? filled : tidyBlankLines(filled);
}

/** Пустое место под аргумент не должно оставлять абзац из пробелов. */
function tidyBlankLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 || (lines[index - 1] ?? '').length > 0)
    .join('\n')
    .trim();
}
