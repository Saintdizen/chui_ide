/**
 * Варианты для клика по слоту статус-бара: кодировка, отступы, язык.
 *
 * Почему это отдельный файл, а не код в `statusbar.ts`: у полосы есть только
 * DOM и клики, а весь выбор — чистый список и чистое следствие выбора. Так его
 * можно проверить без окна, а `statusbar.ts` остаётся про раскладку.
 *
 * Общие правила для всех трёх слотов:
 *
 *   • **Текущее значение видно и отмечено.** Список открывают, чтобы сравнить
 *     с тем, что есть. Галочка — на текущем (поле `checked`).
 *   • **Один выбор — один пункт.** Ничего не «переключается» пачкой: клик по
 *     строке заканчивает выбор (`closeAfter: true` есть у всех).
 *   • **Выбор без последствий возвращается `null`.** Отмена (Escape, клик мимо)
 *     — это не «выбрал то же самое», а «ничего не произошло»: иначе документ
 *     пометится изменённым от простого открытия списка.
 */
import { LANGUAGES, languageLabel, type LanguageInfo } from '../../shared/languages';

export type StatusChoiceKind = 'encoding' | 'indent' | 'language';

/** Одна строка списка. */
export interface StatusChoice {
  /** Значение для действия: id языка, «utf-8», «2 пробела». */
  readonly id: string;
  readonly label: string;
  /** Стоит прямо сейчас — рисуем галочкой. */
  readonly checked?: boolean;
  /** Пояснение справа: расширения языка, «≈ Windows» у кодировок. */
  readonly hint?: string;
}

/** Что выбрали и чем это менять. */
export interface StatusChoiceResult {
  readonly kind: StatusChoiceKind;
  readonly id: string;
}

export interface StatusChoiceContext {
  readonly encoding: string;
  readonly language: string | null;
  readonly tabSize: number;
  readonly useTabs: boolean;
}

/**
 * Кодировки, которые проект реально умеет читать и писать.
 *
 * Список короткий НАРОЧНО: экзотика вроде Shift_JIS или cp1251 без проверки
 * на реальных файлах — обещание, которое приложение не сдержит. Лучше
 * признаться, чем показать пункт, который всё равно не сработает.
 *
 * `utf-8` — без BOM: BOM — отдельная беда (его ставят ради Windows-инструментов,
 * и он ломает шебанги), и молча его дописывать при смене кодировки нельзя.
 */
const ENCODINGS: readonly StatusChoice[] = [
  { id: 'utf-8', label: 'UTF-8', hint: 'без BOM' },
  { id: 'utf-8-bom', label: 'UTF-8 с BOM', hint: 'для Windows-инструментов' },
  { id: 'utf-16le', label: 'UTF-16 LE', hint: 'редко' },
  { id: 'latin1', label: 'Latin-1', hint: 'ISO-8859-1' },
];

/**
 * Отступы, которые стоит предложить.
 *
 * Только эти четыре: всё, что между ними (3, 7, таб-развёртка в 8), — это уже
 * не «выбор», а настройка, и ей место в настройках, а не в меню у полосы.
 */
const INDENT_SIZES = [2, 4] as const;

/**
 * Список вариантов слота.
 *
 * Для языка — вся таблица `LANGUAGES` в её порядке: там языки сгруппированы по
 * родству (Node рядом с TypeScript, C рядом с C++), и это полезнее алфавита.
 * Фильтра здесь нет: список открывается затем, чтобы ВЫБРАТЬ, и клавиатура
 * (стрелки, буква) — обычное дело.
 */
export function statusChoices(kind: StatusChoiceKind, context: StatusChoiceContext): StatusChoice[] {
  if (kind === 'encoding') {
    const current = normalizeEncoding(context.encoding);
    return ENCODINGS.map((item) => ({ ...item, checked: item.id === current }));
  }
  if (kind === 'indent') {
    const items: StatusChoice[] = [];
    for (const size of INDENT_SIZES) {
      items.push({
        id: `${size}-spaces`,
        label: `${size} пробела`,
        checked: !context.useTabs && context.tabSize === size,
      });
    }
    items.push({ id: 'tab', label: 'Табуляция', checked: context.useTabs });
    return items;
  }
  return LANGUAGES.map((info) => ({
    id: info.id,
    label: info.label,
    checked: info.id === context.language,
    ...(info.extensions?.length ? { hint: info.extensions.map((ext) => `.${ext}`).join(' ') } : {}),
  }));
}

/** Попадает ли выбор в список этого слота: чужие id не применяем молча. */
export function isStatusChoice(kind: StatusChoiceKind, id: string): boolean {
  if (kind === 'language') return LANGUAGES.some((info) => info.id === id);
  if (kind === 'encoding') return ENCODINGS.some((item) => item.id === id);
  return id === 'tab' || INDENT_SIZES.some((size) => id === `${size}-spaces`);
}

/** Привести запись кодировки документа к id списка. */
export function normalizeEncoding(encoding: string): string {
  const value = encoding.trim().toLowerCase().replace(/_/g, '-');
  if (value === 'utf8') return 'utf-8';
  if (value === 'utf-8-bom' || value === 'utf8-bom') return 'utf-8-bom';
  if (value === 'utf-16le' || value === 'utf16le' || value === 'utf-16') return 'utf-16le';
  if (value === 'latin1' || value === 'iso-8859-1') return 'latin1';
  return value;
}

/**
 * Что изменится в документе от выбора отступа.
 *
 * Возвращает `null`, если ничего: тот же отступ — не повод трогать файл.
 */
export function indentAfterChoice(
  id: string,
  current: { tabSize: number; useTabs: boolean },
): { tabSize: number; useTabs: boolean } | null {
  if (id === 'tab') {
    return current.useTabs ? null : { tabSize: current.tabSize, useTabs: true };
  }
  const match = /^(\d+)-spaces$/.exec(id);
  if (!match) return null;
  const tabSize = Number(match[1]);
  if (!current.useTabs && current.tabSize === tabSize) return null;
  return { tabSize, useTabs: false };
}

/** Название языка по id — или честное «текст», если язык не выбран. */
export function statusLanguageLabel(language: string | null): string {
  return language ? languageLabel(language) : '—';
}

/** Расширения языка — на случай подписи в списке выбора. */
export function languageHint(info: LanguageInfo): string | undefined {
  if (!info.extensions?.length) return undefined;
  return info.extensions.map((ext) => `.${ext}`).join(' ');
}
