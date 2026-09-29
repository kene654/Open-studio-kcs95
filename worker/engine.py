from __future__ import annotations

import gc
import inspect
import json
import os
import time
from pathlib import Path

os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "30")

import numpy as np
import soundfile as sf
import torch
from PIL import Image

from datetime import datetime, timezone
from threading import Event, Thread

from hardware import wait_if_hot

ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "outputs"
UPLOAD_DIR = ROOT / "uploads"
CACHE_DIR = ROOT / "models"
PROGRESS_DIR = ROOT / "progress"


class JobCancelled(Exception):
    pass


DEFAULT_NEGATIVE = (
    "Bright tones, overexposed, static, blurred details, subtitles, watermark, text, "
    "ugly, incomplete, extra fingers, poorly drawn hands, deformed, still picture"
)
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}

_video_pipe = None
_video_offload = None
_image_pipe = None
_tts_pipe = None
_music_pipe = None


def device_info() -> dict:
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        return {
            "device": "cuda",
            "gpu": props.name,
            "vram_gb": round(props.total_memory / 1024**3, 1),
        }
    return {"device": "cpu", "gpu": None, "vram_gb": 0}


def _free_unused() -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()


def _release_models(*names: str) -> None:
    global _video_pipe, _video_offload, _image_pipe, _tts_pipe, _music_pipe
    mapping = {
        "video": "_video_pipe",
        "image": "_image_pipe",
        "tts": "_tts_pipe",
        "music": "_music_pipe",
    }
    for name in names:
        attr = mapping.get(name)
        if attr:
            globals()[attr] = None
        if name == "video":
            _video_offload = None
    _free_unused()


def _is_cuda_oom(error: BaseException) -> bool:
    if isinstance(error, torch.cuda.OutOfMemoryError):
        return True
    text = str(error).lower()
    return "out of memory" in text or "cuda oom" in text


def _format_eta(seconds: float | None) -> str:
    if seconds is None:
        return "Loading model…"
    seconds = max(0, int(seconds))
    if seconds < 20:
        return "Less than 20s left"
    if seconds < 60:
        return f"About {seconds}s left"
    mins, secs = divmod(seconds, 60)
    if mins == 1:
        return f"About 1 min {secs:02d}s left"
    return f"About {mins} min {secs:02d}s left"


def write_progress_sidecar(job: dict) -> None:
    try:
        PROGRESS_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "progress": job.get("progress"),
            "step": job.get("step"),
            "etaSeconds": job.get("etaSeconds"),
            "etaLabel": job.get("etaLabel"),
            "status": job.get("status"),
            "referenceMode": job.get("referenceMode"),
            "updatedAt": job.get("updatedAt"),
        }
        (PROGRESS_DIR / f"{job['id']}.json").write_text(json.dumps(payload))
    except OSError:
        pass


def set_progress(job: dict, percent: int, step: str, step_index: int | None = None, total_steps: int | None = None) -> None:
    if job.get("cancel"):
        raise JobCancelled("Stopped by user")
    job["progress"] = max(0, min(100, int(percent)))
    job["step"] = step
    job["updatedAt"] = datetime.now(timezone.utc).isoformat()
    now = time.monotonic()
    timing = job.setdefault("timing", {})
    timing.setdefault("t0", now)
    elapsed = now - timing["t0"]
    eta = None
    if step_index is not None and total_steps:
        stamps = timing.setdefault("steps", [])
        stamps.append(now)
        if len(stamps) >= 2:
            avg = (stamps[-1] - stamps[0]) / (len(stamps) - 1)
            eta = avg * max(0, total_steps - step_index - 1) + 10
    elif percent >= 15:
        eta = elapsed * (100 - percent) / max(percent, 1)
    if percent >= 100:
        job["etaSeconds"] = 0
        job["etaLabel"] = "Done"
    elif eta is not None:
        job["etaSeconds"] = int(max(0, eta))
        job["etaLabel"] = _format_eta(eta)
    else:
        job["etaSeconds"] = None
        job["etaLabel"] = "Loading model · first run can take several minutes"
    write_progress_sidecar(job)
    wait_if_hot(job)
    if job.get("cancel"):
        raise JobCancelled("Stopped by user")


_WEIGHT_FILES = (
    "diffusion_pytorch_model.safetensors",
    "diffusion_pytorch_model.bin",
    "diffusion_pytorch_model.safetensors.index.json",
    "model.safetensors",
    "model.bin",
    "model.safetensors.index.json",
    "pytorch_model.bin",
)


def _has_weights(folder: Path) -> bool:
    if not folder.is_dir():
        return False
    return any((folder / name).exists() for name in _WEIGHT_FILES)


def _snapshot_ready(repo_id: str) -> bool:
    folder = CACHE_DIR / f"models--{repo_id.replace('/', '--')}"
    snapshots = folder / "snapshots"
    if not snapshots.exists():
        return False
    try:
        blobs = folder / "blobs"
        if blobs.exists() and any(blobs.glob("*.incomplete")):
            return False
    except OSError:
        return False
    for snap in snapshots.iterdir():
        if not snap.is_dir():
            continue
        index_path = snap / "model_index.json"
        if index_path.exists():
            try:
                index = json.loads(index_path.read_text())
            except json.JSONDecodeError:
                continue
            components = [
                key
                for key, value in index.items()
                if isinstance(value, list) and len(value) == 2 and key in {"unet", "vae", "text_encoder", "text_encoder_2", "transformer"}
            ]
            if components and all(_has_weights(snap / name) for name in components):
                return True
            continue
        if _has_weights(snap):
            return True
    return False


def _clear_stale_incomplete(repo_id: str, max_age: float = 45) -> None:
    blobs = CACHE_DIR / f"models--{repo_id.replace('/', '--')}" / "blobs"
    if not blobs.exists():
        return
    now = time.time()
    for path in blobs.glob("*.incomplete"):
        try:
            if now - path.stat().st_mtime > max_age:
                path.unlink()
        except OSError:
            continue


def _ensure_repo(repo_id: str, force: bool = False) -> None:
    _clear_stale_incomplete(repo_id)
    if not force and _snapshot_ready(repo_id):
        return
    from huggingface_hub import snapshot_download

    snapshot_download(repo_id=repo_id, cache_dir=str(CACHE_DIR), resume_download=True)


def _missing_weight_error(error: BaseException) -> bool:
    text = str(error).lower()
    return "no file named" in text or "does not appear to have a file named" in text or "cannot find the required files" in text


def _from_pretrained(loader, repo_id: str, **kwargs):
    kwargs.setdefault("cache_dir", CACHE_DIR)
    kwargs.setdefault("low_cpu_mem_usage", True)
    _ensure_repo(repo_id)
    local = _snapshot_ready(repo_id)
    try:
        return loader(repo_id, local_files_only=local, **kwargs)
    except Exception as error:
        if not _missing_weight_error(error):
            raise
        _clear_stale_incomplete(repo_id, max_age=0)
        _ensure_repo(repo_id, force=True)
        return loader(repo_id, local_files_only=False, **kwargs)


def _watch_load(job: dict, label: str) -> Event:
    stop = Event()

    def loop() -> None:
        while not stop.wait(2.5):
            if job.get("cancel"):
                return
            set_progress(job, max(8, int(job.get("progress") or 8)), label)

    Thread(target=loop, daemon=True).start()
    return stop


def write_wav(dest: Path, waveform, sample_rate: int) -> None:
    audio = np.asarray(waveform)
    if audio.ndim > 1:
        audio = np.squeeze(audio)
        if audio.ndim > 1:
            audio = np.mean(audio, axis=0)
    audio = audio.astype(np.float64)
    peak = float(np.max(np.abs(audio)) or 1.0)
    audio = np.clip(audio / peak, -1.0, 1.0)
    pcm = (audio * 32767.0).astype(np.int16)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sf.write(dest, pcm, int(sample_rate), subtype="PCM_16")


def _fit_image(image: Image.Image, width: int, height: int) -> Image.Image:
    image = image.convert("RGB")
    src_w, src_h = image.size
    scale = max(width / src_w, height / src_h)
    resized = image.resize((max(1, int(src_w * scale)), max(1, int(src_h * scale))), Image.Resampling.LANCZOS)
    left = max(0, (resized.width - width) // 2)
    top = max(0, (resized.height - height) // 2)
    return resized.crop((left, top, left + width, top + height))


def load_reference(path: str | None, width: int, height: int) -> Image.Image | None:
    if not path:
        return None
    source = Path(path)
    if not source.exists():
        return None
    if source.suffix.lower() in VIDEO_EXTS:
        import imageio.v2 as imageio

        reader = imageio.get_reader(str(source))
        try:
            frame = reader.get_data(0)
        finally:
            reader.close()
        image = Image.fromarray(np.asarray(frame)).convert("RGB")
    else:
        image = Image.open(source).convert("RGB")
    return _fit_image(image, width, height)


def _video_attempts(duration: int, aspect: str, vram_gb: float) -> list[dict]:
    tight = not vram_gb or vram_gb < 10
    frames = ({2: 25, 3: 33, 4: 41, 5: 49} if tight else {2: 33, 3: 49, 4: 65, 5: 81}).get(duration, 33 if tight else 49)
    primary = {"16:9": (480, 832), "9:16": (832, 480), "1:1": (480, 480)}.get(aspect, (480, 832))
    mid = {"16:9": (416, 720), "9:16": (720, 416), "1:1": (416, 416)}.get(aspect, (416, 720))
    last = {"16:9": (384, 640), "9:16": (640, 384), "1:1": (384, 384)}.get(aspect, (384, 640))
    attempts = [
        {"height": primary[0], "width": primary[1], "frames": frames, "steps": 28, "guidance": 5.0, "offload": "model"},
        {"height": mid[0], "width": mid[1], "frames": min(frames, 33), "steps": 24, "guidance": 5.0, "offload": "model"},
        {"height": last[0], "width": last[1], "frames": 25, "steps": 20, "guidance": 4.0, "offload": "sequential"},
    ]
    unique = []
    seen = set()
    for item in attempts:
        key = (item["height"], item["width"], item["frames"], item["steps"], item["offload"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def _apply_offload(pipe, mode: str) -> None:
    if not torch.cuda.is_available():
        return
    if mode == "sequential":
        pipe.enable_sequential_cpu_offload()
        return
    info = device_info()
    if info.get("vram_gb") and info["vram_gb"] < 16:
        pipe.enable_model_cpu_offload()
        return
    pipe.to("cuda")


def _load_video(offload: str = "model"):
    global _video_pipe, _video_offload
    if _video_pipe is not None and _video_offload == offload:
        return _video_pipe
    if not torch.cuda.is_available():
        raise RuntimeError("Wan 2.1 needs a CUDA GPU on the worker machine.")

    from diffusers import AutoencoderKLWan, WanPipeline
    from diffusers.schedulers.scheduling_unipc_multistep import UniPCMultistepScheduler

    _release_models("video", "image", "tts", "music")
    model_id = "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"
    vae = _from_pretrained(
        AutoencoderKLWan.from_pretrained,
        model_id,
        subfolder="vae",
        torch_dtype=torch.float32,
    )
    pipe = _from_pretrained(
        WanPipeline.from_pretrained,
        model_id,
        vae=vae,
        torch_dtype=torch.bfloat16,
    )
    pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=3.0)
    if hasattr(pipe, "vae"):
        if hasattr(pipe.vae, "enable_tiling"):
            pipe.vae.enable_tiling()
        if hasattr(pipe.vae, "enable_slicing"):
            pipe.vae.enable_slicing()
    try:
        pipe.enable_attention_slicing("max")
    except Exception:
        pass
    _apply_offload(pipe, offload)
    _video_pipe = pipe
    _video_offload = offload
    return pipe


def _load_image_pipe():
    global _image_pipe
    if _image_pipe is not None:
        return _image_pipe
    from diffusers import AutoPipelineForText2Image

    _release_models("video", "tts", "music")
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    repo = "stabilityai/sdxl-turbo"
    pipe = _from_pretrained(
        AutoPipelineForText2Image.from_pretrained,
        repo,
        torch_dtype=dtype,
        use_safetensors=True,
    )
    if torch.cuda.is_available():
        info = device_info()
        if info["vram_gb"] and info["vram_gb"] < 12:
            pipe.enable_model_cpu_offload()
        else:
            pipe.to("cuda")
    _image_pipe = pipe
    return pipe


def _load_tts():
    global _tts_pipe
    if _tts_pipe is None:
        from kokoro import KPipeline

        _tts_pipe = KPipeline(lang_code="a")
    return _tts_pipe


def _load_music():
    global _music_pipe
    if _music_pipe is None:
        from transformers import pipeline

        device = 0 if torch.cuda.is_available() else -1
        _music_pipe = pipeline(
            "text-to-audio",
            model="facebook/musicgen-small",
            device=device,
            model_kwargs={"cache_dir": str(CACHE_DIR)},
        )
    return _music_pipe


def _prompt_with_reference(prompt: str, has_ref: bool) -> str:
    if not has_ref:
        return prompt
    return f"{prompt}, matching the attached reference, same subject, composition, and colors"


def generate_video(job: dict, input_data: dict) -> Path:
    from diffusers.utils import export_to_video

    prompt = str(input_data.get("prompt") or job.get("prompt") or "").strip()
    negative = str(input_data.get("negative_prompt") or DEFAULT_NEGATIVE)
    duration = int(input_data.get("duration") or 3)
    aspect = str(input_data.get("aspect_ratio") or "16:9")
    reference = input_data.get("referencePath") or input_data.get("reference")
    attempts = _video_attempts(duration, aspect, float(device_info().get("vram_gb") or 0))
    job["etaSeconds"] = max(90, duration * 45)
    job["etaLabel"] = _format_eta(job["etaSeconds"])

    set_progress(job, 6, "Freeing GPU memory")
    _release_models("image", "tts", "music")
    last_error: BaseException | None = None
    output = None

    for index, attempt in enumerate(attempts):
        height = int(attempt["height"])
        width = int(attempt["width"])
        frames = int(attempt["frames"])
        steps = int(attempt["steps"])
        guidance = float(attempt["guidance"])
        offload = str(attempt["offload"])
        image = load_reference(str(reference) if reference else None, width, height)
        used_prompt = _prompt_with_reference(prompt, image is not None)

        def on_step(_pipe, step_index, _timestep, callback_kwargs, steps=steps):
            set_progress(
                job,
                12 + int((step_index + 1) / steps * 78),
                f"Rendering step {step_index + 1}/{steps}",
                step_index=step_index,
                total_steps=steps,
            )
            return callback_kwargs

        label = f"{width}x{height}, {frames} frames"
        set_progress(job, 8, "Loading video model" if index == 0 else f"Retrying at lower VRAM · {label}")
        watch = _watch_load(job, "Loading video model · first run can take several minutes") if index == 0 else None
        try:
            pipe = _load_video(offload)
        finally:
            if watch:
                watch.set()
        set_progress(job, 12, f"{'Using reference · ' if image else ''}Generating frames · {label}")
        kwargs = {
            "prompt": used_prompt,
            "negative_prompt": negative,
            "height": height,
            "width": width,
            "num_frames": frames,
            "guidance_scale": guidance,
            "num_inference_steps": steps,
            "callback_on_step_end": on_step,
        }
        params = inspect.signature(pipe.__call__).parameters
        if image is not None and "image" in params:
            kwargs["image"] = image
            job["referenceMode"] = "image-to-video"
        elif image is not None:
            job["referenceMode"] = "prompt+first-frame"

        try:
            with torch.inference_mode():
                output = pipe(**kwargs).frames[0]
            last_error = None
            break
        except Exception as error:
            last_error = error
            if not _is_cuda_oom(error) or index == len(attempts) - 1:
                raise
            _release_models("video")
            _free_unused()

    if last_error is not None or output is None:
        raise last_error or RuntimeError("Video generation failed.")

    set_progress(job, 94, "Encoding video")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = OUTPUT_DIR / f"video-{job['id']}.mp4"
    export_to_video(output, str(dest), fps=16)
    set_progress(job, 100, "Done")
    _free_unused()
    return dest


def generate_image(job: dict, input_data: dict) -> Path:
    prompt = str(input_data.get("prompt") or job.get("prompt") or "").strip()
    negative = str(input_data.get("negative_prompt") or "blurry, watermark, text, low quality")
    aspect = str(input_data.get("aspect_ratio") or "1:1")
    sizes = {"16:9": (768, 448), "9:16": (448, 768), "1:1": (512, 512)}
    width, height = sizes.get(aspect, (512, 512))
    reference = input_data.get("referencePath") or input_data.get("reference")
    image = load_reference(str(reference) if reference else None, width, height)
    job["etaSeconds"] = None
    job["etaLabel"] = "Loading model · first run can take several minutes"
    set_progress(job, 8, "Loading image model")
    watch = _watch_load(job, "Loading image model · first run can take several minutes")
    try:
        pipe = _load_image_pipe()
    finally:
        watch.set()
    used_prompt = _prompt_with_reference(prompt, image is not None)
    kwargs = {
        "prompt": used_prompt,
        "negative_prompt": negative,
        "width": width,
        "height": height,
        "num_inference_steps": 4,
        "guidance_scale": 0.0,
    }
    params = inspect.signature(pipe.__call__).parameters
    if image is not None and "image" in params:
        kwargs["image"] = image
        kwargs["strength"] = 0.72
        job["referenceMode"] = "image-to-image"
    set_progress(job, 35, "Rendering image")
    with torch.inference_mode():
        result = pipe(**kwargs).images[0]
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = OUTPUT_DIR / f"image-{job['id']}.png"
    result.save(dest)
    set_progress(job, 100, "Done")
    _free_unused()
    return dest


def generate_tts(job: dict, input_data: dict) -> Path:
    prompt = str(input_data.get("prompt") or job.get("prompt") or "").strip()
    voice = str(input_data.get("voice") or "af_heart")
    speed = float(input_data.get("speed") or 1.0)
    job["etaSeconds"] = 12
    job["etaLabel"] = _format_eta(12)
    set_progress(job, 10, "Loading voice model")
    _release_models("video", "image", "music")
    pipe = _load_tts()
    chunks = []
    set_progress(job, 30, "Synthesizing speech")
    for _, _, audio in pipe(prompt, voice=voice, speed=speed):
        if audio is None:
            continue
        if hasattr(audio, "cpu"):
            audio = audio.cpu().numpy()
        chunks.append(np.asarray(audio))
        set_progress(job, min(88, 30 + len(chunks) * 12), "Synthesizing speech")
    if not chunks:
        raise RuntimeError("Kokoro returned no audio.")
    waveform = np.concatenate(chunks)
    dest = OUTPUT_DIR / f"audio-{job['id']}.wav"
    set_progress(job, 94, "Writing audio")
    write_wav(dest, waveform, 24000)
    set_progress(job, 100, "Done")
    return dest


def generate_music(job: dict, input_data: dict) -> Path:
    prompt = str(input_data.get("prompt") or job.get("prompt") or "").strip()
    duration = int(input_data.get("duration") or 8)
    job["etaSeconds"] = duration * 6
    job["etaLabel"] = _format_eta(job["etaSeconds"])
    set_progress(job, 10, "Loading music model")
    _release_models("video", "image", "tts")
    pipe = _load_music()
    set_progress(job, 35, "Composing track")
    result = pipe(prompt, forward_params={"do_sample": True, "max_new_tokens": duration * 50})
    audio = result["audio"]
    sr = int(result.get("sampling_rate") or 32000)
    if hasattr(audio, "cpu"):
        audio = audio.cpu().numpy()
    dest = OUTPUT_DIR / f"audio-{job['id']}.wav"
    set_progress(job, 90, "Writing audio")
    write_wav(dest, audio, sr)
    set_progress(job, 100, "Done")
    _free_unused()
    return dest


def run_generation(job: dict, input_data: dict) -> Path:
    wait_if_hot(job)
    model_id = job["modelId"]
    if model_id == "wan2.1-1.3b":
        return generate_video(job, input_data)
    if model_id == "sdxl-turbo":
        return generate_image(job, input_data)
    if model_id == "kokoro-tts":
        return generate_tts(job, input_data)
    if model_id == "musicgen-small":
        return generate_music(job, input_data)
    raise RuntimeError(f"Unknown model {model_id}")


def isolated_run(job: dict, result_path: str) -> None:
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    dest_file = Path(result_path)
    dest_file.parent.mkdir(parents=True, exist_ok=True)
    try:
        dest = run_generation(job, job.get("input") or {})
        dest_file.write_text(json.dumps({"ok": True, "file": str(dest)}))
    except JobCancelled as error:
        dest_file.write_text(json.dumps({"ok": False, "cancelled": True, "error": str(error)}))
    except Exception as error:
        import traceback

        traceback.print_exc()
        dest_file.write_text(json.dumps({"ok": False, "error": str(error)}))
