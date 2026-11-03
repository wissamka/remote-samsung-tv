#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, TVRemote, isPrivateIPv4 } from '../lib/tv.mjs';
import { discover, localAddresses } from '../lib/discovery.mjs';
import { createServer } from '../server.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    tv: { type: 'string' }, host: { type: 'string' }, port: { type: 'string', default: '8765' },
    lan: { type: 'boolean' }, discover: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  }});
  if (values.help) {
    console.log(`Remote Samsung TV
  remote-samsung-tv                 Start a remote on this computer
  --discover                        List local computer addresses and nearby TVs, then exit
  --tv TV_IP                        Select the TV by its private IPv4 address
  --lan                             Serve on a private interface for phone access
  --host COMPUTER_IP                Serve on a specific local network interface
  --port PORT                       Choose the web port (default 8765)`);
    return;
  }
  const addresses = localAddresses();
  console.log('Computer IPs: ' + (addresses.join(', ') || 'No private IPv4 network detected'));
  if (values.host && !addresses.includes(values.host)) throw new Error('--host must match one of this computer’s private IPv4 addresses.');
  if (values.discover) {
    const devices = await discover(values.host ? [values.host] : addresses);
    for (const device of devices) console.log(JSON.stringify(device));
    if (!devices.length) console.log('No TVs announced themselves. Enter the address from Network Status on your TV.');
    return;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port between 1 and 65535.');
  if (values.tv !== undefined && !isPrivateIPv4(values.tv)) throw new Error('--tv requires a private IPv4 address.');
  if (values.lan && !values.host && addresses.length !== 1) throw new Error('Choose your Wi-Fi or Ethernet address above with --host COMPUTER_IP.');
  const lanIP = values.host || (values.lan && addresses[0]) || undefined;
  const bind = lanIP || '127.0.0.1';
  const store = new ConfigStore(join(homedir(), '.remote-samsung-tv'));
  const remote = new TVRemote(await store.load(), { store });
  if (values.tv) await remote.setHost(values.tv);
  const server = createServer(remote, { lanIP });
  server.once('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'Port in use. Restart with --port and an available number.' : 'Could not start the remote: ' + error.code);
    process.exitCode = 1;
  });
  server.listen(port, bind, () => {
    console.log('Open http://' + bind + ':' + port + '/ on ' + (lanIP ? 'your computer or phone on trusted Wi-Fi.' : 'this computer.'));
    console.log('Turn on your TV → Find TVs or enter its IP → Connect to TV → Allow on your TV.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { remote.disconnect(); server.close(); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
