import { app, dialog } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describeError, formatDiagnostic, isQuietExit, type DiagnosticEntry } from '../shared/diagnostics';

/**
 * Сбои main и подсобных процессов.
 *
 * Без этого падение main выглядело бы просто закрывшимся окном: свой обработчик
 * отменяет стандартный вывод Electron в stderr, а из окна запуска его всё равно
 * никто не видит. Поэтому каждый сбой уходит в журнал рядом с settings.json и в
 * консоль, а о том, что дальше работать не выйдет, main спрашивает человека.
 */

interface DiagnosticsOptions {
  /** Куда писать журнал. По умолчанию — userData/logs/diagnostics.log. */
  logFile?: string;
}

/** Журнал сбоев: в userData, рядом с settings.json и сессиями проектов. */
export function diagnosticsLogPath(): string {
  return path.join(app.getPath('userData'), 'logs', 'diagnostics.log');
}

/** Дописывает запись. Неудача записи не должна становиться вторым сбоем. */
export function appendDiagnostic(file: string, entry: DiagnosticEntry): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${formatDiagnostic(entry)}\n\n`, 'utf8');
  } catch {
    // Нет прав или нет места на диске — молчим: в консоль строка всё равно уйдёт.
  }
}

/**
 * Ставит обработчики сбоев. Вызывать один раз и до создания окон: иначе первое
 * падение renderer'а случится раньше, чем мы начнём его замечать.
 */
export function installDiagnostics(options: DiagnosticsOptions = {}): void {
  const logFile = (): string => options.logFile ?? diagnosticsLogPath();

  // Спрашиваем один раз за запуск: в цикле ошибок диалог превратился бы в
  // очередь модальных окон поверх уже мёртвого интерфейса.
  let asked = false;
  // При выходе окна закрываются штатно, и спрашивать о них нечего.
  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
  });

  const log = (source: string, message: string, details: readonly string[]): void => {
    const entry: DiagnosticEntry = { source, message, details, at: new Date() };
    appendDiagnostic(logFile(), entry);
    // И в консоль: при `npm run dev` журнал читают оттуда.
    process.stderr.write(`${formatDiagnostic(entry)}\n`);
  };

  /** Сбой, о котором имеет смысл спросить: `restart` — что сделать по согласию. */
  const report = (source: string, message: string, details: readonly string[], restart: () => void): void => {
    log(source, message, details);
    if (quitting || asked) return;
    asked = true;
    void askToRestart(logFile(), message, restart);
  };

  process.on('uncaughtException', (error) => {
    const { message, details } = describeError(error);
    report('main/uncaughtException', message, details, relaunch);
  });

  process.on('unhandledRejection', (reason) => {
    const { message, details } = describeError(reason);
    report('main/unhandledRejection', message, details, relaunch);
  });

  // Renderer вернуть можно только перезагрузкой страницы: состояние вкладок живёт
  // в самом renderer'е и вместе с ним уже потеряно.
  app.on('render-process-gone', (_event, contents, details) => {
    if (isQuietExit(details.reason)) return;
    report(
      'renderer/render-process-gone',
      `процесс интерфейса завершился: ${details.reason} (код ${details.exitCode})`,
      [],
      () => {
        if (!contents.isDestroyed()) contents.reload();
      },
    );
  });

  // Подсобные процессы (GPU, утилиты) Chromium переживает сам: пишем в журнал, но
  // не спрашиваем — иначе обычное падение GPU поднимало бы окно с вопросом.
  app.on('child-process-gone', (_event, details) => {
    if (isQuietExit(details.reason)) return;
    log(
      'main/child-process-gone',
      `процесс ${details.type} завершился: ${details.reason} (код ${details.exitCode})`,
      details.serviceName ? [`служба: ${details.serviceName}`] : [],
    );
  });
}

/**
 * Спрашиваем, а не перезапускаем сами: несохранённые буферы живут в renderer'е,
 * и перезапуск без спроса выбросил бы их. Поэтому первая кнопка — «продолжить».
 */
async function askToRestart(logFile: string, message: string, restart: () => void): Promise<void> {
  try {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'chui_iDE',
      message: 'Приложение столкнулось с ошибкой',
      detail: `${message}\n\nПодробности записаны в журнал:\n${logFile}`,
      buttons: ['Продолжить работу', 'Перезапустить'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) restart();
  } catch {
    // Диалог недоступен (сбой до готовности приложения) — остаётся журнал.
  }
}

function relaunch(): void {
  app.relaunch();
  app.exit(0);
}
