import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { FALLBACK_MODELS } from "./catalog.js";
import { findMachine, loadConfig, publicConfig, saveConfig, workerAuthHeaders } from "./config.js";
import { installStatus, startInstall } from "./install.js";
import { archiveJob, archiveJobs, ensureSaveDir, resolveSaveDir } from "./library.js";
import { emptyMachine, machineAsConfig, pickMachine, probeMachine, publicMachine, resolveMachineUrl } from "./machines.js";
import { testSsh } from "./ssh.js";
import type { JobKind, Machine, StudioConfig } from "./types.js";

dotenv.config({ path: ".env.local" });
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const UPLOAD_DIR = path.resolve(process.cwd(), "data", "uploads");
const app = express();
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 80 * 1024 * 1024 } });

app.use(express.json({ limit: "32mb" }));
app.use(express.static(path.join(__dirname, "../public")));

function authFor(machine: Machine, config: StudioConfig): HeadersInit {
  return workerAuthHeaders(machineAsConfig(machine, config));
}

async function probeAll(config: StudioConfig) {
  return Promise.all(config.machines.map((machine) => probeMachine(machine, config)));
}

app.get("/api/health", async (_req, res) => {
  const config = await loadConfig();
  const machines = await probeAll(config);
  const online = machines.filter((item) => item.online);
  const preferred = machines.find((item) => item.id === config.preferredMachineId) || online[0] || machines[0];
  const connected = online.length > 0;
  res.json({
    ok: connected,
    connected,
    statusLabel: connected ? `${online.length}/${machines.length} machines online` : "All machines offline",
    worker: preferred?.url,
    target: config.target,
    models: config.models,
    onlineCount: online.length,
    machineCount: machines.length,
    machines,
    ...(preferred && preferred.online
      ? {
          gpu: preferred.gpu,
          vram_gb: preferred.vram_gb,
          hardware: preferred.hardware,
          thermal: preferred.thermal,
        }
      : {}),
  });
});

app.get("/api/config", async (_req, res) => {
  res.json(publicConfig(await loadConfig()));
});

app.post("/api/config", async (req, res) => {
  const body = req.body ?? {};
  const saved = await saveConfig({
    preferredMachineId: body.preferredMachineId,
    machines: body.machines,
    models: body.models,
    system: body.system,
  });
  res.json(publicConfig(saved));
});

app.get("/api/machines", async (_req, res) => {
  const config = await loadConfig();
  const healths = await probeAll(config);
  res.json({
    preferredMachineId: config.preferredMachineId,
    machines: config.machines.map((machine) => ({
      ...publicMachine(machine),
      health: healths.find((item) => item.id === machine.id) || null,
    })),
  });
});

app.post("/api/machines", async (req, res) => {
  const config = await loadConfig();
  const body = req.body ?? {};
  const machine = emptyMachine(body.type || "network");
  Object.assign(machine, {
    name: String(body.name || machine.name),
    type: body.type || machine.type,
    enabled: body.enabled !== false,
    workerPort: Number(body.workerPort) || 7860,
    priority: Number(body.priority) || 50,
    ssh: { ...machine.ssh, ...body.ssh },
    cloud: { ...machine.cloud, ...body.cloud },
  });
  const machines = config.machines.length ? [...config.machines, machine] : [{ ...machine, preferred: true }];
  const saved = await saveConfig({
    machines,
    preferredMachineId: config.machines.length ? config.preferredMachineId : machine.id,
  });
  res.status(201).json(publicMachine(findMachine(saved, machine.id)!));
});

app.put("/api/machines/:id", async (req, res) => {
  const config = await loadConfig();
  const current = findMachine(config, req.params.id);
  if (!current) {
    res.status(404).json({ error: "Machine not found" });
    return;
  }
  const body = req.body ?? {};
  const next: Machine = {
    ...current,
    name: String(body.name || current.name),
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : current.enabled,
    type: body.type || current.type,
    workerPort: Number(body.workerPort) || current.workerPort,
    priority: Number(body.priority) || current.priority,
    ssh: { ...current.ssh, ...body.ssh },
    cloud: { ...current.cloud, ...body.cloud },
  };
  if (body.ssh && !body.ssh.password) next.ssh.password = current.ssh.password;
  if (body.cloud && !body.cloud.apiKey) next.cloud.apiKey = current.cloud.apiKey;
  const machines = config.machines.map((item) => (item.id === next.id ? next : item));
  const saved = await saveConfig({ machines });
  res.json(publicMachine(findMachine(saved, next.id)!));
});

app.delete("/api/machines/:id", async (req, res) => {
  const config = await loadConfig();
  if (config.machines.length <= 1) {
    res.status(400).json({ error: "Keep at least one machine." });
    return;
  }
  const machines = config.machines.filter((item) => item.id !== req.params.id);
  const preferredMachineId = config.preferredMachineId === req.params.id ? machines[0].id : config.preferredMachineId;
  await saveConfig({ machines, preferredMachineId });
  res.json({ ok: true });
});

app.post("/api/machines/:id/preferred", async (req, res) => {
  const config = await loadConfig();
  const machine = findMachine(config, req.params.id);
  if (!machine) {
    res.status(404).json({ error: "Machine not found" });
    return;
  }
  const saved = await saveConfig({ preferredMachineId: machine.id });
  res.json(publicConfig(saved));
});

app.post("/api/machines/:id/test", async (req, res) => {
  const config = await loadConfig();
  const machine = findMachine(config, req.params.id);
  if (!machine) {
    res.status(404).json({ error: "Machine not found" });
    return;
  }
  const scoped = machineAsConfig(machine, config);
  const result: Record<string, unknown> = { id: machine.id, type: machine.type };
  if (machine.type === "network") {
    const ssh = await testSsh(scoped);
    result.ssh = { ok: ssh.ok, detail: ssh.ok ? ssh.stdout : ssh.stderr || "SSH failed" };
  }
  result.worker = await probeMachine(machine, config);
  res.json(result);
});

app.get("/api/system", async (_req, res) => {
  const config = await loadConfig();
  res.json({
    ...config.system,
    saveDirResolved: resolveSaveDir(config.system.saveDir),
  });
});

app.post("/api/system", async (req, res) => {
  const body = req.body ?? {};
  const current = await loadConfig();
  const saved = await saveConfig({
    system: {
      saveDir: String(body.saveDir || "").trim() || current.system.saveDir,
      copyOnComplete: body.copyOnComplete !== false,
      openOnComplete: Boolean(body.openOnComplete),
      autoOpenBrowser: body.autoOpenBrowser !== false,
      confirmGenerate: Boolean(body.confirmGenerate),
      filenamePattern: String(body.filenamePattern || "{kind}-{date}-{id}"),
      uiPort: Number(body.uiPort) || 8787,
    },
  });
  const dest = await ensureSaveDir(saved.system.saveDir);
  res.json({ ...saved.system, saveDirResolved: dest });
});

app.post("/api/config/test", async (req, res) => {
  const config = await loadConfig();
  const machine = findMachine(config, req.body?.machineId) || findMachine(config);
  if (!machine) {
    res.status(404).json({ error: "No machine configured." });
    return;
  }
  const scoped = machineAsConfig(machine, config);
  const result: Record<string, unknown> = { target: scoped.target, machineId: machine.id };
  if (scoped.target === "network") {
    const ssh = await testSsh(scoped);
    result.ssh = { ok: ssh.ok, detail: ssh.ok ? ssh.stdout : ssh.stderr || "SSH failed" };
  }
  result.worker = await probeMachine(machine, config);
  res.json(result);
});

app.post("/api/config/install", (req, res) => {
  res.status(202).json(startInstall(req.body?.machineId));
});

app.get("/api/config/install", (_req, res) => {
  res.json(installStatus());
});

app.get("/api/models", async (_req, res) => {
  const config = await loadConfig();
  for (const machine of config.machines.filter((item) => item.enabled)) {
    try {
      const remote = await fetch(`${resolveMachineUrl(machine)}/api/models`, {
        headers: authFor(machine, config),
        signal: AbortSignal.timeout(2500),
      });
      if (remote.ok) {
        res.json(await remote.json());
        return;
      }
    } catch {
      // try next machine
    }
  }
  res.json(FALLBACK_MODELS);
});

function rewriteJob(job: Record<string, unknown>, machine: Machine): Record<string, unknown> {
  const local = String(job.localFile || "");
  const workerUrl = resolveMachineUrl(machine);
  return {
    ...job,
    machineId: machine.id,
    machineName: machine.name,
    workerUrl,
    localFile: local.startsWith("/outputs/") ? `/machines/${machine.id}${local}` : local,
  };
}

async function findJobMachine(config: StudioConfig, jobId: string, machineId?: string): Promise<Machine | undefined> {
  const candidates = machineId
    ? [findMachine(config, machineId), ...config.machines.filter((item) => item.id !== machineId)]
    : config.machines;
  for (const machine of candidates) {
    if (!machine?.enabled && machineId !== machine?.id) continue;
    if (!machine) continue;
    try {
      const remote = await fetch(`${resolveMachineUrl(machine)}/api/jobs/${jobId}`, {
        headers: authFor(machine, config),
        signal: AbortSignal.timeout(8000),
      });
      if (remote.ok) return machine;
    } catch {
      // try next machine
    }
  }
  return undefined;
}

app.get("/api/jobs", async (_req, res) => {
  const config = await loadConfig();
  const batches = await Promise.all(
    config.machines.filter((item) => item.enabled).map(async (machine) => {
      try {
        const remote = await fetch(`${resolveMachineUrl(machine)}/api/jobs`, {
          headers: authFor(machine, config),
          signal: AbortSignal.timeout(8000),
        });
        if (!remote.ok) return [];
        const payload = await remote.json();
        const jobs = Array.isArray(payload) ? payload : [];
        return jobs.map((job: Record<string, unknown>) => rewriteJob(job, machine));
      } catch {
        return [];
      }
    }),
  );
  const merged = batches.flat().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const seen = new Set<string>();
  const unique = [];
  for (const job of merged) {
    const id = String(job.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(job);
  }
  res.json(await archiveJobs(unique));
});

app.get("/api/jobs/:id", async (req, res) => {
  const config = await loadConfig();
  for (const machine of config.machines) {
    try {
      const remote = await fetch(`${resolveMachineUrl(machine)}/api/jobs/${req.params.id}`, {
        headers: authFor(machine, config),
        signal: AbortSignal.timeout(8000),
      });
      if (!remote.ok) continue;
      const payload = (await remote.json()) as Record<string, unknown>;
      res.json(await archiveJob(rewriteJob(payload, machine)));
      return;
    } catch {
      // try next
    }
  }
  res.status(404).json({ error: "Job not found" });
});

app.post("/api/jobs/:id/stop", async (req, res) => {
  const config = await loadConfig();
  const machineId = String(req.query.machineId || req.body?.machineId || "");
  const machine = await findJobMachine(config, req.params.id, machineId);
  if (!machine) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  try {
    const remote = await fetch(`${resolveMachineUrl(machine)}/api/jobs/${req.params.id}/stop`, {
      method: "POST",
      headers: authFor(machine, config),
      signal: AbortSignal.timeout(20000),
    });
    const payload = (await remote.json().catch(() => ({}))) as Record<string, unknown>;
    if (!remote.ok) {
      res.status(remote.status).json(payload);
      return;
    }
    res.json(rewriteJob(payload, machine));
  } catch {
    res.status(503).json({ error: `${machine.name} is not reachable.` });
  }
});

app.delete("/api/jobs/:id", async (req, res) => {
  const config = await loadConfig();
  const machineId = String(req.query.machineId || req.body?.machineId || "");
  const machine = await findJobMachine(config, req.params.id, machineId);
  if (!machine) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  try {
    const remote = await fetch(`${resolveMachineUrl(machine)}/api/jobs/${req.params.id}`, {
      method: "DELETE",
      headers: authFor(machine, config),
      signal: AbortSignal.timeout(20000),
    });
    const payload = (await remote.json().catch(() => ({}))) as Record<string, unknown>;
    if (!remote.ok) {
      res.status(remote.status).json(payload);
      return;
    }
    res.json(payload);
  } catch {
    res.status(503).json({ error: `${machine.name} is not reachable.` });
  }
});

app.post("/api/jobs", upload.single("reference"), async (req, res) => {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const config = await loadConfig();
  const isMultipart = Boolean(req.file || (req.body && req.body.input && req.body.kind));
  const kind = String((isMultipart ? req.body.kind : req.body?.kind) || "") as JobKind;
  const modelId = String((isMultipart ? req.body.modelId : req.body?.modelId) || "");
  const machineId = String((isMultipart ? req.body.machineId : req.body?.machineId) || "");
  const boost = String((isMultipart ? req.body.boost : req.body?.boost) || "") === "true" || req.body?.boost === true;
  let input: Record<string, unknown> = {};
  if (isMultipart && req.body?.input) {
    try {
      input = JSON.parse(String(req.body.input));
    } catch {
      input = {};
    }
  } else {
    input = { ...(req.body?.input || {}) };
  }
  if (!kind || !modelId) {
    res.status(400).json({ error: "kind and modelId are required" });
    return;
  }
  const healths = await probeAll(config);
  const machine = pickMachine(config.machines, healths, kind, { machineId, boost });
  if (!machine) {
    res.status(503).json({ error: "No enabled machine is available. Open AI Manager to add one." });
    return;
  }
  const health = healths.find((item) => item.id === machine.id);
  if (!health?.online) {
    res.status(503).json({ error: `${machine.name} is offline. Open AI Manager to connect or install.` });
    return;
  }
  try {
    const url = `${resolveMachineUrl(machine)}/api/jobs`;
    const headers = new Headers(authFor(machine, config));
    let body: BodyInit;
    if (req.file) {
      const form = new FormData();
      form.set("kind", kind);
      form.set("modelId", modelId);
      form.set("input", JSON.stringify(input));
      const bytes = await readFile(req.file.path);
      form.set("reference", new Blob([new Uint8Array(bytes)]), req.file.originalname || "reference.bin");
      body = form;
    } else {
      headers.set("content-type", "application/json");
      body = JSON.stringify({ kind, modelId, input });
    }
    const remote = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(120000) });
    const payload = (await remote.json()) as Record<string, unknown>;
    if (!remote.ok) {
      res.status(remote.status).json(payload);
      return;
    }
    res.status(202).json(rewriteJob(payload, machine));
  } catch {
    res.status(503).json({ error: `${machine.name} is not reachable.` });
  }
});

app.use("/machines/:machineId/outputs", async (req, res) => {
  const config = await loadConfig();
  const machine = findMachine(config, req.params.machineId);
  if (!machine) {
    res.status(404).json({ error: "Machine not found" });
    return;
  }
  await proxyMedia(req, res, `${resolveMachineUrl(machine)}/outputs${req.url}`, machineAsConfig(machine, config));
});

app.use("/outputs", async (req, res) => {
  const config = await loadConfig();
  await proxyMedia(req, res, `${config.workerUrl}/outputs${req.url}`, config);
});

app.use("/library", async (req, res, next) => {
  const config = await loadConfig();
  const dest = await ensureSaveDir(config.system.saveDir);
  express.static(dest)(req, res, next);
});

app.get("/configure", (_req, res) => {
  res.redirect("/ai-manager");
});

app.get("/ai-config", (_req, res) => {
  res.redirect("/ai-manager");
});

app.get("/ai-manager", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/configure.html"));
});

app.get("/system-config", (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/system.html"));
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

async function proxyMedia(req: Request, res: Response, target: string, config: StudioConfig): Promise<void> {
  try {
    const headers = new Headers(workerAuthHeaders(config));
    if (req.headers.range) headers.set("range", String(req.headers.range));
    const response = await fetch(target, { headers, signal: AbortSignal.timeout(120000) });
    res.status(response.status);
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!response.headers.get("content-type")) {
      if (target.endsWith(".wav")) res.setHeader("content-type", "audio/wav");
      if (target.endsWith(".mp3")) res.setHeader("content-type", "audio/mpeg");
      if (target.endsWith(".mp4")) res.setHeader("content-type", "video/mp4");
      if (target.endsWith(".png")) res.setHeader("content-type", "image/png");
      if (target.endsWith(".jpg") || target.endsWith(".jpeg")) res.setHeader("content-type", "image/jpeg");
    }
    if (!response.headers.get("accept-ranges")) res.setHeader("accept-ranges", "bytes");
    if (!response.body) {
      res.end();
      return;
    }
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.status(503).json({ error: "Media is not available from the worker." });
  }
}

const server = app.listen(PORT, async () => {
  await mkdir(UPLOAD_DIR, { recursive: true });
  const config = await loadConfig();
  console.log(`Open-Studio UI  http://127.0.0.1:${PORT}`);
  console.log(`Machines        ${config.machines.length}`);
  if (config.system.autoOpenBrowser) {
    void import("open").then(({ default: open }) => open(`http://127.0.0.1:${PORT}`)).catch(() => undefined);
  }
});

void server;
