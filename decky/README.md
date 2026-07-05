# SteamOS LACT Toolkit Decky Plugin

Decky plugin for monitoring and tuning AMD GPU settings exposed by LACT on
SteamOS and SteamOS-like DIY living-room PCs.

## Features

- Read LACT status through `/run/lactd.sock`
- Show GPU temperatures, voltage, power, clocks, fan, busy percent, and throttling
- Show configured values versus currently applied driver values
- Adjust custom tuning from Decky:
  - power cap
  - voltage offset
  - VRAM max clock
  - Zero RPM
- Save and delete named presets

Custom presets are stored in:

```text
~/.config/steamos-lact-toolkit/profiles.json
```

## Requirements

- SteamOS or a SteamOS-like Linux system
- Decky Loader
- LACT with `lactd` running
- AMD GPU supported by LACT
- AMD overdrive enabled in the kernel if voltage offset tuning is needed

## Build

```bash
npm install
npm run build
```

## Manual Install

Copy this `decky` directory to the Decky plugin directory and restart Decky
Loader:

```bash
sudo rm -rf /home/deck/homebrew/plugins/steamos-lact-toolkit
sudo cp -a decky /home/deck/homebrew/plugins/steamos-lact-toolkit
sudo systemctl restart plugin_loader.service
```

If the service name differs, restart Decky Loader from Decky settings instead.
