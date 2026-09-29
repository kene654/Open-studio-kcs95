@echo off
cd /d "%~dp0"
set HF_HOME=%CD%\models
set TRANSFORMERS_CACHE=%CD%\models
set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
if not exist outputs mkdir outputs
if not exist models mkdir models
if not exist uploads mkdir uploads
start "Open-Studio Worker" /MIN cmd /c ""%CD%\.venv\Scripts\uvicorn.exe" main:app --host 0.0.0.0 --port 7860 > "%CD%\worker.log" 2>&1"
echo STARTED
