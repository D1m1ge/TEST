'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { getJson, waitForEndpoint, CDP, inject } = require('../launcher/inject');

async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return { port: s.address().port, url: `http://127.0.0.1:${s.address().port}` };
}
class Socket extends EventEmitter {
  addEventListener(name, fn) { this.on(name, fn); }
  send(data) { this.sent.push(JSON.parse(data)); }
  constructor() { super(); this.sent = []; }
}

test('endpoint accepts local browser and rejects remote websocket addresses', async t => {
  let remote = false;
  const s = await server(t, (req, res) => res.end(JSON.stringify({
    webSocketDebuggerUrl: remote ? 'ws://example.com:9222/devtools/browser/a' : `ws://127.0.0.1:${s.port}/devtools/browser/a`,
  })));
  assert.match(await waitForEndpoint(s.port), /devtools\/browser\/a$/);
  remote = true;
  await assert.rejects(waitForEndpoint(s.port, 30), /Unexpected CDP websocket address/);
});
test('HTTP requests fail on status, invalid JSON and stalled response', async t => {
  const s = await server(t, (req, res) => {
    if (req.url === '/status') { res.writeHead(503); res.end('{}'); }
    else if (req.url === '/json') res.end('broken');
  });
  await assert.rejects(getJson(s.url + '/status'), /HTTP 503/);
  await assert.rejects(getJson(s.url + '/json'), SyntaxError);
  await assert.rejects(getJson(s.url + '/stall', 30), /timeout/);
});
test('CDP cleans pending commands on reply, timeout, close and send failure', async () => {
  const ws = new Socket(), cdp = new CDP(ws, 30);
  const first = cdp.send('Page.enable', {}, 'session');
  assert.equal(ws.sent[0].sessionId, 'session');
  ws.emit('message', { data: 'invalid' });
  ws.emit('message', { data: JSON.stringify({ id: ws.sent[0].id, result: { ok: true } }) });
  assert.deepEqual(await first, { ok: true });
  await assert.rejects(cdp.send('Timeout'), /CDP timeout/);
  const pending = cdp.send('Wait');
  ws.emit('close');
  await assert.rejects(pending, /connection closed/);
  await assert.rejects(cdp.send('AfterClose'), /connection closed/);
  assert.equal(cdp.pending.size, 0);
  const bad = new Socket(); bad.send = () => { throw new Error('send failed'); };
  const badCdp = new CDP(bad);
  await assert.rejects(badCdp.send('Fail'), /send failed/);
  assert.equal(badCdp.pending.size, 0);
});
test('inject registers full userscript before navigation and reports navigation errors', async () => {
  const ws = new Socket(), cdp = new CDP(ws);
  const methods = [];
  let fail = false;
  ws.send = data => {
    const m = JSON.parse(data); methods.push(m);
    const result = m.method === 'Target.createTarget' ? { targetId: 'target' }
      : m.method === 'Target.attachToTarget' ? { sessionId: 'session' }
      : m.method === 'Page.navigate' && fail ? { errorText: 'ERR_FAILED' } : {};
    queueMicrotask(() => ws.emit('message', { data: JSON.stringify({ id: m.id, result }) }));
  };
  assert.equal(await inject(cdp, 'source', 'https://mope.io/'), 'target');
  assert.deepEqual(methods.map(m => m.method), ['Target.createTarget', 'Target.attachToTarget', 'Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Page.navigate']);
  assert.equal(methods[3].params.source, 'source');
  assert.equal(methods[4].sessionId, 'session');
  fail = true;
  await assert.rejects(inject(cdp, 'source', 'https://mope.io/'), /Navigation failed: ERR_FAILED/);
});
