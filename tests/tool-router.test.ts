import { describe, expect, it } from 'vitest';
import { redirectForUrl } from '../src/shared/tool-router';

/**
 * Чужая ссылка — чужой инструмент.
 *
 * Отказ `web_fetch` читает модель, а не человек: «нельзя» ей ничего не говорит,
 * и она повторяет вызов. Поэтому отказ обязан назвать инструмент, который здесь
 * работает, — это и проверяем.
 */
describe('redirectForUrl', () => {
  it('file: — это read, а не запрещённый адрес', () => {
    expect(redirectForUrl('file:///etc/hostname')?.tool).toBe('read');
  });

  it('ссылка на PDF — скачивается терминалом', () => {
    expect(redirectForUrl('https://github.com/u/r/raw/main/paper.pdf')?.tool).toBe('bash');
  });

  it('архив и картинка — тот же путь', () => {
    expect(redirectForUrl('https://x.y/a.zip')?.tool).toBe('bash');
    expect(redirectForUrl('https://x.y/a.png')?.tool).toBe('bash');
  });

  it('кварг и якорь не мешают узнать расширение', () => {
    expect(redirectForUrl('https://x.y/a.pdf?raw=1#page=2')?.tool).toBe('bash');
  });

  it('обычная страница замена не нужна', () => {
    expect(redirectForUrl('https://example.com/docs/intro')).toBeNull();
  });

  it('домен с точкой, но без файла — не файл', () => {
    expect(redirectForUrl('https://example.com')).toBeNull();
  });

  it('объяснение говорит, что делать', () => {
    expect(redirectForUrl('file:///tmp/a.ts')?.why).toContain('read');
    expect(redirectForUrl('https://x.y/a.pdf')?.why).toContain('pdf');
  });
});
