import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseEnvFile } from '../shared/env-file';

/**
 * Переменные окружения проекта из файла `.env`.
 *
 * Читает main (здесь файловая система), а значения уезжают туда, где запускается
 * код: установка пакетов, тесты, форматирование, терминал и языковой сервер. Так
 * все они видят одно окружение, а не каждый своё.
 *
 * Нет `.env` — пустой объект, а не ошибка: файл необязателен.
 */
export async function projectEnv(root: string | null): Promise<Record<string, string>> {
  if (!root) return {};
  const text = await fs.readFile(path.join(root, '.env'), 'utf8').catch(() => null);
  return text ? parseEnvFile(text) : {};
}
