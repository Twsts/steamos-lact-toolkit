import asyncio
import copy
import json
import os
import socket
from pathlib import Path

import decky


SOCKET_PATH = "/run/lactd.sock"
APP_ID = "steamos-lact-toolkit"


class Plugin:
    def __init__(self):
        self._home = Path(os.environ.get("SUDO_USER_HOME", "/home/deck"))
        if not self._home.exists():
            self._home = Path.home()
        self._profiles_path = self._home / ".config" / APP_ID / "profiles.json"

    async def _lact_request(self, command: str, args=None) -> dict:
        return await asyncio.to_thread(self._lact_request_sync, command, args)

    def _lact_request_sync(self, command: str, args=None):
        payload = {"command": command}
        if args is not None:
            payload["args"] = args

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(5)
            client.connect(SOCKET_PATH)
            client.sendall(json.dumps(payload).encode("utf-8") + b"\n")
            chunks = []
            response = None
            while True:
                chunk = client.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                try:
                    response = json.loads(b"".join(chunks).decode("utf-8"))
                    break
                except json.JSONDecodeError:
                    continue

        if response is None:
            response = json.loads(b"".join(chunks).decode("utf-8"))
        if not isinstance(response, dict):
            raise RuntimeError(f"{command} returned invalid response: {type(response).__name__}")
        if response.get("status") != "ok":
            raise RuntimeError(f"{command} failed: {response.get('data')}")
        return response.get("data")

    def _profile_config(self, profile_id: str) -> dict:
        for custom in self._load_custom_profiles():
            if custom.get("id") == profile_id:
                return self._sanitize_config(custom.get("config") or {})
        raise ValueError(f"Unknown profile: {profile_id}")

    def _profile_summaries(self, lact_profiles: dict | None, gpu_id: str) -> list[dict]:
        profiles = []
        for name, profile in (lact_profiles or {}).items():
            if not isinstance(profile, dict):
                decky.logger.warning("Skipping invalid LACT profile %r: %s", name, type(profile).__name__)
                continue
            config = (profile.get("gpus") or {}).get(gpu_id)
            if not isinstance(config, dict):
                continue
            profiles.append(
                {
                    "id": f"lact:{name}",
                    "name": name,
                    "source": "lact",
                    "power_cap": config.get("power_cap"),
                    "voltage_offset": config.get("voltage_offset"),
                    "max_memory_clock": config.get("max_memory_clock"),
                    "custom": False,
                }
            )
        profiles.extend(
            {
                "id": custom["id"],
                "name": custom["name"],
                "source": "toolkit",
                "power_cap": custom["config"]["power_cap"],
                "voltage_offset": custom["config"]["voltage_offset"],
                "max_memory_clock": custom["config"]["max_memory_clock"],
                "custom": True,
            }
            for custom in self._load_custom_profiles()
        )
        return profiles

    def _load_custom_profiles(self) -> list[dict]:
        try:
            data = json.loads(self._profiles_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (json.JSONDecodeError, OSError):
            decky.logger.exception("Failed to read custom LACT profiles")
            return []
        if not isinstance(data, list):
            return []
        profiles = []
        for entry in data:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name") or "").strip()[:40]
            profile_id = str(entry.get("id") or "").strip()
            config = entry.get("config")
            if not name or not profile_id.startswith("custom:") or not isinstance(config, dict):
                continue
            profiles.append({"id": profile_id, "name": name, "config": self._sanitize_config(config)})
        return profiles

    def _save_custom_profiles(self, profiles: list[dict]) -> None:
        self._profiles_path.parent.mkdir(parents=True, exist_ok=True)
        self._profiles_path.write_text(json.dumps(profiles, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def _sanitize_config(self, config) -> dict:
        base = {
            "pmfw_options": {"zero_rpm": True},
            "power_cap": 0.0,
            "performance_level": "auto",
            "max_memory_clock": 0,
            "voltage_offset": 0,
        }
        if isinstance(config, dict):
            base.update(
                {
                    "power_cap": float(max(0, min(int(config.get("power_cap", base["power_cap"])), 1000))),
                    "performance_level": str(config.get("performance_level") or "auto"),
                    "max_memory_clock": int(max(0, min(int(config.get("max_memory_clock", base["max_memory_clock"])), 5000))),
                    "voltage_offset": int(max(-300, min(int(config.get("voltage_offset", base["voltage_offset"])), 300))),
                }
            )
            pmfw = dict(base.get("pmfw_options") or {})
            pmfw["zero_rpm"] = bool((config.get("pmfw_options") or {}).get("zero_rpm", pmfw.get("zero_rpm", True)))
            base["pmfw_options"] = pmfw
        return base

    def _merge_config(self, current, desired):
        merged = dict(current or {})
        pmfw = dict(merged.get("pmfw_options") or {})
        pmfw.update(desired["pmfw_options"])
        merged.update(desired)
        merged["pmfw_options"] = pmfw
        return merged

    def _fan_control_args(self, gpu_id: str, current: dict, stats: dict, fan_config: dict) -> dict:
        current = current or {}
        stats = stats or {}
        fan_config = fan_config or {}
        settings = current.get("fan_control_settings") or {}
        fan_stats = stats.get("fan") or {}

        requested_mode = str(fan_config.get("mode") or settings.get("mode") or fan_stats.get("control_mode") or "static").lower()
        enabled = False if requested_mode == "automatic" else bool(fan_config.get("enabled", True))
        mode = requested_mode if requested_mode in ("static", "curve") else "static"

        raw_static_speed = fan_config.get("static_speed", settings.get("static_speed", fan_stats.get("static_speed", 0.5)))
        if raw_static_speed is None:
            raw_static_speed = 0.5
        static_speed = max(0.0, min(float(raw_static_speed), 1.0))
        zero_rpm = bool(fan_config.get("zero_rpm", (current.get("pmfw_options") or {}).get("zero_rpm", True)))

        args = {
            "id": gpu_id,
            "enabled": enabled,
            "pmfw": {"zero_rpm": zero_rpm},
        }
        if enabled:
            args["mode"] = mode
            if mode == "static":
                args["static_speed"] = static_speed
            else:
                curve = settings.get("curve") or fan_stats.get("curve")
                if curve:
                    args["curve"] = curve
                for key in ("spindown_delay_ms", "change_threshold"):
                    if settings.get(key) is not None:
                        args[key] = settings[key]
        return args

    def _config_matches(self, config, desired) -> bool:
        if not isinstance(config, dict):
            return False
        for key, value in desired.items():
            if key == "pmfw_options":
                if (config.get("pmfw_options") or {}).get("zero_rpm") != (value or {}).get("zero_rpm"):
                    return False
            elif config.get(key) != value:
                return False
        return True

    def _detect_profile(self, config, lact_profiles: dict | None = None, gpu_id: str | None = None) -> str | None:
        if gpu_id:
            for name, profile in (lact_profiles or {}).items():
                if not isinstance(profile, dict):
                    continue
                lact_config = (profile.get("gpus") or {}).get(gpu_id)
                if isinstance(lact_config, dict) and self._config_matches(config, self._sanitize_config(lact_config)):
                    return f"lact:{name}"
        for custom in self._load_custom_profiles():
            if self._config_matches(config, custom["config"]):
                return custom["id"]
        return None

    def _select_gpu(self, devices: list[dict]) -> dict | None:
        if not isinstance(devices, list):
            return None
        devices = [device for device in devices if isinstance(device, dict)]
        dedicated = next((device for device in devices if device.get("id") and device.get("device_type") == "Dedicated"), None)
        if dedicated:
            return dedicated
        return next((device for device in devices if device.get("id") and device.get("device_type") != "Integrated"), None) or next(
            (device for device in devices if device.get("id")),
            None,
        )

    def _read_text(self, path: Path, limit: int = 4000) -> str:
        try:
            return path.read_text(encoding="utf-8", errors="replace")[-limit:]
        except FileNotFoundError:
            return ""

    def _as_dict(self, value) -> dict:
        return value if isinstance(value, dict) else {}

    async def get_status(self) -> dict:
        try:
            decky.logger.info("SteamOS LACT Toolkit get_status start")
            if not Path(SOCKET_PATH).exists():
                return {"ok": False, "level": "error", "error": f"{SOCKET_PATH} missing"}

            devices = await self._lact_request("list_devices")
            gpu = self._select_gpu(devices)
            if not gpu:
                return {"ok": False, "level": "error", "error": "No LACT GPU device found", "devices": devices}
            gpu_id = gpu["id"]

            system_info = self._as_dict(await self._lact_request("system_info"))
            lact_profile_state = await self._list_lact_profiles()
            lact_profiles = lact_profile_state.get("profiles") or {}
            config = self._as_dict(await self._lact_request("get_gpu_config", {"id": gpu_id}))
            stats = self._as_dict(await self._lact_request("device_stats", {"id": gpu_id}))
            clocks_info = self._as_dict(await self._lact_request("device_clocks_info", {"id": gpu_id}))

            current_profile = self._detect_profile(config, lact_profiles, gpu_id)
            desired = self._config_for_profile_id(current_profile, lact_profiles, gpu_id) if current_profile else self._sanitize_config(config)
            profile_ok = True
            overdrive_ok = system_info.get("amdgpu_overdrive_enabled") is True
            applied = self._applied_values(stats, clocks_info)
            applied_ok = (
                applied.get("power_cap") == desired["power_cap"]
                and applied.get("max_memory_clock") == desired["max_memory_clock"]
                and applied.get("voltage_offset") == desired["voltage_offset"]
            )
            level = "ok" if profile_ok and overdrive_ok and applied_ok else "warn"
            if not overdrive_ok:
                title = "Undervolt inactive"
            elif not applied_ok:
                title = "Runtime mismatch"
            elif not current_profile:
                title = "Current LACT config"
            else:
                title = "Ready"

            payload = {
                "ok": True,
                "level": level,
                "title": title,
                "gpu_id": gpu_id,
                "gpu_name": gpu.get("name") or gpu_id,
                "gpu_type": gpu.get("device_type"),
                "system": system_info,
                "config": config,
                "desired": desired,
                "current_profile": current_profile or "custom",
                "profiles": self._profile_summaries(lact_profiles, gpu_id),
                "lact_current_profile": lact_profile_state.get("current_profile"),
                "lact_auto_switch": lact_profile_state.get("auto_switch"),
                "profile_ok": profile_ok,
                "overdrive_ok": overdrive_ok,
                "applied_ok": applied_ok,
                "applied": applied,
                "limits": self._limits(stats, clocks_info),
                "stats": {
                    "clockspeed": stats.get("clockspeed", {}),
                    "voltage": stats.get("voltage", {}),
                    "power": stats.get("power", {}),
                    "temps": stats.get("temps", {}),
                    "fan": stats.get("fan", {}),
                    "busy_percent": stats.get("busy_percent"),
                    "performance_level": stats.get("performance_level"),
                    "throttle_info": stats.get("throttle_info", {}),
                },
            }
            decky.logger.info("SteamOS LACT Toolkit get_status done level=%s", level)
            return payload
        except Exception as exc:
            decky.logger.exception("SteamOS LACT Toolkit status failed")
            return {"ok": False, "level": "error", "error": str(exc)}

    def _applied_values(self, stats: dict, clocks_info: dict) -> dict:
        stats = self._as_dict(stats)
        clocks_info = self._as_dict(clocks_info)
        table = ((clocks_info or {}).get("table") or {}).get("value") or {}
        data = table.get("data") or {}
        mclk_range = data.get("current_mclk_range") or {}
        return {
            "power_cap": (stats.get("power") or {}).get("cap_current"),
            "performance_level": stats.get("performance_level"),
            "max_memory_clock": clocks_info.get("max_mclk") or mclk_range.get("max"),
            "voltage_offset": data.get("voltage_offset"),
            "zero_rpm": ((stats.get("fan") or {}).get("pmfw_info") or {}).get("zero_rpm_enable"),
            "gpu_voltage": (stats.get("voltage") or {}).get("gpu"),
            "vram_clock": (stats.get("clockspeed") or {}).get("vram_clockspeed"),
        }

    def _limits(self, stats: dict, clocks_info: dict) -> dict:
        stats = self._as_dict(stats)
        clocks_info = self._as_dict(clocks_info)
        table = ((clocks_info or {}).get("table") or {}).get("value") or {}
        data = table.get("data") or {}
        od_range = data.get("od_range") or {}
        mclk = od_range.get("mclk") or {}
        voltage_offset = od_range.get("voltage_offset") or {}
        power = stats.get("power") or {}
        return {
            "power_cap": {
                "min": power.get("cap_min"),
                "max": power.get("cap_max"),
                "default": power.get("cap_default"),
            },
            "max_memory_clock": {
                "min": mclk.get("min"),
                "max": mclk.get("max") or clocks_info.get("max_mclk"),
            },
            "voltage_offset": {
                "min": voltage_offset.get("min"),
                "max": voltage_offset.get("max"),
            },
        }

    async def restore_profile(self) -> dict:
        return await self.get_status()

    async def apply_profile(self, profile_id: str) -> dict:
        try:
            profile_id = str(profile_id)
            if profile_id.startswith("lact:"):
                await self._lact_request("set_profile", {"name": profile_id.removeprefix("lact:"), "auto_switch": False})
                return await self.get_status()
            desired = self._profile_config(profile_id)
            gpu_id = await self._selected_gpu_id()
            current = await self._lact_request("get_gpu_config", {"id": gpu_id})
            await self._lact_request("set_gpu_config", {"id": gpu_id, "config": self._merge_config(current, desired)})
            await self._lact_request("confirm_pending_config", {"command": "confirm"})
            return await self.get_status()
        except Exception as exc:
            decky.logger.exception("SteamOS LACT Toolkit profile apply failed")
            return {"ok": False, "level": "error", "error": str(exc)}

    async def apply_custom_config(self, config: dict) -> dict:
        try:
            desired = self._sanitize_config(config)
            gpu_id = await self._selected_gpu_id()
            current = await self._lact_request("get_gpu_config", {"id": gpu_id})
            await self._lact_request("set_gpu_config", {"id": gpu_id, "config": self._merge_config(current, desired)})
            await self._lact_request("confirm_pending_config", {"command": "confirm"})
            return await self.get_status()
        except Exception as exc:
            decky.logger.exception("SteamOS LACT Toolkit custom apply failed")
            return {"ok": False, "level": "error", "error": str(exc)}

    async def apply_fan_control(self, fan_config: dict) -> dict:
        try:
            gpu_id = await self._selected_gpu_id()
            current = await self._lact_request("get_gpu_config", {"id": gpu_id})
            stats = await self._lact_request("device_stats", {"id": gpu_id})
            await self._lact_request("set_fan_control", self._fan_control_args(gpu_id, current, stats, fan_config))
            await self._lact_request("confirm_pending_config", {"command": "confirm"})
            return await self.get_status()
        except Exception as exc:
            decky.logger.exception("SteamOS LACT Toolkit fan control failed")
            return {"ok": False, "level": "error", "error": str(exc)}

    async def save_custom_profile(self, name: str, config: dict) -> dict:
        try:
            safe_name = str(name or "").strip()[:40] or "Custom"
            slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in safe_name).strip("-") or "custom"
            profile_id = f"custom:{slug}"
            profiles = [profile for profile in self._load_custom_profiles() if profile.get("id") != profile_id]
            profiles.append({"id": profile_id, "name": safe_name, "config": self._sanitize_config(config)})
            profiles.sort(key=lambda profile: profile["name"].lower())
            self._save_custom_profiles(profiles)
            return await self.apply_profile(profile_id)
        except Exception as exc:
            decky.logger.exception("SteamOS LACT Toolkit custom profile save failed")
            return {"ok": False, "level": "error", "error": str(exc)}

    async def delete_custom_profile(self, profile_id: str) -> dict:
        try:
            profile_id = str(profile_id or "").strip()
            if not profile_id.startswith("custom:"):
                raise ValueError("Only custom profiles can be deleted")
            profiles = [profile for profile in self._load_custom_profiles() if profile.get("id") != profile_id]
            self._save_custom_profiles(profiles)
            current = await self.get_status()
            if current.get("current_profile") == profile_id:
                return await self.get_status()
            return current
        except Exception as exc:
            decky.logger.exception("SteamOS LACT Toolkit custom profile delete failed")
            return {"ok": False, "level": "error", "error": str(exc)}

    async def set_power_cap(self, watts: int) -> dict:
        try:
            safe_watts = max(0, min(int(watts), 1000))
            gpu_id = await self._selected_gpu_id()
            current = await self._lact_request("get_gpu_config", {"id": gpu_id})
            desired = self._sanitize_config(current)
            desired["power_cap"] = float(safe_watts)
            await self._lact_request("set_gpu_config", {"id": gpu_id, "config": self._merge_config(current, desired)})
            await self._lact_request("confirm_pending_config", {"command": "confirm"})
            return await self.get_status()
        except Exception as exc:
            decky.logger.exception("SteamOS LACT Toolkit power cap failed")
            return {"ok": False, "level": "error", "error": str(exc)}

    async def _selected_gpu_id(self) -> str:
        devices = await self._lact_request("list_devices")
        gpu = self._select_gpu(devices)
        if not gpu:
            raise RuntimeError("No LACT GPU device found")
        return gpu["id"]

    async def _list_lact_profiles(self) -> dict:
        try:
            data = await self._lact_request("list_profiles", {"include_state": True})
            return data if isinstance(data, dict) else {}
        except Exception:
            decky.logger.exception("SteamOS LACT Toolkit LACT profile list failed")
            return {}

    def _config_for_profile_id(self, profile_id: str | None, lact_profiles: dict | None, gpu_id: str) -> dict:
        if profile_id and profile_id.startswith("lact:"):
            profile = (lact_profiles or {}).get(profile_id.removeprefix("lact:"))
            config = (profile.get("gpus") or {}).get(gpu_id) if isinstance(profile, dict) else None
            if isinstance(config, dict):
                return self._sanitize_config(config)
        if profile_id:
            return self._profile_config(profile_id)
        raise ValueError("No profile selected")

    async def _main(self):
        decky.logger.info("SteamOS LACT Toolkit plugin loaded")

    async def _unload(self):
        decky.logger.info("SteamOS LACT Toolkit plugin unloading")

    async def _uninstall(self):
        decky.logger.info("SteamOS LACT Toolkit plugin uninstalled")
