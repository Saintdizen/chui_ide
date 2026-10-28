import { describe, expect, it, vi } from 'vitest';

/**
 * Реестр грамматик грузится по требованию (`import()`), а не статически: иначе
 * все 34 языка тянулись бы в стартовый чанк. Тест стережёт то, ради чего ленивость
 * сделана: `import()` случается один раз, а повторные вызовы ждут то же обещание.
 */
describe('highlight/lazy-registry', () => {
  it('грузит реестр один раз и отдаёт ту же грамматику', async () => {
    vi.resetModules();
    const { languageGrammar, loadRegistry } = await import('../src/renderer/editor/highlight/lazy-registry');

    const first = await loadRegistry();
    const second = await loadRegistry();
    expect(second).toBe(first);

    const python = await languageGrammar('python');
    const again = await languageGrammar('python');
    expect(python).not.toBeNull();
    expect(again).toBe(python);
  });

  it('неизвестный язык даёт null, а не ошибку', async () => {
    vi.resetModules();
    const { languageGrammar } = await import('../src/renderer/editor/highlight/lazy-registry');
    await expect(languageGrammar('этого-языка-нет')).resolves.toBeNull();
  });

  it('идентификатор языка сравнивается без учёта регистра', async () => {
    vi.resetModules();
    const { languageGrammar } = await import('../src/renderer/editor/highlight/lazy-registry');
    const lower = await languageGrammar('python');
    const upper = await languageGrammar('PYTHON');
    expect(upper).toBe(lower);
  });
});
