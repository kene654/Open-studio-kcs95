import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { publicMachine, resolveMachineUrl } from "./machines.js";
import type { Machine, PublicConfig, StudioConfig, TargetKind } from "./types.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const CONFIG_PATH = path.join(DATA_DIR, "studio.json");

function defaultSsh() {
  return {
    host: "192.168.0.51",
    port: 22,
    username: "kenstudios-aim-02",
    password: "",
    connectionType: "ssh" as const,
  };
}

function defaultCloud() {
  return {
    provider: "custom" as const,
    url: "",
    apiKey: "",
  };
}

function defaultMachine(partial: Partial<Machine> = {}): Machine {
  return {
    id: partial.id || randomUUID(),
    name: partial.name || "Linux GPU",
    enabled: partial.enabled !== false,
    preferred: partial.preferred !== false,
    type: (partial.type || "network") as TargetKind,
    workerPort: Number(partial.workerPort) || 7860,
    ssh: { ...defaultSsh(), ...partial.ssh },
    cloud: { ...defaultCloud(), ...partial.cloud },
    priority: Number(partial.priority) || 100,
  };
}

const DEFAULT_CONFIG: StudioConfig = {
  machines: [defaultMachine({ id: "linux-gpu", name: "Linux GPU", preferred: true, priority: 100 })],
  preferredMachineId: "linux-gpu",
  target: "network",
  workerUrl: "http://192.168.0.51:7860",
  workerPort: 7860,
  ssh: defaultSsh(),
  cloud: defaultCloud(),
  models: {
    video: "wan2.1-1.3b",
    audio: "kokoro-tts",
    image: "sdxl-turbo",
  },
  system: {
    saveDir: path.join(homedir(), "Open-Studio", "outputs"),
    copyOnComplete: true,
    openOnComplete: false,
    autoOpenBrowser: true,
    confirmGenerate: false,
    filenamePattern: "{kind}-{date}-{id}",
    uiPort: 8787,
  },
};

let cache: StudioConfig | null = null;

function preferredMachine(config: StudioConfig): Machine {
  return (
    config.machines.find((item) => item.id === config.preferredMachineId) ||
    config.machines.find((item) => item.preferred) ||
    config.machines[0]
  );
}

function syncLegacy(config: StudioConfig): StudioConfig {
  const machine = preferredMachine(config);
  if (!machine) return config;
  config.preferredMachineId = machine.id;
  config.machines = config.machines.map((item) => ({ ...item, preferred: item.id === machine.id }));
  config.target = machine.type;
  config.workerPort = machine.workerPort;
  config.workerUrl = resolveMachineUrl(machine);
  config.ssh = { ...machine.ssh };
  config.cloud = { ...machine.cloud };
  return config;
}

function migrateMachines(raw: Partial<StudioConfig> & { machines?: Machine[] }): Machine[] {
  if (Array.isArray(raw.machines) && raw.machines.length) {
    return raw.machines.map((item, index) =>
      defaultMachine({
        ...item,
        preferred: item.preferred || item.id === raw.preferredMachineId || index === 0,
      }),
    );
  }
  return [
    defaultMachine({
      id: "linux-gpu",
      name: raw.target === "local" ? "This Mac" : raw.target === "cloud" ? "Cloud worker" : "Linux GPU",
      type: (raw.target as TargetKind) || "network",
      workerPort: Number(raw.workerPort) || 7860,
      ssh: { ...defaultSsh(), ...raw.ssh },
      cloud: { ...defaultCloud(), ...raw.cloud },
      preferred: true,
      priority: 100,
    }),
  ];
}

function normalize(raw: Partial<StudioConfig>): StudioConfig {
  const machines = migrateMachines(raw);
  const merged: StudioConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    machines,
    preferredMachineId: raw.preferredMachineId || machines.find((item) => item.preferred)?.id || machines[0].id,
    ssh: { ...DEFAULT_CONFIG.ssh, ...raw.ssh },
    cloud: { ...DEFAULT_CONFIG.cloud, ...raw.cloud },
    models: { ...DEFAULT_CONFIG.models, ...raw.models },
    system: { ...DEFAULT_CONFIG.system, ...raw.system },
  };
  merged.machines = merged.machines.map((item) => ({
    ...item,
    type: (["local", "network", "cloud"].includes(item.type) ? item.type : "network") as TargetKind,
    workerPort: Number(item.workerPort) || 7860,
    ssh: { ...defaultSsh(), ...item.ssh, connectionType: "ssh" as const },
    cloud: { ...defaultCloud(), ...item.cloud },
    priority: Number(item.priority) || 50,
  }));
  return syncLegacy(merged);
}

export async function loadConfig(): Promise<StudioConfig> {
  if (cache) return cache;
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    cache = normalize(JSON.parse(text) as Partial<StudioConfig>);
  } catch {
    cache = normalize(DEFAULT_CONFIG);
    await saveConfig(cache);
  }
  return cache;
}

export async function saveConfig(next: Partial<StudioConfig>): Promise<StudioConfig> {
  const current = cache ?? (await loadConfig());
  const merged = normalize({
    ...current,
    ...next,
    machines: next.machines || current.machines,
    ssh: { ...current.ssh, ...next.ssh },
    cloud: { ...current.cloud, ...next.cloud },
    models: { ...current.models, ...next.models },
    system: { ...current.system, ...next.system },
  });
  if (next.ssh && !next.ssh.password) merged.ssh.password = current.ssh.password;
  if (next.cloud && !next.cloud.apiKey) merged.cloud.apiKey = current.cloud.apiKey;
  merged.machines = merged.machines.map((machine) => {
    const previous = current.machines.find((item) => item.id === machine.id);
    if (previous && machine.ssh && !machine.ssh.password) machine.ssh.password = previous.ssh.password;
    if (previous && machine.cloud && !machine.cloud.apiKey) machine.cloud.apiKey = previous.cloud.apiKey;
    return machine;
  });
  const synced = syncLegacy(merged);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(synced, null, 2));
  cache = synced;
  process.env.WORKER_URL = synced.workerUrl;
  return synced;
}

export function publicConfig(config: StudioConfig): PublicConfig {
  const machine = preferredMachine(config) || config.machines[0];
  return {
    machines: config.machines.map(publicMachine),
    preferredMachineId: config.preferredMachineId,
    target: config.target,
    workerUrl: config.workerUrl,
    workerPort: config.workerPort,
    ssh: publicMachine(machine).ssh,
    cloud: publicMachine(machine).cloud,
    models: config.models,
    system: config.system,
  };
}

export function workerAuthHeaders(config: StudioConfig): HeadersInit {
  const headers: Record<string, string> = {};
  if (config.target === "cloud" && config.cloud.apiKey) {
    headers.Authorization = `Bearer ${config.cloud.apiKey}`;
  }
  return headers;
}

export function findMachine(config: StudioConfig, id?: string): Machine | undefined {
  if (id) return config.machines.find((item) => item.id === id);
  return preferredMachine(config);
}
