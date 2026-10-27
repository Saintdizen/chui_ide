import { promises as fs } from 'node:fs';

/**
 * Убрать временные каталоги, созданные тестом.
 *
 * Убирать именно так, а не одним `fs.rm`, приходится из-за Windows: она не сразу
 * отпускает каталог, который только что был рабочим для процесса git — его держат
 * индексатор или антивирус, и `rm` падает с `EBUSY`. Повтор с паузой это переживает.
 * Без него падала бы УБОРКА, а не сам тест, и причина сбоя выглядела бы загадочно
 * (тест-то прошёл, а файл помечен упавшим).
 *
 * Если и повторы не помогли, на Windows молчим: оставшийся каталог в `%TEMP%` —
 * это мусор, а не провал теста (причину — живой процесс, держащий каталог, —
 * чинят в самом коде, а не здесь). На других системах такое молчать не должно:
 * там это признак настоящей ошибки.
 *
 * Каталоги берём из массива и тут же его опустошаем: одна уборка на файл, без
 * повторов между тестами.
 */
export async function removeTemp(roots: string[]): Promise<void> {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        const busy = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
        if (process.platform === 'win32' && busy) return;
        throw error;
      }),
    ),
  );
}
