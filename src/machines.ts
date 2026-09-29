import { randomUUID } from "node:crypto";
import type { JobKind, Machine, PublicMachine, StudioConfig, TargetKind } from "./types.js";

function machineHeaders(machine: Machine): HeadersInit {
  if (machine.type === "cloud" && machine.cloud.apiKey) {
    return { Authorization: `Bearer ${machine.cloud.apiKey}` };
  }
  return {};
}

export function resolveMachineUrl(machine: Machine): string {
  if (machine.type === "local") {
    return `http://127.0.0.1:${machine.workerPort || 7860}`;
  }
  if (machine.type === "cloud") {
    return (machine.cloud.url || "").replace(/\/$/, "");
  }
  const host = machine.ssh.host || "127.0.0.1";
  return `http://${host}:${machine.workerPort || 7860}`;
}

export function publicMachine(machine: Machine): PublicMachine {
  return {
    id: machine.id,
    name: machine.name,
    enabled: machine.enabled,
    preferred: machine.preferred,
    type: machine.type,
    workerPort: machine.workerPort,
    workerUrl: resolveMachineUrl(machine),
    ssh: {
      host: machine.ssh.host,
      port: machine.ssh.port,
      username: machine.ssh.username,
      passwordSet: Boolean(machine.ssh.password),
      connectionType: "ssh",
    },
    cloud: {
      provider: "custom",
      url: machine.cloud.url,
      apiKeySet: Boolean(machine.cloud.apiKey),
    },
    priority: machine.priority,
  };
}

export function emptyMachine(type: TargetKind = "network"): Machine {
  return {
    id: randomUUID(),
    name: type === "local" ? "This Mac" : type === "cloud" ? "Cloud worker" : "Network PC",
    enabled: true,
    preferred: false,
    type,
    workerPort: 7860,
    ssh: {
      host: "",
      port: 22,
      username: "",
      password: "",
      connectionType: "ssh",
    },
    cloud: {
      provider: "custom",
      url: "",
      apiKey: "",
    },
    priority: 50,
  };
}

export function machineAsConfig(machine: Machine, base: StudioConfig): StudioConfig {
  return {
    ...base,
    target: machine.type,
    workerPort: machine.workerPort,
    workerUrl: resolveMachineUrl(machine),
    ssh: { ...machine.ssh },
    cloud: { ...machine.cloud },
  };
}

function number(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function probeMachine(machine: Machine, config: StudioConfig): Promise<Record<string, unknown>> {
  const url = resolveMachineUrl(machine);
  if (!url || url === "http://") {
    return {
      id: machine.id,
      name: machine.name,
      online: false,
      busy: false,
      url,
      detail: "Machine URL is not set.",
    };
  }
  try {
    const remote = await fetch(`${url}/api/health`, {
      headers: machineHeaders(machine),
      signal: AbortSignal.timeout(4000),
    });
    const body = (await remote.json().catch(() => ({}))) as Record<string, unknown>;
    const hardware = (body.hardware || {}) as Record<string, unknown>;
    const gpu = (hardware.gpu || {}) as Record<string, unknown>;
    const cpu = (hardware.cpu || {}) as Record<string, unknown>;
    const memory = (hardware.memory || {}) as Record<string, unknown>;
    const thermal = (body.thermal || hardware.thermal || {}) as Record<string, unknown>;
    return {
      id: machine.id,
      name: machine.name,
      type: machine.type,
      enabled: machine.enabled,
      preferred: machine.preferred,
      online: remote.ok,
      busy: Boolean(body.busy),
      queue: Number(body.queue || 0),
      url,
      gpu: body.gpu || gpu.name,
      vram_gb: number(body.vram_gb) ?? number(gpu.vram_total_gb),
      gpuUtil: number(gpu.util),
      gpuTemp: number(gpu.temp_c),
      cpuPercent: number(cpu.percent),
      cpuTemp: number(cpu.temp_c),
      ramUsed: number(memory.used_gb),
      ramTotal: number(memory.total_gb),
      thermalPaused: Boolean(thermal.paused),
      hardware,
      thermal,
      capabilities: body.capabilities || ["video", "audio", "image"],
    };
  } catch (error) {
    return {
      id: machine.id,
      name: machine.name,
      type: machine.type,
      enabled: machine.enabled,
      preferred: machine.preferred,
      online: false,
      busy: false,
      url,
      detail: error instanceof Error ? error.message : "Worker offline",
    };
  }
}

export function scoreMachine(health: Record<string, unknown>, kind: JobKind, boost: boolean): number {
  if (health.enabled === false || !health.online) return -1;
  const vram = Number(health.vram_gb) || 0;
  const util = Number(health.gpuUtil) || 0;
  const temp = Number(health.gpuTemp) || 0;
  const priority = Number(health.priority) || 0;
  const queue = Number(health.queue) || 0;
  const busyPenalty = health.busy ? 8 + queue * 4 : queue * 3;
  let score = priority + vram * 6 - util * 0.25 - temp * 0.12 - busyPenalty;
  if ((kind === "video") && vram > 0 && vram < 6) score -= 80;
  if ((kind === "image") && vram > 0 && vram < 4) score -= 15;
  if (boost) score += vram * 10 - util * 0.4;
  if (health.thermalPaused) score -= 40;
  return score;
}

export function pickMachine(
  machines: Machine[],
  healths: Record<string, unknown>[],
  kind: JobKind,
  options: { machineId?: string; boost?: boolean } = {},
): Machine | null {
  const enabled = machines.filter((item) => item.enabled);
  if (options.machineId) {
    return enabled.find((item) => item.id === options.machineId) || null;
  }
  const ranked = enabled
    .map((machine) => {
      const health = healths.find((item) => item.id === machine.id) || { id: machine.id, online: false };
      return {
        machine,
        score: scoreMachine({ ...health, priority: machine.priority, enabled: machine.enabled }, kind, Boolean(options.boost)),
      };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.machine || enabled.find((item) => item.preferred) || enabled[0] || null;
}
