import { execFile } from 'node:child_process';
import { addressName, formatFsAddress, joinAddress, parseFsAddress, type FsAddress } from '../../shared/fs-address';
import type { DirEntry } from '../../shared/api';

/**
 * Удалённые файловые системы: SSH, WSL и контейнеры.
 *
 * Своего протокола у нас нет, и заводить его — отдельная жизнь (свой клиент,
 * ключи, обрывы связи). Зато `ssh`, `wsl` и `docker` уже стоят у человека и умеют
 * ровно то, что нужно: выполнить команду на той стороне и вернуть её вывод. Поэтому
 * вся работа идёт через них: адрес (`shared/fs-address.ts`) превращается в команду,
 * а вывод разбирается здесь же — до того, как он станет обычным `DirEntry`.
 *
 * Что это даёт и чего не даёт. Даёт: смотреть и править файлы удалённой папки из
 * того же окна. Не даёт: наблюдения за папкой, языкового сервера, git-пометок и
 * индексации по удалённым путям — это всё локальные вещи (см. `README`, «Что
 * дальше»). Так честнее, чем притвориться, что удалённая папка неотличима.
 *
 * Модуль почти чистый: формирование команд и разбор вывода — отдельные функции без
 * процессов, поэтому их проверяют тесты; процесс запускается одним методом.
 */

/** Потолок вывода команды: файл целиком читаем до этого размера. */
const MAX_OUTPUT = 8 * 1024 * 1024;

/** Предел времени на команду: сеть и чужие диски отвечают не мгновенно. */
const COMMAND_TIMEOUT_MS = 20_000;

/** Разделитель полей вывода: байт US, как в git-парсерах — в именах его не бывает. */
const FIELD = '\u001f';

/** Результат запуска на той стороне. */
export interface RemoteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Экранирование аргумента для оболочки той стороны. Одинарные кавычки — самый
 * простой надёжный способ; встречающаяся кавычка закрывает строку и открывает её
 * заново уже экранированной (`'\''`), поэтому имя файла не может разорвать команду.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Команда оболочки для адреса: первая часть — «как ходить», вторая — что сделать.
 * `wsl` и `container` получают владельца аргументом, путь — уже внутри команды.
 */
export function remoteCommand(address: FsAddress, command: string): { file: string; args: string[] } {
  switch (address.scheme) {
    case 'ssh':
      // Портик и пользователя отдаём как есть: их разбирает сам ssh, а `--` отделяет
      // адрес от команды, чтобы её первые слова он не принял за свои флаги.
      return { file: 'ssh', args: [...sshTargetArgs(address.authority), '--', command] };
    case 'wsl':
      return { file: 'wsl', args: ['-d', address.authority, '--', 'sh', '-lc', command] };
    case 'container':
      return { file: 'docker', args: ['exec', address.authority, 'sh', '-lc', command] };
  }
}

/** Аргументы адресата ssh: `[user@]host` и отдельный порт, если он задан. */
export function sshTargetArgs(authority: string): string[] {
  const match = /^(?:(?<user>[^@/]+)@)?(?<host>[^:/]+)(?::(?<port>\d+))?$/.exec(authority);
  if (!match?.groups) return [authority];
  const { user, host, port } = match.groups;
  const target = user ? `${user}@${host}` : host!;
  return port ? ['-p', port, target] : [target];
}

/** Команда «прочитать каталог»: папки/файлы/ссылки плюс время и размер. */
export function listDirCommand(address: FsAddress): string {
  // `find` с `-printf` есть в GNU coreutils (Linux на той стороне — обычное дело).
  // Формат печатаем разделителем US, а имя — последним: пробелы и перевод строки
  // в именах разбор ломать не должны.
  const pattern = `%y${FIELD}%T@${FIELD}%s${FIELD}%f`;
  return `find ${shellQuote(address.path)} -mindepth 1 -maxdepth 1 -printf ${shellQuote(`${pattern}\\n`)}`;
}

/** Разбор вывода `find`: строки, которые не сложились, просто пропускаем. */
export function parseDirListing(stdout: string, address: FsAddress): DirEntry[] {
  const entries: DirEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [type, seconds, size, ...rest] = line.split(FIELD);
    const name = rest.join(FIELD);
    if (!type || !name) continue;
    const mtime = Number(seconds);
    const bytes = Number(size);
    entries.push({
      name,
      path: joinAddress(address, name),
      kind: type === 'd' ? 'directory' : type === 'l' ? 'symlink' : 'file',
      mtimeMs: Number.isFinite(mtime) ? Math.round(mtime * 1000) : 0,
      size: Number.isFinite(bytes) ? bytes : 0,
    });
    if (entries.length >= MAX_DIR_ENTRIES) break;
  }
  return entries;
}

/** Потолок списка каталога: папка с сотней тысяч файлов не должна вешать окно. */
export const MAX_DIR_ENTRIES = 5000;

/** Команда «прочитать файл»: `cat` с ограничением размера. */
export function readFileCommand(address: FsAddress, maxBytes: number): string {
  // `head -c` обрезает на той стороне: тянуть мегабайты по сети ради отказа нельзя.
  return `head -c ${Math.max(1, Math.round(maxBytes))} -- ${shellQuote(address.path)}`;
}

/** Команда «записать файл»: содержимое приходит на стандартный ввод. */
export function writeFileCommand(address: FsAddress): string {
  return `cat > ${shellQuote(address.path)}`;
}

/** Команда «состояние файла»: время правки, размер и вид одной строкой. */
export function statCommand(address: FsAddress): string {
  return `stat -c ${shellQuote(`%Y${FIELD}%s${FIELD}%F`)} -- ${shellQuote(address.path)}`;
}

/** Разбор ответа `stat`: `null` — файла нет или ответ не сложился. */
export function parseStat(stdout: string): { mtimeMs: number; size: number; kind: 'file' | 'directory' } | null {
  const [seconds, size, kind] = stdout.trim().split(FIELD);
  const at = Number(seconds);
  const bytes = Number(size);
  if (!Number.isFinite(at) || at <= 0) return null;
  return {
    mtimeMs: Math.round(at * 1000),
    size: Number.isFinite(bytes) ? bytes : 0,
    kind: kind === 'directory' ? 'directory' : 'file',
  };
}

/** Команды изменения: создание каталогов, переименование, копирование, удаление. */
export function mkdirCommand(address: FsAddress): string {
  return `mkdir -p -- ${shellQuote(address.path)}`;
}

export function moveCommand(from: FsAddress, to: FsAddress): string {
  return `mv -- ${shellQuote(from.path)} ${shellQuote(to.path)}`;
}

export function copyCommand(from: FsAddress, to: FsAddress): string {
  return `cp -r -- ${shellQuote(from.path)} ${shellQuote(to.path)}`;
}

export function removeCommand(address: FsAddress, recursive = true): string {
  return `rm ${recursive ? '-rf' : '-f'} -- ${shellQuote(address.path)}`;
}

/** Короткая подпись адреса для сообщений: «SSH: host: /srv/app» — из `shared/fs-address`. */
export function remoteName(address: FsAddress): string {
  return addressName(address) || address.authority;
}

/** Адрес строкой — так он уходит в RPC и настройки. */
export function remoteToString(address: FsAddress): string {
  return formatFsAddress(address);
}

/** Проверка «путь принадлежит этому адресу»: по-другому его открывать нельзя. */
export function belongsToAddress(address: FsAddress, path: string): boolean {
  const parsed = parseFsAddress(path);
  return parsed !== null && formatFsAddress(parsed) === formatFsAddress(address);
}

/**
 * Найти `ssh`, `wsl` или `docker` в PATH. Без клиента схему открыть нельзя, и об
 * этом надо сказать словами — «команда не найдена» пользователю ничего не говорит.
 */
export function clientNameOf(address: FsAddress): string {
  return address.scheme === 'ssh' ? 'ssh' : address.scheme === 'wsl' ? 'wsl' : 'docker';
}

/** Запустить команду на той стороне. Только здесь есть процесс — всё прочее чистое. */
export class RemoteShell {
  /**
   * `stdin` — данные для записи файла: они уходят на вход команды (в `cat`), поэтому
   * содержимое не проходит через аргументы и не упирается в их длину.
   */
  run(address: FsAddress, command: string, stdin?: string): Promise<RemoteResult> {
    const { file, args } = remoteCommand(address, command);
    return new Promise((resolve) => {
      const child = execFile(
        file,
        args,
        {
          timeout: COMMAND_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT,
          windowsHide: true,
          // Ввода от человека не ждём: пароль и подсказки ключа — не для этого окна.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
        },
        (error, stdout, stderr) => {
          resolve({ ok: error === null, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
      if (stdin !== undefined) {
        child.stdin?.end(stdin);
      }
    });
  }

  /**
   * Клиент есть в системе? Спрашиваем у него версию, но судим НЕ по коду возврата.
   *
   * Ловушка: у OpenSSH нет длинной опции `--version` — он отвечает «unknown option»
   * и выходит с ошибкой, хотя сам на месте (поэтому у ssh спрашиваем `-V`). Значит,
   * признак «клиента нет» — только `ENOENT` (файла нет в PATH); любой другой ответ
   * означает, что программа ответила.
   */
  async available(address: FsAddress): Promise<{ ok: boolean; detail: string }> {
    const client = clientNameOf(address);
    const args = address.scheme === 'ssh' ? ['-V'] : ['--version'];
    const result = await new Promise<{ missing: boolean; stdout: string; stderr: string }>((resolve) => {
      execFile(client, args, { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({ missing: code === 'ENOENT', stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    });
    if (result.missing) {
      return { ok: false, detail: `Не нашёл клиент «${client}»: поставьте его или задайте путь в PATH` };
    }
    const version =
      (result.stdout || result.stderr)
        .split('\n')
        .find((line) => line.trim() !== '')
        ?.trim() ?? '';
    return { ok: true, detail: version || `${client}: клиент на месте` };
  }
}
