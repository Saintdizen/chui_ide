import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatRunLog } from '../../shared/run-log';
import {
  buildRunRecord,
  formatTelemetryLine,
  parseTelemetry,
  type RunTelemetryInput,
  type RunTelemetryRecord,
} from '../../shared/telemetry';
import { buildCountsRecord, formatCountsLine, type CountsInput } from '../../shared/step-counts';

/**
 * Журнал прогонов: файл в пользовательских данных и запись в него.
 *
 * Файлов два и они разные по цене согласия.
 *
 * `runs.jsonl` — полный журнал, только по включённой настройке: в записи лежат
 * системные инструкции, контекст проекта и ответы модели, то есть чтение чужой
 * переписки без спроса.
 *
 * `counts.jsonl` — счётчик шагов (`shared/step-counts.ts`): имена инструментов,
 * числа, наши же короткие пометки. Ни одного слова переписки — поэтому пишется
 * всегда, без настройки. Без него замеры приходилось считать по `chats/*.json`, где
 * от прогона остались только итоги, — и каждый вывод про инструменты проверялся
 * «на глаз».
 *
 * Формат — JSON Lines: строка на прогон. Дописывание дешевле перезаписи целого
 * файла, а падение посреди записи портит только последнюю строку, и разбор её
 * пропускает (см. `parseTelemetry`).
 *
 * Файл растёт, но не бесконечно: перед записью смотрим размер и, если журнал
 * перевалил за потолок, сдвигаем его в `runs.1.jsonl` (одна предыдущая копия).
 * Ротация на один шаг, а не по датам: журнал — диагностика, а не архив.
 */

export const TELEMETRY_FILE = 'runs.jsonl';
/** Счётчик шагов — всегда включён: текстов переписки в нём нет. */
export const COUNTS_FILE = 'counts.jsonl';
/** Предел файла: выше — сдвигаем в `runs.1.jsonl`. */
export const MAX_TELEMETRY_FILE_BYTES = 4 * 1024 * 1024;

/** Папка журнала — внутри пользовательских данных приложения. */
export function telemetryDir(userData: string): string {
  return path.join(userData, 'telemetry');
}

export interface TelemetryStoreDeps {
  /** Папка журнала. */
  dir(): string;
  /** Включена ли запись: читается на каждый прогон — настройку могли поменять. */
  enabled(): boolean;
}

export class TelemetryStore {
  /** Очередь записи: два прогона разом не должны перемешать строки в файле. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: TelemetryStoreDeps) {}

  get enabled(): boolean {
    return this.deps.enabled();
  }

  /** Путь к журналу — для показа человеку и для проверок. */
  path(): string {
    return path.join(this.deps.dir(), TELEMETRY_FILE);
  }

  /** Путь к счётчику шагов (`scripts/step-report.ts` читает его по умолчанию). */
  countsPath(): string {
    return path.join(this.deps.dir(), COUNTS_FILE);
  }

  /**
   * Записать прогон. Выключенная телеметрия — тишина: ни файла, ни папки.
   *
   * Ошибку записи не поднимаем: диагностика не должна ронять прогон, который уже
   * состоялся. Но и молчать вечно нехорошо — говорим в stderr.
   */
  record(run: ChatRunLog, input: RunTelemetryInput = {}): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const line = `${formatTelemetryLine(buildRunRecord(run, input))}\n`;
    this.queue = this.queue.then(() => this.append(this.path(), line));
    return this.queue;
  }

  /**
   * Записать счётчик шагов. В отличие от полного журнала — без настроек и без
   * содержания: только имена, числа и пометки, поэтому согласия не требует.
   */
  recordCounts(run: ChatRunLog, input: CountsInput = {}): Promise<void> {
    const line = `${formatCountsLine(buildCountsRecord(run, input))}\n`;
    this.queue = this.queue.then(() => this.append(this.countsPath(), line));
    return this.queue;
  }

  /** Последние записи и сам файл: `records` — разбор хвоста, а не всего файла. */
  async tail(maxChars = 200_000): Promise<{ path: string; bytes: number; records: RunTelemetryRecord[] }> {
    const file = this.path();
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const bytes = Buffer.byteLength(text, 'utf8');
    const slice = text.length > maxChars ? text.slice(text.length - maxChars) : text;
    // Первая строка обрезанного хвоста могла начаться с середины — разбор её пропустит.
    return { path: file, bytes, records: parseTelemetry(slice) };
  }

  /** Очистить журнал: строки удаляются целиком, предыдущая копия тоже. */
  async clear(): Promise<void> {
    for (const file of [this.path(), this.countsPath()]) {
      await fs.rm(file, { force: true }).catch(() => undefined);
      await fs.rm(previousFile(file), { force: true }).catch(() => undefined);
    }
  }

  private async append(file: string, line: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await this.rotateIfNeeded(file);
      await fs.appendFile(file, line, 'utf8');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[chui] журнал прогонов не записан: ${reason}\n`);
    }
  }

  /** Сдвиг тяжёлого журнала: одна предыдущая копия, без накопления папки. */
  private async rotateIfNeeded(file: string): Promise<void> {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.size < MAX_TELEMETRY_FILE_BYTES) return;
    await fs.rename(file, previousFile(file)).catch(() => undefined);
  }
}

/** Предыдущая копия журнала: одна и та же, каждый сдвиг её перезаписывает. */
function previousFile(file: string): string {
  return file.replace(/\.jsonl$/, '.1.jsonl');
}
