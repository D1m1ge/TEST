'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

function getJson(url, timeout = 1500) {
  return new Promise((resolve, reject) => {
    let timer;
    const req = http.get(url, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 1024 * 1024) req.destroy(new Error('CDP response too large'));
      });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) return reject(new Error(`CDP HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    timer = setTimeout(() => req.destroy(new Error('CDP HTTP timeout')), timeout);
    req.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

async function waitForEndpoint(port, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    let info;
    try {
      info = await getJson(`http://127.0.0.1:${port}/json/version`, Math.min(1500, deadline - Date.now()));
    } catch (err) { lastError = err; }
    if (info) {
      const url = new URL(info.webSocketDebuggerUrl);
      if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || Number(url.port) !== port) {
        throw new Error('Unexpected CDP websocket address');
      }
      return url.href;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(300, remaining)));
  }
  throw new Error(`No CDP endpoint on 127.0.0.1:${port}: ${lastError?.message}`);
}

function openSocket(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { reject(new Error('CDP websocket timeout')); ws.close(); }, timeout);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket error')); }, { once: true });
    ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('CDP websocket closed')); }, { once: true });
  });
}

class CDP {
  constructor(ws, timeout = 5000) {
    this.ws = ws;
    this.timeout = timeout;
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    const close = () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    };
    ws.addEventListener('close', close);
    ws.addEventListener('error', close);
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params, sessionId })); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }
}

async function inject(cdp, source, game) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
  const result = await cdp.send('Page.navigate', { url: game }, sessionId);
  if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
  return targetId;
}

async function main() {
  const port = Number(process.env.MOPE_CDP_PORT || 9222);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MOPE_CDP_PORT');
  if (typeof WebSocket !== 'function') throw new Error('Node.js 22 or newer is required');
  const game = new URL(process.env.MOPE_URL || 'https://mope.io/');
  if (!['https:', 'http:'].includes(game.protocol)) throw new Error('MOPE_URL must be an HTTP(S) URL');
  const source = fs.readFileSync(path.join(__dirname, '..', 'mope-cheat.user.js'), 'utf8');
  const ws = await openSocket(await waitForEndpoint(port));
  try {
    await inject(new CDP(ws), source, game.href);
    console.log('[mope] Инъекция готова. Оставь это окно открытым. Ctrl+C — отключить launcher.');
    process.once('SIGINT', () => ws.close());
  } catch (err) { ws.close(); throw err; }
}

if (require.main === module) main().catch(err => { console.error('[mope]', err.message); process.exitCode = 1; });
module.exports = { getJson, waitForEndpoint, openSocket, CDP, inject };
