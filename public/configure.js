const els = {
  list: document.querySelector("#machine-list"),
  listStatus: document.querySelector("#list-status"),
  add: document.querySelector("#add-machine"),
  editorTitle: document.querySelector("#editor-title"),
  id: document.querySelector("#machine-id"),
  name: document.querySelector("#machine-name"),
  targetRow: document.querySelector("#target-row"),
  panels: {
    local: document.querySelector("#panel-local"),
    network: document.querySelector("#panel-network"),
    cloud: document.querySelector("#panel-cloud"),
  },
  priority: document.querySelector("#priority"),
  workerPort: document.querySelector("#worker-port"),
  enabled: document.querySelector("#enabled"),
  sshHost: document.querySelector("#ssh-host"),
  sshPort: document.querySelector("#ssh-port"),
  sshUser: document.querySelector("#ssh-user"),
  sshPass: document.querySelector("#ssh-pass"),
  cloudUrl: document.querySelector("#cloud-url"),
  cloudKey: document.querySelector("#cloud-key"),
  videoModel: document.querySelector("#video-model"),
  imageModel: document.querySelector("#image-model"),
  audioModel: document.querySelector("#audio-model"),
  connStatus: document.querySelector("#conn-status"),
  installCopy: document.querySelector("#install-copy"),
  installLog: document.querySelector("#install-log"),
  test: document.querySelector("#test"),
  save: document.querySelector("#save"),
  saveModels: document.querySelector("#save-models"),
  install: document.querySelector("#install"),
};

let type = "network";
let machines = [];
let preferredId = "";
let pollTimer = null;

function setType(next) {
  type = next;
  els.targetRow.querySelectorAll(".choice").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.target === next);
  });
  Object.entries(els.panels).forEach(([key, panel]) => {
    panel.hidden = key !== next;
  });
  els.install.hidden = next === "cloud";
}

function formPayload() {
  return {
    name: els.name.value.trim() || "Machine",
    type,
    enabled: els.enabled.checked,
    workerPort: Number(els.workerPort.value) || 7860,
    priority: Number(els.priority.value) || 50,
    ssh: {
      host: els.sshHost.value.trim(),
      port: Number(els.sshPort.value) || 22,
      username: els.sshUser.value.trim(),
      password: els.sshPass.value,
      connectionType: "ssh",
    },
    cloud: {
      provider: "custom",
      url: els.cloudUrl.value.trim(),
      apiKey: els.cloudKey.value,
    },
  };
}

function fillEditor(machine) {
  if (!machine) return;
  els.id.value = machine.id;
  els.name.value = machine.name || "";
  els.priority.value = machine.priority || 50;
  els.workerPort.value = machine.workerPort || 7860;
  els.enabled.checked = machine.enabled !== false;
  els.sshHost.value = machine.ssh?.host || "";
  els.sshPort.value = machine.ssh?.port || 22;
  els.sshUser.value = machine.ssh?.username || "";
  els.sshPass.value = "";
  els.sshPass.placeholder = machine.ssh?.passwordSet ? "Password saved" : "Password";
  els.cloudUrl.value = machine.cloud?.url || "";
  els.cloudKey.value = "";
  els.cloudKey.placeholder = machine.cloud?.apiKeySet ? "API key saved" : "Optional API key";
  els.editorTitle.textContent = machine.name || "Machine";
  setType(machine.type || "network");
}

function renderList() {
  if (!machines.length) {
    els.list.innerHTML = `<div class="empty">No machines yet. Add a local, network, or cloud worker.</div>`;
    return;
  }
  els.list.innerHTML = machines
    .map((machine) => {
      const health = machine.health || {};
      const online = Boolean(health.online);
      const preferred = machine.id === preferredId;
      const stats = online
        ? `${health.gpu || "GPU"} · ${health.busy ? "busy" : "idle"} · VRAM ${health.vram_gb ?? "—"}G`
        : health.detail || "Offline";
      return `<article class="machine-card ${els.id.value === machine.id ? "active" : ""}" data-id="${machine.id}">
        <div class="job-top">
          <span>${escapeHtml(machine.name)} · ${escapeHtml(machine.type)}</span>
          <span>${preferred ? "Preferred" : online ? "Online" : "Offline"}</span>
        </div>
        <p>${escapeHtml(stats)}</p>
        <div class="btn-row">
          <button class="ghost" data-act="edit" type="button">Edit</button>
          <button class="ghost" data-act="prefer" type="button">Prefer</button>
          <button class="ghost" data-act="remove" type="button">Remove</button>
        </div>
      </article>`;
    })
    .join("");
}

async function refreshMachines() {
  const data = await api("/api/machines");
  machines = data.machines || [];
  preferredId = data.preferredMachineId;
  if (!els.id.value && machines[0]) fillEditor(machines[0]);
  const current = machines.find((item) => item.id === els.id.value);
  if (current) els.editorTitle.textContent = current.name;
  renderList();
}

function fillModels(models, selected) {
  const fill = (el, list, value) => {
    el.innerHTML = (list || [])
      .map((model) => `<option value="${model.id}" ${model.id === value ? "selected" : ""}>${model.name}</option>`)
      .join("");
  };
  fill(els.videoModel, models.video, selected.video);
  fill(els.imageModel, models.image, selected.image);
  fill(els.audioModel, models.audio, selected.audio);
}

els.targetRow.addEventListener("click", (event) => {
  const btn = event.target.closest(".choice");
  if (!btn) return;
  setType(btn.dataset.target);
});

els.list.addEventListener("click", async (event) => {
  const card = event.target.closest(".machine-card");
  if (!card) return;
  const machine = machines.find((item) => item.id === card.dataset.id);
  const act = event.target.closest("button")?.dataset.act;
  if (!machine) return;
  if (!act || act === "edit") {
    fillEditor(machine);
    renderList();
    return;
  }
  try {
    if (act === "prefer") {
      await api(`/api/machines/${machine.id}/preferred`, { method: "POST", body: "{}" });
    }
    if (act === "remove") {
      await api(`/api/machines/${machine.id}`, { method: "DELETE" });
    }
    await refreshMachines();
    await refreshHealth();
  } catch (error) {
    els.listStatus.textContent = error.message;
  }
});

els.add.addEventListener("click", async () => {
  els.listStatus.textContent = "Adding machine…";
  try {
    const created = await api("/api/machines", {
      method: "POST",
      body: JSON.stringify({ type: "network", name: "New machine" }),
    });
    await refreshMachines();
    fillEditor(machines.find((item) => item.id === created.id) || created);
    els.listStatus.textContent = "Added. Fill in SSH or cloud details, then Save and Test.";
  } catch (error) {
    els.listStatus.textContent = error.message;
  }
});

els.save.addEventListener("click", async () => {
  els.connStatus.textContent = "Saving…";
  try {
    const id = els.id.value;
    if (!id) throw new Error("Select a machine first.");
    await api(`/api/machines/${id}`, { method: "PUT", body: JSON.stringify(formPayload()) });
    await refreshMachines();
    await refreshHealth();
    els.connStatus.textContent = "Saved.";
  } catch (error) {
    els.connStatus.textContent = error.message;
  }
});

els.saveModels.addEventListener("click", async () => {
  els.connStatus.textContent = "Saving models…";
  try {
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        models: {
          video: els.videoModel.value,
          image: els.imageModel.value,
          audio: els.audioModel.value,
        },
      }),
    });
    els.connStatus.textContent = "Model defaults saved.";
  } catch (error) {
    els.connStatus.textContent = error.message;
  }
});

els.test.addEventListener("click", async () => {
  els.connStatus.textContent = "Testing…";
  try {
    const id = els.id.value;
    if (!id) throw new Error("Select a machine first.");
    await api(`/api/machines/${id}`, { method: "PUT", body: JSON.stringify(formPayload()) });
    const result = await api(`/api/machines/${id}/test`, { method: "POST", body: "{}" });
    const bits = [];
    if (result.ssh) bits.push(result.ssh.ok ? "SSH ok" : `SSH failed: ${result.ssh.detail}`);
    if (result.worker) bits.push(result.worker.online ? "Worker online" : "Worker offline");
    els.connStatus.textContent = bits.join(" · ") || "Test finished.";
    await refreshMachines();
    await refreshHealth();
  } catch (error) {
    els.connStatus.textContent = error.message;
  }
});

els.install.addEventListener("click", async () => {
  els.install.disabled = true;
  els.installLog.hidden = false;
  els.installLog.textContent = "Starting install…";
  try {
    const id = els.id.value;
    await api(`/api/machines/${id}`, { method: "PUT", body: JSON.stringify(formPayload()) });
    await api("/api/config/install", { method: "POST", body: JSON.stringify({ machineId: id }) });
    pollInstall();
  } catch (error) {
    els.installLog.textContent = error.message;
    els.install.disabled = false;
  }
});

function pollInstall() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const status = await api("/api/config/install");
    els.installLog.textContent = (status.log || []).join("\n") || status.step;
    if (!status.running && status.done) {
      clearInterval(pollTimer);
      els.install.disabled = false;
      els.connStatus.textContent = status.ok ? "Install finished." : status.error || "Install failed.";
      await refreshMachines();
      await refreshHealth();
    }
  }, 2000);
}

async function boot() {
  renderNav("/ai-manager");
  const [config, models] = await Promise.all([api("/api/config"), api("/api/models"), refreshHealth()]);
  fillModels(models, config.models || {});
  await refreshMachines();
  setInterval(async () => {
    await refreshHealth();
    await refreshMachines().catch(() => undefined);
  }, 4000);
}

boot().catch((error) => {
  els.connStatus.textContent = error.message;
});
