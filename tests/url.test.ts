import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl, isSameUrlOrigin, isWebPageUrl } from '../src/shared/url';

/**
 * Что можно показать во встроенном браузере. Решается до создания `<webview>`:
 * всё, что не `http`/`https`, в него не попадает никогда.
 */
describe('isWebPageUrl', () => {
  it('сетевые адреса — можно', () => {
    expect(isWebPageUrl('http://localhost:5273/x')).toBe(true);
    expect(isWebPageUrl('https://example.com')).toBe(true);
  });

  it('регистр схемы не важен', () => {
    expect(isWebPageUrl('HTTPS://Example.com/Path')).toBe(true);
  });

  it('файл мимо дерева и прав — нельзя', () => {
    // `file:` показал бы локальный файл, которого нет в дереве проекта.
    expect(isWebPageUrl('file:///etc/passwd')).toBe(false);
    expect(isWebPageUrl('app://bundle/index.html')).toBe(false);
  });

  it('запуск чужого кода — нельзя', () => {
    expect(isWebPageUrl('javascript:alert(1)')).toBe(false);
    expect(isWebPageUrl('data:text/html,<script></script>')).toBe(false);
  });

  it('не адрес — нельзя', () => {
    expect(isWebPageUrl('example.com')).toBe(false);
    expect(isWebPageUrl('')).toBe(false);
  });
});

/**
 * Какие адреса можно отдать системе. Опасны не столько «странные» адреса,
 * сколько знакомые схемы с чужим обработчиком (`file:`), поэтому проверяем
 * и разрешённое, и отказ, и разбор мусора.
 */
describe('isSafeExternalUrl', () => {
  it('http и https — можно', () => {
    expect(isSafeExternalUrl('http://localhost:5273/x')).toBe(true);
    expect(isSafeExternalUrl('https://example.com/docs#anchor')).toBe(true);
  });

  it('mailto — можно', () => {
    expect(isSafeExternalUrl('mailto:dev@example.com')).toBe(true);
  });

  it('регистр схемы не важен', () => {
    expect(isSafeExternalUrl('HTTPS://example.com')).toBe(true);
  });

  it('file и прочие схемы — нельзя', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,<script></script>')).toBe(false);
  });

  it('не адрес — тоже нельзя', () => {
    expect(isSafeExternalUrl('example.com')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
  });
});

/**
 * Чей это адрес: свой или чужой. По этому решению окно пускает перезагрузку своей
 * страницы (dev-сервер шлёт full-reload) или отдаёт адрес системному браузеру.
 */
describe('isSameUrlOrigin', () => {
  const dev = 'http://localhost:5273';
  const app = 'app://bundle';

  it('свой адрес — тот же узел по схеме и хозяину, путь не важен', () => {
    expect(isSameUrlOrigin('http://localhost:5273/', dev)).toBe(true);
    expect(isSameUrlOrigin('http://localhost:5273/index.html', dev)).toBe(true);
    expect(isSameUrlOrigin('http://localhost:5273/welcome.html', dev)).toBe(true);
  });

  it('нестандартная схема `app:` сравнивается по хозяину, а не пустым origin', () => {
    expect(isSameUrlOrigin('app://bundle/index.html', app)).toBe(true);
    expect(isSameUrlOrigin('app://other/index.html', app)).toBe(false);
  });

  it('другой хозяин или схема — чужой', () => {
    expect(isSameUrlOrigin('http://localhost:3000/', dev)).toBe(false);
    expect(isSameUrlOrigin('https://example.com/', dev)).toBe(false);
    expect(isSameUrlOrigin('file:///etc/passwd', dev)).toBe(false);
    expect(isSameUrlOrigin('http://localhost:5273/', app)).toBe(false);
  });

  it('мусор и пустое — чужой (не свой)', () => {
    expect(isSameUrlOrigin('не адрес', dev)).toBe(false);
    expect(isSameUrlOrigin('', dev)).toBe(false);
    expect(isSameUrlOrigin('http://localhost:5273/', '')).toBe(false);
  });
});
