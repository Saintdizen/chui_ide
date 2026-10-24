/**
 * Личность автора, подпись коммитов и ключи — модель и чистые правила.
 *
 * Коммит в git подписывается не «сам собой»: у него есть автор (`user.name`,
 * `user.email`) и, если включено, подпись (`commit.gpgsign`/`tag.gpgsign` плюс
 * `user.signingkey` и `gpg.format`). Всё это настройки git, а не IDE, поэтому здесь
 * только модель и правила: как прочитать настройки, что в них не так и какие строки
 * дописать в сообщение коммита для соавторов.
 *
 * Подпись бывает двух родов: `openpgp` (обычная GPG-подпись, ключ задаётся
 * отпечатком или почтой) и `ssh` (подпись вашим SSH-ключом, ключ — путь к файлу).
 * Разные форматы — разные требования к `user.signingkey`, и проверка тут разная.
 *
 * Модуль чистый: ни процессов, ни ФС. Их дело — в main (`git/git.ts`).
 */

/** Формат подписи, как его понимает git. */
export type GitSignFormat = 'openpgp' | 'ssh';

/** Действующие настройки личности и подписи. */
export interface GitIdentity {
  name: string;
  email: string;
  /** `user.signingkey`: отпечаток/почта для GPG или путь к ключу для ssh. */
  signingKey: string;
  format: GitSignFormat;
  /** Подписывать коммиты (`commit.gpgsign`). */
  signCommits: boolean;
  /** Подписывать теги (`tag.gpgsign`). */
  signTags: boolean;
  /** Хранилище паролей HTTPS (`credential.helper`). Пусто — git спросит каждый раз. */
  credentialHelper: string;
  /** Найден ли ключ подписи: у GPG — в связке секретных, у ssh — файл на диске. */
  keyFound: boolean;
}

/** Публичный SSH-ключ из `~/.ssh` — им подписывают коммиты и работают с удалёнкой. */
export interface GitSshKey {
  /** Путь к файлу открытого ключа (`*.pub`). */
  path: string;
  /** Тип ключа: `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`… */
  type: string;
  /** Комментарий из ключа — обычно почта или имя машины. */
  comment: string;
  /** Отпечаток, если его удалось посчитать (`ssh-keygen -lf`). */
  fingerprint: string;
  /** Содержимое открытого ключа: его и добавляют в аккаунт на платформе. */
  publicKey: string;
}

/** Пустая личность: git ничего не настроено. */
export const EMPTY_IDENTITY: GitIdentity = {
  name: '',
  email: '',
  signingKey: '',
  format: 'openpgp',
  signCommits: false,
  signTags: false,
  credentialHelper: '',
  keyFound: false,
};

/** Значения `git config`, из которых собирается личность. */
export interface GitConfigValues {
  'user.name'?: string;
  'user.email'?: string;
  'user.signingkey'?: string;
  'gpg.format'?: string;
  'commit.gpgsign'?: string;
  'tag.gpgsign'?: string;
  'credential.helper'?: string;
}

/** Ключи, из которых собирается личность. Остальные настройки репозитория не нужны. */
const IDENTITY_KEYS = [
  'user.name',
  'user.email',
  'user.signingkey',
  'gpg.format',
  'commit.gpgsign',
  'tag.gpgsign',
  'credential.helper',
] as const;

/**
 * Шаблон для `git config --get-regexp`: только ключи личности — плоский конфиг
 * репозитория бывает длинным, и тащить его весь в main незачем.
 */
export const IDENTITY_CONFIG_PATTERN = `^(${['user', 'gpg', 'commit', 'tag', 'credential'].join('|')})\\.`;

/**
 * Разобрать вывод `git config --get-regexp -z`.
 *
 * Записи разделены NUL, внутри записи ключ отделён от значения ПЕРВЫМ переводом
 * строки, а в значении переводы строки остаются как есть (многострочный помощник
 * учётных данных). Уровни идут сверху вниз: системный, глобальный, локальный, —
 * и действующим считается ПОСЛЕДНЕЕ значение ключа, как у самого git. Ключи вне
 * списка личности пропускаем.
 *
 * Многозначный ключ (`user.signingkey` может быть задан и локально, и глобально без
 * `--replace-all`) git печатает несколько раз. Действует последнее.
 */
export function parseIdentityConfig(raw: string): GitConfigValues {
  const values: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    if (entry === '') continue;
    const cut = entry.indexOf('\n');
    if (cut < 0) continue;
    const key = entry.slice(0, cut).trim();
    if (!(IDENTITY_KEYS as readonly string[]).includes(key)) continue;
    values[key] = entry.slice(cut + 1).replace(/\r\n/g, '\n');
  }
  return values as GitConfigValues;
}

/** Собрать личность из прочитанных настроек. Логические значения git пишет `true`/`false`. */
export function identityFromConfig(config: GitConfigValues, keyFound = false): GitIdentity {
  return {
    name: (config['user.name'] ?? '').trim(),
    email: (config['user.email'] ?? '').trim(),
    signingKey: (config['user.signingkey'] ?? '').trim(),
    format: config['gpg.format'] === 'ssh' ? 'ssh' : 'openpgp',
    signCommits: config['commit.gpgsign'] === 'true',
    signTags: config['tag.gpgsign'] === 'true',
    credentialHelper: (config['credential.helper'] ?? '').trim(),
    keyFound,
  };
}

/** Похоже ли на почту: одна `@`, точка в домене, без пробелов. */
export function isValidEmail(value: string): boolean {
  const email = value.trim();
  if (email === '' || /\s/.test(email)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(email);
}

/** Настройки, которые непусты и отличаются от текущих, — их и пишем в конфиг. */
export function identityPatch(current: GitIdentity, next: Partial<GitIdentity>): Array<{ key: string; value: string }> {
  const patch: Array<{ key: string; value: string }> = [];
  const set = (key: string, value: string, before: string): void => {
    if (value.trim() !== before.trim()) patch.push({ key, value: value.trim() });
  };
  if (next.name !== undefined) set('user.name', next.name, current.name);
  if (next.email !== undefined) set('user.email', next.email, current.email);
  if (next.signingKey !== undefined) set('user.signingkey', next.signingKey, current.signingKey);
  if (next.format !== undefined && next.format !== current.format) {
    patch.push({ key: 'gpg.format', value: next.format });
  }
  if (next.signCommits !== undefined && next.signCommits !== current.signCommits) {
    patch.push({ key: 'commit.gpgsign', value: next.signCommits ? 'true' : 'false' });
  }
  if (next.signTags !== undefined && next.signTags !== current.signTags) {
    patch.push({ key: 'tag.gpgsign', value: next.signTags ? 'true' : 'false' });
  }
  if (next.credentialHelper !== undefined) {
    set('credential.helper', next.credentialHelper, current.credentialHelper);
  }
  return patch;
}

/**
 * Что не так с личностью — словами, для окна. Пустой список значит «всё готово».
 * Подпись без ключа — не ошибка настройки, а предупреждение: без ключа git не сможет
 * подписать коммит, и человек получил бы непонятный отказ в самый неподходящий момент.
 */
export function identityProblems(identity: GitIdentity): string[] {
  const problems: string[] = [];
  if (identity.name === '') problems.push('Не задано имя автора (user.name) — коммиты уйдут без подписи автора.');
  if (identity.email === '') problems.push('Не задана почта автора (user.email).');
  else if (!isValidEmail(identity.email)) problems.push(`Почта «${identity.email}» выглядит неверной.`);
  if (identity.signCommits || identity.signTags) {
    if (identity.signingKey === '') problems.push('Подпись включена, но ключ не задан (user.signingkey).');
    else if (!identity.keyFound) {
      problems.push(
        identity.format === 'ssh'
          ? `Файл ключа подписи не найден: ${identity.signingKey}`
          : `Ключ подписи не найден в связке GPG: ${identity.signingKey}`,
      );
    }
  }
  if (identity.format === 'ssh' && identity.signingKey !== '' && !identity.signingKey.includes('/')) {
    problems.push('Для формата ssh в user.signingkey нужен путь к файлу ключа, а не отпечаток.');
  }
  return problems;
}

/** Короткая подпись состояния: «GPG · подпись включена» или «без подписи». */
export function signingLabel(identity: GitIdentity): string {
  const kind = identity.format === 'ssh' ? 'SSH-ключ' : 'GPG';
  if (!identity.signCommits && !identity.signTags) return 'подпись выключена';
  const what: string[] = [];
  if (identity.signCommits) what.push('коммиты');
  if (identity.signTags) what.push('теги');
  const state = identity.keyFound ? '' : ' (ключ не найден)';
  return `${kind}: подпись — ${what.join(', ')}${state}`;
}

/** Строка соавтора для сообщения коммита. */
export function coAuthorLine(name: string, email: string): string {
  return `Co-authored-by: ${name.trim()} <${email.trim()}>`;
}

/**
 * Дописать соавторов в сообщение коммита. Повтор и уже упомянутых не добавляем:
 * иначе `git log` покажет одного и того же человека дважды.
 */
export function withCoAuthors(message: string, authors: readonly { name: string; email: string }[]): string {
  const existing = parseCoAuthors(message);
  const seen = new Set(existing.map((author) => author.email.toLowerCase()));
  const lines: string[] = [];
  for (const author of authors) {
    const email = author.email.trim();
    if (email === '' || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    lines.push(coAuthorLine(author.name, email));
  }
  if (lines.length === 0) return message;
  const base = message.replace(/\s+$/, '');
  const separator = base === '' ? '' : '\n\n';
  return `${base}${separator}${lines.join('\n')}\n`;
}

/** Соавторы, уже упомянутые в сообщении, — показываем их в окне отдельным списком. */
export function parseCoAuthors(message: string): Array<{ name: string; email: string }> {
  const result: Array<{ name: string; email: string }> = [];
  for (const line of message.split('\n')) {
    const match = /^\s*co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/i.exec(line);
    if (!match) continue;
    result.push({ name: match[1]!.trim(), email: match[2]!.trim() });
  }
  return result;
}

/**
 * Разбор того, что человек набрал в поле соавтора: `Имя <mail@example.com>` или
 * просто почта (тогда имя берём из адреса до `@`). `null` — почту понять не удалось.
 */
export function parseAuthorInput(value: string): { name: string; email: string } | null {
  const text = value.trim();
  if (text === '') return null;
  const angled = /^(.*?)<([^>]+)>\s*$/.exec(text);
  const email = (angled ? angled[2]! : text).trim();
  if (!isValidEmail(email)) return null;
  const name = (angled ? angled[1]! : email.slice(0, email.indexOf('@'))).trim();
  return { name: name === '' ? email.slice(0, email.indexOf('@')) : name, email };
}

/** Разбор строки открытого SSH-ключа: тип, тело и комментарий. */
export function parseSshPublicKey(text: string): { type: string; comment: string } | null {
  const line = text.trim();
  if (line === '') return null;
  const parts = line.split(/\s+/);
  const type = parts[0] ?? '';
  if (!type.startsWith('ssh-') && !type.startsWith('ecdsa-') && type !== 'sk-ssh-ed25519@openssh.com') {
    // Не похоже на открытый ключ: сертификат, конфиг или что-то ещё.
    return null;
  }
  // Комментарий — всё после тела ключа; тела может и не быть (битый файл).
  const comment = parts.length > 2 ? parts.slice(2).join(' ') : '';
  return { type, comment };
}

/** Подпись ключа в списке: тип и комментарий (или путь, если комментария нет). */
export function sshKeyLabel(key: GitSshKey): string {
  const name = key.comment !== '' ? key.comment : (key.path.split('/').pop() ?? key.path);
  return `${key.type} · ${name}`;
}
