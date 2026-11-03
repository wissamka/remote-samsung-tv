import test from 'node:test';
import assert from 'node:assert/strict';
import { discover, localAddresses, verifyTV } from '../lib/discovery.mjs';
import { TVRemote } from '../lib/tv.mjs';

test('interface selection excludes loopback, public addresses and duplicates', () => {
  const iface = (address, internal = false) => ({ address, internal, family: 'IPv4' });
  const entries = [iface('127.0.0.1', true), iface('203.0.113.8'), iface('10.77.88.8'), iface('10.77.88.8')];
  assert.deepEqual(localAddresses({ ethernet: entries }), ['10.77.88.8']);
});

test('discovery deduplicates responses and shows only verified Samsung devices', async () => {
  const target = '10.77.88.10';
  const other = '10.77.88.11';
  const visited = [];
  const verify = host => verifyTV(host, async (url, options) => {
    assert.equal(options.redirect, 'error');
    visited.push(url);
    return { ok: true, json: async () => ({ device: {
      type: host === target ? 'Samsung SmartTV' : 'Other device', name: 'Example'
    } }) };
  });
  const result = await discover(['10.77.88.8'], async () => [target, target, other, '203.0.113.1'], verify);
  assert.deepEqual(result, [{ name: 'Example', host: target }]);
  assert.equal(visited.length, 2);
});

test('fresh setup has no target and never tries to connect before selection', async () => {
  const remote = new TVRemote({});
  assert.equal((await remote.check()).host, undefined);
  await assert.rejects(remote.connect(), /Choose a TV/);
  await remote.setHost('10.77.88.10');
  assert.equal(remote.status().host, '10.77.88.10');
});
