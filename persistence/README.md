# SteamOS LACT Toolkit Persistence

SteamOS atomic updates can replace parts of `/etc` and can drop the AMD
overdrive kernel option needed by LACT voltage offset tuning. This helper keeps
the relevant files listed for atomic updates and periodically verifies that the
running kernel still has AMD overdrive enabled.

It preserves:

- `/etc/lact/**`
- `/etc/modprobe.d/99-amdgpu-overdrive.conf`
- `/etc/atomic-update.conf.d/steamos-lact-toolkit.conf`
- `/etc/steamos-lact-toolkit/**`
- the `steamos-lact-restore` systemd service and timer

## Install

```bash
sudo ./install.sh
```

The installer enables the timer and runs the restore check once immediately.

If the service has to restore the kernel option, it regenerates initramfs with
`mkinitcpio -P` and writes:

```text
/var/lib/steamos-lact-toolkit/reboot-required
```

Reboot after that marker appears. The marker is removed automatically once the
running kernel reports AMD overdrive as active.
