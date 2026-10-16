/**
 * Виды новых проектов — ОДИН список на два процесса.
 *
 * Стартовое окно берёт отсюда подписи для выбора типа, а main — допустимые
 * значения: по виду выбирается набор файлов-заготовок (`main/project/scaffold.ts`).
 * Два списка неизбежно разъехались бы (как разъехались бы два меню), поэтому он
 * один — как `shared/app-menu.ts` у меню приложения.
 *
 * Имя проекта проверяется тоже здесь, одной функцией на оба процесса: тем же
 * правилом гасится кнопка «Создать» в окне, и им же закрывается путь наружу в main.
 */

export interface ProjectKindInfo {
  /** Код вида: уходит в RPC и выбирает набор заготовок. */
  kind: string;
  /** Подпись в выборе типа. */
  label: string;
  /** Что появится в папке — коротко, под выбором типа. */
  hint: string;
}

/**
 * Список видов. Порядок — от самого частого к редкому: первым встаёт тип, который
 * выберет большинство, а «Пустой» уходит вниз — он для тех, кто знает, зачем пришёл.
 */
export const PROJECT_KINDS = [
  { kind: 'python', label: 'Python', hint: 'main.py, README.md и .gitignore' },
  { kind: 'node', label: 'Node.js', hint: 'package.json, src/index.js, README.md и .gitignore' },
  { kind: 'empty', label: 'Пустой проект', hint: 'README.md и .gitignore' },
] as const satisfies readonly ProjectKindInfo[];

export type ProjectKind = (typeof PROJECT_KINDS)[number]['kind'];

/** Вид из RPC приходит строкой: без проверки он попал бы в выбор заготовок. */
export function isProjectKind(value: string): value is ProjectKind {
  return PROJECT_KINDS.some((item) => item.kind === value);
}

/** Что за вид: подпись и подсказку показывает окно, заготовки берёт main. */
export function projectKindInfo(kind: ProjectKind): ProjectKindInfo {
  return PROJECT_KINDS.find((item) => item.kind === kind) ?? PROJECT_KINDS[0];
}

/**
 * Имена, которые Windows не даёт занять: `CON`, `NUL`, `COM1` и прочее. Папку с
 * таким именем система не создаст (или создаст, но не откроет) — а имя папки и
 * есть имя проекта, поэтому отказываем сразу и с понятной причиной.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Что не так с именем проекта: `null` — имя годится.
 *
 * Требования — от имени ПАПКИ, а не от языка: в этой папке окажется проект, и её
 * должны принять и система, и git, и оболочка. Поэтому запрещены разделители пути
 * (`/`, `\`), знаки, недопустимые в именах Windows, и хвостовая точка с пробелом.
 */
export function projectNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Укажите имя проекта';
  if (trimmed === '.' || trimmed === '..') return 'Такое имя занято системой';
  if (/[\\/]/.test(trimmed)) return 'Имя не может содержать «/» или «\\»';
  if (/[<>:"|?*]/.test(trimmed)) return 'Имя не может содержать < > : " | ? *';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) return 'Имя не может содержать управляющие символы';
  // Имя обрезается по краям, поэтому хвостовой пробел не помеха, а точка — да:
  // Windows «api.» молча превращает в «api», и человек искал бы папку не там.
  if (/\.$/.test(trimmed)) return 'Имя не может заканчиваться точкой';
  if (WINDOWS_RESERVED.test(trimmed)) return 'Это имя зарезервировано системой';
  if (trimmed.length > 100) return 'Слишком длинное имя: сократите до 100 символов';
  return null;
}

/**
 * Имя пакета для `package.json`: в npm оно пишется строчными буквами без пробелов.
 * Пусто после чистки (имя из одних «?!») — подставляем `app`, иначе пакет не собрать.
 */
export function projectSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return slug || 'app';
}
