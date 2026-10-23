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

// Настоящий spawn (как в runRipgrep) — асинхронный и ищет .cmd сам, если может.
const { spawn } = require('node:child_process');
const child = spawn('rg', ['--json', '-e', 'x', '.'], { windowsHide: true });
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { err += d.toString(); });
child.on('error', (e) => console.log('async spawn error:', String(e)));
child.on('close', (code) => console.log('async spawn close:', { code, out, err }));

console.log('--- процессы:');
console.log('  pid', process.pid, 'ppid', process.ppid);
try { const { execSync } = require('node:child_process');
  console.log(execSync('wmic process where "ProcessId=' + process.ppid + '" get CommandLine /value', { encoding: 'utf8' }).trim().slice(0, 300));
} catch (e) { console.log('  wmic не сработал:', String(e).slice(0, 80)); }
const { spawn: sp2 } = require('node:child_process');
const c2 = sp2('where', ['rg'], { windowsHide: true, shell: false });
let o2 = ''; c2.stdout.on('data', (d) => { o2 += d.toString(); });
c2.on('close', (code) => console.log('  where rg:', code, JSON.stringify(o2)));
const c3 = sp2('rg', ['--version'], { windowsHide: true, shell: true });
let o3 = ''; let e3 = ''; c3.stdout.on('data', (d) => { o3 += d.toString(); }); c3.stderr.on('data', (d) => { e3 += d.toString(); });
c3.on('close', (code) => console.log('  с shell:true:', code, JSON.stringify(o3), JSON.stringify(e3).slice(0, 120)));
