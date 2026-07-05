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
        if response.get("status") != "ok":
            raise RuntimeError(f"{command} failed: {response.get('data')}")
        return response.get("data")

    def _profile_config(self, profile_id: str) -> dict:
        for custom in self._load_custom_profiles():
            if custom.get("id") == profile_id:
                return self._sanitize_config(custom.get("config") or {})
        raise ValueError(f"Unknown profile: {profile_id}")

    def _profile_summaries(self) -> list[dict]:
        return [
            {
                "id": custom["id"],
                "name": custom["name"],
                "power_cap": custom["config"]["power_cap"],
                "voltage_offset": custom["config"]["voltage_offset"],
                "max_memory_clock": custom["config"]["max_memory_clock"],
                "custom": True,
            }
            for custom in self._load_custom_profiles()
        ]

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
            "fan_control_enabled": False,
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
                    "fan_control_enabled": bool(config.get("fan_control_enabled", False)),
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

    def _config_matches(self, config, desired) -> bool:
        if not isinstance(config, dict):
            return False
        for key, value in desired.items():
            if key == "pmfw_options":
                if (config.get("pmfw_options") or {}).get("zero_rpm") is not True:
                    return False
            elif config.get(key) != value:
                return False
        return True

    def _detect_profile(self, config) -> str | None:
        for custom in self._load_custom_profiles():
            if self._config_matches(config, custom["config"]):
                return custom["id"]
        return None

    def _select_gpu(self, devices: list[dict]) -> dict | None:
        if not isinstance(devices, list):
            return None
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

            system_info = await self._lact_request("system_info")
            config = await self._lact_request("get_gpu_config", {"id": gpu_id})
            stats = await self._lact_request("device_stats", {"id": gpu_id})
            clocks_info = await self._lact_request("device_clocks_info", {"id": gpu_id})

            current_profile = self._detect_profile(config)
            desired = self._profile_config(current_profile) if current_profile else self._sanitize_config(config)
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
                title = "Unsaved preset"
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
                "profiles": self._profile_summaries(),
                "profile_ok": profile_ok,
                "overdrive_ok": overdrive_ok,
                "applied_ok": applied_ok,
                "applied": applied,
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

    async def restore_profile(self) -> dict:
        return await self.get_status()

    async def apply_profile(self, profile_id: str) -> dict:
        try:
            desired = self._profile_config(str(profile_id))
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
            config = self._sanitize_config(current)
            config["power_cap"] = float(safe_watts)
            await self._lact_request("set_gpu_config", {"id": gpu_id, "config": config})
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

    async def _main(self):
        decky.logger.info("SteamOS LACT Toolkit plugin loaded")

    async def _unload(self):
        decky.logger.info("SteamOS LACT Toolkit plugin unloading")

    async def _uninstall(self):
        decky.logger.info("SteamOS LACT Toolkit plugin uninstalled")
