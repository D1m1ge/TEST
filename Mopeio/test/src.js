'use strict';
// The userscript is stored as ordered parts under ../src so the GitHub connector
// can carry it in pieces; every consumer (launcher, tests) joins them the same way.
const fs = require('node:fs');
const path = require('node:path');

function partFiles() {
  const dir = path.join(__dirname, '..', 'src');
  return fs.readdirSync(dir)
    .filter(f => /^mope\.part\d+\.js$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

function loadSource() {
  return partFiles().map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('');
}

module.exports = { loadSource, partFiles };
