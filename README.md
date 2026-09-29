# Open-Studio

Local video and audio studio by [kenstudios95.com](https://kenstudios95.com).

The UI runs here. **AI Config** sets the worker and models. **System Config** sets the local save folder and other machine settings.

## Layout

- **Mac UI** — `npm start` → http://127.0.0.1:8787
- **Linux worker** — Wan 2.1 1.3B, Kokoro TTS, MusicGen Small → http://192.168.0.51:7860

## Mac (this computer)

```bash
npm install
npm start
```

`.env.local` already points at the Linux worker:

```bash
WORKER_URL=http://192.168.0.51:7860
```

## Linux (192.168.0.51)

Copy this repo onto the Linux machine, then:

```bash
chmod +x scripts/*.sh
./scripts/install-linux.sh
./scripts/start-linux.sh
```

First run downloads the open-source weights into `worker/models/` (several GB). You need:

- NVIDIA GPU, about 8 GB VRAM for Wan 2.1 1.3B
- `ffmpeg`
- outbound Hugging Face access for the first download

## Models

| Tab | Model | What it does |
|---|---|---|
| Video | Wan 2.1 1.3B | Text-to-video, 480p, 2–5 seconds |
| Audio | Kokoro 82M | Text-to-speech |
| Audio | MusicGen Small | Text-to-music |

No cloud video API is used. If the worker is offline, the UI still opens and says so.
