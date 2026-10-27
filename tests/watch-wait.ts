import fs from 'node:fs/promises';

/**
 * Дождаться уведомления о правке, ПОВТОРЯЯ запись в файл.
 *
 * Одиночная запись проверяет не то, что нужно: `fs.watch` не обещает доставку
 * каждой правки. На macOS (FSEvents) событие для записи, сделанной через
 * миллисекунды после установки наблюдения, теряется; на загруженном раннере
 * наблюдение успевает пересоздаваться (`WATCH_RETRY_MS`). На CI 27.10 это дало
 * «no event in time» при полностью здоровом сервисе. Живой редактор в такой
 * ситуации сохраняет ещё раз — здесь так же: пишем, пока наблюдатель не ответит.
 *
 * Перезапись идёт ТЕМ ЖЕ содержимым: `write(2)` всё равно помечает файл
 * изменённым, а смысл файла от повторов не меняется (для `.ai_ignore` это
 * важно — правила должны остаться правилами). Строгость проверок тоже на месте:
 * путь один и тот же, поэтому `pendingCount` не растёт и `many` не взводится,
 * а принять событие можно по-прежнему только с ожидаемым путём. Дохлый
 * наблюдатель так не вылечится — тест упадёт.
 */
export async function untilEdit(files: string[], check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`правка не дошла до наблюдателя за ${Date.now() - started} мс`);
    }
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8').catch(() => '');
      await fs.writeFile(file, content, 'utf8').catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
