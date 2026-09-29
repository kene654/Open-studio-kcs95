#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER="$ROOT/worker"
VENV="$WORKER/.venv"

echo "Open-Studio worker install on $(hostname)"
echo "Repo: $ROOT"

if ! command -v python3 >/dev/null; then
  echo "python3 is required"
  exit 1
fi

if command -v apt-get >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y python3-venv python3-pip ffmpeg git espeak-ng
fi

python3 -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install --upgrade pip

if command -v nvidia-smi >/dev/null; then
  echo "CUDA GPU detected:"
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
  pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130
else
  echo "No NVIDIA driver found. Video generation will fail until CUDA is available."
  pip install torch torchvision
fi

pip install -r "$WORKER/requirements.txt"

mkdir -p "$WORKER/outputs" "$WORKER/models"

echo
echo "Install finished."
echo "Start the worker with:"
echo "  $ROOT/scripts/start-linux.sh"
echo
echo "The Mac UI should point at http://$(hostname -I | awk '{print $1}'):7860"
