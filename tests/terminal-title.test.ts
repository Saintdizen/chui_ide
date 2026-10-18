import { describe, expect, it } from 'vitest';
import { shortenShellTitle } from '../src/renderer/terminal/core/title';

/**
 * Подпись вкладки терминала: имя окна от программы (OSC 0/2) ужимается до читаемого.
 * Оболочка называет окно приглашением целиком, а полоса дока такой строке не рада.
 */

describe('shortenShellTitle: приглашение оболочки', () => {
  it('от пути остаётся последний сегмент', () => {
    expect(shortenShellTitle('dethmond@LOQ: ~/PROJECTS/GITHUB/chui_ide')).toBe('dethmond@LOQ: ~/chui_ide');
  });

  it('абсолютный путь ужимается так же, без пометки дома', () => {
    expect(shortenShellTitle('root@host: /var/log/nginx')).toBe('root@host: nginx');
  });

  it('домашний каталог и корень не трогаем — они уже короткие', () => {
    expect(shortenShellTitle('dethmond@LOQ: ~')).toBe('dethmond@LOQ: ~');
    expect(shortenShellTitle('root@host: /')).toBe('root@host: /');
  });

  it('завершающий слэш не даёт пустого хвоста', () => {
    expect(shortenShellTitle('me@box: /srv/data/')).toBe('me@box: data');
  });

  it('длинное имя хоста уступает место каталогу', () => {
    const label = shortenShellTitle('very-long-username@very-long-hostname: /var/log/nginx');
    expect(label.length).toBeLessThanOrEqual(26);
    expect(label).toBe('nginx');
  });
});

describe('shortenShellTitle: чужие имена окна', () => {
  it('имя без каталога остаётся как есть', () => {
    expect(shortenShellTitle('vim CHANGELOG.md')).toBe('vim CHANGELOG.md');
    expect(shortenShellTitle('npm run dev')).toBe('npm run dev');
  });

  it('пустое имя остаётся пустым', () => {
    expect(shortenShellTitle('')).toBe('');
    expect(shortenShellTitle('   ')).toBe('');
  });
});
