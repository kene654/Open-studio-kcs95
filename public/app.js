const state = {
  kind: "video",
  models: { video: [], audio: [], image: [] },
  defaults: { video: "", audio: "", image: "" },
  confirmGenerate: false,
  jobs: [],
  selectedJobId: null,
  previewKey: "",
  machines: [],
};

const els = {
  tabs: document.querySelectorAll(".tab"),
  model: document.querySelector("#model"),
  blurb: document.querySelector("#blurb"),
  fields: document.querySelector("#fields"),
  generate: document.querySelector("#generate"),
  formError: document.querySelector("#form-error"),
  jobs: document.querySelector("#jobs"),
  preview: document.querySelector("#preview"),
  jobsHint: document.querySelector("#jobs-hint"),
  attachBox: document.querySelector("#attach-box"),
  attachHint: document.querySelector("#attach-hint"),
  attachName: document.querySelector("#attach-name"),
  reference: document.querySelector("#reference"),
  machine: document.querySelector("#machine"),
  boost: document.querySelector("#boost"),
};

function currentModels() {
  return state.models[state.kind] || [];
}

function selectedModel() {
  return currentModels().find((model) => model.id === els.model.value);
}

function fieldControl(field) {
  const value = field.defaultValue ?? "";
  if (field.type === "textarea") {
    return `<textarea name="${field.key}" ${field.required ? "required" : ""} placeholder="${field.placeholder || ""}"></textarea>`;
  }
  if (field.type === "select") {
    return `<select name="${field.key}">${(field.options || [])
      .map((option) => `<option value="${option}" ${option === value ? "selected" : ""}>${option}</option>`)
      .join("")}</select>`;
  }
  if (field.type === "number") {
    return `<input type="number" name="${field.key}" min="${field.min ?? ""}" max="${field.max ?? ""}" step="${field.step ?? 1}" value="${value}">`;
  }
  return `<input name="${field.key}" value="${value}">`;
}

function renderMachines() {
  const options = [`<option value="">Auto · smart routing</option>`]
    .concat(
      state.machines.map((machine) => {
        const health = machine.health || {};
        const mark = health.online ? "online" : "offline";
        const busy = health.busy ? ", busy" : "";
        return `<option value="${machine.id}">${escapeHtml(machine.name)} · ${mark}${busy}</option>`;
      }),
    )
    .join("");
  els.machine.innerHTML = options;
}

function renderModels() {
  const models = currentModels();
  const preferred = state.defaults[state.kind];
  els.model.innerHTML = models
    .map((model) => `<option value="${model.id}" ${model.id === preferred ? "selected" : ""}>${model.name}</option>`)
    .join("");
  renderFields();
}

function renderFields() {
  const model = selectedModel();
  if (!model) {
    els.fields.innerHTML = "";
    els.blurb.textContent = "";
    els.attachBox.hidden = true;
    return;
  }
  els.blurb.textContent = model.blurb;
  const prompt = model.fields.find((field) => field.key === "prompt");
  const negative = model.fields.find((field) => field.key === "negative_prompt");
  const rest = model.fields.filter((field) => field.key !== "prompt" && field.key !== "negative_prompt");
  els.fields.innerHTML = `
    ${prompt ? `<label>${prompt.label}</label>${fieldControl(prompt)}` : ""}
    ${negative ? `<label>${negative.label}</label>${fieldControl(negative)}` : ""}
    <div class="grid-2">${rest.map((field) => `<div><label>${field.label}</label>${fieldControl(field)}</div>`).join("")}</div>
  `;
  const attachments = model.attachments || [];
  els.attachBox.hidden = !attachments.length;
  if (attachments.length) {
    const accept = attachments.includes("video") ? "image/*,video/*" : "image/*";
    els.reference.accept = accept;
    els.attachHint.textContent = attachments.includes("video")
      ? "Optional. Attach an image or a video. Video uses the first frame as the look reference."
      : "Optional. Attach an image for the model to follow.";
  }
}

function readForm() {
  const input = {};
  els.fields.querySelectorAll("[name]").forEach((el) => {
    input[el.name] = el.type === "number" ? Number(el.value) : el.value;
  });
  return input;
}

function progressOf(job) {
  if (typeof job.progress === "number") return Math.max(0, Math.min(100, job.progress));
  if (job.status === "queued") return 4;
  if (job.status === "loading_model") return 12;
  if (job.status === "in_progress" || job.status === "paused") return 45;
  if (job.status === "completed") return 100;
  return 0;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function liveStatuses() {
  return ["queued", "loading_model", "in_progress", "paused", "saving", "downloading"];
}

function etaText(job) {
  if (job.status === "completed") return "Done";
  if (job.status === "cancelled") return "Stopped";
  if ((job.progress || 0) < 15) return job.etaLabel || job.step || "Loading model…";
  if (job.etaLabel) return job.etaLabel;
  if (typeof job.etaSeconds === "number") {
    const mins = Math.floor(job.etaSeconds / 60);
    const secs = job.etaSeconds % 60;
    return mins ? `About ${mins} min ${String(secs).padStart(2, "0")}s left` : `About ${secs}s left`;
  }
  return "Estimating time…";
}

function meterLabel(job, pct) {
  return `${job.step || job.status} · ${pct}% · ${etaText(job)}`;
}

function jobActionButtons(job) {
  const live = liveStatuses().includes(job.status);
  return `<div class="btn-row job-actions">
    ${live ? `<button type="button" class="ghost" data-act="stop">Stop</button>` : ""}
    <button type="button" class="ghost danger" data-act="remove">Remove</button>
  </div>`;
}

function renderJobs() {
  if (!state.jobs.length) {
    els.jobs.innerHTML = `<div class="empty">No jobs yet. Press Generate to send work to a machine.</div>`;
    return;
  }
  els.jobs.innerHTML = state.jobs
    .map((job) => {
      const active = job.id === state.selectedJobId ? "active" : "";
      const stopped = job.status === "cancelled" ? " cancelled" : "";
      const pct = progressOf(job);
      const live = liveStatuses().includes(job.status);
      return `<article class="job ${active}${stopped}" data-id="${job.id}">
        <div class="job-top"><span>${escapeHtml(job.kind || "")} · ${escapeHtml(job.modelName)}</span><span>${escapeHtml(job.status)}</span></div>
        <p>${escapeHtml(job.prompt).slice(0, 140)}</p>
        <p class="hint">${escapeHtml(job.machineName || "Machine")} · ${escapeHtml(etaText(job))}</p>
        ${live ? `<div class="meter"><div class="meter-track"><div class="meter-fill" style="width:${pct}%"></div></div></div>` : ""}
        ${jobActionButtons(job)}
      </article>`;
    })
    .join("");
}

function bindPlayer(root, media) {
  const play = root.querySelector(".player-play");
  const fill = root.querySelector(".player-fill");
  const track = root.querySelector(".player-track");
  const time = root.querySelector(".player-time");
  if (!play || !fill || !track || !time) return;
  const paint = () => {
    const duration = media.duration || 0;
    const current = media.currentTime || 0;
    fill.style.width = duration ? `${(current / duration) * 100}%` : "0%";
    time.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    play.textContent = media.paused ? "Play" : "Pause";
  };
  play.onclick = () => {
    if (media.paused) media.play().catch(() => undefined);
    else media.pause();
  };
  track.onclick = (event) => {
    if (!media.duration) return;
    const box = track.getBoundingClientRect();
    media.currentTime = ((event.clientX - box.left) / box.width) * media.duration;
  };
  media.ontimeupdate = paint;
  media.onloadedmetadata = paint;
  media.onplay = paint;
  media.onpause = paint;
  media.onended = paint;
  paint();
}

function mediaTag(job, mediaUrl) {
  if (job.kind === "audio") return `<audio id="media-el" src="${mediaUrl}" preload="metadata"></audio>`;
  if (job.kind === "image") return `<img class="still" src="${mediaUrl}" alt="${escapeHtml(job.prompt)}">`;
  return `<video id="media-el" src="${mediaUrl}" preload="metadata" playsinline></video>`;
}

function renderPreview(force = false) {
  const job = state.jobs.find((item) => item.id === state.selectedJobId);
  if (!job) {
    state.previewKey = "";
    els.preview.innerHTML = `<p class="hint">Select a job to preview the result.</p>`;
    return;
  }
  const mediaUrl = job.localFile || job.resultUrl || "";
  const key = `${job.id}:${job.status}:${mediaUrl}:${job.etaLabel || ""}`;
  const live = liveStatuses().includes(job.status);
  const pct = progressOf(job);
  if (!force && state.previewKey.startsWith(`${job.id}:`) && live && els.preview.querySelector(".meter-fill")) {
    els.preview.querySelector(".meter-fill").style.width = `${pct}%`;
    const label = els.preview.querySelector(".meter-label");
    if (label) label.textContent = meterLabel(job, pct);
    const status = els.preview.querySelector(".job-top span");
    if (status) status.textContent = job.status;
    return;
  }
  if (!force && state.previewKey === key && !live) return;
  state.previewKey = key;
  const player = job.status === "completed" && mediaUrl
    ? `<div class="player">
        ${mediaTag(job, mediaUrl)}
        ${job.kind === "image"
          ? `<div class="player-row"><a class="ghost" href="${mediaUrl}" download>Download</a></div>`
          : `<div class="player-row">
              <button class="player-play" type="button">Play</button>
              <div class="player-track"><div class="player-fill"></div></div>
              <span class="player-time">0:00 / 0:00</span>
              <a class="ghost" href="${mediaUrl}" download>Download</a>
            </div>`}
      </div>`
    : "";
  els.preview.innerHTML = `
    <div class="job-top"><strong>${escapeHtml(job.modelName)}</strong><span>${escapeHtml(job.status)}</span></div>
    <p>${escapeHtml(job.prompt)}</p>
    <p class="hint">${escapeHtml(job.machineName || "Machine")}${job.referenceMode ? ` · ${escapeHtml(job.referenceMode)}` : ""}</p>
    ${job.error ? `<p class="error">${escapeHtml(job.error)}</p>` : ""}
    ${live ? `<div class="meter"><div class="meter-track"><div class="meter-fill" style="width:${pct}%"></div></div><p class="meter-label">${escapeHtml(meterLabel(job, pct))}</p></div>` : ""}
    ${jobActionButtons(job)}
    ${player}
  `;
  const media = els.preview.querySelector("#media-el");
  if (media) bindPlayer(els.preview, media);
}

async function refreshJobs() {
  try {
    state.jobs = await api("/api/jobs");
    if (!state.selectedJobId && state.jobs[0]) state.selectedJobId = state.jobs[0].id;
  } catch {
    state.jobs = [];
  }
  renderJobs();
  renderPreview();
}

els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.kind = tab.dataset.kind;
    els.tabs.forEach((item) => item.classList.toggle("active", item === tab));
    renderModels();
  });
});

els.model.addEventListener("change", renderFields);
els.reference.addEventListener("change", () => {
  els.attachName.textContent = els.reference.files[0] ? els.reference.files[0].name : "";
});

els.generate.addEventListener("click", async () => {
  els.formError.textContent = "";
  const model = selectedModel();
  if (!model) {
    els.formError.textContent = "No model selected. Open AI Manager to install one.";
    return;
  }
  const input = readForm();
  if (!input.prompt?.trim()) {
    els.formError.textContent = "Add a positive prompt first.";
    return;
  }
  if (state.confirmGenerate && !window.confirm("Start this generation?")) return;
  els.generate.disabled = true;
  try {
    const form = new FormData();
    form.set("kind", model.kind || state.kind);
    form.set("modelId", model.id);
    form.set("input", JSON.stringify(input));
    form.set("boost", els.boost.checked ? "true" : "false");
    if (els.machine.value) form.set("machineId", els.machine.value);
    if (els.reference.files[0]) form.set("reference", els.reference.files[0]);
    const job = await api("/api/jobs", { method: "POST", body: form });
    state.selectedJobId = job.id;
    state.previewKey = "";
    await refreshJobs();
  } catch (error) {
    els.formError.textContent = error.message;
  } finally {
    els.generate.disabled = false;
  }
});

els.jobs.addEventListener("click", async (event) => {
  const act = event.target.closest("[data-act]");
  const card = event.target.closest(".job");
  if (act && card) {
    event.preventDefault();
    event.stopPropagation();
    await handleJobAction(card.dataset.id, act.dataset.act);
    return;
  }
  if (!card) return;
  state.selectedJobId = card.dataset.id;
  state.previewKey = "";
  renderJobs();
  renderPreview(true);
});

els.preview.addEventListener("click", async (event) => {
  const act = event.target.closest("[data-act]");
  if (!act || !state.selectedJobId) return;
  event.preventDefault();
  await handleJobAction(state.selectedJobId, act.dataset.act);
});

async function handleJobAction(id, act) {
  const job = state.jobs.find((item) => item.id === id);
  const qs = job?.machineId ? `?machineId=${encodeURIComponent(job.machineId)}` : "";
  try {
    if (act === "stop") {
      await api(`/api/jobs/${id}/stop${qs}`, { method: "POST", body: "{}" });
    } else if (act === "remove") {
      await api(`/api/jobs/${id}${qs}`, { method: "DELETE" });
      if (state.selectedJobId === id) {
        state.selectedJobId = null;
        state.previewKey = "";
      }
    }
    await refreshJobs();
  } catch (error) {
    els.formError.textContent = error.message;
  }
}

async function boot() {
  renderNav("/");
  const [models, config, health, machines] = await Promise.all([
    api("/api/models"),
    api("/api/config"),
    refreshHealth(),
    api("/api/machines"),
  ]);
  state.models = { video: [], audio: [], image: [], ...models };
  state.defaults = { video: "", audio: "", image: "", ...config.models };
  state.confirmGenerate = Boolean(config.system?.confirmGenerate);
  state.machines = machines.machines || [];
  renderMachines();
  if (health?.statusLabel) els.jobsHint.textContent = health.statusLabel;
  renderModels();
  await refreshJobs();
  setInterval(refreshHealth, 3000);
  setInterval(refreshJobs, 1500);
}

boot().catch((error) => {
  els.formError.textContent = error.message;
});
