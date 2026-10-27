/* ── Git ───────────────────────────────────────────────────────────────── */

/** Как git помечает файл в статусе. Коды porcelain приведены к домену. */
export type GitChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFileStatus {
  /** Абсолютный путь — по нему UI находит файл в дереве проекта. */
  path: string;
  /** Путь от корня репозитория: в таком виде его понимает git. */
  relative: string;
  change: GitChange;
  /** Правка лежит в индексе, то есть попадёт в коммит. */
  staged: boolean;
  /** Есть незакоммиченные правки в рабочем дереве. */
  unstaged: boolean;
}

export interface GitRepository {
  root: string;
  /** Ветка; null — если HEAD оторван (detached HEAD). */
  branch: string | null;
  detached: boolean;
  /** Короткий хеш HEAD. */
  head: string | null;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  /** null — рабочая папка не лежит внутри репозитория. */
  repository: GitRepository | null;
  files: GitFileStatus[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

/**
 * Diff того, что попадёт в коммит: чем кормить модель для сообщения коммита.
 * `diff` уже обрезан по размеру (потолок — в `shared/commit-message.ts`), `truncated`
 * говорит, что картина неполная, а `untracked` — новые файлы: их содержимого в
 * `git diff` нет, но названия о правке говорят.
 */
export interface GitCommitDiff {
  diff: string;
  /** Правки проиндексированы: diff — индекс против HEAD, иначе рабочее дерево против индекса. */
  staged: boolean;
  /** Обрезан ли diff по размеру. */
  truncated: boolean;
  /** Сколько файлов с правками попадает в коммит. */
  files: number;
  /** Новые файлы: в diff их нет, показываем именами. */
  untracked: string[];
}

/** Ответ «сообщение коммита по diff»: текст, готовый лечь в поле сообщения. */
export interface CommitMessageResult {
  message: string;
}

/** Ответ «тест к выделенному коду»: код теста, готовый лечь в файл. */
export interface TestGenerationResult {
  code: string;
}

/**
 * Название беседы от модели. Пустая строка — названия нет: вкладка останется с
 * заголовком по первому вопросу, и это нормальный вид, а не сбой.
 */
export interface ChatTitleResult {
  title: string;
}

/**
 * Блоки изменений одного файла — для действий прямо из жёлоба редактора.
 *
 * Два набора, потому что строки, по которым щёлкают в редакторе, согласуются с
 * рабочим деревом: правки, ещё не попавшие в индекс, ищутся в `unstaged` (рабочее
 * дерево против индекса), уже проиндексированные — в `staged` (индекс против HEAD).
 * Границы — как в `shared/git-hunks.ts`, номера блоков годятся для `git apply`.
 */
export interface GitFileHunks {
  /** Блоки вне индекса: их можно проиндексировать или откатить. */
  unstaged: GitDiffHunk[];
  /** Блоки в индексе: их можно убрать из индекса. */
  staged: GitDiffHunk[];
}

/** Границы блока изменений в сравнении: по строкам старой и новой версий. */
export interface GitDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface GitDiff {
  /** С чем сравниваем: HEAD или индекс. */
  original: string;
  /** Что сравниваем: индекс или рабочее дерево. */
  modified: string;
  /**
   * Блоки изменений в порядке файла: по ним интерфейс ставит у каждого свою
   * кнопку «проиндексировать блок». Границы совпадают с теми, что приложил бы
   * `git apply`, поэтому номер блока из этого списка годится и в main.
   */
  hunks: GitDiffHunk[];
}

export interface GitCommitInfo {
  hash: string;
  summary: string;
}

/**
 * Итог операции с историей (rebase). Rebase — не одна команда: он может
 * остановиться на конфликте или на шаге `edit`. Поэтому ответ несёт не только
 * «получилось», но и текст git, и признак того, что rebase ещё идёт и ждёт человека.
 */
export interface GitRebaseResult {
  /** Завершился ли rebase целиком (без останова на конфликте или `edit`). */
  ok: boolean;
  /** Идёт ли rebase прямо сейчас: нужно остановиться, разрешить и продолжить. */
  inProgress: boolean;
  /** Есть ли неразрешённые конфликты: тогда правки надо свести руками. */
  conflict: boolean;
  /** Словами git: что он сделал или на чём споткнулся. */
  message: string;
  status: GitStatus;
}

/**
 * Три версии файла из конфликта слияния: общий предок и две стороны.
 * Пустая строка — соответствующего объекта в индексе нет (например, файл
 * добавлен только одной стороной: у него нет ни базы, ни второй стороны).
 */
export interface GitConflictParts {
  /** Общий предок (стадия 1). */
  base: string;
  /** Наша версия (стадия 2, HEAD). */
  ours: string;
  /** Их версия (стадия 3, входящая ветка). */
  theirs: string;
}

/** Один коммит из истории: то, что нужно списку, без тела сообщения и диффа. */
export interface GitCommit {
  /** Короткий хеш (7 символов), как его печатает git. */
  hash: string;
  author: string;
  /** Дата коммита, `ГГГГ-ММ-ДД`. */
  date: string;
  summary: string;
  /**
   * Время коммита в миллисекундах эпохи. По нему лента истории файла ставит коммиты
   * и локальные снимки в один порядок (см. `shared/timeline.ts`); у старых ответов
   * поля нет — тогда берём дату.
   */
  at?: number;
}

/** Удалённый репозиторий: как он назван в `git remote` и куда ведут адреса. */
export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/**
 * Итог операции с внешним репозиторием (fetch/pull/push). Сбой не бросаем: сеть,
 * авторизация и конфликты — обычные ответы, а не исключения, поэтому `ok` и текст
 * от git едут вместе. Свежий статус — рядом: после операции состояние изменилось.
 */
export interface GitNetworkResult {
  ok: boolean;
  message: string;
  status: GitStatus;
}

/** Строка в списке недавних: путь, имя и признак того, что папка ещё существует. */
export interface RecentProject {
  path: string;
  name: string;
  exists: boolean;
}

/** Событие прогресса `git.clone`: строки, которые git пишет в прогресс-вывод. */
export const CloneEvent = {
  Progress: 'progress',
} as const;

/** Событие прогресса `python.createVenv`: шаги и вывод команд. */
export const VenvEvent = {
  Progress: 'venv:progress',
} as const;

/** Полезная нагрузка события `CloneEvent.Progress`. */
export interface CloneProgressPayload {
  line: string;
}
