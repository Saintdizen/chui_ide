/**
 * Разрешения, выданные человеком по ходу работы.
 *
 * Подтверждение команды — это вопрос, на который можно ответить четыре раза:
 * «один раз», «эта команда», «всё в этой папке», «всегда». Последние три не
 * хранятся в прогоне: их запоминает IDE и больше не спрашивает, пока человек не
 * уберёт разрешение в настройках. Поэтому форма одна на всех, и рядом с ней —
 * проверка: совпало ли разрешение с тем, что агент опять просит.
 *
 * Осторожность в том, что совпадение по папке считается по границе сегмента, а
 * не по подстроке: разрешение на `/p/src` не пускает `/p/src-secret`.
 */
import { isInsidePath } from './paths';

export type CommandGrantScope = 'command' | 'dir' | 'all';

export interface CommandGrant {
  scope: CommandGrantScope;
  /**
   * Точная команда (`command`) или каталог (`dir`). У `all` пусто: тогда
   * разрешено всё, что вообще доходит до вопроса.
   */
  value?: string;
}

/** Что агент просит разрешить. */
export interface CommandRequest {
  command: string;
  /** Где команда выполняется: от этого зависит совпадение `dir`. */
  cwd?: string;
}

/** Сколько разрешений храним: список без хвоста — это настройка, а не журнал. */
export const MAX_COMMAND_GRANTS = 100;

/**
 * Команда сравнивается после схлопывания пробелов: `npm  test` и `npm test` —
 * одна и та же команда, и человек не должен отвечать дважды.
 */
export function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

function normalizeDir(dir: string): string {
  const unified = dir.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return unified === '/' ? '/' : unified.replace(/\/+$/, '');
}

/** Совпало ли сохранённое разрешение с тем, о чём просят снова. */
export function grantMatches(grant: CommandGrant, request: CommandRequest): boolean {
  if (grant.scope === 'all') return true;
  if (grant.scope === 'command') {
    return normalizeCommand(grant.value ?? '') === normalizeCommand(request.command);
  }
  // `dir`: команда идёт в этом каталоге или в любом внутри него.
  if (!grant.value || !request.cwd) return false;
  return isInsidePath(normalizeDir(grant.value), normalizeDir(request.cwd));
}

/** Ответ карточки на вопрос о команде: можно ли и запомнить ли на будущее. */
export interface ConfirmCommandAnswer {
  allowed: boolean;
  /** «Больше не спрашивать» — в каком объёме. Пусто — разрешение разовое. */
  remember?: CommandGrantScope;
}

/**
 * Ответ на вопрос о команде.
 *
 * `boolean` — разовый ответ, который был раньше; объект добавился вместе с
 * «больше не спрашивать». Оба вида ходят по одним местам, поэтому читать
 * ответ надо через `decisionAllowed`/`decisionRemember`: `if (answer)`
 * истолковал бы объект как «разрешено» всегда.
 */
export type CommandDecision = boolean | ConfirmCommandAnswer;

export function decisionAllowed(decision: CommandDecision): boolean {
  return typeof decision === 'boolean' ? decision : decision.allowed;
}

export function decisionRemember(decision: CommandDecision): CommandGrantScope | undefined {
  return typeof decision === 'boolean' ? undefined : decision.remember;
}

/** Есть ли разрешение, покрывающее этот запрос. */
export function matchesGrant(grants: readonly CommandGrant[] | undefined, request: CommandRequest): boolean {
  return grants ? grants.some((grant) => grantMatches(grant, request)) : false;
}

/**
 * Из ответа человека — то, что ляжет в настройки. «Эта команда» хранится уже
 * схлопнутой: сравнивать будем именно её.
 */
export function rememberedGrant(scope: CommandGrantScope, command: string, cwd?: string): CommandGrant {
  if (scope === 'all') return { scope: 'all' };
  if (scope === 'dir') return { scope: 'dir', value: cwd ? normalizeDir(cwd) : '' };
  return { scope: 'command', value: normalizeCommand(command) };
}

/** Первое подходящее разрешение; нет — `null`, и тогда придётся спросить человека. */
export function matchingGrant(grants: readonly CommandGrant[], request: CommandRequest): CommandGrant | null {
  return grants.find((grant) => grantMatches(grant, request)) ?? null;
}

/**
 * Добавить разрешение. Повтор того же — не ошибка: старый срок заменяется,
 * иначе список рос бы одним и тем же. Слишком длинный список режется с начала:
 * свежие разрешения нужнее старых.
 */
export function addGrant(grants: readonly CommandGrant[], grant: CommandGrant): CommandGrant[] {
  // Приводим к тому же виду, в каком потом сравниваем: `npm  test` и `npm test` —
  // одна команда, и две строки в списке были бы двумя ответами на один вопрос.
  const clean: CommandGrant =
    grant.scope === 'all'
      ? { scope: 'all' }
      : grant.scope === 'dir'
        ? { scope: 'dir', value: normalizeDir(grant.value ?? '') }
        : { scope: 'command', value: normalizeCommand(grant.value ?? '') };
  const rest = grants.filter((item) => !(item.scope === clean.scope && (item.value ?? '') === (clean.value ?? '')));
  return [...rest, clean].slice(-MAX_COMMAND_GRANTS);
}

/** Убрать разрешение по его месту в списке (UI показывает его номером). */
export function removeGrant(grants: readonly CommandGrant[], index: number): CommandGrant[] {
  return grants.filter((_, position) => position !== index);
}

/**
 * Чтение из файла настроек: всё, что не похоже на разрешение, выкидываем.
 * Настройки правят и руками — испорченное значение не повод падать.
 */
export function normalizeGrants(value: unknown): CommandGrant[] {
  if (!Array.isArray(value)) return [];
  const grants: CommandGrant[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const scope = (item as CommandGrant).scope;
    if (scope === 'all') {
      grants.push({ scope: 'all' });
      continue;
    }
    if (scope !== 'command' && scope !== 'dir') continue;
    const raw = (item as CommandGrant).value;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    grants.push({ scope, value: raw.trim() });
  }
  return grants.slice(-MAX_COMMAND_GRANTS);
}

/** Человеческая формулировка для настроек и для строки в ленте. */
export function describeGrant(grant: CommandGrant): string {
  if (grant.scope === 'all') return 'все команды';
  if (grant.scope === 'command') return `команда: ${grant.value ?? ''}`;
  return `папка: ${grant.value ?? ''}`;
}

/**
 * Разрешения на правку файлов — отдельный список, а не продолжение списка команд.
 *
 * Вопрос другой: команда спрашивает «можно выполнить вот это в такой-то папке»,
 * а правка — «можно трогать этот файл». Один и тот же `dir` внешне похож, но
 * совпадение считается по другому полю (путь файла, а не cwd команды), и смешать
 * их значило бы пустить `rm` по разрешению «правлю src/».
 */
export type EditGrantScope = 'file' | 'dir';

export interface EditGrant {
  scope: EditGrantScope;
  /** Файл (`file`) или каталог (`dir`), в который можно писать без вопроса. */
  value: string;
}

/** Сколько разрешений на правки храним: список виден в настройках, не журнал. */
export const MAX_EDIT_GRANTS = 100;

/**
 * Совпало ли разрешение на правку с файлом, который агент собрался менять.
 *
 * Папка — по границе сегмента (как и у команд): `/p/src` не пускает
 * `/p/src-secret/x.ts`.
 */
export function editGrantMatches(grant: EditGrant, path: string): boolean {
  const target = normalizeDir(path);
  if (grant.scope === 'file') return normalizeDir(grant.value) === target;
  return isInsidePath(normalizeDir(grant.value), target);
}

/** Первое подходящее разрешение на правку; нет — `null`, и тогда спросим человека. */
export function matchingEditGrant(grants: readonly EditGrant[], path: string): EditGrant | null {
  return grants.find((grant) => editGrantMatches(grant, path)) ?? null;
}

/** Разрешение, которое предложит карточка ревью: «этот файл» или «эта папка». */
export function rememberedEditGrant(scope: EditGrantScope, path: string): EditGrant {
  return { scope, value: normalizeDir(path) };
}

/**
 * Добавить разрешение на правку. Повтор заменяет старое, а не копится: одна
 * строка в списке на один файл. Длинный список режется с начала — свежие нужнее.
 */
export function addEditGrant(grants: readonly EditGrant[], grant: EditGrant): EditGrant[] {
  const clean: EditGrant = { scope: grant.scope, value: normalizeDir(grant.value ?? '') };
  const rest = grants.filter((item) => !(item.scope === clean.scope && item.value === clean.value));
  return [...rest, clean].slice(-MAX_EDIT_GRANTS);
}

/** Убрать разрешение по его месту в списке (настройки показывают его номером). */
export function removeEditGrant(grants: readonly EditGrant[], index: number): EditGrant[] {
  return grants.filter((_, position) => position !== index);
}

/** Чтение из файла настроек: всё, что не похоже на разрешение, выкидываем. */
export function normalizeEditGrants(value: unknown): EditGrant[] {
  if (!Array.isArray(value)) return [];
  const grants: EditGrant[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { scope, value: raw } = item as EditGrant;
    if (scope !== 'file' && scope !== 'dir') continue;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    grants.push({ scope, value: normalizeDir(raw.trim()) });
  }
  return grants.slice(-MAX_EDIT_GRANTS);
}

/** Человеческая формулировка для настроек. */
export function describeEditGrant(grant: EditGrant): string {
  return `${grant.scope === 'file' ? 'файл' : 'папка'}: ${grant.value}`;
}
