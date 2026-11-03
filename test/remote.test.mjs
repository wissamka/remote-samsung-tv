import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { TVRemote, ConfigStore, isPrivateIPv4 } from '../lib/tv.mjs';
import { createServer } from '../server.mjs';

class FakeSocket extends EventEmitter {
  static latest;
  constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; FakeSocket.latest = this; queueMicrotask(() => this.emit('open')); }
  send(data, callback) { this.sent.push(JSON.parse(data)); callback(); }
  terminate() { this.readyState = 3; this.emit('close'); }
  message(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}
const makeRemote = options => new TVRemote({ host: '10.77.88.16' }, { Socket: FakeSocket, pairingTimeout: 150, ...options });

test('accepts only private IPv4 targets', () => {
  for (const host of ['10.77.88.16', '10.1.2.3', '172.16.0.1', '172.31.9.2']) assert.equal(isPrivateIPv4(host), true);
  for (const host of ['127.0.0.1', '8.8.8.8', '169.254.169.254', 'localhost', '172.32.0.1', '10.77.88.999', '10.77.88.1:8002', undefined]) assert.equal(isPrivateIPv4(host), false);
});

test('pairing is required before a button can be sent; valid packets and private token storage', async () => {
  let saved;
  const remote = makeRemote({ store: { save: async config => { saved = { ...config }; } } });
  await assert.rejects(remote.send('KEY_VOLUP'), /Connect/);
  const pending = remote.connect();
  await tick();
  assert.equal(remote.state, 'pairing');
  FakeSocket.latest.message({ event: 'ms.channel.connect', data: { token: 'test-pairing-credential' } });
  await pending;
  assert.equal(saved.token, 'test-pairing-credential');
  assert.equal(remote.status().paired, true);
  assert.equal(JSON.stringify(remote.status()).includes('test-pairing-credential'), false);
  assert.deepEqual(await remote.send('KEY_VOLUP'), { sent: true, key: 'KEY_VOLUP' });
  assert.deepEqual(FakeSocket.latest.sent[0], { method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_VOLUP', Option: 'false', TypeOfRemote: 'SendRemoteKey' } });
  await assert.rejects(remote.send('KEY_FACTORY'), /Unsupported/);
  await assert.rejects(remote.send('KEY_VOLUP'), /wait a moment/);
  remote.disconnect();
});

test('reconnect includes saved token without exposing it in status', async () => {
  const remote = makeRemote(); remote.config.token = 'saved-token';
  const pending = remote.connect();
  await tick();
  assert.equal(new URL(FakeSocket.latest.url).searchParams.get('token'), 'saved-token');
  FakeSocket.latest.message({ event: 'ms.channel.connect', data: {} });
  await pending;
  remote.disconnect();
});

test('repeated connect shares one attempt', async () => {
  const remote = makeRemote();
  const first = remote.connect(); const second = remote.connect();
  assert.equal(first, second);
  await tick(); FakeSocket.latest.message({ event: 'ms.channel.connect' });
  await first; remote.disconnect();
});

test('TV denial and timeout do not leave controls enabled', async () => {
  const remote = makeRemote();
  const pending = remote.connect(); const rejection = assert.rejects(pending, /denied/);
  await tick(); FakeSocket.latest.message({ event: 'ms.channel.unauthorized' });
  await rejection; assert.equal(remote.state, 'disconnected');
  await assert.rejects(remote.connect(), /timed out/);
  assert.equal(remote.state, 'disconnected');
});

test('closing the TV socket clears connected status', async () => {
  const remote = makeRemote(); const pending = remote.connect();
  await tick(); FakeSocket.latest.message({ event: 'ms.channel.connect' }); await pending;
  FakeSocket.latest.terminate(); assert.equal(remote.state, 'disconnected');
  await assert.rejects(remote.send('KEY_ENTER'), /Connect/);
});

test('pairing save failure is visible and leaves connection closed', async () => {
  const remote = makeRemote({ store: { save: async () => { throw new Error('EACCES'); } } });
  const pending = remote.connect(); const rejection = assert.rejects(pending, /could not save pairing/);
  await tick(); FakeSocket.latest.message({ event: 'ms.channel.connect', data: { token: 'test' } });
  await rejection; assert.equal(remote.state, 'disconnected');
});

test('changing TV invalidates previous pairing; failing save preserves previous configuration', async () => {
  const remote = makeRemote({ store: { save: async () => {} } }); remote.config.token = 'old';
  await remote.setHost('10.77.88.17');
  assert.deepEqual(remote.config, { host: '10.77.88.17' });
  remote.store.save = async () => { throw new Error('disk failure'); };
  await assert.rejects(remote.setHost('10.77.88.18'));
  assert.equal(remote.config.host, '10.77.88.17');
  await assert.rejects(remote.setHost('8.8.8.8'), /local TV address/);
});

test('device check exposes selected identity fields, no raw device data', async () => {
  const remote = makeRemote({ fetcher: async () => ({ ok: true, json: async () => ({ device: { type: 'Samsung SmartTV', name: 'Example', modelName: 'DemoModel', PowerState: 'on', wifiMac: 'private' } }) }) });
  const status = await remote.check();
  assert.deepEqual(status.device, { name: 'Example', model: 'DemoModel', power: 'on' });
  remote.fetcher = async () => { throw new Error('timeout'); };
  assert.equal((await remote.check()).state, 'offline');
});

test('config persists outside source with owner-only permissions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ConfigStore(join(dir, 'settings'));
  await store.save({ host: '10.77.88.16', token: 'test-secret' });
  assert.equal((await store.load()).token, 'test-secret');
  if (process.platform !== 'win32') assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  if (process.platform !== 'win32') assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(store.path)).host, '10.77.88.16');
});

test('HTTP API rejects foreign origins, DNS rebinding, missing CSRF, malformed bodies and unsupported paths', async t => {
  let presses = 0;
  const remote = { status: () => ({ state: 'connected', host: '10.77.88.16' }), send: async () => { presses++; return { sent: true }; } };
  const server = createServer(remote);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { csrf } = await (await fetch(`${base}/api/status`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-Remote-Token': csrf };
  const post = (body, extra = {}) => fetch(`${base}/api/key`, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await post('{"key":"KEY_ENTER"}', { Origin: 'https://evil.example' })).status, 403);
  // Node's fetch normalizes Host, so use the raw HTTP client for this case.
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/key`, { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await post('{}', { 'X-Remote-Token': 'wrong' })).status, 403);
  assert.equal((await post('{}', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('{bad')).status, 400);
  assert.equal((await post('null')).status, 400);
  assert.equal((await post(JSON.stringify({ data: 'x'.repeat(1100) }))).status, 413);
  assert.equal((await fetch(`${base}/settings.json`)).status, 404);
  assert.equal(presses, 0);
  assert.equal((await post('{"key":"KEY_ENTER"}', { Origin: base })).status, 200);
  assert.equal(presses, 1);
  const page = await fetch(base);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Remote Samsung TV/);
});

test('streaming shortcuts require pairing and a positive TV acknowledgement', async () => {
  const calls = [];
  let accepted = true;
  const remote = makeRemote({ fetcher: async (url, opts) => {
    calls.push({ url, method: opts.method });
    return { ok: true, json: async () => accepted };
  } });
  await assert.rejects(remote.launch('Netflix'), /Connect/);
  const pairing = remote.connect();
  await tick();
  FakeSocket.latest.message({ event: 'ms.channel.connect' });
  await pairing;
  await assert.rejects(remote.launch('arbitrary'), /Unknown/);
  assert.deepEqual(await remote.launch('Prime Video'), { sent: true, app: 'Prime Video' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: 'http://10.77.88.16:8001/api/v2/applications/3201910019365', method: 'POST' });
  accepted = false;
  await assert.rejects(remote.launch('Netflix'), /did not accept/);
  remote.disconnect();
});
