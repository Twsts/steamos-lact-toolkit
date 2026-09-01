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
  <img src="screenshots/status.png?v=5" alt="SteamOS LACT Toolkit status and verification view" width="32%">
  <img src="screenshots/tuning.png?v=5" alt="SteamOS LACT Toolkit custom tuning controls" width="32%">
  <img src="screenshots/fan-control.png?v=5" alt="SteamOS LACT Toolkit fan control settings" width="32%">
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
checks the LACT daemon setup, installs the SteamOS persistence helper, and
restarts Decky Loader. It also checks that Decky starts and reports whether the
plugin backend is visible in the Decky log. Installing from Desktop Mode is
supported; return to Gaming Mode afterwards to use the Decky UI. If LACT or
`lactd` is missing, it can guide the user through installing the LACT Flatpak
and enabling its system daemon.

The installer needs sudo/root access. On SteamOS, set a password first with
`passwd` if sudo has not been configured yet. On non-`deck` systems, set
`DECK_HOME` and `DECK_USER` if the Decky homebrew directory is not under
`/home/deck`.

When SteamOS readonly mode blocks system service or AMD overdrive files, the
installer temporarily disables readonly mode for that operation and enables it
again afterwards. Users should not need to leave SteamOS readonly mode disabled.

If AMD OverDrive was not already active in the running kernel, a reboot can be
required before voltage/clock tuning works in Gaming Mode. This is normal: the
installer can restore the kernel option and regenerate initramfs, but the
running kernel does not pick that up until the next boot.

Manual build/install is also possible from `decky/`.

Install the SteamOS persistence helper from `persistence/`:

```bash
cd persistence
sudo ./install.sh
```

See the README in each subdirectory for details.

## Uninstall

One-command uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/Twsts/steamos-lact-toolkit/master/uninstall.sh | bash
```

The uninstaller removes the Decky plugin and the SteamOS LACT Toolkit
persistence helper:

- `${DECK_HOME}/homebrew/plugins/steamos-lact-toolkit`
- `/etc/systemd/system/steamos-lact-restore.service`
- `/etc/systemd/system/steamos-lact-restore.timer`
- `/etc/atomic-update.conf.d/steamos-lact-toolkit.conf`
- `/etc/steamos-lact-toolkit`
- `/var/lib/steamos-lact-toolkit/reboot-required`

It does not remove LACT itself, `lactd.service`, `/etc/lact`, or AMD OverDrive
kernel settings. Those may be used by LACT Desktop or other tooling.
