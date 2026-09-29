import { spawn } from "node:child_process";
import path from "node:path";
import { findMachine, loadConfig } from "./config.js";
import { machineAsConfig } from "./machines.js";
import { detectRemote, remoteCommand, syncWorker, type RemoteInfo } from "./ssh.js";
import type { StudioConfig } from "./types.js";

export interface InstallState {
  running: boolean;
  done: boolean;
  ok: boolean;
  step: string;
  log: string[];
  error?: string;
}

const state: InstallState = {
  running: false,
  done: false,
  ok: false,
  step: "idle",
  log: [],
};

function push(line: string) {
  state.log.push(line);
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

export function installStatus(): InstallState {
  return state;
}

export function startInstall(machineId?: string): InstallState {
  if (state.running) return state;
  state.running = true;
  state.done = false;
  state.ok = false;
  state.error = undefined;
  state.step = "starting";
  state.log = [];
  void runInstall(machineId);
  return state;
}

async function runInstall(machineId?: string) {
  try {
    const config = await loadConfig();
    const machine = findMachine(config, machineId);
    if (!machine) throw new Error("No machine selected. Add one in AI Manager first.");
    const scoped = machineAsConfig(machine, config);
    if (scoped.target === "cloud") {
      throw new Error("Cloud targets are connected by URL. Use Test connection instead of Install.");
    }
    push(`Installing worker on ${machine.name}…`);
    if (scoped.target === "local") {
      await installLocal();
    } else {
      await installNetwork(scoped);
    }
    state.ok = true;
    state.step = "ready";
    push("Worker install finished.");
  } catch (error) {
    state.ok = false;
    state.error = error instanceof Error ? error.message : "Install failed";
    state.step = "failed";
    push(state.error);
  } finally {
    state.running = false;
    state.done = true;
  }
}

async function installLocal() {
  state.step = "local-install";
  push("Installing worker on this computer...");
  const script = path.join(process.cwd(), "scripts", "install-linux.sh");
  await runLocal(script);
  state.step = "local-start";
  push("Starting local worker...");
  spawn(path.join(process.cwd(), "scripts", "start-linux.sh"), [], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

async function installNetwork(config: StudioConfig) {
  state.step = "ssh-test";
  push(`Testing SSH ${config.ssh.username}@${config.ssh.host}...`);
  const remote = await detectRemote(config);
  if (remote.os === "unknown") throw new Error(remote.detail || "SSH connection failed");
  push(`${remote.os} · ${remote.hostname} · ${remote.gpu}`);

  if (remote.os === "windows") {
    await installWindows(config, remote);
    return;
  }
  await installLinux(config);
}

async function installLinux(config: StudioConfig) {
  state.step = "sync";
  push("Copying Open-Studio worker files...");
  const sync = await syncWorker(config, "linux");
  if (!sync.ok) throw new Error(sync.stderr || "File sync failed");
  push("Files copied.");

  state.step = "packages";
  push("Installing Python environment on the remote machine...");
  const remote = [
    "set -e",
    "cd ~/open-studio/worker",
    "python3 -m venv .venv",
    ". .venv/bin/activate",
    "pip install --upgrade pip",
    "if command -v nvidia-smi >/dev/null; then pip install torch torchvision --index-url https://download.pytorch.org/whl/cu130; else pip install torch torchvision; fi",
    "pip install -r requirements.txt",
    "mkdir -p outputs models",
    "echo INSTALL_OK",
  ].join(" && ");
  const installed = await remoteCommand(config, remote, 20 * 60 * 1000);
  if (!installed.ok) throw new Error(installed.stderr || installed.stdout || "Remote install failed");
  push("Python packages installed.");

  state.step = "start";
  push("Starting worker...");
  await remoteCommand(
    config,
    "mkdir -p ~/open-studio/worker/outputs ~/open-studio/worker/models; pgrep -f 'uvicorn main:app --host 0.0.0.0 --port 7860' >/dev/null || (cd ~/open-studio/worker && nohup env HF_HOME=$HOME/open-studio/worker/models PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True .venv/bin/uvicorn main:app --host 0.0.0.0 --port 7860 > worker.log 2>&1 &)",
    15000,
  );
  push(`Worker should be reachable at ${config.workerUrl}`);
}

async function installWindows(config: StudioConfig, info: RemoteInfo) {
  state.step = "sync";
  push("Windows PC detected. Copying worker files with scp (no rsync required)...");
  const sync = await syncWorker(config, "windows");
  if (!sync.ok) throw new Error(sync.stderr || sync.stdout || "File copy to Windows failed");
  push("Files copied.");

  state.step = "python";
  push("Looking for Python on Windows...");
  const py = await remoteCommand(config, "py -3 -c \"import sys; print(sys.executable)\"", 15000);
  const python = py.ok ? "py -3" : "python";
  if (!py.ok) {
    const fallback = await remoteCommand(config, "python -c \"import sys; print(sys.executable)\"", 15000);
    if (!fallback.ok) {
      throw new Error("Python 3 was not found on this Windows PC. Install Python 3.11+ from python.org, tick Add python.exe to PATH, then click Install again.");
    }
  }
  push(`Using ${python}`);

  state.step = "packages";
  push("Creating venv and installing PyTorch + worker packages. This can take several minutes...");
  const gpu = /nvidia|geforce|rtx|gtx/i.test(info.gpu);
  const torch = gpu
    ? `${python} -m pip install --upgrade pip && .venv\\Scripts\\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124`
    : `${python} -m pip install --upgrade pip && .venv\\Scripts\\python.exe -m pip install torch torchvision`;
  const installed = await remoteCommand(
    config,
    `cd /d %USERPROFILE%\\open-studio\\worker && if not exist outputs mkdir outputs && if not exist models mkdir models && ${python} -m venv .venv && ${torch} && .venv\\Scripts\\python.exe -m pip install -r requirements.txt && echo INSTALL_OK`,
    25 * 60 * 1000,
  );
  if (!installed.ok || !/INSTALL_OK/i.test(installed.stdout + installed.stderr)) {
    throw new Error(installed.stderr || installed.stdout || "Windows Python install failed");
  }
  push("Python packages installed.");

  state.step = "firewall";
  push("Allowing worker port 7860 through Windows Firewall if permitted...");
  await remoteCommand(
    config,
    "netsh advfirewall firewall add rule name=OpenStudioWorker dir=in action=allow protocol=TCP localport=7860",
    15000,
  );

  state.step = "start";
  push("Starting Windows worker...");
  const started = await remoteCommand(config, "%USERPROFILE%\\open-studio\\worker\\start-windows.cmd", 15000);
  if (!started.ok) push(started.stderr || "Start command returned a warning; checking HTTP next.");
  push(`Worker should be reachable at ${config.workerUrl}`);
  if (/1650|4 GiB|4096/i.test(info.gpu)) {
    push("Note: GTX 1650 4GB is too small for Wan video. Auto routing will prefer the stronger GPU for video; this PC can still help with speech and lighter image jobs.");
  }
}

function runLocal(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], { cwd: process.cwd() });
    child.stdout.on("data", (chunk) => push(String(chunk).trimEnd()));
    child.stderr.on("data", (chunk) => push(String(chunk).trimEnd()));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Local install exited ${code}`));
    });
  });
}
