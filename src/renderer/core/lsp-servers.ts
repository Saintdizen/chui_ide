/**
 * Языковые серверы: дополнить настроенные найденными, один раз сказать о проблеме,
 * перезапустить под новое окружение, прогреть языки проекта.
 *
 * Раньше это было тремя замыканиями в `app.ts` вместе с флагом «уже сказали».
 * Флаги и гонки — самое невидное и самое ломкое место: три одновременных вызова на
 * старте окна давали три одинаковых уведомления. Здесь состояние живёт в замыкании
 * модуля, а не в файле на 6800 строк, и его можно проверить тестом.
 *
 * Знания о содержимом DOM нет. Окно приносит: показ уведомления, открытие настроек,
 * настройки (свежие на момент вызова), карту проекта и список открытых документов.
 */

import type { LspServerConfig } from '../../shared/api';
import type { LspStatus } from '../../shared/lsp-status';
import { lspLanguagesForKind, lspPrimaryLanguagesForKind, mergeLspServers } from '../../shared/lsp-presets';
import type { ProjectScan } from '../../shared/project-scan';
import type { RpcClient } from './rpc';

export interface OpenDocument {
  path: string;
  languageId: string;
  value: string;
}

export interface LspServersOptions {
  rpc: RpcClient;
  /** Свежие настройки: push-событие приходит позже ответа, читать копию нельзя. */
  settings: () => {
    lsp: { enabled: boolean; servers: LspServerConfig[] };
  };
  /** Карта проекта — для языков и для вида проекта; `null` — ещё не пересчитана. */
  scan: () => ProjectScan | null;
  /** Корень активного проекта: карта от другого корня считается чужой. */
  root: () => string | null;
  /** Открытые документы: после `lsp.restart` их нужно снова открыть в сервере. */
  documents: () => Iterable<OpenDocument>;
  toast: (message: string, kind?: 'info' | 'success' | 'error', action?: { label: string; run: () => void }) => void;
  /** Куда ведёт кнопка «поставить сервер» в уведомлении. */
  openLspSettings: () => void;
  /** Новый статус после перезапуска — показать чип сразу, не дожидаясь опроса. */
  onStatus: (status: LspStatus) => void;
  /** Прогрев заодно запускает сборку карты символов в main — начинаем за ней следить. */
  onPrewarmed?: () => void;
  /** Документы снова открыты в сервере: активному файлу нужны свежие данные. */
  onRestarted?: () => void;
  /** Признак «список пополнился» не нужен окну, но нужен тесту; окно может опустить. */
  announce?: (added: readonly string[]) => void;
}

/** Языки, которые стоит прогреть: из карты проекта и из его вида. */ export function prewarmLanguages(
  scan: ProjectScan | null,
): string[] {
  if (!scan) return [];
  const fromKind = lspPrimaryLanguagesForKind(scan.kind.id) ?? [];
  return [...new Set([...scan.languages.map((item) => item.id), ...fromKind])];
}

/**
 * Фраза «сервера для языка проекта нет» — или `null`, когда говорить не о чем.
 *
 * Молчать тут нельзя: без сервера не работают подсказки, переход к определению и
 * подсветка пометок, а человек считает, что «IDE не умеет» вместо «нет сервера».
 */
export function missingServerHint(kindId: string | null, found: readonly LspServerConfig[]): string | null {
  const languages = lspLanguagesForKind(kindId);
  if (!languages) return null;
  if (found.some((server) => languages.includes(server.language))) return null;
  return kindId === 'python'
    ? 'Языковой сервер для Python не найден: переходы и подсказки работать не будут'
    : 'Языковой сервер для JS/TS не найден: переходы и подсказки работать не будут';
}

export function createLspServers(options: LspServersOptions) {
  const { rpc, settings, scan, root, documents, toast, openLspSettings, onStatus } = options;

  /** Про выключенные серверы говорим один раз за сеанс — иначе это стал бы шум. */
  let hintShown = false;
  /** Про отсутствие сервера для языка проекта — тоже один раз. */
  let missingShown = false;
  /** Языки, о подключении которых уже сказали: повтор про то же — шум. */
  const announced = new Set<string>();
  /** Идущий прогон поиска — один на всех вызывающих. */
  let running: Promise<boolean> | null = null;

  /**
   * Прогреть серверы языков проекта, не дожидаясь открытия файлов.
   *
   * Греть серверы языков, которых в проекте нет, — лишние процессы. Карта от другого
   * корня (проект только что сменился) — молчим: прогреем, когда она пересчитается.
   * Для каких языков сервер есть, решает main — у него свежие настройки, а здешние
   * могли отстать; там же поднятый сервер обходит проект и строит индекс.
   */
  const prewarm = async (): Promise<void> => {
    if (!settings().lsp.enabled) return;
    const activeRoot = root();
    const map = scan();
    if (!activeRoot || !map || map.root !== activeRoot) return;
    const languages = prewarmLanguages(map);
    if (languages.length === 0) return;
    await rpc.request('lsp.prewarm', { languages });
    // Прогрев заодно запускает сборку карты символов в main — начинаем за ней следить.
    options.onPrewarmed?.();
  };

  const discover = async (): Promise<boolean> => {
    // Мастер-тумблер — решение человека: в обход него серверы не подставляем и не
    // запускаем. Но если серверы в проекте есть, а подсказки выключены, сказать об
    // этом стоит — иначе причину ищут в окружении, а не в настройке.
    if (!settings().lsp.enabled) {
      if (!hintShown) {
        // Флаг занимаем ДО запроса: два вызова накладываются (загрузка и смена
        // проекта), и если ставить его после ответа, оба успеют показать уведомление.
        hintShown = true;
        const available = await rpc.request('lsp.detect').catch(() => []);
        if (available.length > 0) {
          toast('Языковые серверы установлены, но выключены в настройках', 'info', {
            label: 'Открыть',
            run: openLspSettings,
          });
        } else {
          // Серверов нет — уведомления не было; пусть скажем позже, когда появятся.
          hintShown = false;
        }
      }
      return false;
    }

    const found = await rpc.request('lsp.detect').catch(() => []);
    if (!missingShown) {
      const hint = missingServerHint(scan()?.kind.id ?? null, found);
      if (hint) {
        missingShown = true;
        toast(hint, 'info', { label: 'Поставить', run: openLspSettings });
      }
    }

    const configured = settings().lsp.servers;
    const merged = mergeLspServers(configured, found);
    if (merged.length === configured.length) return false;

    // Дописанное всегда идёт в хвосте (см. `mergeLspServers`) — по длине исходного
    // списка видно, что именно подключилось, и об этом стоит сказать.
    const added = merged
      .slice(configured.length)
      .map((server) => server.language)
      .filter((language) => !announced.has(language));
    await rpc.request('settings.update', { lsp: { servers: merged } }).catch(() => undefined);
    // Сказать нечего — молчим: повторный прогон на тех же языках заметил бы их снова
    // (настройки приходят push-событием позже ответа).
    if (added.length === 0) return true;
    for (const language of added) announced.add(language);
    options.announce?.(added);
    toast(`Языковые серверы подключены: ${added.join(', ')}`);
    return true;
  };

  /**
   * Окно: идёт ли прогон. Нужно для подсказки «сервера нет» — пока список едет,
   * говорить «не найден» рано.
   */
  const isRunning = (): boolean => running !== null;

  /**
   * Дополнить настроенные серверы найденными — одним прогоном на всех.
   *
   * Зовут почти одновременно загрузка окна, открытие проекта и смена корня; порознь
   * каждый показывал своё уведомление. Вызовы, пришедшие во время прогона, ждут его.
   */
  const ensure = (): Promise<boolean> => {
    if (!running) {
      running = discover().finally(() => {
        running = null;
      });
    }
    return running;
  };

  /**
   * Перезапустить серверы и заново открыть в них документы.
   *
   * Сервер поднимается с интерпретатором проекта один раз — при первом открытии
   * файла этого языка. Сменившееся окружение он сам не заметит, а после перезапуска
   * документы в нём уже не значатся: без повторного `lsp.open` подсказки пропали бы
   * до переоткрытия файла.
   *
   * Тумблер читаем свежим: `lsp.restart` шлёт main уведомление о настройках, и
   * локальная копия в этот момент ещё старая. Уйди запрос с ней — main снял бы
   * сервер, разбудил его новым списком и тут же получил второй рестарт.
   */
  const restart = async (): Promise<void> => {
    if (!settings().lsp.enabled) return;
    const status = await rpc.request('lsp.restart').catch(() => null);
    if (status) onStatus(status);
    if (!settings().lsp.enabled) return;
    for (const document of documents()) {
      void rpc.request('lsp.open', {
        path: document.path,
        languageId: document.languageId,
        text: document.value,
      });
    }
    // Перезапуск снял и «не поднялось» — обновляем чип сразу ответом, а серверы
    // поднимутся следом, когда уйдут `lsp.open` (тогда переспросим ещё раз).
    options.onRestarted?.();
  };

  /**
   * Подхватить появившиеся серверы и перезапустить уже настроенные.
   *
   * Одно без другого бессмысленно: без перезапуска новый сервер не поднимется, а без
   * перезапуска со сменившимся окружением старый останется с прошлым интерпретатором.
   * Поэтому порядок один и тот же во всех случаях, когда окружение могло измениться.
   */
  const refresh = (): void => {
    void ensure()
      .then(() => restart())
      .then(() => prewarm());
  };

  return { ensure, restart, prewarm, refresh, isRunning };
}

export type LspServers = ReturnType<typeof createLspServers>;
