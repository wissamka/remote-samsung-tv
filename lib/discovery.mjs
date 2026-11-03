import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { isPrivateIPv4 } from './tv.mjs';

export function localAddresses(interfaces = networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flat().filter(entry =>
    entry && !entry.internal && entry.family === 'IPv4' && isPrivateIPv4(entry.address)
  ).map(entry => entry.address))];
}

function searchInterface(address) {
  const group = '239.255.255.250';
  const socket = dgram.createSocket('udp4');
  const hosts = new Set();
  return new Promise(resolve => {
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      resolve([...hosts]);
    }
    const timer = setTimeout(finish, 2800);
    socket.on('error', finish);
    socket.on('message', (data, peer) => {
      if (hosts.size < 64 && isPrivateIPv4(peer.address) && /^HTTP\/1\.[01] 200\b/i.test(data.toString('ascii', 0, 32))) {
        hosts.add(peer.address);
      }
    });
    socket.bind(0, address, () => {
      try {
        socket.setMulticastInterface(address);
        socket.setMulticastTTL(1);
        for (const target of ['urn:schemas-upnp-org:device:MediaRenderer:1', 'ssdp:all']) {
          const message = ['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 1', 'ST: ' + target, '', ''].join('\r\n');
          socket.send(message, 1900, group);
        }
      } catch { finish(); }
    });
  });
}

export async function verifyTV(host, fetcher = fetch) {
  if (!isPrivateIPv4(host)) return null;
  try {
    const response = await fetcher('http://' + host + ':8001/api/v2/', {
      redirect: 'error', signal: AbortSignal.timeout(1600)
    });
    if (!response.ok) return null;
    const { device } = await response.json();
    if (!/samsung/i.test(device?.type || '')) return null;
    return { host, name: String(device.name || 'Samsung TV').slice(0, 120) };
  } catch { return null; }
}

export async function discover(addresses = localAddresses(), search = searchInterface, verify = verifyTV) {
  const replies = await Promise.all(addresses.map(search));
  const hosts = [...new Set(replies.flat())].filter(isPrivateIPv4).slice(0, 64);
  const devices = await Promise.all(hosts.map(host => verify(host)));
  return devices.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
