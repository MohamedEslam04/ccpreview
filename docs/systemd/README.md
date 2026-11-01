# Start Marsad on login (systemd, Linux)

With socket activation, systemd listens on `127.0.0.1:4747` and starts Marsad the first time something connects to it. Turning the server off from the UI (the server button, `POST /api/shutdown`) exits the process, and the next visit starts it again. Outside systemd that button does nothing, because there is no socket to restart from. When idle it costs nothing.

Marsad detects the activated socket on its own (`LISTEN_FDS` / `LISTEN_PID`) and does not open a browser in that case.

## Install

```sh
npm install -g marsad
mkdir -p ~/.config/systemd/user
cp marsad.socket marsad.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now marsad.socket
```

Then open <http://127.0.0.1:4747/>.

Check it:

```sh
systemctl --user status marsad.socket marsad.service
journalctl --user -u marsad.service -e
```

Remove it:

```sh
systemctl --user disable --now marsad.socket
rm ~/.config/systemd/user/marsad.{socket,service}
systemctl --user daemon-reload
```

## Node path caveats (nvm, fnm, volta)

User units do not read your shell profile, so `node` and `marsad` installed through nvm or fnm are usually not on the unit's `PATH`. `/usr/bin/env marsad` only works when `marsad` is in a directory systemd already knows (for example `/usr/bin` or `/usr/local/bin`).

Use absolute paths instead. Find them in the shell where `marsad` works:

```sh
command -v node     # e.g. /home/you/.nvm/versions/node/v22.11.0/bin/node
command -v marsad   # e.g. /home/you/.nvm/versions/node/v22.11.0/bin/marsad
```

Then edit `marsad.service`:

```ini
ExecStart=/home/you/.nvm/versions/node/v22.11.0/bin/node /home/you/.nvm/versions/node/v22.11.0/bin/marsad --no-open
```

Running through `node` explicitly avoids the `#!/usr/bin/env node` lookup failing inside the unit. The path changes when you switch Node versions, so update the unit after upgrading Node.

If you prefer not to install globally, use `npx`. It needs `npx` and `node` on the same `PATH`, which you can set in the unit:

```ini
Environment=PATH=/home/you/.nvm/versions/node/v22.11.0/bin:/usr/local/bin:/usr/bin
ExecStart=/home/you/.nvm/versions/node/v22.11.0/bin/npx --yes marsad --no-open
```

`npx --yes` may download the package on the first start, which delays the first page load.

## Other options

Pass options after `--no-open`, for example `--projects /path/to/projects` or `--data /path/to/data`. The `--port` option is ignored under socket activation, because the port comes from `ListenStream` in `marsad.socket`. To change the port, edit that file.

`ListenStream=127.0.0.1:4747` binds to loopback only. Do not change it to `0.0.0.0` or a LAN address: transcripts can contain secrets and code.
