/**
 * ВРЕМЕННЫЙ диагностический скрипт. Удалить, когда разберёмся, почему на Windows
 * заглушка `rg` не запускается. Печатает, что именно легло в каталог и что
 * отвечает spawn.
 */
const { mkdtempSync, writeFileSync, readdirSync, readFileSync, chmodSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = mkdtempSync(join(tmpdir(), 'chui-probe-'));
const js = join(dir, 'rg-fake.js');
const body = "if (process.argv[2] === '--version') process.exit(0);\nprocess.stdout.write('ИТОГ');\n";
writeFileSync(js, body, 'utf8');
if (process.platform === 'win32') {
  writeFileSync(join(dir, 'rg.cmd'), `@echo off\r\nnode "${js}" %*\r\n`, 'utf8');
} else {
  writeFileSync(join(dir, 'rg'), `#!/usr/bin/env node\n${body}`, 'utf8');
  chmodSync(join(dir, 'rg'), 0o755);
}

console.log('ОС:', process.platform);
console.log('каталог:', dir);
console.log('содержимое:', readdirSync(dir));
console.log('tmpdir содержит пробел:', /\s/.test(dir));
const cmd = join(dir, 'rg.cmd');
if (process.platform === 'win32') {
  console.log('--- rg.cmd байты:', [...readFileSync(cmd)].slice(0, 80).join(','));
}
const previous = process.env.PATH ?? '';
process.env.PATH = `${dir};${previous}`;
const direct = spawnSync('rg', ['--version'], { windowsHide: true, encoding: 'utf8' });
console.log('spawn rg --version:', { error: direct.error && String(direct.error), status: direct.status, stderr: direct.stderr });
const search = spawnSync('rg', ['--json', '-e', 'x', '.'], { windowsHide: true, encoding: 'utf8' });
console.log('spawn rg (поиск):', { error: search.error && String(search.error), status: search.status, stdout: search.stdout, stderr: search.stderr });
