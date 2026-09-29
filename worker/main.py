from __future__ import annotations

import json
import multiprocessing
import os
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock, Thread

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from catalog import CATALOG
from engine import OUTPUT_DIR, PROGRESS_DIR, UPLOAD_DIR, device_info, isolated_run
from hardware import snapshot

app = FastAPI(title="Open-Studio Worker", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
PROGRESS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/outputs", StaticFiles(directory=OUTPUT_DIR), name="outputs")

JOBS_FILE = Path(__file__).resolve().parent / "jobs.json"
jobs: dict[str, dict] = {}
lock = Lock()
busy = False
running_procs: dict[str, multiprocessing.Process] = {}
LIVE_STATUSES = {"queued", "loading_model", "in_progress", "paused", "saving", "downloading"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def public_job(job: dict) -> dict:
    skip = {"input", "timing", "cancel"}
    return {k: v for k, v in job.items() if k not in skip}


def persist_jobs() -> None:
    payload = []
    for job in jobs.values():
        item = public_job(job)
        raw = dict(job.get("input") or {})
        raw.pop("reference_bytes", None)
        if not raw.get("prompt"):
            raw["prompt"] = job.get("prompt") or ""
        item["input"] = raw
        payload.append(item)
    JOBS_FILE.write_text(json.dumps(payload, indent=2))


def load_jobs() -> None:
    if not JOBS_FILE.exists():
        return
    try:
        saved = json.loads(JOBS_FILE.read_text())
    except json.JSONDecodeError:
        return
    for item in saved:
        if item.get("id"):
            jobs[item["id"]] = item


def recover_jobs() -> None:
    global busy
    resumed = False
    for job in jobs.values():
        if job.get("status") == "cancelled" or job.get("cancel"):
            job["status"] = "cancelled"
            job["cancel"] = True
            job["step"] = job.get("step") or "Stopped"
            continue
        if job.get("status") in {"loading_model", "in_progress", "paused"} or (
            job.get("status") == "failed" and "wait_if_hot" in str(job.get("error") or "")
        ):
            job["status"] = "queued"
            job["step"] = "Queued · resumed after worker restart"
            job["error"] = None
            job["progress"] = 0
            job["etaLabel"] = "Estimating time…"
            if not isinstance(job.get("input"), dict):
                job["input"] = {}
            if not job["input"].get("prompt"):
                job["input"]["prompt"] = job.get("prompt") or ""
            resumed = True
    if resumed:
        persist_jobs()
    if any(job.get("status") == "queued" for job in jobs.values()):
        busy = True
        Thread(target=worker_loop, daemon=True).start()


def catalog_for(kind: str) -> list[dict]:
    return CATALOG.get(kind) or []


def find_model(kind: str, model_id: str) -> dict | None:
    return next((item for item in catalog_for(kind) if item["id"] == model_id), None)


@app.get("/api/health")
def health():
    info = device_info()
    hardware = snapshot()
    queued = sum(1 for job in jobs.values() if job.get("status") in LIVE_STATUSES)
    return {
        "ok": True,
        "product": "Open-Studio",
        "studio": "kenstudios95.com",
        **info,
        "hardware": hardware,
        "thermal": hardware.get("thermal") or {},
        "busy": busy,
        "queue": queued,
        "capabilities": ["video", "audio", "image"],
    }


@app.get("/api/models")
def models():
    return CATALOG


@app.get("/api/jobs")
def list_jobs():
    return sorted((public_job(job) for job in jobs.values()), key=lambda item: item.get("createdAt") or "", reverse=True)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return public_job(job)


def enqueue_job(kind: str, model_id: str, payload_input: dict) -> dict:
    global busy
    model = find_model(kind, model_id)
    if not model:
        raise HTTPException(400, "Unknown model")
    prompt = str(payload_input.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "A positive prompt is required")
    job = {
        "id": str(uuid.uuid4()),
        "kind": kind,
        "modelId": model_id,
        "modelName": model["name"],
        "prompt": prompt,
        "input": payload_input,
        "status": "queued",
        "progress": 0,
        "step": "Queued",
        "etaSeconds": 30,
        "etaLabel": "Estimating time…",
        "createdAt": now(),
        "updatedAt": now(),
    }
    with lock:
        jobs[job["id"]] = job
        persist_jobs()
        if not busy:
            busy = True
            Thread(target=worker_loop, daemon=True).start()
    return public_job(job)


@app.post("/api/jobs", status_code=202)
async def create_job(request: Request):
    content_type = request.headers.get("content-type") or ""
    if "multipart/form-data" in content_type:
        form = await request.form()
        kind = str(form.get("kind") or "")
        model_id = str(form.get("modelId") or "")
        raw_input = form.get("input") or "{}"
        payload_input = json.loads(str(raw_input)) if isinstance(raw_input, str) else {}
        upload = form.get("reference")
        if upload is not None and hasattr(upload, "filename") and upload.filename:
            suffix = Path(str(upload.filename)).suffix or ".bin"
            dest = UPLOAD_DIR / f"{uuid.uuid4()}{suffix}"
            dest.write_bytes(await upload.read())
            payload_input["referencePath"] = str(dest)
            payload_input["referenceName"] = upload.filename
    else:
        body = await request.json()
        kind = str(body.get("kind") or "")
        model_id = str(body.get("modelId") or "")
        payload_input = dict(body.get("input") or {})
    return enqueue_job(kind, model_id, payload_input)


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _merge_progress(job: dict) -> None:
    data = _read_json(PROGRESS_DIR / f"{job['id']}.json")
    if not data:
        return
    for key in ("progress", "step", "etaSeconds", "etaLabel", "referenceMode", "updatedAt"):
        if key in data and data[key] is not None:
            job[key] = data[key]
    if not job.get("cancel") and data.get("status"):
        job["status"] = data["status"]


def _kill_process(job_id: str) -> None:
    proc = running_procs.get(job_id)
    if not proc:
        return
    if proc.is_alive():
        proc.terminate()
        proc.join(8)
    if proc.is_alive():
        proc.kill()
        proc.join(3)
    running_procs.pop(job_id, None)


def mark_cancelled(job: dict) -> None:
    job["cancel"] = True
    job["status"] = "cancelled"
    job["step"] = "Stopped"
    job["error"] = None
    job["etaSeconds"] = None
    job["etaLabel"] = "Stopped"
    job["updatedAt"] = now()
    _kill_process(job["id"])


def _cleanup_job_files(job: dict) -> None:
    for path in (
        PROGRESS_DIR / f"{job['id']}.json",
        PROGRESS_DIR / f"{job['id']}.result.json",
    ):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
    local = str(job.get("localFile") or "")
    if local.startswith("/outputs/"):
        dest = OUTPUT_DIR / Path(local).name
        try:
            dest.unlink(missing_ok=True)
        except OSError:
            pass
    for name in (f"image-{job['id']}.png", f"video-{job['id']}.mp4", f"audio-{job['id']}.wav"):
        try:
            (OUTPUT_DIR / name).unlink(missing_ok=True)
        except OSError:
            pass


def worker_loop() -> None:
    global busy
    ctx = multiprocessing.get_context("spawn")
    try:
        while True:
            with lock:
                nxt = next((job for job in jobs.values() if job.get("status") == "queued" and not job.get("cancel")), None)
                if not nxt:
                    busy = False
                    persist_jobs()
                    return
                nxt["status"] = "loading_model"
                nxt["progress"] = 5
                nxt["step"] = "Loading model"
                nxt["updatedAt"] = now()
                persist_jobs()
            if nxt.get("cancel"):
                with lock:
                    mark_cancelled(nxt)
                    persist_jobs()
                continue
            result_path = PROGRESS_DIR / f"{nxt['id']}.result.json"
            try:
                result_path.unlink(missing_ok=True)
            except OSError:
                pass
            nxt["status"] = "in_progress"
            nxt["progress"] = 8
            nxt["step"] = "Starting generation"
            nxt["updatedAt"] = now()
            persist_jobs()
            snapshot = json.loads(json.dumps({k: v for k, v in nxt.items() if k != "timing"}))
            proc = ctx.Process(target=isolated_run, args=(snapshot, str(result_path)), daemon=True)
            running_procs[nxt["id"]] = proc
            proc.start()
            while proc.is_alive():
                if nxt.get("cancel"):
                    _kill_process(nxt["id"])
                    break
                _merge_progress(nxt)
                persist_jobs()
                time.sleep(0.4)
            proc.join(2)
            running_procs.pop(nxt["id"], None)
            if nxt["id"] not in jobs:
                continue
            result = _read_json(result_path)
            try:
                result_path.unlink(missing_ok=True)
            except OSError:
                pass
            if nxt.get("cancel") or result.get("cancelled"):
                mark_cancelled(nxt)
            elif result.get("ok") and result.get("file"):
                dest = Path(str(result["file"]))
                nxt["localFile"] = f"/outputs/{dest.name}"
                nxt["status"] = "completed"
                nxt["progress"] = 100
                nxt["step"] = "Done"
                nxt["etaSeconds"] = 0
                nxt["etaLabel"] = "Done"
                nxt["updatedAt"] = now()
            else:
                nxt["status"] = "failed"
                nxt["error"] = str(result.get("error") or "Worker process exited")
                nxt["updatedAt"] = now()
            persist_jobs()
    except Exception:
        traceback.print_exc()
    finally:
        with lock:
            if any(job.get("status") == "queued" and not job.get("cancel") for job in jobs.values()):
                busy = True
                Thread(target=worker_loop, daemon=True).start()
            else:
                busy = False
                persist_jobs()


@app.post("/api/jobs/{job_id}/stop")
def stop_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.get("status") in {"completed", "failed", "cancelled"}:
        return public_job(job)
    with lock:
        mark_cancelled(job)
        persist_jobs()
    return public_job(job)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    with lock:
        if job.get("status") in LIVE_STATUSES:
            mark_cancelled(job)
        _cleanup_job_files(job)
        jobs.pop(job_id, None)
        persist_jobs()
    return {"ok": True, "id": job_id}


load_jobs()
recover_jobs()
