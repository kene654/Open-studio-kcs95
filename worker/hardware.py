from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from threading import Lock

GPU_PAUSE_C = int(os.environ.get("OPEN_STUDIO_GPU_PAUSE_C", "80"))
GPU_RESUME_C = int(os.environ.get("OPEN_STUDIO_GPU_RESUME_C", "68"))
CPU_PAUSE_C = int(os.environ.get("OPEN_STUDIO_CPU_PAUSE_C", "88"))
CPU_RESUME_C = int(os.environ.get("OPEN_STUDIO_CPU_RESUME_C", "75"))
POLL_SECONDS = float(os.environ.get("OPEN_STUDIO_THERMAL_POLL", "3"))

_lock = Lock()
_cpu_sample: tuple[int, int] | None = None
_hw_cache: tuple[float, dict] | None = None
_thermal = {
    "paused": False,
    "reason": None,
    "component": None,
    "temp_c": None,
    "resume_c": None,
}


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _read_cpu_times() -> tuple[int, int] | None:
    try:
        parts = Path("/proc/stat").read_text().splitlines()[0].split()
        values = [int(item) for item in parts[1:]]
    except (OSError, ValueError, IndexError):
        return None
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return sum(values), idle


def _cpu_percent() -> float | None:
    global _cpu_sample
    current = _read_cpu_times()
    if current is None:
        return None
    previous = _cpu_sample
    _cpu_sample = current
    if previous is None:
        time.sleep(0.12)
        current = _read_cpu_times()
        if current is None:
            return None
        previous = _cpu_sample
        _cpu_sample = current
    total_delta = current[0] - previous[0]
    idle_delta = current[1] - previous[1]
    if total_delta <= 0:
        return 0.0
    return max(0.0, min(100.0, round((1.0 - idle_delta / total_delta) * 100.0, 1)))


def _memory() -> dict:
    info: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, raw = line.split(":", 1)
            info[key] = int(raw.strip().split()[0])
    except (OSError, ValueError):
        return {"used_gb": None, "total_gb": None, "percent": None}
    total = info.get("MemTotal")
    available = info.get("MemAvailable")
    if not total:
        return {"used_gb": None, "total_gb": None, "percent": None}
    used = total - (available if available is not None else info.get("MemFree", 0))
    return {
        "used_gb": round(used / 1024 / 1024, 1),
        "total_gb": round(total / 1024 / 1024, 1),
        "percent": round(used / total * 100.0, 1),
    }


def _read_hwmon_temp() -> float | None:
    preferred = ("k10temp", "zenpower", "coretemp", "cpu_thermal")
    temps: list[float] = []
    fallback: list[float] = []
    hwmon = Path("/sys/class/hwmon")
    if not hwmon.exists():
        return _thermal_zone_temp()
    for node in hwmon.glob("hwmon*"):
        name = (_read_text(node / "name") or "").lower()
        values = []
        for probe in node.glob("temp*_input"):
            raw = _read_text(probe)
            if not raw:
                continue
            try:
                celsius = int(raw) / 1000.0
            except ValueError:
                continue
            if 0 < celsius < 125:
                values.append(celsius)
        if not values:
            continue
        highest = max(values)
        if name in preferred:
            temps.append(highest)
        else:
            fallback.append(highest)
    if temps:
        return round(max(temps), 1)
    if fallback:
        return round(max(fallback), 1)
    return _thermal_zone_temp()


def _thermal_zone_temp() -> float | None:
    best = None
    root = Path("/sys/class/thermal")
    if not root.exists():
        return None
    for zone in root.glob("thermal_zone*"):
        kind = (_read_text(zone / "type") or "").lower()
        raw = _read_text(zone / "temp")
        if not raw:
            continue
        try:
            celsius = int(raw) / 1000.0
        except ValueError:
            continue
        if not (0 < celsius < 125):
            continue
        if any(token in kind for token in ("cpu", "x86", "k10", "soc")):
            return round(celsius, 1)
        best = celsius if best is None else max(best, celsius)
    return round(best, 1) if best is not None else None


def _gpu() -> dict:
    empty = {
        "name": None,
        "util": None,
        "temp_c": None,
        "vram_used_gb": None,
        "vram_total_gb": None,
    }
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=1.5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return empty
    line = (result.stdout or "").strip().splitlines()
    if not line:
        return empty
    parts = [part.strip() for part in line[0].split(",")]
    if len(parts) < 5:
        return empty

    def number(value: str) -> float | None:
        try:
            return float(value)
        except ValueError:
            return None

    used = number(parts[2])
    total = number(parts[3])
    return {
        "name": parts[0] or None,
        "util": number(parts[1]),
        "temp_c": number(parts[4]),
        "vram_used_gb": round(used / 1024.0, 1) if used is not None else None,
        "vram_total_gb": round(total / 1024.0, 1) if total is not None else None,
    }


def snapshot(force: bool = False) -> dict:
    global _hw_cache
    now = time.monotonic()
    if not force and _hw_cache and now - _hw_cache[0] < 1.0:
        return _hw_cache[1]
    with _lock:
        if not force and _hw_cache and now - _hw_cache[0] < 1.0:
            return _hw_cache[1]
        gpu = _gpu()
        payload = {
            "cpu": {"percent": _cpu_percent(), "temp_c": _read_hwmon_temp()},
            "memory": _memory(),
            "gpu": gpu,
            "thermal": dict(_thermal),
            "limits": {
                "gpu_pause_c": GPU_PAUSE_C,
                "gpu_resume_c": GPU_RESUME_C,
                "cpu_pause_c": CPU_PAUSE_C,
                "cpu_resume_c": CPU_RESUME_C,
            },
        }
        _hw_cache = (time.monotonic(), payload)
        return payload


def _hot_reason(hw: dict, pause: bool) -> tuple[str, str, float, int] | None:
    gpu_temp = hw.get("gpu", {}).get("temp_c")
    cpu_temp = hw.get("cpu", {}).get("temp_c")
    gpu_limit = GPU_PAUSE_C if pause else GPU_RESUME_C
    cpu_limit = CPU_PAUSE_C if pause else CPU_RESUME_C
    if gpu_temp is not None and gpu_temp >= gpu_limit:
        return "gpu", "GPU", float(gpu_temp), GPU_RESUME_C
    if cpu_temp is not None and cpu_temp >= cpu_limit:
        return "cpu", "CPU", float(cpu_temp), CPU_RESUME_C
    return None


def thermal_state() -> dict:
    return dict(_thermal)


def _set_thermal(paused: bool, reason: str | None = None, component: str | None = None, temp_c: float | None = None, resume_c: int | None = None) -> None:
    _thermal.update(
        {
            "paused": paused,
            "reason": reason,
            "component": component,
            "temp_c": temp_c,
            "resume_c": resume_c,
        }
    )


def wait_if_hot(job: dict | None = None) -> bool:
    entered = False
    previous_step = job.get("step") if job else None
    previous_status = job.get("status") if job else None
    while True:
        hw = snapshot(force=True)
        hot = _hot_reason(hw, pause=not entered)
        if hot:
            component_id, label, temp_c, resume_c = hot
            entered = True
            reason = f"{label} {round(temp_c)}°C"
            _set_thermal(True, reason, component_id, temp_c, resume_c)
            if job is not None:
                job["status"] = "paused"
                job["step"] = f"Paused — cooling {reason}"
            time.sleep(POLL_SECONDS)
            continue
        if entered:
            still_warm = _hot_reason(hw, pause=False)
            if still_warm:
                component_id, label, temp_c, resume_c = still_warm
                reason = f"{label} {round(temp_c)}°C"
                _set_thermal(True, reason, component_id, temp_c, resume_c)
                if job is not None:
                    job["status"] = "paused"
                    job["step"] = f"Paused — cooling {reason}"
                time.sleep(POLL_SECONDS)
                continue
        _set_thermal(False)
        if job is not None and entered:
            job["status"] = previous_status or "in_progress"
            if previous_step:
                job["step"] = previous_step
        return entered
