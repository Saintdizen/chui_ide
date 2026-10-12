import { describe, expect, it } from 'vitest';
import {
  coAuthorLine,
  identityFromConfig,
  identityPatch,
  identityProblems,
  isValidEmail,
  parseAuthorInput,
  parseCoAuthors,
  parseSshPublicKey,
  signingLabel,
  sshKeyLabel,
  withCoAuthors,
  EMPTY_IDENTITY,
} from '../src/shared/git-identity';

/**
 * Личность автора, подпись и соавторы — чистые правила.
 *
 * Здесь важно, что настройки читаются терпимо (git может не иметь их вовсе), что
 * «подпись включена, а ключа нет» ловится ДО коммита, и что соавтор не дописывается
 * дважды: `git log` не должен показывать одного человека несколькими строками.
 */
describe('identityFromConfig', () => {
  it('пустой конфиг даёт пустую личность', () => {
    expect(identityFromConfig({})).toEqual(EMPTY_IDENTITY);
  });

  it('читает имя, почту, формат и подпись', () => {
    const identity = identityFromConfig(
      {
        'user.name': '  Иван  ',
        'user.email': 'ivan@example.com',
        'gpg.format': 'ssh',
        'user.signingkey': '~/.ssh/id_ed25519',
        'commit.gpgsign': 'true',
        'tag.gpgsign': 'false',
        'credential.helper': 'cache',
      },
      true,
    );
    expect(identity.name).toBe('Иван');
    expect(identity.email).toBe('ivan@example.com');
    expect(identity.format).toBe('ssh');
    expect(identity.signingKey).toBe('~/.ssh/id_ed25519');
    expect(identity.signCommits).toBe(true);
    expect(identity.signTags).toBe(false);
    expect(identity.credentialHelper).toBe('cache');
    expect(identity.keyFound).toBe(true);
  });

  it('незнакомый формат подписи читается как GPG', () => {
    expect(identityFromConfig({ 'gpg.format': 'x509' }).format).toBe('openpgp');
  });

  it('подпись включена только при точном «true»', () => {
    expect(identityFromConfig({ 'commit.gpgsign': '1' }).signCommits).toBe(false);
  });
});

describe('isValidEmail', () => {
  it('обычные адреса проходят', () => {
    expect(isValidEmail('a@b.ru')).toBe(true);
    expect(isValidEmail('ivan.petrov+tag@mail.example.com')).toBe(true);
  });

  it('мусор и пустое — нет', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('ivan')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.ru')).toBe(false);
    expect(isValidEmail('a@@b.ru')).toBe(false);
  });
});

describe('identityPatch', () => {
  const current = identityFromConfig({ 'user.name': 'Иван', 'user.email': 'ivan@example.com' });

  it('пишет только изменившееся', () => {
    expect(identityPatch(current, { email: 'new@example.com' })).toEqual([
      { key: 'user.email', value: 'new@example.com' },
    ]);
  });

  it('подпись превращается в true/false', () => {
    expect(identityPatch(current, { signCommits: true })).toEqual([{ key: 'commit.gpgsign', value: 'true' }]);
    expect(identityPatch({ ...current, signCommits: true }, { signCommits: false })).toEqual([
      { key: 'commit.gpgsign', value: 'false' },
    ]);
  });

  it('ничего не изменилось — пустой патч', () => {
    expect(identityPatch(current, { name: 'Иван', email: 'ivan@example.com' })).toEqual([]);
    expect(identityPatch(current, {})).toEqual([]);
  });

  it('смена формата пишется отдельной строкой', () => {
    expect(identityPatch(current, { format: 'ssh' })).toEqual([{ key: 'gpg.format', value: 'ssh' }]);
  });
});

describe('identityProblems', () => {
  it('пустая личность — две подсказки', () => {
    const problems = identityProblems(EMPTY_IDENTITY);
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toContain('user.name');
  });

  it('подпись без ключа — это предупреждение', () => {
    const identity = identityFromConfig({ 'user.name': 'A', 'user.email': 'a@b.ru', 'commit.gpgsign': 'true' });
    expect(identityProblems(identity).join(' ')).toContain('ключ не задан');
  });

  it('ключ не найден — сказано, где искали', () => {
    const gpg = identityFromConfig({
      'user.name': 'A',
      'user.email': 'a@b.ru',
      'commit.gpgsign': 'true',
      'user.signingkey': 'ABCD1234',
    });
    expect(identityProblems(gpg).join(' ')).toContain('связке GPG');
    const ssh = identityFromConfig({
      'user.name': 'A',
      'user.email': 'a@b.ru',
      'commit.gpgsign': 'true',
      'gpg.format': 'ssh',
      'user.signingkey': '~/.ssh/id_ed25519',
    });
    expect(identityProblems(ssh).join(' ')).toContain('не найден');
  });

  it('ssh-формат с отпечатком вместо пути — замечено', () => {
    const identity = identityFromConfig({
      'user.name': 'A',
      'user.email': 'a@b.ru',
      'gpg.format': 'ssh',
      'user.signingkey': 'SHA256:abcdef',
    });
    expect(identityProblems(identity).join(' ')).toContain('путь к файлу');
  });

  it('готовая личность — без замечаний', () => {
    const identity = identityFromConfig(
      { 'user.name': 'A', 'user.email': 'a@b.ru', 'commit.gpgsign': 'true', 'user.signingkey': 'ABCD' },
      true,
    );
    expect(identityProblems(identity)).toEqual([]);
  });
});

describe('подпись словами', () => {
  it('без подписи', () => {
    expect(signingLabel(identityFromConfig({ 'user.name': 'A', 'user.email': 'a@b.ru' }))).toBe('подпись выключена');
  });

  it('GPG и коммиты, ключа нет', () => {
    const identity = identityFromConfig({ 'commit.gpgsign': 'true', 'user.signingkey': 'ABCD' });
    expect(signingLabel(identity)).toBe('GPG: подпись — коммиты (ключ не найден)');
  });

  it('SSH, коммиты и теги, ключ найден', () => {
    const identity = identityFromConfig(
      { 'gpg.format': 'ssh', 'commit.gpgsign': 'true', 'tag.gpgsign': 'true', 'user.signingkey': '~/.ssh/id' },
      true,
    );
    expect(signingLabel(identity)).toBe('SSH-ключ: подпись — коммиты, теги');
  });
});

describe('соавторы', () => {
  it('строка соавтора в стандартном виде', () => {
    expect(coAuthorLine(' Иван ', ' i@b.ru ')).toBe('Co-authored-by: Иван <i@b.ru>');
  });

  it('дописывается двумя переводами строки', () => {
    expect(withCoAuthors('Правка', [{ name: 'Иван', email: 'i@b.ru' }])).toBe(
      'Правка\n\nCo-authored-by: Иван <i@b.ru>\n',
    );
  });

  it('пустое сообщение даёт только строку соавтора', () => {
    expect(withCoAuthors('', [{ name: 'Иван', email: 'i@b.ru' }])).toBe('Co-authored-by: Иван <i@b.ru>\n');
  });

  it('повтор не дописывается', () => {
    const once = withCoAuthors('Правка', [{ name: 'Иван', email: 'i@b.ru' }]);
    expect(withCoAuthors(once, [{ name: 'Другой', email: 'i@b.ru' }])).toBe(once);
  });

  it('без почты соавтор не добавляется', () => {
    expect(withCoAuthors('Правка', [{ name: 'Иван', email: '   ' }])).toBe('Правка');
  });

  it('уже упомянутые читаются из сообщения', () => {
    const message = 'Тело\n\nCo-authored-by: Иван <i@b.ru>\nCo-authored-by: Пётр <p@b.ru>\n';
    expect(parseCoAuthors(message)).toEqual([
      { name: 'Иван', email: 'i@b.ru' },
      { name: 'Пётр', email: 'p@b.ru' },
    ]);
  });

  it('обычное сообщение соавторов не имеет', () => {
    expect(parseCoAuthors('просто текст')).toEqual([]);
  });
});

describe('ввод соавтора и ключи ssh', () => {
  it('«Имя <почта>» разбирается', () => {
    expect(parseAuthorInput('Иван Петров <ivan@example.com>')).toEqual({
      name: 'Иван Петров',
      email: 'ivan@example.com',
    });
  });

  it('одна почта даёт имя из адреса', () => {
    expect(parseAuthorInput('ivan@example.com')).toEqual({ name: 'ivan', email: 'ivan@example.com' });
  });

  it('без почты — null', () => {
    expect(parseAuthorInput('просто имя')).toBeNull();
    expect(parseAuthorInput('')).toBeNull();
  });

  it('открытый ключ разбирается на тип и комментарий', () => {
    expect(parseSshPublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1 i@example.com')).toEqual({
      type: 'ssh-ed25519',
      comment: 'i@example.com',
    });
    expect(parseSshPublicKey('ssh-rsa AAAA')).toEqual({ type: 'ssh-rsa', comment: '' });
  });

  it('не ключ — null', () => {
    expect(parseSshPublicKey('Host github.com\n  User git')).toBeNull();
    expect(parseSshPublicKey('')).toBeNull();
  });

  it('подпись ключа без комментария берёт имя файла', () => {
    expect(
      sshKeyLabel({
        path: '/home/u/.ssh/id_ed25519.pub',
        type: 'ssh-ed25519',
        comment: '',
        fingerprint: '',
        publicKey: '',
      }),
    ).toBe('ssh-ed25519 · id_ed25519.pub');
  });
});
