import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StudioConfig } from "./types.js";

export interface CommandResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface RemoteInfo {
  os: "windows" | "linux" | "unknown";
  hostname: string;
  gpu: string;
  detail: string;
}

function sshTarget(config: StudioConfig): string {
  return `${config.ssh.username}@${config.ssh.host}`;
}

function sshArgs(config: StudioConfig, extra: string[] = []): string[] {
  return [
    "-e",
    "ssh",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "PreferredAuthentications=password",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "ConnectTimeout=8",
    "-p",
    String(config.ssh.port || 22),
    ...extra,
    sshTarget(config),
  ];
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 20000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function passEnv(config: StudioConfig): NodeJS.ProcessEnv {
  return { SSHPASS: config.ssh.password };
}

export async function remoteCommand(config: StudioConfig, remote: string, timeoutMs = 20000): Promise<CommandResult> {
  return run("sshpass", [...sshArgs(config), remote], passEnv(config), timeoutMs);
}

export async function detectRemote(config: StudioConfig): Promise<RemoteInfo> {
  const uname = await remoteCommand(config, "uname -s", 8000);
  if (uname.ok && /linux|darwin/i.test(uname.stdout)) {
    const extra = await remoteCommand(
      config,
      "hostname; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo NO_GPU",
      12000,
    );
    const lines = extra.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return {
      os: "linux",
      hostname: lines[0] || "",
      gpu: lines.slice(1).join(" | ") || "NO_GPU",
      detail: extra.stdout || uname.stdout,
    };
  }

  const ver = await remoteCommand(config, "ver", 8000);
  const windows = /windows/i.test(`${ver.stdout}\n${ver.stderr}\n${uname.stderr}`);
  if (windows) {
    const extra = await remoteCommand(config, "hostname & nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", 12000);
    const lines = extra.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const gpuLine = lines.find((line) => /nvidia|geforce|rtx|gtx|tesla|quadro/i.test(line)) || "";
    return {
      os: "windows",
      hostname: lines[0] || "",
      gpu: gpuLine || (extra.ok ? extra.stdout : "NO_GPU"),
      detail: extra.stdout || ver.stdout,
    };
  }

  return {
    os: "unknown",
    hostname: "",
    gpu: "NO_GPU",
    detail: uname.stderr || ver.stdout || "Could not detect remote OS",
  };
}

export async function testSsh(config: StudioConfig): Promise<CommandResult> {
  if (!config.ssh.host || !config.ssh.username || !config.ssh.password) {
    return { ok: false, code: 1, stdout: "", stderr: "SSH host, username, and password are required." };
  }
  const info = await detectRemote(config);
  if (info.os === "unknown") {
    return { ok: false, code: 1, stdout: info.detail, stderr: info.detail };
  }
  return {
    ok: true,
    code: 0,
    stdout: `OK | ${info.os} | ${info.hostname} | ${info.gpu}`,
    stderr: "",
  };
}

async function syncLinux(config: StudioConfig): Promise<CommandResult> {
  const root = process.cwd();
  return run(
    "sshpass",
    [
      "-e",
      "rsync",
      "-az",
      "--exclude",
      "node_modules",
      "--exclude",
      ".git",
      "--exclude",
      "data",
      "--exclude",
      "outputs",
      "--exclude",
      "worker/.venv",
      "--exclude",
      "worker/outputs",
      "--exclude",
      "worker/models",
      "--exclude",
      "worker/jobs.json",
      "--exclude",
      "worker/progress",
      "-e",
      `ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -p ${config.ssh.port || 22}`,
      `${root}/`,
      `${sshTarget(config)}:~/open-studio/`,
    ],
    passEnv(config),
    120000,
  );
}

async function syncWindows(config: StudioConfig): Promise<CommandResult> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "open-studio-"));
  const archive = path.join(tmp, "worker.tgz");
  const worker = path.join(process.cwd(), "worker");
  const packed = await run(
    "tar",
    [
      "-czf",
      archive,
      "--exclude=.venv",
      "--exclude=models",
      "--exclude=outputs",
      "--exclude=uploads",
      "--exclude=jobs.json",
      "--exclude=__pycache__",
      "-C",
      worker,
      ".",
    ],
    {},
    60000,
  );
  if (!packed.ok) {
    await rm(tmp, { recursive: true, force: true });
    return packed;
  }

  const copied = await run(
    "sshpass",
    [
      "-e",
      "scp",
      "-o",
      "PreferredAuthentications=password",
      "-o",
      "PubkeyAuthentication=no",
      "-P",
      String(config.ssh.port || 22),
      archive,
      `${sshTarget(config)}:open-studio-worker.tgz`,
    ],
    passEnv(config),
    120000,
  );
  if (!copied.ok) {
    await rm(tmp, { recursive: true, force: true });
    return copied;
  }

  const extracted = await remoteCommand(
    config,
    "if not exist %USERPROFILE%\\open-studio\\worker mkdir %USERPROFILE%\\open-studio\\worker & tar -xf %USERPROFILE%\\open-studio-worker.tgz -C %USERPROFILE%\\open-studio\\worker",
    60000,
  );
  await rm(tmp, { recursive: true, force: true });
  return extracted;
}

export async function syncWorker(config: StudioConfig, osKind?: RemoteInfo["os"]): Promise<CommandResult> {
  const kind = osKind || (await detectRemote(config)).os;
  if (kind === "windows") return syncWindows(config);
  return syncLinux(config);
}

export function repoRoot(): string {
  return path.resolve(process.cwd());
}
