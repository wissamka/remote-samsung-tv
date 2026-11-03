import WebSocket from 'ws';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';

export const KEYS = new Set([
  'KEY_UP', 'KEY_DOWN', 'KEY_LEFT', 'KEY_RIGHT', 'KEY_ENTER', 'KEY_RETURN',
  'KEY_HOME', 'KEY_EXIT', 'KEY_SOURCE', 'KEY_MENU', 'KEY_GUIDE', 'KEY_INFO',
  'KEY_VOLUP', 'KEY_VOLDOWN', 'KEY_MUTE', 'KEY_CHUP', 'KEY_CHDOWN',
  'KEY_PLAY', 'KEY_PAUSE', 'KEY_STOP', 'KEY_REWIND', 'KEY_FF', 'KEY_POWER',
  ...Array.from({ length: 10 }, (_, n) => `KEY_${n}`),
]);

export function isPrivateIPv4(host) {
  if (typeof host !== 'string' || isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export class ConfigStore {
  constructor(directory) { this.directory = directory; this.path = join(directory, 'settings.json'); }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8'));
      if (!isPrivateIPv4(data.host)) throw new Error('Invalid saved TV address');
      return { host: data.host, token: typeof data.token === 'string' ? data.token : undefined };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {};
    }
  }
  async save(config) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

export class TVRemote {
  constructor(config, { store, Socket = WebSocket, pairingTimeout = 45000, fetcher = fetch } = {}) {
    if (config.host !== undefined && !isPrivateIPv4(config.host)) throw new Error('Use a private IPv4 address for the TV.');
    this.config = config;
    this.store = store;
    this.Socket = Socket;
    this.fetcher = fetcher;
    this.pairingTimeout = pairingTimeout;
    this.state = 'disconnected';
    this.message = 'Connect to start using your remote.';
    this.device = null;
    this.lastSent = 0;
  }

  status() {
    return { host: this.config.host, state: this.state, message: this.message,
      paired: Boolean(this.config.token), device: this.device };
  }

  async check() {
    const host = this.config.host;
    if (!host) return this.status();
    try {
      const response = await this.fetcher(`http://${host}:8001/api/v2/`, { signal: AbortSignal.timeout(3500), redirect: 'error' });
      if (!response.ok) throw new Error('TV unavailable');
      const { device } = await response.json();
      if (host !== this.config.host) return this.status();
      if (!device || !/Samsung/i.test(device.type || '')) throw new Error('Not a Samsung TV');
      this.device = { name: device.name, model: device.modelName, power: device.PowerState };
      if (this.state === 'disconnected' || this.state === 'offline') {
        this.state = 'disconnected';
        this.message = 'TV found. Connect to use your remote.';
      }
    } catch {
      if (host === this.config.host && this.state !== 'connected' && this.state !== 'connecting' && this.state !== 'pairing') {
        this.state = 'offline';
        this.message = 'TV unavailable. Turn it on and check that it’s on the same Wi-Fi.';
      }
    }
    return this.status();
  }

  async setHost(host) {
    if (!isPrivateIPv4(host)) throw new Error('Enter the local TV address shown in Network Status.');
    if (this.pending || this.changingHost) throw new Error('Wait for the current connection attempt to finish.');
    if (host === this.config.host) return this.status();
    const next = { host };
    this.changingHost = true;
    try { await this.store?.save(next); } finally { this.changingHost = false; }
    this.disconnect();
    this.config = next;
    this.device = null;
    return this.status();
  }

  connect() {
    if (!this.config.host) return Promise.reject(new Error('Choose a TV first.'));
    if (this.changingHost) return Promise.reject(new Error('Wait for the address to be saved.'));
    if (this.state === 'connected' && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    this.state = 'connecting';
    this.message = 'Reaching your TV…';
    this.pending = this.open().finally(() => { this.pending = null; });
    return this.pending;
  }

  open() {
    const query = new URLSearchParams({ name: Buffer.from('Remote Samsung TV').toString('base64') });
    if (this.config.token) query.set('token', this.config.token);
    return new Promise((resolve, reject) => {
      // Samsung uses a self-signed certificate on its local remote-control endpoint.
      // This exception is scoped to this private-IP connection; never global TLS settings.
      const socket = new this.Socket(`wss://${this.config.host}:8002/api/v2/channels/samsung.remote.control?${query}`, {
        rejectUnauthorized: false, handshakeTimeout: 7000, maxPayload: 65536,
      });
      this.socket = socket;
      let settled = false;
      let authorizing = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.state = 'disconnected';
        this.message = message;
        socket.terminate();
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail('Connection timed out. Select Allow on the TV, then try Connect again.'), this.pairingTimeout);
      socket.on('open', () => {
        this.state = 'pairing';
        this.message = 'Select Allow for “Remote Samsung TV” on your TV.';
      });
      socket.on('message', async raw => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (data.event === 'ms.channel.unauthorized') {
          fail('The TV denied access. Allow Remote Samsung TV in the TV’s connected-device settings, then retry.');
        } else if (data.event === 'ms.channel.connect' && !settled && !authorizing) {
          authorizing = true;
          const token = data.data?.token;
          const config = { ...this.config };
          if (typeof token === 'string' || typeof token === 'number') config.token = String(token);
          try {
            if (config.token) await this.store?.save(config);
            if (settled) return;
            this.config = config;
            settled = true;
            clearTimeout(timer);
            this.state = 'connected';
            this.message = 'Connected. Your remote is ready.';
            resolve(this.status());
          } catch { fail('Connected, but could not save pairing. Check your local settings folder permissions.'); }
        } else if (data.event === 'ms.error') {
          if (!settled) fail('The TV rejected the remote connection. Try connecting again.');
          else this.message = 'The TV reported a command error. This action may not be supported.';
        }
      });
      socket.on('error', () => {
        if (!settled) fail('Could not connect. Turn the TV on and check its Wi-Fi address.');
      });
      socket.on('close', () => {
        if (!settled) fail('The TV closed the connection. Select Allow on the TV and reconnect.');
        else if (this.socket === socket && this.state === 'connected') {
          this.state = 'disconnected';
          this.message = 'Connection closed. If the TV is on, connect again.';
        }
      });
    });
  }

  async launch(app) {
    const ids = new Map([
      ['Netflix', '3201907018807'], ['Prime Video', '3201910019365'],
      ['Disney+', '3201901017640'], ['Apple TV', '3201807016597'], ['YouTube', '111299001912'],
    ]);
    if (!ids.has(app)) throw new Error('Unknown streaming shortcut.');
    if (this.state !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Connect to the TV first.');
    const url = `http://${this.config.host}:8001/api/v2/applications/${ids.get(app)}`;
    let accepted = false;
    try {
      const response = await this.fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000) });
      accepted = response.ok && await response.json() === true;
    } catch { /* Report the same actionable error for timeout and unavailable TV. */ }
    if (!accepted) throw new Error('TV did not accept the launch. Check that the app is installed and try again.');
    return { sent: true, app };
  }

  async send(key) {
    if (!KEYS.has(key)) throw new Error('Unsupported remote button.');
    if (this.state !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Connect to the TV first.');
    const now = Date.now();
    if (now - this.lastSent < 100) throw new Error('Please wait a moment between button presses.');
    this.lastSent = now;
    const message = { method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' } };
    await new Promise((resolve, reject) => this.socket.send(JSON.stringify(message), error => error ? reject(new Error('Could not send the button. Reconnect and retry.')) : resolve()));
    // A socket write is not an acknowledgement that the TV performed the action.
    return { sent: true, key };
  }

  disconnect() {
    this.state = 'disconnected';
    this.message = 'Connect to start using your remote.';
    this.socket?.terminate();
    this.socket = null;
  }
}
