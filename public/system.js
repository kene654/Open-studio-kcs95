const els = {
  saveDir: document.querySelector("#save-dir"),
  filename: document.querySelector("#filename-pattern"),
  copyOnComplete: document.querySelector("#copy-on-complete"),
  openOnComplete: document.querySelector("#open-on-complete"),
  autoOpen: document.querySelector("#auto-open"),
  confirmGenerate: document.querySelector("#confirm-generate"),
  resolved: document.querySelector("#save-resolved"),
  status: document.querySelector("#sys-status"),
  save: document.querySelector("#save-system"),
};

function fill(system) {
  els.saveDir.value = system.saveDir || "";
  els.filename.value = system.filenamePattern || "{kind}-{date}-{id}";
  els.copyOnComplete.checked = system.copyOnComplete !== false;
  els.openOnComplete.checked = Boolean(system.openOnComplete);
  els.autoOpen.checked = system.autoOpenBrowser !== false;
  els.confirmGenerate.checked = Boolean(system.confirmGenerate);
  els.resolved.textContent = system.saveDirResolved ? `Resolves to ${system.saveDirResolved}` : "";
}

function payload() {
  return {
    saveDir: els.saveDir.value.trim(),
    filenamePattern: els.filename.value.trim() || "{kind}-{date}-{id}",
    copyOnComplete: els.copyOnComplete.checked,
    openOnComplete: els.openOnComplete.checked,
    autoOpenBrowser: els.autoOpen.checked,
    confirmGenerate: els.confirmGenerate.checked,
  };
}

els.save.addEventListener("click", async () => {
  els.status.textContent = "Saving…";
  try {
    const saved = await api("/api/system", {
      method: "POST",
      body: JSON.stringify(payload()),
    });
    fill(saved);
    els.status.textContent = "Saved.";
  } catch (error) {
    els.status.textContent = error.message;
  }
});

async function boot() {
  renderNav("/system-config");
  await refreshHealth();
  fill(await api("/api/system"));
  setInterval(refreshHealth, 3000);
}

boot().catch((error) => {
  els.status.textContent = error.message;
});
