/**
 * Запуск терминала системы в папке проекта: какую команду и с какими доводами
 * звать на каждой платформе.
 *
 * Встроенный терминал (панель IDE) — отдельная история: здесь открывается
 * ПРИВЫЧНЫЙ человеку терминал, тем, чем он пользуется. Угадать его нельзя, поэтому
 * устроено так: свой выбор из настройки (или `$TERMINAL`) → известные терминалы
 * платформы по порядку частоты. Ничего не нашлось — честно говорим об этом.
 *
 * Логика чистая: платформа, папка и проверка «есть ли команда» приходят снаружи,
 * значит её можно проверить тестами, не поднимая настоящий терминал.
 */

/** Платформа, как её называет Node. Свой тип: `shared` не тянет типы Node. */
export type LaunchPlatform = 'linux' | 'darwin' | 'win32';

export interface TerminalLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

export interface TerminalChoice {
  /** Свой терминал человека (`$TERMINAL` или настройка): пробуется первым. */
  preferred?: string;
  /**
   * Оболочка Windows (`%ComSpec%`). Приходит снаружи: `shared` не читает окружение
   * процесса — этот файл попадает и в браузер, где `process` нет вовсе.
   */
  comspec?: string;
}

/**
 * Известные терминалы Linux и то, как в них задать рабочий каталог. Порядок —
 * от частого к редкому: у первого же найденного и остановимся. Аргументы у всех
 * разные, поэтому у каждого терминала своя функция.
 */
const LINUX_TERMINALS: ReadonlyArray<{ command: string; dirArgs: (dir: string) => readonly string[] }> = [
  { command: 'gnome-terminal', dirArgs: (dir) => [`--working-directory=${dir}`] },
  { command: 'konsole', dirArgs: (dir) => ['--workdir', dir] },
  { command: 'xfce4-terminal', dirArgs: (dir) => [`--working-directory=${dir}`] },
  { command: 'tilix', dirArgs: (dir) => [`--working-directory=${dir}`] },
  { command: 'mate-terminal', dirArgs: (dir) => [`--working-directory=${dir}`] },
  { command: 'kitty', dirArgs: (dir) => ['--directory', dir] },
  { command: 'alacritty', dirArgs: (dir) => ['--working-directory', dir] },
  // У xterm и подобных «свой каталог» задаётся только рабочим каталогом процесса.
  { command: 'xterm', dirArgs: () => [] },
];

/**
 * Команда запуска терминала. `preferred` — выбор человека (`$TERMINAL` или
 * настройка): он пробуется первым и получает только рабочий каталог процесса —
 * общих доводов «откройся здесь» у незнакомых терминалов нет.
 *
 * `isAvailable` отвечает, есть ли команда в системе; её передают снаружи, чтобы
 * функция осталась чистой.
 */
export function pickExternalTerminal(
  platform: LaunchPlatform,
  dir: string,
  isAvailable: (command: string) => boolean,
  choice: TerminalChoice = {},
): TerminalLaunch | null {
  const chosen = choice.preferred?.trim();
  if (chosen && isAvailable(chosen)) return { command: chosen, args: [] };

  if (platform === 'darwin') {
    // `open -a Terminal` открывает привычный терминал macOS в нужной папке.
    return isAvailable('open') ? { command: 'open', args: ['-a', 'Terminal', dir] } : null;
  }

  if (platform === 'win32') {
    // `start` открывает НОВОЕ окно консоли; рабочий каталог наследуется от `cwd`.
    const command = choice.comspec || 'cmd.exe';
    return isAvailable(command) ? { command, args: ['/c', 'start', '', 'cmd'] } : null;
  }

  for (const terminal of LINUX_TERMINALS) {
    if (isAvailable(terminal.command)) return { command: terminal.command, args: terminal.dirArgs(dir) };
  }
  return null;
}

/** Список известных терминалов Linux — нужен проверкам и подсказке в отказе. */
export function knownLinuxTerminals(): string[] {
  return LINUX_TERMINALS.map((terminal) => terminal.command);
}
