import { defineConfig } from 'vitest/config';

/**
 * Юнит-тесты чистой логики: то, что не требует Electron, Monaco и DOM.
 * Проверки интерфейса и процессов живут в `scripts/*-smoke.cjs`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
  },
});
