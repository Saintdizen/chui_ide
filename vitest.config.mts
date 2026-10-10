import { defineConfig } from 'vitest/config';

/**
 * Юнит-тесты чистой логики: то, что не требует Electron, Monaco и DOM.
 * Проверки интерфейса и процессов живут в `scripts/*-smoke.cjs`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Тесты чистые (чистая логика shared/), без общего состояния, поэтому общие воркеры
    // между файлами дешевле, чем поднимать отдельный на каждый.
    isolate: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      // Порог держим только на чистой логике: UI и процессы гоняются пробниками,
      // а не юнит-тестами (<600 строк renderer/main вытянуты бы средний
      // процент вниз без всякой пользы).
      include: ['src/shared/**'],
      reporter: ['text-summary'],
      thresholds: { statements: 97, branches: 92, functions: 99, lines: 98 },
    },
  },
});
