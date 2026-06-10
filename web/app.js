/* AI Infra Price Index — frontend (vanilla JS + Chart.js) */
"use strict";

const DATA_URL = "data/history.json";

const GPU_COLUMNS = [
  { key: "runpod_secure", label: "RunPod Secure" },
  { key: "runpod_community", label: "RunPod Community" },
  { key: "vast_median", label: "Vast.ai (median)" },
];

/* ---------- pure helpers ---------- */

function fmtIndex(v) {
  return Number.isFinite(v) ? v.toFixed(1) : "—";
}

function fmtMoney(v, decimals) {
  if (!Number.isFinite(v)) return "—";
  return "$" + v.toFixed(decimals == null ? 2 : decimals);
}

// Delta of an index vs the previous snapshot.
// Returns null when there is no previous snapshot (single-point history).
function indexDelta(curr, prev, key) {
  if (!prev || !prev.indices || !curr || !curr.indices) return null;
  const a = curr.indices[key];
  const b = prev.indices[key];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a - b;
}

// Build sorted GPU table rows from the latest snapshot. Sorted by best DESC.
function gpuRows(snapshot) {
  const gpu = (snapshot && snapshot.gpu) || {};
  return Object.keys(gpu)
    .map((model) => ({ model, prices: gpu[model] || {} }))
    .filter((r) => Number.isFinite(r.prices.best))
    .sort((a, b) => b.prices.best - a.prices.best);
}

// Which provider cells tie the best price (for highlighting).
function bestCells(prices) {
  const best = prices.best;
  const out = {};
  for (const col of GPU_COLUMNS) {
    const v = prices[col.key];
    out[col.key] = Number.isFinite(v) && Number.isFinite(best) && Math.abs(v - best) < 1e-9;
  }
  return out;
}

function fmtUpdated(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso || "unknown";
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
}

function fmtTick(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/* ---------- rendering ---------- */

function renderDelta(el, delta) {
  if (delta === null) {
    el.textContent = "baseline · first reading";
    el.className = "stat-delta";
    return;
  }
  const eps = 0.005;
  let cls = "stat-delta";
  let arrow = "→";
  let tag = "flat vs prev";
  if (delta < -eps) {
    cls += " down";
    arrow = "▼";
    tag = "cheaper vs prev";
  } else if (delta > eps) {
    cls += " up";
    arrow = "▲";
    tag = "pricier vs prev";
  }
  el.className = cls;
  el.innerHTML = "";
  const num = document.createElement("span");
  num.textContent = `${arrow} ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`;
  const label = document.createElement("span");
  label.className = "delta-tag";
  label.textContent = tag;
  el.append(num, label);
}

function renderStats(curr, prev) {
  const idx = curr.indices || {};
  for (const key of ["composite", "gpu", "cpu", "ram"]) {
    document.getElementById("stat-" + key).textContent = fmtIndex(idx[key]);
    renderDelta(document.getElementById("delta-" + key), indexDelta(curr, prev, key));
  }
  document.getElementById("sub-cpu").textContent =
    Number.isFinite(curr.cpu_per_vcpu_hr) ? fmtMoney(curr.cpu_per_vcpu_hr, 4) + " /vCPU·hr" : "";
  document.getElementById("sub-ram").textContent =
    Number.isFinite(curr.ram_per_gb_hr) ? fmtMoney(curr.ram_per_gb_hr, 4) + " /GB·hr" : "";
}

function renderChart(snapshots) {
  const labels = snapshots.map((s) => fmtTick(s.ts));
  const series = (key) => snapshots.map((s) => {
    const v = s.indices && s.indices[key];
    return Number.isFinite(v) ? v : null;
  });

  // With very few points, lines alone look broken — always show markers then.
  const fewPoints = snapshots.length <= 3;
  const pointRadius = fewPoints ? 5 : 2;

  const mk = (key, label, color, emphasized) => ({
    label,
    data: series(key),
    borderColor: color,
    backgroundColor: color,
    borderWidth: emphasized ? 3 : 1.5,
    pointRadius,
    pointHoverRadius: pointRadius + 2,
    tension: 0.25,
    spanGaps: true,
  });

  const ctx = document.getElementById("history-chart").getContext("2d");
  new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        mk("composite", "Composite", "#f5a623", true),
        mk("gpu", "GPU", "#60a5fa", false),
        mk("cpu", "CPU", "#34d399", false),
        mk("ram", "RAM", "#a78bfa", false),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: { color: "#8b93a7", usePointStyle: true, pointStyle: "line", boxWidth: 24 },
        },
        tooltip: {
          backgroundColor: "#161b28",
          borderColor: "#232a3a",
          borderWidth: 1,
          titleColor: "#e6e9f0",
          bodyColor: "#c5cbd9",
          callbacks: {
            label: (item) => ` ${item.dataset.label}: ${Number(item.parsed.y).toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#5c6478", maxRotation: 0, autoSkip: true, font: { family: "IBM Plex Mono", size: 11 } },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
        y: {
          ticks: { color: "#5c6478", font: { family: "IBM Plex Mono", size: 11 } },
          grid: { color: "rgba(255,255,255,0.06)" },
          title: { display: true, text: "index (baseline = 100)", color: "#5c6478", font: { size: 11 } },
        },
      },
    },
  });
}

function renderGpuTable(curr) {
  const tbody = document.getElementById("gpu-tbody");
  tbody.innerHTML = "";
  const rows = gpuRows(curr);

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = GPU_COLUMNS.length + 2;
    td.className = "missing";
    td.textContent = "No GPU prices in the latest snapshot.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    const tdModel = document.createElement("td");
    tdModel.className = "model";
    tdModel.textContent = row.model;
    tr.appendChild(tdModel);

    const best = bestCells(row.prices);
    for (const col of GPU_COLUMNS) {
      const td = document.createElement("td");
      const v = row.prices[col.key];
      td.className = "num";
      if (Number.isFinite(v)) {
        td.textContent = fmtMoney(v);
        if (best[col.key]) td.classList.add("best-cell");
      } else {
        td.textContent = "—";
        td.classList.add("missing");
      }
      tr.appendChild(td);
    }

    const tdBest = document.createElement("td");
    tdBest.className = "num best-col";
    tdBest.textContent = fmtMoney(row.prices.best);
    tr.appendChild(tdBest);
    tbody.appendChild(tr);
  }
}

function showStatus(html) {
  const el = document.getElementById("status");
  el.innerHTML = html;
  el.hidden = false;
  document.getElementById("dashboard").hidden = true;
}

function renderAll(data) {
  const snapshots = (data && Array.isArray(data.snapshots)) ? data.snapshots : [];
  if (snapshots.length === 0) {
    showStatus("No snapshots yet — run <code>collector/collect.py</code> to take the first reading.");
    return;
  }

  const curr = snapshots[snapshots.length - 1];
  const prev = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;

  const stamp = document.getElementById("updated-stamp");
  document.getElementById("updated-time").textContent = fmtUpdated(data.updated || curr.ts);
  stamp.hidden = false;

  renderStats(curr, prev);
  try {
    renderChart(snapshots);
  } catch (err) {
    console.error("Chart rendering failed (Chart.js CDN unreachable?):", err);
  }
  renderGpuTable(curr);

  document.getElementById("status").hidden = true;
  document.getElementById("dashboard").hidden = false;
}

async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    renderAll(await res.json());
  } catch (err) {
    console.error("Failed to load index data:", err);
    showStatus(
      "No data yet — run <code>collector/collect.py</code> to generate " +
      "<code>web/data/history.json</code>, then refresh."
    );
  }
}

if (typeof module !== "undefined" && module.exports) {
  // Allow node-based sanity checks of pure functions.
  module.exports = { fmtIndex, fmtMoney, indexDelta, gpuRows, bestCells };
} else {
  document.addEventListener("DOMContentLoaded", init);
}
