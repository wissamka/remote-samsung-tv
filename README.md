# Remote Samsung TV

A browser remote for compatible Samsung smart TVs on your home network. Use the directional pad, keyboard, volume, playback controls and number pad, or launch Netflix, Prime Video, Disney+, Apple TV and YouTube. Available buttons and installed app IDs vary by TV and region.

## Get started

1. Install [Node.js](https://nodejs.org/) 22 or later (includes npm) on a Mac, Windows PC or Linux computer. Turn the TV on and connect both devices to the same home network.
2. From Terminal or PowerShell, run the following command. It installs the remote from this GitHub project into npm's cache and starts the local server.

   ```sh
   npx --yes --package=https://github.com/wissamka/remote-samsung-tv/archive/refs/tags/v1.0.0.tar.gz remote-samsung-tv
   ```

3. Open the URL printed in the terminal (normally `http://127.0.0.1:8765/`). Click **Find TVs**, then choose the matching device. For manual setup, open **TV address**, enter the private IPv4 address shown under **Network Status → IP Settings** on the TV and click **Save**.
4. Click **Connect to TV**. On the TV screen, select **Allow** for **Remote Samsung TV**. Use the remote when its status reads **Connected**. On later runs, click **Connect to TV** to reuse the saved pairing.
5. Keep the computer awake and the command running. Press Ctrl+C in the terminal to stop it.

## Install from source

```sh
git clone https://github.com/wissamka/remote-samsung-tv.git
cd remote-samsung-tv
npm ci
npm start
```

From the checkout, use these commands (replace uppercase placeholders with actual addresses):

| What you want | Command |
| --- | --- |
| List the computer's IP addresses and discover TVs without pairing | `npm start -- --discover` |
| Set a TV address yourself | `npm start -- --tv TV_IP` |
| Use the remote on your phone over trusted Wi-Fi | `npm start -- --lan` |
| Choose the computer's Wi-Fi or Ethernet IP if several are listed | `npm start -- --host COMPUTER_IP` |
| Choose both addresses and the port | `npm start -- --host COMPUTER_IP --tv TV_IP --port 9000` |

The same flags work after the executable name in the npx command. For phone use, open the printed LAN URL on your phone while connected to the same Wi-Fi. Allow the computer's firewall to accept the app on your private network if prompted. LAN mode allows anyone who can reach that port to control the remote. Keep the port inside your trusted network.

## Discovery and troubleshooting

- **No TV listed:** Discovery sends SSDP multicast queries on private IPv4 interfaces and verifies each responder against the Samsung device API on TCP 8001. Some TVs sleep or do not advertise. Guest Wi-Fi, client isolation, VPNs or a firewall may block discovery. Enter the TV address manually and use **Check connection**.
- **Found but cannot connect:** The TV must support Samsung’s local WebSocket remote on TCP 8002. Look for the approval prompt or check the TV’s device connection permissions. Developer Mode and Tizen Studio are not required. Older TVs using other protocols are unsupported.
- **App button fails:** Confirm the streaming app is installed on this TV. The server reports whether the TV accepted the launch request. Other button sends do not confirm physical effects.
- **Port in use:** Start with `--port 9000` or another free port.

## Local data

The app starts on loopback unless you explicitly choose LAN access. TV and computer addresses are supplied or detected at runtime. The selected TV address and its pairing token stay in `.remote-samsung-tv/settings.json` in your OS user home directory, outside the checkout. Changing TV addresses discards the old token. To forget pairing, stop the app and delete that settings file. The TV can also revoke access.

The browser uses local assets and the app has no analytics. Network discovery and TV commands stay on the LAN. Only the private TV WebSocket connection accepts Samsung’s self-signed certificate; it does not authenticate the TV certificate. Use on a trusted network.

## Development

Run `npm ci`, then `npm test`. Tests simulate discovery, pairing and request validation without controlling a real TV. CI runs on Windows, macOS and Linux.

Independent project. Samsung and the streaming service names and logos belong to their respective owners. The MIT license covers the project's code.
