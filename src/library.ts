import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { findMachine, loadConfig, workerAuthHeaders } from "./config.js";
import { machineAsConfig } from "./machines.js";

export function resolveSaveDir(saveDir: string): string {
  const expanded = saveDir.replace(/^~(?=\/|$)/, process.env.HOME || "");
  return path.resolve(expanded);
}

export async function ensureSaveDir(saveDir: string): Promise<string> {
  const dest = resolveSaveDir(saveDir);
  await mkdir(dest, { recursive: true });
  return dest;
}

function stamp(pattern: string, job: { id: string; kind: string; prompt?: string }): string {
  const date = new Date().toISOString().slice(0, 10);
  const slug = String(job.prompt || "clip")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return pattern
    .replaceAll("{kind}", job.kind)
    .replaceAll("{id}", job.id.slice(0, 8))
    .replaceAll("{date}", date)
    .replaceAll("{prompt}", slug || "clip");
}

const archived = new Map<string, string>();

export async function archiveJob(job: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = await loadConfig();
  const id = String(job.id || "");
  if (id && archived.has(id)) {
    return { ...job, localFile: archived.get(id) };
  }
  if (!config.system.copyOnComplete || job.status !== "completed") return job;

  const remote = String(job.localFile || job.resultUrl || "");
  if (!remote) return job;

  const machine = findMachine(config, String(job.machineId || ""));
  const scoped = machine ? machineAsConfig(machine, config) : config;
  const destDir = await ensureSaveDir(config.system.saveDir);
  const sourceUrl = remote.startsWith("http")
    ? remote
    : `${String(job.workerUrl || scoped.workerUrl)}${remote}`;
    const ext = path.extname(new URL(sourceUrl, "http://local").pathname) || (job.kind === "audio" ? ".wav" : job.kind === "image" ? ".png" : ".mp4");
  const filename = `${stamp(config.system.filenamePattern, job as { id: string; kind: string; prompt?: string })}${ext}`;
  const dest = path.join(destDir, filename);

  try {
    const response = await fetch(sourceUrl, { headers: workerAuthHeaders(scoped) });
    if (!response.ok || !response.body) return job;
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      createWriteStream(dest),
    );
    const localFile = `/library/${filename}`;
    if (id) archived.set(id, localFile);
    return {
      ...job,
      savedFile: dest,
      localFile,
    };
  } catch {
    return job;
  }
}

export async function archiveJobs(jobs: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const next = [];
  for (const job of jobs) {
    next.push(await archiveJob(job));
  }
  return next;
}
