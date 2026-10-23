/**
 * ВРЕМЕННЫЙ диагностический скрипт. Удалить, когда разберёмся, почему на Windows
 * заглушка `rg` не запускается.
 */
const { mkdtempSync, writeFileSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');

const dir = mkdtempSync(join(tmpdir(), 'chui-probe-'));
const js = join(dir, 'rg-fake.js');
writeFileSync(js, "process.stdout.write('ИТОГ');\n", 'utf8');
writeFileSync(join(dir, 'rg.cmd'), `@echo off\r\nnode "${js}" %*\r\n`, 'utf8');
process.env.PATH = `${dir};${process.env.PATH}`;

function probe(label, command, options) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let promise;
    try {
      const child = spawn(command, ['--json'], { ...options, windowsHide: true });
      promise = new Promise((res) => {
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (e) => { err += 'ERR ' + String(e); });
        child.on('close', (code) => res(code));
      });
      promise.then((code) => {
        console.log(label, '=> код', code, '| out:', JSON.stringify(out), '| err:', JSON.stringify(err).slice(0, 100));
        resolve();
      });
    } catch (e) {
      console.log(label, '=> бросок:', String(e).slice(0, 100));
      resolve();
    }
  });
}

(async () => {
  console.log('каталог:', readdirSync(dir));
  await probe('rg без опций', 'rg', {});
  await probe('cmd /c rg', 'cmd', { shell: false });  // просто чтобы увидеть окружение
  await probe('rg.cmd явно', join(dir, 'rg.cmd'), {});
  await probe('rg с shell:true', 'rg', { shell: true });
})();
