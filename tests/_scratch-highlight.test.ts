import { describe, expect, it } from 'vitest';
import { grammarFor } from '../src/renderer/editor/highlight/registry';

describe('scratch', () => {
  it('дамп токенов', () => {
    const grammar = grammarFor('javascript')!;
    const lines = [
      "const {Page, WebView, Spinner, ipcRenderer, Label, Log} = require('chuijs');",
      'const $json = require("../../package.json")',
      'class MainPage extends Page {',
      '  constructor() {',
      '    super();',
      '    this.setTitle(`${$json.productName}`);',
    ];
    let state = 0;
    for (const line of lines) {
      const result = grammar.line(line, state);
      state = result.state;
      const parts = result.tokens.map((t) => `${JSON.stringify(line.slice(t.start, t.end))}=${t.type}`);
      console.log('LINE:', line);
      console.log('  ->', parts.join('  '));
    }
    expect(true).toBe(true);
  });
});
