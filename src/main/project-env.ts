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

/**
 * Слияние окружения процесса с переменными проекта.
 *
 * Значения из `.env` важнее системных: проект задаёт своё, не полагаясь на то, что
 * человек успел выставить в оболочке. Ключи со значением `undefined` (в `process.env`
 * такие бывают) отбрасываем — `spawn` их не примет.
 */
export function mergeEnv(base: NodeJS.ProcessEnv, project: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) merged[key] = value;
  }
  return { ...merged, ...project };
}
