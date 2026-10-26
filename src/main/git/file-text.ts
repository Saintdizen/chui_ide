import { promises as fs } from 'node:fs';
import { RpcErrorCode } from '../../shared/api';
import { RpcFailure } from '../ipc/router';
import { execGit, MAX_DIFF_BYTES } from './exec';

/** Содержимое файла в коммите или индексе; пустая строка — если такого нет. */
export async function showFile(spec: string, cwd: string): Promise<string> {
  const result = await execGit(['show', spec], cwd, { allowFailure: true });
  return result.ok ? result.stdout : '';
}

/**
 * Текст файла для сравнения «было/стало».
 *
 * Ограничения не косметические: файл в 2 МБ и больше шлётся в интерфейс целиком,
 * а двоичный (в первых килобайтах есть нулевой байт) бессмысленно строить по
 * строкам — оба случая честнее отклонить, чем показать мусор.
 */
export async function readFileText(absolute: string): Promise<string> {
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) return '';
  if (stat.size > MAX_DIFF_BYTES) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, 'Файл слишком большой для сравнения');
  }
  const buffer = await fs.readFile(absolute);
  if (buffer.includes(0)) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Двоичный файл — сравнение недоступно');
  return buffer.toString('utf8');
}
