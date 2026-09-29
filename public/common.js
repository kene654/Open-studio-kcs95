async function api(path, options = {}) {
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };
  if (!isForm && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (isForm) delete headers["Content-Type"];
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.detail || "Request failed");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderNav(active) {
  const el = document.querySelector("#nav");
  if (!el) return;
  const links = [
    ["/", "Studio"],
    ["/ai-manager", "AI Manager"],
    ["/system-config", "System Config"],
  ];
  el.innerHTML = links
    .map(([href, label]) => `<a class="nav-link ${active === href ? "active" : ""}" href="${href}">${label}</a>`)
    .join("");
}

function formatStat(value, suffix = "") {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${Math.round(Number(value))}${suffix}`;
}

function formatGb(used, total) {
  if (used == null || total == null) return "—";
  return `${Number(used).toFixed(1)}/${Number(total).toFixed(1)}G`;
}

function hardwareChips(health) {
  const hw = health.hardware || {};
  const cpu = hw.cpu || {};
  const gpu = hw.gpu || {};
  const memory = hw.memory || {};
  const thermal = health.thermal || hw.thermal || {};
  const chips = [
    ["CPU", `${formatStat(cpu.percent, "%")}${cpu.temp_c != null ? ` ${formatStat(cpu.temp_c, "°")}` : ""}`],
    ["GPU", `${formatStat(gpu.util, "%")}${gpu.temp_c != null ? ` ${formatStat(gpu.temp_c, "°")}` : ""} ${formatGb(gpu.vram_used_gb, gpu.vram_total_gb)}`],
    ["RAM", formatGb(memory.used_gb, memory.total_gb)],
  ];
  const extra = thermal.paused
    ? `<span class="hw-chip hot">Cooling ${escapeHtml(thermal.reason || "")}</span>`
    : "";
  return `${chips
    .map(([label, value]) => `<span class="hw-chip"><em>${label}</em> ${escapeHtml(value)}</span>`)
    .join("")}${extra}`;
}

async function refreshHealth() {
  const el = document.querySelector("#health");
  if (!el) return null;
  try {
    const health = await api("/api/health");
    const online = Boolean(health.connected);
    const cooling = Boolean(health.thermal?.paused || health.hardware?.thermal?.paused);
    const label = !online
      ? "All machines offline"
      : cooling
        ? "Worker cooling"
        : health.statusLabel || "Machines online";
    el.className = `worker-status${online ? " ready" : ""}${cooling ? " cooling" : ""}`;
    el.innerHTML = `<div class="status-pill${online ? " ready" : ""}${cooling ? " cooling" : ""}"><span class="dot"></span>${escapeHtml(label)}</div>${online ? `<div class="hw-stats">${hardwareChips(health)}</div>` : ""}`;
    return health;
  } catch {
    el.className = "worker-status";
    el.innerHTML = `<div class="status-pill"><span class="dot"></span>All machines offline</div>`;
    return null;
  }
}
