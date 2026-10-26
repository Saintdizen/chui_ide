import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type GitSshKey, parseSshPublicKey } from '../../shared/git-identity';
import { runTool } from '../tool';

/**
 * Открытые SSH-ключи из `~/.ssh` для настройки подписи и выбора ключа.
 *
 * Только чтение: ни одного изменения на диске, поэтому ни корня репозитория,
 * ни контекста сервиса не нужно. Ключи ищутся по `*.pub` — приватные файлы в
 * список не попадают, даже если у них нет расширения.
 */
export async function listSshKeys(): Promise<GitSshKey[]> {
  const dir = path.join(os.homedir(), '.ssh');
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const keys: GitSshKey[] = [];
  for (const name of entries) {
    if (!name.endsWith('.pub')) continue;
    const full = path.join(dir, name);
    const text = await fs.readFile(full, 'utf8').catch(() => '');
    const parsed = parseSshPublicKey(text);
    if (!parsed) continue;
    keys.push({
      path: full,
      type: parsed.type,
      comment: parsed.comment,
      fingerprint: await sshFingerprint(full),
      publicKey: text.trim(),
    });
  }
  return keys.sort((a, b) => a.path.localeCompare(b.path));
}

/** Отпечаток ключа (`ssh-keygen -lf`). Нет ssh-keygen — пусто, а не отказ. */
export async function sshFingerprint(file: string): Promise<string> {
  const result = await runTool('ssh-keygen', ['-l', '-f', file]);
  if (!result.ok) return '';
  // «256 SHA256:abcd… comment (ED25519)» — берём второй столбец.
  return result.stdout.trim().split(/\s+/)[1] ?? '';
}
