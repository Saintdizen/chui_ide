import { describe, expect, it } from 'vitest';
import { featureOff } from '../src/shared/lsp-visibility';

describe('featureOff — выключение inlay hints / code lens по языку', () => {
  it('пустой список — включено всюду', () => {
    expect(featureOff({ lsp: { inlayHintsOff: [] } }, 'inlayHintsOff', '/p/a.ts')).toBe(false);
    expect(featureOff({ lsp: {} }, 'codeLensOff', '/p/a.ts')).toBe(false);
  });

  it('язык из списка — выключено только для него', () => {
    const s = { lsp: { inlayHintsOff: ['python'] } };
    expect(featureOff(s, 'inlayHintsOff', '/p/script.py')).toBe(true);
    expect(featureOff(s, 'inlayHintsOff', '/p/app.ts')).toBe(false);
  });

  it('списки inlay и code lens независимы', () => {
    const s = { lsp: { codeLensOff: ['typescript'] } };
    expect(featureOff(s, 'codeLensOff', '/p/app.ts')).toBe(true);
    expect(featureOff(s, 'inlayHintsOff', '/p/app.ts')).toBe(false);
  });
});
