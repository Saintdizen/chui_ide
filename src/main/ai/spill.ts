import fs from 'node:fs';
import path from 'node:path';

/**
 * Длинный вывод инструмента — в файл, а не под нож.
 *
 * Обрезка вывода нужна: один `npm install` или файл на 2 МБ не влезают в окно
 * модели. Но обрезка «в никуда» теряет данные: агент видит пометку «вывод
 * обрезан» и не может достать отброшенное — приходится запускать команду
 * заново, а второй запуск даёт уже другой вывод. Поэтому отброшенное
 * складывается в файл, а модели отдаётся путь и подсказка, чем его прочитать
 * (`read_file` с диапазоном строк).
 *
 * Модуль ничего не знает про инструменты и Electron: каталог приходит снаружи.
 * Это позволяет проверить запись без окна и без userData разработчика.
 */

/**
 * Потолок файла в символах (не байтах: русский текст в utf8 вдвое тяжелее).
 * Дальше писать некуда — это уже не отладочный хвост, а заливка диска.
 */
export const MAX_SPILL_CHARS = 4_000_000;

/** Сколько файлов держим: старые уходят, иначе каталог растёт молча. */
export const MAX_SPILL_FILES = 40;

/**
 * Потолок для свёрнутых результатов — отдельно от хвостов команд.
 *
 * Свёртка пишет копию на каждый проход, и общий счётчик вытеснял хвосты
 * настоящих команд: в живом каталоге было 38 копий свёртки против 2 хвостов, —
 * а хвост `terminal` нужен модели и человеку, когда сама команда давно забыта.
 * Перечитать свёртку почти не надо (её текст и так не нужен целиком), а хвост
 * нужен — значит и лимиты у них разные.
 */
export const MAX_AGED_FILES = 8;

/**
 * Имя файла: время и инструмент. Время первым — по нему же сортируется уборка,
 * а человеку по имени видно, к какому вызову относится файл.
 */
export function spillName(kind: string, at: Date = new Date()): string {
  const stamp = at.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const safe = kind.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'tool';
  return `${stamp}-${safe}.txt`;
}

/** Что сказать модели вместо голого «вывод обрезан». */
export function spillHint(file: string): string {
  return `полностью — в файле ${file}: читайте read с диапазоном строк`;
}

/**
 * Поток в файл: куски приходят по мере чтения процесса, поэтому полный вывод
 * нигде не копится целиком — в памяти остаются только голова и хвост.
 */
export interface SpillStream {
  write(chunk: string): void;
  /**
   * Закрыть поток. `keep` — оставить файл и получить путь; иначе файл убирается:
   * копия вывода, который и так ушёл модели целиком, никому не нужна.
   */
  close(keep: boolean): string | null;
}

export function createSpillStream(dir: string, kind: string): SpillStream {
  const file = path.join(dir, spillName(kind));
  let fd: number | null = null;
  let written = 0;
  let broken = false;

  /** Файл открывается при первой записи: короткие выводы его не создают вовсе. */
  const open = (): number | null => {
    if (fd !== null) return fd;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fd = fs.openSync(file, 'w');
      return fd;
    } catch {
      broken = true;
      return null;
    }
  };

  return {
    write(chunk) {
      if (broken || chunk.length === 0) return;
      const room = MAX_SPILL_CHARS - written;
      if (room <= 0) return;
      const text = chunk.length > room ? chunk.slice(0, room) : chunk;
      const handle = open();
      if (handle === null) return;
      try {
        fs.writeSync(handle, text);
        written += text.length;
      } catch {
        broken = true;
      }
    },
    close(keep) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          broken = true;
        }
        fd = null;
      }
      if (!keep || broken || written === 0) {
        removeQuiet(file);
        return null;
      }
      prune(dir);
      return file;
    },
  };
}

/**
 * Записать текст целиком. Возвращает путь или null: сбой записи не должен
 * ломать сам инструмент — тогда останется прежняя пометка «вывод обрезан».
 */
export function spillText(dir: string, kind: string, text: string): string | null {
  const stream = createSpillStream(dir, kind);
  stream.write(text);
  return stream.close(true);
}

/** Своё имя у свёртки: по нему уборка и отличает её от хвостов команд. */
export const AGED_KIND = 'svernutye-rezultaty';

/**
 * Убрать старые файлы. Счёт у каждого вида свой: свёртка живёт по
 * `MAX_AGED_FILES`, всё остальное — по `MAX_SPILL_FILES`. Имя начинается со
 * времени, поэтому сортировка режет именно старое.
 */
export function prune(dir: string, keep: number = MAX_SPILL_FILES): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.txt'));
  } catch {
    return;
  }
  const aged = names.filter((name) => name.includes(`-${AGED_KIND}.txt`));
  const rest = names.filter((name) => !name.includes(`-${AGED_KIND}.txt`));
  for (const [list, limit] of [
    [aged, Math.min(keep, MAX_AGED_FILES)],
    [rest, keep],
  ] as const) {
    if (list.length <= limit) continue;
    list.sort();
    for (const name of list.slice(0, list.length - limit)) removeQuiet(path.join(dir, name));
  }
}

function removeQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // файла нет или он занят — уборка не повод падать
  }
}
