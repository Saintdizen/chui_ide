/**
 * Раннер сторожа границ: собирает `scripts/layer-check.ts` через rolldown и запускает.
 * Так `npm run check:layers` не зависит от `tsx`, которого в установленном дереве нет.
 */
import { pathToFileURL } from 'node:url';
import { build } from 'rolldown';

const output = 'node_modules/.cache/layer-check.cjs';
await build({
  input: 'scripts/layer-check.ts',
  platform: 'node',
  external: [/^node:/],
  output: { file: output, format: 'cjs' },
});

const module = await import(pathToFileURL(output).href);
process.exitCode = (await module.checkLayers()) ? 0 : 1;
