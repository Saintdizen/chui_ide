import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../src/renderer/ui/run-failure';

describe('ошибка прогона глазами человека', () => {
  it('остановку руками не выдаёт за ошибку — разбирать нечего', () => {
    expect(classifyFailure('generation aborted', true)).toBeNull();
  });

  it('429 и перегрузка — «провайдер перегружен», повтор предлагается', () => {
    const failure = classifyFailure('HTTP 429 after 4 attempts');
    expect(failure?.kind).toBe('busy');
    expect(failure?.title).toBe('Провайдер перегружен');
    expect(failure?.retryable).toBe(true);
  });

  it('слишком много запросов по-русски — тоже перегрузка', () => {
    expect(classifyFailure('Слишком много запросов — подождите и повторите')?.kind).toBe('busy');
  });

  it('сеть — повторяемо', () => {
    const failure = classifyFailure('fetch failed: ECONNREFUSED 127.0.0.1:8080');
    expect(failure?.kind).toBe('network');
    expect(failure?.retryable).toBe(true);
  });

  it('ключ и оплата — повтор не предлагается: без починки настроек он бесполезен', () => {
    for (const text of ['401 Unauthorized', 'invalid api key', 'billing hard limit reached']) {
      const failure = classifyFailure(text);
      expect(failure?.kind).toBe('access');
      expect(failure?.retryable).toBe(false);
    }
  });

  it('кончился контекст — повтор тем же вопросом упрётся снова', () => {
    const failure = classifyFailure('maximum context length is 128000 tokens');
    expect(failure?.kind).toBe('context');
    expect(failure?.retryable).toBe(false);
  });

  it('неизвестная ошибка: не врёт о причине, но текст не выбрасывает', () => {
    const failure = classifyFailure('что-то странное случилось');
    expect(failure?.kind).toBe('other');
    // Сырой текст — единственное, по чему можно искать причину и жаловаться.
    expect(failure?.hint).toBe('что-то странное случилось');
    // А вдруг временное — кнопку прятать нельзя.
    expect(failure?.retryable).toBe(true);
  });

  it('пустое сообщение — «причина неизвестна», и всё равно без пустой строки', () => {
    const failure = classifyFailure('   ');
    expect(failure?.hint).toContain('не сообщил причину');
  });

  it('403 от провайдера — это доступ, а не перегрузка', () => {
    expect(classifyFailure('403 Forbidden')?.kind).toBe('access');
  });

  it('404 не путается с 401 и попадает в «другое», а не в «нет доступа»', () => {
    // Проверка на «40[13]» не должна ловить всё подряд из 400-х: иначе вечный
    // совет «проверьте ключ» на любой запрос, который модели просто не понравился.
    const failure = classifyFailure('HTTP 404: no such provider route');
    expect(failure?.kind).toBe('other');
  });
});
