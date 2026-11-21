// scripts/check.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const files = [];
for (const dir of ['api', 'lib', 'scripts']) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!fs.statSync(p).isFile()) continue;
    if (name.endsWith('.js') || name === 'codes') files.push(p);
  }
}

let bad = 0;
for (const f of files) {
  try {
    if (f.endsWith('.js')) {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } else {
      new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f });
    }
  } catch (e) {
    bad++;
    console.log('FAIL ' + f);
    console.log(String(e.stderr || e.message).slice(0, 700));
  }
}
console.log(bad ? 'Ошибок: ' + bad + ' из ' + files.length : 'OK: ' + files.length + ' файлов, синтаксис чистый');
process.exit(bad ? 1 : 0);
