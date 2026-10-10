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
  },
});
