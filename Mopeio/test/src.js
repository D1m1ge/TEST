'use strict';
// The userscript ships as a gzip+base64 archive under ../src so the GitHub connector
// can carry it in one small file; every consumer (launcher, tests) decodes it the same way.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function archiveFiles() {
  const dir = path.join(__dirname, '..', 'src');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.b64'))
    .sort();
}

function loadSource() {
  const files = archiveFiles();
  if (!files.length) throw new Error('No userscript archive found in src/*.b64');
  const b64 = files.map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8').replace(/\s+/g, '')).join('');
  return zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
}

module.exports = { loadSource, archiveFiles };
