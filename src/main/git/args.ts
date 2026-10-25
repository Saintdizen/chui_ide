import { RpcErrorCode } from '../../shared/api';
import { RpcFailure } from '../ipc/router';

/**
 * Значения из интерфейса не могут начинаться с `-`: иначе git примет их за флаг.
 *
 * Проверка одна на теги, ветки и ссылки сравнения — раньше она была размазана
 * двумя почти одинаковыми копиями, которые разошлись в тексте ошибки.
 */

/** Имя тега/ветки: `git tag -d --force` недопустим. */
export function nameArg(name: string): string {
  const value = name.trim();
  if (!value) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задано имя тега');
  if (value.startsWith('-')) throw new RpcFailure(RpcErrorCode.InvalidParams, `Некорректное имя тега: ${value}`);
  return value;
}

/** Ссылка для сравнения (`diff base..head`). */
export function refArg(value: string): string {
  const text = value.trim();
  if (!text) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не задана ссылка для сравнения');
  if (text.startsWith('-')) throw new RpcFailure(RpcErrorCode.InvalidParams, `Некорректная ссылка: ${text}`);
  return text;
}
