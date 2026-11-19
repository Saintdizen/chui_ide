/**
 * Скачивание файла выпуска средствами Chromium: прогресс, отмена, папка загрузок.
 *
 * Через `session.downloadURL`, а не через `net`/`https`: Electron уже умеет
 * показывать прогресс и дописывать файл частями, а системный диалог «сохранить
 * как» тут не нужен — файл кладём сразу в «Загрузки», человек сам решит, что с
 * ним делать дальше (мы ничего не устанавливаем).
 *
 * Сумму не сверяем: у ассетов GitHub поле `digest` есть не всегда, поэтому
 * проверка была бы лотереей, а не защитой. Человек видит, откуда файл.
 */
import { app, type Session } from 'electron';
import { basename } from 'node:path';
import type { DownloadResult } from '../../shared/update';

/** Ошибка скачивания в виде, который можно отдать человеку текстом. */
export class DownloadError extends Error {}

/**
 * Запустить скачивание и дождаться конца.
 *
 * `will-download` — единственный способ перехватить переход по ссылке, минуя
 * диалог «сохранить как»: обработчик снимаем сразу после первого события,
 * чтобы не перехватывать чужие скачивания из встроенного браузера.
 */
export function downloadReleaseAsset(session: Session, url: string): Promise<DownloadResult> {
  return new Promise<DownloadResult>((resolve, reject) => {
    let guard: ReturnType<typeof setTimeout> | undefined;

    const onWillDownload = (
      _event: Electron.Event,
      item: Electron.DownloadItem,
      _webContents: Electron.WebContents | undefined,
    ): void => {
      clearTimeout(guard);
      session.removeListener('will-download', onWillDownload);

      // Без этой строки Chromium предложил бы выбрать место сам — а место у нас одно.
      item.setSavePath(`${app.getPath('downloads')}/${basename(item.getFilename())}`);

      item.once('done', (_doneEvent, state) => {
        if (state === 'completed') {
          const path = item.getSavePath();
          resolve({ path, name: basename(path) });
          return;
        }
        // `cancelled` — чаще всего человек закрыл окно или отменил загрузку.
        reject(new DownloadError(state === 'cancelled' ? 'Скачивание отменено' : 'Не удалось скачать файл'));
      });
    };

    session.on('will-download', onWillDownload);

    // `downloadURL` не возвращает признак «перехватили»: если Chromium не начнёт
    // загрузку (битая ссылка, отмена прокси), `will-download` не случится вовсе,
    // и обещание повисло бы навсегда. Поэтому сторож по времени и снятие обработчика.
    guard = setTimeout(() => {
      session.removeListener('will-download', onWillDownload);
      reject(new DownloadError('Не удалось начать скачивание'));
    }, 15_000);

    try {
      session.downloadURL(url);
    } catch (error) {
      clearTimeout(guard);
      session.removeListener('will-download', onWillDownload);
      reject(new DownloadError(error instanceof Error ? error.message : 'Не удалось начать скачивание'));
      return;
    }
  });
}
