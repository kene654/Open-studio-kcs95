#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER="$ROOT/worker"

if [[ ! -x "$WORKER/.venv/bin/uvicorn" ]]; then
  echo "Worker is not installed. Run scripts/install-linux.sh first."
  exit 1
fi

cd "$WORKER"
export HF_HOME="$WORKER/models"
export TRANSFORMERS_CACHE="$WORKER/models"
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
exec "$WORKER/.venv/bin/uvicorn" main:app --host 0.0.0.0 --port 7860
