/**
 * Песочница: правило и текст. Команды агента выполняются в контейнере, а не на
 * машине пользователя.
 *
 * Здесь только то, что можно проверить без Docker: сборка аргументов запуска,
 * проверка имени образа, нормализация настроек и подписи. Сам запуск — в
 * `main/sandbox/sandbox.ts` (там процессы и поиск движка по PATH).
 *
 * Модуль чистый, поэтому аргументы разбираются тестами: запуск чужой команды —
 * самое опасное, что делает агент, и «вылезти» из своей позиции она не должна.
 */

/** Настройки песочницы. Живут в `settings.json` (`ai.sandbox`). */
export interface AiSandboxSettings {
  /** Выключено — команды идут на хосте, как раньше. */
  enabled: boolean;
  /** Образ, в котором выполняются команды. Задаёт человек, не модель. */
  image: string;
  /** Рабочий каталог внутри контейнера: сюда монтируется проект. */
  workdir: string;
  /** Разрешить контейнеру сеть. Выключено — `--network none`. */
  network: boolean;
}

/**
 * Образ по умолчанию. Взят питоновский: он сразу готов к «запусти и проверь»,
 * а большинство одноразовых скриптов пишутся на Python. Для другого стека образ
 * меняет человек в настройках — в нём должны быть инструменты проекта.
 */
export const DEFAULT_SANDBOX_IMAGE = 'python:3.12-slim';
/** Куда монтируем проект, если человек не задал своё. */
export const DEFAULT_SANDBOX_WORKDIR = '/workspace';

/** Имена движков контейнеров, которые подойдут: podman говорит на том же CLI. */
export const SANDBOX_ENGINES: readonly string[] = ['docker', 'podman', 'docker.exe', 'podman.exe'];

/** Общие ограничения: длинное имя образа — это уже не имя, а попытка обойти разбор. */
const MAX_IMAGE_CHARS = 200;
const MAX_WORKDIR_CHARS = 200;

/** Настройки по умолчанию: выключено, образ готовый, сеть разрешена. */
export const DEFAULT_SANDBOX: AiSandboxSettings = {
  enabled: false,
  image: DEFAULT_SANDBOX_IMAGE,
  workdir: DEFAULT_SANDBOX_WORKDIR,
  network: true,
};

/**
 * Проверка имени образа. Имя уходит первым аргументом `docker run`, то есть в
 * позицию, где всё, начинающееся с дефиса, читается как флаг: `--privileged`
 * вместо образа выдал бы контейнер с правами хоста. Поэтому имя проверяем
 * строго, а не «как получится».
 */
export function checkSandboxImage(raw: string): { ok: true; image: string } | { ok: false; reason: string } {
  const image = raw.trim();
  if (!image) return { ok: false, reason: 'Не задан образ: укажите его в настройках «Песочница»' };
  if (image.length > MAX_IMAGE_CHARS) return { ok: false, reason: `Имя образа длиннее ${MAX_IMAGE_CHARS} символов` };
  if (image.startsWith('-')) {
    return { ok: false, reason: `Имя образа не может начинаться с дефиса: «${image}». Это место флагов docker` };
  }
  if (/\s/.test(image)) return { ok: false, reason: `В имени образа пробел: «${image}»` };
  // Разрешён только обычный вид ссылки на образ: имя, слэши, тег, дайджест.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(image)) {
    return { ok: false, reason: `Непонятное имя образа: «${image}»` };
  }
  return { ok: true, image };
}

/**
 * Рабочий каталог внутри контейнера. Должен быть абсолютным путём и не содержать
 * `:` — иначе сломается запись монтирования `хост:контейнер`, и проект уедет не
 * туда (или `-v` прочитает часть пути как флаг). Непонятное значение заменяем
 * значением по умолчанию, а не пытаемся угадать.
 */
export function normalizeSandboxWorkdir(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_SANDBOX_WORKDIR;
  if (value.length > MAX_WORKDIR_CHARS) return DEFAULT_SANDBOX_WORKDIR;
  if (value.includes(':')) return DEFAULT_SANDBOX_WORKDIR;
  if (/\s/.test(value)) return DEFAULT_SANDBOX_WORKDIR;

  const absolute = value.startsWith('/') ? value : `/${value}`;
  const normalized = absolute.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
  // Корень монтировать нельзя: проект накрыл бы всю файловую систему контейнера.
  if (normalized === '/' || normalized.startsWith('/..')) return DEFAULT_SANDBOX_WORKDIR;
  return normalized.replace(/\/$/, '') || DEFAULT_SANDBOX_WORKDIR;
}

/** Привести настройки из файла к известному виду: файл правят и руками. */
export function sanitizeSandbox(raw: unknown): AiSandboxSettings {
  const value = (raw ?? {}) as Partial<AiSandboxSettings>;
  const image = checkSandboxImage(typeof value.image === 'string' ? value.image : DEFAULT_SANDBOX_IMAGE);
  return {
    enabled: value.enabled === true,
    // Побитое имя образа — не повод запускать что попало: возвращаемся к образцу.
    image: image.ok ? image.image : DEFAULT_SANDBOX_IMAGE,
    workdir: normalizeSandboxWorkdir(value.workdir),
    network: value.network !== false,
  };
}

/** Аргументы запуска — всё, что идёт после имени движка. */
export interface SandboxRunOptions {
  /** Абсолютный путь к корню проекта на хосте: его монтируем в контейнер. */
  root: string;
  /** Кто будет владельцем файлов внутри контейнера (`1000:1000`). */
  user?: string;
}

/**
 * Собрать аргументы `docker run` для одной команды.
 *
 * Важный момент — монтирование: наружу отдаём ровно один каталог (корень
 * проекта) в режиме чтения-записи и ничего больше. Ни домашнего каталога, ни
 * сокета docker, ни переменных окружения хоста: контейнер не должен видеть ни
 * ключей, ни истории, ни запущенных процессов пользователя.
 *
 * Команда уходит последним аргументом после `sh -c`, поэтому внутри контейнера
 * работают пайпы и перенаправления, а на хосте ничего не разбирается: список
 * аргументов передаётся процессу как есть (см. `runProcess`).
 */
export function sandboxDockerArgs(settings: AiSandboxSettings, command: string, options: SandboxRunOptions): string[] {
  const image = checkSandboxImage(settings.image);
  if (!image.ok) throw new Error(image.reason);
  if (!options.root.trim()) throw new Error('Не задана рабочая папка проекта');

  const workdir = normalizeSandboxWorkdir(settings.workdir);
  const args = [
    'run',
    '--rm',
    // Проект — единственное, что связывает контейнер с хостом.
    '--volume',
    `${options.root}:${workdir}`,
    '--workdir',
    workdir,
    // Сеть по умолчанию выключена на уровне флагов, а не «как получится».
    ...(settings.network ? [] : ['--network', 'none']),
    // Цвета и прогресс-бары в выводе агента только мешают — те же просьбы, что у хоста.
    '--env',
    'NO_COLOR=1',
    '--env',
    'TERM=dumb',
  ];
  // Файлы, созданные в смонтированном проекте, не должны становиться root-овыми:
  // на Linux работаем от имени пользователя. На Windows и macOS этим занят Docker Desktop.
  if (options.user) args.push('--user', options.user);
  args.push(image.image, 'sh', '-c', command);
  return args;
}

/** Короткая подпись для вывода инструмента: видно, где именно шла команда. */
export function formatSandboxLabel(settings: AiSandboxSettings): string {
  return `контейнер ${checkSandboxImage(settings.image).ok ? settings.image.trim() : DEFAULT_SANDBOX_IMAGE}`;
}

/**
 * Что сказать модели, когда песочница включена. Агент должен знать, что работает
 * не в обычном окружении: инструментов хоста в контейнере нет, установленное
 * внутри останется внутри, а смонтированный проект — общий.
 */
export function sandboxNote(settings: AiSandboxSettings, available: boolean): string {
  if (!available) {
    return [
      'Песочница включена, но движок контейнеров (docker или podman) в PATH не найден.',
      'Команды и тесты выполнить не удастся — на хост они НЕ переключаются. Скажи об этом пользователю и предложи установить движок или выключить песочницу.',
    ].join('\n');
  }

  return [
    `Команды и тесты выполняются не на машине пользователя, а в контейнере ${settings.image.trim()}.`,
    `Проект смонтирован в ${normalizeSandboxWorkdir(settings.workdir)} — правки файлов там видны на хосте, а всё остальное (установленные пакеты, системные изменения, переменные окружения) останется внутри контейнера и исчезнет после запуска.`,
    settings.network
      ? 'Сеть в контейнере разрешена.'
      : 'Сеть в контейнере выключена: скачивание пакетов не сработает — не предлагай его.',
    'Не рассчитывай на инструменты хоста (интерпретатор проекта, npm, pytest), если их нет в образе.',
  ].join('\n');
}
