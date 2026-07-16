# SteamOS LACT Toolkit

Toolkit for AMD GPU monitoring, LACT tuning, and SteamOS update persistence on
DIY SteamOS machines.

This project contains:

- `decky/`: Decky Loader plugin for reading LACT status, applying tuning values,
  using LACT Desktop profiles, and saving/deleting local Toolkit presets.
- `persistence/`: SteamOS atomic-update keep-list and systemd timer for keeping
  LACT config and AMD overdrive kernel settings intact across SteamOS updates.

## Screenshots

<p>
  <img src="screenshots/status.png?v=3" alt="SteamOS LACT Toolkit status and verification view" width="48%">
  <img src="screenshots/tuning.png?v=3" alt="SteamOS LACT Toolkit custom tuning and fan controls" width="48%">
</p>

## What It Does

The Decky plugin talks to LACT through `/run/lactd.sock`. It prefers a dedicated
LACT GPU device when one is available, displays live telemetry, compares saved
LACT configuration with runtime driver values, and lets the user apply LACT
profiles made in Desktop mode. It can also save local Toolkit presets for quick
Gaming Mode snapshots and adjust basic fan control through LACT.

The persistence helper preserves LACT and AMD overdrive files across SteamOS
atomic updates and warns when a reboot is required before voltage offset tuning
can apply again.

## Requirements

- SteamOS or SteamOS-like Linux system
- AMD GPU supported by LACT
- LACT installed and `lactd` running
- Decky Loader for the plugin

The LACT Flatpak can work as long as its system daemon setup has been completed
and `/run/lactd.sock` is available. Running the Flatpak GUI in sandbox-only
monitoring mode is not enough for this plugin because tuning requires the root
`lactd` service.

## Safety

GPU tuning can cause crashes, visual corruption, or reboots if values are too
aggressive. Start with conservative settings and test stability before saving a
preset.

## Install

One-command install:

```bash
curl -fsSL https://raw.githubusercontent.com/Twsts/steamos-lact-toolkit/master/install.sh | bash
```

The installer downloads the latest release bundle, installs the Decky plugin,
installs the SteamOS persistence helper, and restarts Decky Loader.

Manual build/install is also possible from `decky/`.

Install the SteamOS persistence helper from `persistence/`:

```bash
cd persistence
sudo ./install.sh
sudo systemctl start steamos-lact-restore.service
```

See the README in each subdirectory for details.
