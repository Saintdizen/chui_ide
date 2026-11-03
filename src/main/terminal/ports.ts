/**
 * Слушающие порты машины: раз в несколько секунд — один запуск системной
 * утилиты, разбор — в `shared/port-forward.ts`.
 *
 * Опрос ленивый: панель закрыта — команд нет. Открыта — `refresh()` зовётся из
 * рендерера по таймеру. Обратного канала (push) здесь нет намеренно: частота
 * меняется от того, смотрят ли на панель, а это знает только рендерер.
 *
 * lsof важнее ss: `ss -p` без root показывает pid не у всех процессов, lsof —
 * показывает все свои, а чужие частично. Ошибка любой из них — не повод
 * показать пусто: пробуем следующую.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseListings, parsePsTree, portEntries, type PortEntry } from '../../shared/port-forward';

const run = promisify(execFile);

/** Опции для утилита — с ограничением вывода, чтобы забытый `lsof -i` не съел память. */
const TIMEOUT_MS = 3000;

async function tryCommand(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(file, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    // Нет утилиты, нет прав, ненулевой код — все три означают «этим путём не
    // получилось»; выбор следующего пути — не за этим вызовом.
    return null;
  }
}

async function listenListing(): Promise<string | null> {
  // Порядок — от самого информативного. На macOS `ss` нет, на Windows — ни того, ни другого.
  return (
    (await tryCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])) ??
    (await tryCommand('ss', ['-ltnp'])) ??
    (await tryCommand('netstat', ['-ltnp']))
  );
}

async function processTree(): Promise<string | null> {
  // `pid=,ppid=` без заголовка — разбор в shared не зависит от платформы.
  return (await tryCommand('ps', ['-eo', 'pid=,ppid='])) ?? null;
}

/**
 * Порт, который открывает сама IDE, тоже попадёт в список (отладчик, превью,
 * языковые серверы). Это не шум: он сидит на порте машины так же, как чужие.
 */

export class PortService {
  /**
   * Собрать список сейчас. Кэша нет осознанно: `refresh` зовётся по таймеру
   * рендерера, а держать порты устаревшими дольше опроса — хуже, чем лишний `ps`.
   */
  async list(sessions: ReadonlyMap<number, string>): Promise<PortEntry[]> {
    const listing = await listenListing();
    if (listing === null) return [];
    const ports = parseListings(listing);
    if (ports.length === 0) return [];
    // Дерево нужно только когда есть кому его сопоставить: без сессий
    // терминалов привязка не найдётся ни для какого порта.
    const tree = sessions.size === 0 ? new Map<number, number>() : parsePsTree((await processTree()) ?? '');
    return portEntries(ports, sessions, tree);
  }
}
