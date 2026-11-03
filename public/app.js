const icons = {
  tv: '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2m3 6a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2"/>',
  power: '<path d="M12 2v10m-6-7a9 9 0 1 0 12 0"/>',
  home: '<path d="m3 10 9-7 9 7v10H3Zm6 10v-7h6v7"/>',
  input: '<path d="M12 4h8v16h-8M3 12h12m-4-4 4 4-4 4"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 3v6m8 0v6m-7 0v6"/>',
  up: '<path d="m7 14 5-5 5 5"/>', down: '<path d="m7 10 5 5 5-5"/>',
  left: '<path d="m14 7-5 5 5 5"/>', right: '<path d="m10 7 5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  back: '<path d="m8 4-5 5 5 5m-5-5h12a5 5 0 0 1 0 10h-4"/>',
  exit: '<path d="m6 6 12 12M6 18 18 6"/>',
  mute: '<path d="M11 4 6 8H3v8h3l5 4ZM16 9l6 6m-6 0 6-6"/>',
  play: '<path d="m7 4 14 8-14 8Z"/>', pause: '<path d="M8 4v16M16 4v16"/>',
  rewind: '<path d="m11 5-9 7 9 7Zm11 0-9 7 9 7Z"/>',
  forward: '<path d="m2 5 9 7-9 7Zm11 0 9 7-9 7Z"/>',
};
for (const element of document.querySelectorAll('[data-icon]')) {
  element.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[element.dataset.icon]}</svg>`;
}
const $ = selector => document.querySelector(selector);
const grid = $('#number-grid');
for (const [label, key] of [...Array.from({ length: 9 }, (_, n) => [String(n + 1), `KEY_${n + 1}`]), ['Info', 'KEY_INFO'], ['0', 'KEY_0'], ['Guide', 'KEY_GUIDE']]) {
  const button = document.createElement('button');
  button.textContent = label;
  button.dataset.key = key;
  button.disabled = true;
  button.setAttribute('aria-label', label);
  grid.append(button);
}

let csrf;
let state = 'disconnected';
let connecting = false;
let sending = false;
let checking = false;
const labels = { disconnected: 'Not connected', connecting: 'Connecting', pairing: 'Waiting for TV approval', connected: 'Connected', offline: 'TV unavailable' };
function render(data) {
  state = data.state;
  if (data.csrf) csrf = data.csrf;
  if (data.computerIPs) $('#computer-ips').textContent = 'Computer IP: ' + (data.computerIPs.join(', ') || 'No private IPv4 interface found');
  $('#status-label').textContent = labels[state] || 'Not connected';
  $('#status-dot').className = `status-dot ${state}`;
  $('#remote-led').className = state;
  if ($('#connection-message').textContent !== data.message) $('#connection-message').textContent = data.message;
  $('#address-summary').textContent = data.host || 'Choose a TV';
  if (document.activeElement !== $('#host')) $('#host').value = data.host || '';
  $('#device-name').textContent = data.device?.name || 'Samsung TV';
  $('#device-model').textContent = data.device?.model || 'Smart TV';
  $('#check').disabled = !data.host || checking;
  const busy = connecting || state === 'connecting' || state === 'pairing';
  $('#connect').disabled = !csrf || !data.host || state === 'connected' || busy;
  $('#connect-label').textContent = state === 'connected' ? 'Connected to TV' : state === 'pairing' ? 'Select Allow on your TV' : busy ? 'Connecting…' : 'Connect to TV';
  $('#host').disabled = busy;
  $('#settings-form button').disabled = busy;
  document.querySelectorAll('[data-key], [data-app]').forEach(button => { button.disabled = state !== 'connected'; });
  $('#remote-hint').textContent = state === 'connected' ? 'Click a button or use your keyboard.' : 'Connect to bring your remote to life.';
}
function feedback(message, error = false) {
  $('#feedback').textContent = message;
  $('#feedback').className = `command-feedback${error ? ' error' : ''}`;
}
async function request(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Remote-Token': csrf || '' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}
async function refresh() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error();
    render(await response.json());
  } catch {
    csrf = undefined;
    render({ state: 'disconnected', host: $('#address-summary').textContent, message: 'The remote server is unavailable. Check your network, then reload.' });
  }
}
async function check() {
  if (!csrf || checking) return;
  checking = true;
  $('#check').disabled = true;
  $('#check').textContent = 'Checking…';
  try { render(await request('/api/check')); } catch (error) { feedback(error.message, true); }
  finally { checking = false; $('#check').disabled = false; $('#check').textContent = 'Check connection'; }
}
$('#connect').addEventListener('click', async () => {
  connecting = true;
  $('#connect').disabled = true;
  $('#connect-label').textContent = 'Connecting…';
  feedback('Look for “Remote Samsung TV” on your TV and select Allow.');
  try { render(await request('/api/connect')); feedback('Paired. Your remote is ready.'); }
  catch (error) { feedback(error.message, true); }
  finally { connecting = false; await refresh(); }
});
$('#check').addEventListener('click', check);
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { render(await request('/api/settings', { host: $('#host').value.trim() })); feedback('TV address saved.'); await check(); }
  catch (error) { feedback(error.message, true); }
});
async function send(button) {
  if (!button || button.disabled || sending) return;
  sending = true;
  button.classList.add('pressed');
  try {
    await request('/api/key', { key: button.dataset.key });
    feedback(`${button.getAttribute('aria-label') || button.textContent.trim()} sent`);
  } catch (error) { feedback(error.message, true); await refresh(); }
  finally { setTimeout(() => { button.classList.remove('pressed'); sending = false; }, 110); }
}
document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', () => send(button)));
document.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('button, summary, a')) return;
  const mapping = { ArrowUp: 'KEY_UP', ArrowDown: 'KEY_DOWN', ArrowLeft: 'KEY_LEFT', ArrowRight: 'KEY_RIGHT', Enter: 'KEY_ENTER', Escape: 'KEY_RETURN', h: 'KEY_HOME', H: 'KEY_HOME', '+': 'KEY_VOLUP', '=': 'KEY_VOLUP', '-': 'KEY_VOLDOWN', m: 'KEY_MUTE', M: 'KEY_MUTE', p: 'KEY_PLAY', P: 'KEY_PLAY', ' ': 'KEY_PAUSE' };
  const key = mapping[event.key] || (/^[0-9]$/.test(event.key) ? `KEY_${event.key}` : null);
  if (!key || state !== 'connected') return;
  event.preventDefault();
  send(document.querySelector(`[data-key="${key}"]`));
});
refresh();
setInterval(refresh, 1500);

for (const button of document.querySelectorAll('[data-app]')) {
  button.addEventListener('click', async () => {
    const result = $('#launch-status');
    try {
      await request('/api/launch', { app: button.dataset.app });
      result.textContent = button.dataset.app + ' launch request sent.';
    } catch (error) { result.textContent = error.message; await refresh(); }
  });
}

$('#discover').addEventListener('click', async () => {
  const find = $('#discover');
  const results = $('#devices');
  const status = $('#search-status');
  find.disabled = true;
  results.replaceChildren();
  status.textContent = 'Searching your network…';
  try {
    const { devices } = await request('/api/discover');
    status.textContent = devices.length ? 'Choose your TV:' : 'No TVs found. Enter the address from the TV’s Network Status screen below.';
    for (const device of devices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = device.name + ' · ' + device.host;
      button.onclick = async () => {
        try {
          render(await request('/api/settings', { host: device.host }));
          status.textContent = 'TV selected. Now choose Connect to TV.';
        } catch (error) { status.textContent = error.message; }
      };
      results.append(button);
    }
  } catch (error) { status.textContent = error.message; }
  finally { find.disabled = false; }
});
