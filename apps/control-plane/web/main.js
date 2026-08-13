const TOKEN_KEY = "bsl_api_token";
const ACTIVE_JOB_KEY = "bsl_active_job_id";
const AGENTS_QUERY_KEY = "bsl_agents_query";
const AGENTS_SHOW_ARCHIVED_KEY = "bsl_agents_show_archived";

const state = {
  tab: "projects",
  config: null,
  setup: null,
  repos: [],
  branches: [],
  ios: null,
  selectedRepo: null,
  selectedRef: "",
  projectPath: ".",
  scheme: "",
  deployMode: "ota",
  engine: "local",
  platform: "ios",
  agents: [],
  agentDetail: null,
  agentsLoading: false,
  openingAgentId: null,
  agentsQuery: "",
  agentsShowArchived: false,
  deploys: [],
  artifacts: [],
  devices: null,
  jobs: [],
  activeJobId: null,
  activeJob: null,
  busy: false,
  cancelling: false,
  message: "",
  error: "",
  warning: "",
  pollTimer: null,
  apiToken: "",
  apiAuthRequired: false,
  showAdvanced: false,
  showStatusMore: false,
  showLogs: false,
};

const app = document.getElementById("app");

try {
  state.apiToken = localStorage.getItem(TOKEN_KEY) || "";
  state.agentsQuery = localStorage.getItem(AGENTS_QUERY_KEY) || "";
  state.agentsShowArchived = localStorage.getItem(AGENTS_SHOW_ARCHIVED_KEY) === "1";
} catch {
  state.apiToken = "";
}

function persistAgentsFilters() {
  try {
    if (state.agentsQuery) localStorage.setItem(AGENTS_QUERY_KEY, state.agentsQuery);
    else localStorage.removeItem(AGENTS_QUERY_KEY);
    localStorage.setItem(
      AGENTS_SHOW_ARCHIVED_KEY,
      state.agentsShowArchived ? "1" : "0",
    );
  } catch {
    /* ignore */
  }
}

function rememberActiveJobId(id) {
  try {
    // localStorage survives Safari refresh / PWA relaunch better than sessionStorage
    if (id) localStorage.setItem(ACTIVE_JOB_KEY, id);
    else localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    /* ignore */
  }
}

function readRememberedJobId() {
  try {
    return (
      localStorage.getItem(ACTIVE_JOB_KEY) ||
      sessionStorage.getItem(ACTIVE_JOB_KEY) ||
      ""
    );
  } catch {
    return "";
  }
}

function isLiveJob(job) {
  return job && (job.status === "queued" || job.status === "running");
}

function applyJobOutcome(job) {
  if (!job) return;
  if (job.status === "succeeded") {
    if (job.installUrl) state.message = "Build ready — tap Install below.";
    else if (job.testflightNote) state.message = job.testflightNote;
    else state.message = "Deploy finished.";
    state.error = "";
  } else if (job.status === "failed") {
    state.error = job.error || "Deploy failed — see log.";
  } else if (job.status === "cancelled") {
    state.message = "Build cancelled.";
    state.error = "";
  }
}

function adoptJob(job, { resumePoll = false, message } = {}) {
  if (!job) return;
  state.activeJobId = job.id;
  state.activeJob = job;
  rememberActiveJobId(job.id);

  if (isLiveJob(job)) {
    state.busy = true;
    state.showLogs = true;
    state.message =
      message || state.message || "Live build in progress…";
    state.error = "";
    if (resumePoll) {
      stopPoll();
      state.pollTimer = setInterval(() => pollJob(job.id), 1500);
    }
  } else {
    state.busy = false;
    applyJobOutcome(job);
  }
}

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (state.apiToken) h["Authorization"] = `Bearer ${state.apiToken}`;
  return h;
}

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...authHeaders(), ...(opts?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function setTab(tab) {
  state.tab = tab;
  render();
  if (tab === "cursor") loadAgents();
  if (tab === "status") loadStatus();
}

async function bootstrap() {
  try {
    const health = await api("/api/health");
    state.apiAuthRequired = Boolean(health.apiAuthRequired);
    state.config = await api("/api/config");
    state.apiAuthRequired = Boolean(
      state.config.apiAuthRequired || state.apiAuthRequired,
    );
    state.setup = await api("/api/setup");
    state.deployMode = state.config.defaults?.deploy_mode || "ota";
    state.engine = state.config.deployEngine || "local";
    const reposRes = await api("/api/repos");
    state.repos = reposRes.repos || [];
    state.warning = reposRes.warning || "";
    const fav =
      state.repos.find((r) => r.favorite) ||
      state.repos.find((r) => /guideai/i.test(r.name || r.full_name)) ||
      state.repos[0];
    if (fav) await selectRepo(fav.full_name, fav.default_branch || "main", fav);
    else state.error = "No repos yet — set GuideAI in config/repos.yaml and GITHUB_TOKEN in .env";
  } catch (e) {
    const msg = String(e.message || e);
    if (/unauthorized/i.test(msg) && !state.apiToken) {
      state.error =
        "API token required — open Status, paste BSL_API_TOKEN from .env, then Save.";
      state.apiAuthRequired = true;
      state.tab = "status";
    } else {
      state.error = msg;
    }
  }
  // Always attempt reattach — even if earlier bootstrap steps failed.
  try {
    await resumeActiveJob();
  } catch {
    /* ignore */
  }
  render();
}

async function resumeActiveJob() {
  let remembered = null;
  const rememberedId = readRememberedJobId();
  if (rememberedId) {
    try {
      remembered = await api(`/api/jobs/${encodeURIComponent(rememberedId)}`);
    } catch {
      rememberActiveJobId("");
    }
  }

  let jobs = state.jobs || [];
  let liveJobId = null;
  try {
    const data = await api("/api/jobs");
    jobs = data.jobs || [];
    state.jobs = jobs;
    liveJobId = data.liveJobId || null;
    // If the gate is held but liveJobId was missing, prefer any live row in the list.
    if (!liveJobId) {
      const listedLive = jobs.find((j) => isLiveJob(j));
      if (listedLive) liveJobId = listedLive.id;
    }
  } catch {
    /* keep going with remembered job if any */
  }

  let live = null;
  if (liveJobId) {
    live =
      (remembered && remembered.id === liveJobId ? remembered : null) ||
      jobs.find((j) => j.id === liveJobId) ||
      null;
    if (!live) {
      try {
        live = await api(`/api/jobs/${encodeURIComponent(liveJobId)}`);
      } catch {
        live = null;
      }
    }
  }
  if (!live) {
    live =
      (remembered && isLiveJob(remembered) ? remembered : null) ||
      jobs.find((j) => isLiveJob(j)) ||
      null;
  }

  if (live && isLiveJob(live)) {
    // Prefer a fresh fetch so logs are complete after refresh.
    try {
      const fresh = await api(`/api/jobs/${encodeURIComponent(live.id)}`);
      live = fresh;
    } catch {
      /* use list copy */
    }
    adoptJob(live, {
      resumePoll: true,
      message: "Reattached to build in progress…",
    });
    await pollJob(live.id);
    return true;
  }

  // No live job — still restore the last finished card (Install / logs) if we have one.
  const finished =
    (remembered && !isLiveJob(remembered) ? remembered : null) ||
    jobs.find((j) => j.engine === "local") ||
    null;
  if (finished) {
    // Refresh finished job so Install URL / full logs survive a reload.
    try {
      const fresh = await api(`/api/jobs/${encodeURIComponent(finished.id)}`);
      adoptJob(fresh);
    } catch {
      adoptJob(finished);
    }
  }
  return false;
}

async function selectRepo(fullName, preferredRef, meta) {
  state.selectedRepo = fullName;
  state.error = "";
  state.message = "";
  state.branches = [];
  state.ios = null;
  render();
  try {
    const { branches, warning } = await api(`/api/repos/${fullName}/branches`);
    if (warning) state.warning = warning;
    state.branches = branches;
    state.selectedRef =
      preferredRef ||
      meta?.default_branch ||
      branches.find((b) => b.name === "main")?.name ||
      branches[0]?.name ||
      "main";
    if (meta?.scheme) state.scheme = meta.scheme;
    if (meta?.project_path) state.projectPath = meta.project_path;
    if (meta?.platform === "watchos" || meta?.platform === "ios") {
      state.platform = meta.platform;
    }
    await refreshIos();
  } catch (e) {
    state.error = String(e.message || e);
  }
  render();
}

async function refreshIos() {
  if (!state.selectedRepo || !state.selectedRef) return;
  const data = await api(
    `/api/repos/${state.selectedRepo}/ios?ref=${encodeURIComponent(state.selectedRef)}`,
  );
  state.ios = data;
  if (data.warning) state.warning = data.warning;
  if (!state.scheme && data.suggestedScheme) state.scheme = data.suggestedScheme;
  if (data.suggestedPath) state.projectPath = data.suggestedPath;
  if (data.suggestedPlatform === "watchos" || data.suggestedPlatform === "ios") {
    state.platform = data.suggestedPlatform;
  }
  if (!state.scheme) state.showAdvanced = true;
}

function stopPoll() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollJob(jobId) {
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    state.activeJob = job;
    state.activeJobId = job.id;
    rememberActiveJobId(job.id);
    if (
      job.status === "succeeded" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      stopPoll();
      state.busy = false;
      applyJobOutcome(job);
      await loadStatus();
    } else {
      state.busy = true;
    }
  } catch (e) {
    state.error = String(e.message || e);
    stopPoll();
    state.busy = false;
  }
  render({ allowPatch: true });
}

async function cancelActiveJob() {
  const job = state.activeJob;
  if (!job || !isLiveJob(job) || state.cancelling) return;
  state.cancelling = true;
  state.error = "";
  state.message = "Cancelling build…";
  render();
  try {
    const result = await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {
      method: "POST",
      body: "{}",
    });
    if (result.job) {
      adoptJob(result.job);
      state.message = "Build cancelled.";
    } else {
      await pollJob(job.id);
    }
    stopPoll();
    state.busy = false;
  } catch (e) {
    state.error = String(e.message || e);
    // Still try to refresh — cancel may have landed server-side.
    try {
      await pollJob(job.id);
    } catch {
      /* ignore */
    }
  } finally {
    state.cancelling = false;
    render();
  }
}

async function reattachFromPayload(payload, fallbackMessage) {
  const reattachId = payload?.jobId || null;
  const embedded = payload?.liveJob && isLiveJob(payload.liveJob) ? payload.liveJob : null;

  if (embedded) {
    adoptJob(embedded, {
      resumePoll: true,
      message: "Reattached to build in progress…",
    });
    // Refresh logs in the background
    try {
      await pollJob(embedded.id);
    } catch {
      /* keep embedded snapshot */
    }
    return true;
  }

  if (reattachId) {
    const job = await api(`/api/jobs/${encodeURIComponent(reattachId)}`);
    if (isLiveJob(job)) {
      adoptJob(job, {
        resumePoll: true,
        message: "Reattached to build in progress…",
      });
      await pollJob(job.id);
      return true;
    }
    // Finished while we were attaching — still show the card.
    adoptJob(job);
    return true;
  }

  const resumed = await resumeActiveJob();
  if (resumed || (state.activeJob && isLiveJob(state.activeJob))) {
    state.message = "Reattached to build in progress…";
    state.error = "";
    render();
    return true;
  }

  if (fallbackMessage) state.error = fallbackMessage;
  return false;
}

async function deploy() {
  if (!state.scheme?.trim()) {
    state.error = "Enter an Xcode scheme (e.g. GuideAI).";
    render();
    return;
  }
  // Already watching a live build — just keep the card, don't POST again.
  if (state.activeJob && isLiveJob(state.activeJob)) {
    state.message = "Build already in progress — watching logs below.";
    state.error = "";
    state.showLogs = true;
    if (!state.pollTimer) {
      state.pollTimer = setInterval(() => pollJob(state.activeJob.id), 1500);
    }
    render();
    return;
  }
  state.busy = true;
  state.error = "";
  state.message = "";
  // Keep the current job card visible until a new job actually starts.
  // If the gate says a deploy is already running, we reattach instead.
  render();
  try {
    const result = await api("/api/deploy", {
      method: "POST",
      body: JSON.stringify({
        repository: state.selectedRepo,
        ref: state.selectedRef,
        project_path: state.projectPath || ".",
        scheme: state.scheme,
        deploy_mode: state.deployMode,
        engine: state.engine,
        platform: state.platform || "ios",
        title: state.scheme,
      }),
    });
    state.message = result.message;
    state.activeJobId = result.jobId;
    state.activeJob = null;
    rememberActiveJobId(result.jobId);
    stopPoll();
    // Drop the previous job card before awaiting the new job's first poll.
    render();
    if (result.engine === "local" && result.jobId) {
      state.showLogs = true;
      state.pollTimer = setInterval(() => pollJob(result.jobId), 1500);
      await pollJob(result.jobId);
    } else {
      state.busy = false;
      await loadStatus();
      render();
    }
  } catch (e) {
    const payload = e.payload || {};
    const shouldReattach =
      Boolean(payload.reattach) ||
      Boolean(payload.jobId) ||
      Boolean(payload.liveJob) ||
      /already in progress/i.test(String(e.message || ""));

    if (shouldReattach) {
      try {
        const ok = await reattachFromPayload(
          payload,
          String(e.message || e),
        );
        if (ok) return;
      } catch (reattachErr) {
        state.error = String(reattachErr.message || reattachErr);
        if (!(state.activeJob && isLiveJob(state.activeJob))) {
          state.busy = false;
        }
        render();
        return;
      }
    }

    state.error = String(e.message || e);
    if (!(state.activeJob && isLiveJob(state.activeJob))) {
      state.busy = false;
    }
    render();
  }
}

async function loadAgents() {
  state.agentsLoading = true;
  state.error = "";
  render();
  try {
    const data = await api("/api/cursor/agents");
    state.agents = data.agents || [];
    if (data.warning) state.warning = data.warning;
    if (data.error) state.error = data.error;
  } catch (e) {
    state.error = String(e.message || e);
  } finally {
    state.agentsLoading = false;
    render();
  }
}

async function openAgent(id) {
  if (!id || state.openingAgentId) return;
  state.agentDetail = null;
  state.openingAgentId = id;
  state.error = "";
  render();
  try {
    const detail = await api(`/api/cursor/agents/${encodeURIComponent(id)}`);
    if (state.openingAgentId !== id) return; // user cancelled / navigated away
    state.agentDetail = detail;
  } catch (e) {
    if (state.openingAgentId !== id) return;
    state.error = String(e.message || e);
  } finally {
    if (state.openingAgentId === id) state.openingAgentId = null;
    render();
  }
}

function isArchivedAgent(a) {
  return Boolean(a?.archived) || /archiv/i.test(String(a?.status || ""));
}

function filteredAgents() {
  const q = state.agentsQuery.trim().toLowerCase();
  return (state.agents || []).filter((a) => {
    if (!state.agentsShowArchived && isArchivedAgent(a)) return false;
    if (!q) return true;
    const hay = `${a.name || ""} ${a.status || ""} ${(a.branches || [])
      .map((b) => `${b.branch || ""} ${b.repoUrl || ""}`)
      .join(" ")}`.toLowerCase();
    return hay.includes(q);
  });
}

function agentStatusBadge(a) {
  if (isArchivedAgent(a)) return `<span class="badge">archived</span>`;
  const s = String(a.status || "").toLowerCase();
  if (/run|progress|busy/i.test(s)) return `<span class="badge run">${escapeHtml(a.status)}</span>`;
  if (/fail|error/i.test(s)) return `<span class="badge err">${escapeHtml(a.status)}</span>`;
  if (/done|finish|complete|success|idle|ready/i.test(s))
    return `<span class="badge ok">${escapeHtml(a.status)}</span>`;
  return a.status ? `<span class="badge">${escapeHtml(a.status)}</span>` : "";
}

async function deployFromAgent() {
  const detail = state.agentDetail;
  if (!detail) return;
  const branchInfo =
    detail.agent.branches?.find((b) => b.branch) ||
    detail.runs?.find((r) => r.git?.branches?.[0])?.git?.branches?.[0];
  if (!branchInfo?.branch) {
    state.error = "No branch on this agent to deploy.";
    render();
    return;
  }
  let repo = state.config?.guideAiRepo;
  if (branchInfo.repoUrl) {
    const m = String(branchInfo.repoUrl).match(
      /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i,
    );
    if (m) repo = m[1];
  }
  if (!repo || /YOUR_/i.test(repo)) {
    state.error = "Set GuideAI repository in config/repos.yaml first.";
    render();
    return;
  }
  state.tab = "projects";
  await selectRepo(repo, branchInfo.branch);
  state.message = `Prefilled from Cursor · ${repo}@${branchInfo.branch}`;
  render();
}

async function loadStatus() {
  try {
    const [deploys, artifacts, devices, jobs, setup] = await Promise.all([
      api("/api/deploys").catch(() => ({ runs: [] })),
      api("/api/artifacts").catch(() => ({ artifacts: [] })),
      api("/api/devices").catch(() => null),
      api("/api/jobs").catch(() => ({ jobs: [] })),
      api("/api/setup").catch(() => null),
    ]);
    state.deploys = deploys.runs || [];
    state.artifacts = artifacts.artifacts || [];
    state.devices = devices;
    state.jobs = jobs.jobs || [];
    if (setup) state.setup = setup;
  } catch (e) {
    state.error = String(e.message || e);
  }
  render();
}

const TAB_ICONS = {
  projects: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>`,
  cursor: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19L19 5"/><path d="M9 5h10v10"/></svg>`,
  status: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l2.5 1.5"/></svg>`,
};

function setupMissing() {
  return (state.setup?.items || []).filter((i) => i.required && !i.ok);
}

function renderSetupBanner() {
  if (!state.setup) return "";
  const missing = setupMissing();

  // Build tab: only interrupt when something is wrong
  if (state.tab === "projects") {
    if (!missing.length) return "";
    return `<div class="banner warn">
      <strong>Setup needed</strong>
      <div class="muted">${escapeHtml(missing.map((m) => m.label).join(" · "))}</div>
      <button type="button" class="secondary" data-tab-jump="status" style="margin-top:0.65rem">Fix in Setup</button>
    </div>`;
  }

  if (state.tab !== "status") return "";

  return `<div class="card">
    <h2>Checklist</h2>
    <p class="muted lead">Green means you’re ready to build.</p>
    ${(state.setup.items || [])
      .map(
        (i) => `<div class="list-item checklist-item">
          <span class="badge ${i.ok ? "ok" : i.required ? "err" : "run"}">${i.ok ? "OK" : "TODO"}</span>
          <div class="checklist-copy">
            <span class="title">${escapeHtml(i.label)}</span>
            ${i.hint && !i.ok ? `<div class="muted">${escapeHtml(i.hint)}</div>` : ""}
          </div>
        </div>`,
      )
      .join("")}
  </div>`;
}

function renderJobCard() {
  const job = state.activeJob;
  if (!job) return "";
  const live = isLiveJob(job);
  const logs = job.logs || [];
  const latestLog = logs.length ? logs[logs.length - 1] : "";
  const showFullLogs = live || state.showLogs;
  const statusClass =
    job.status === "succeeded"
      ? "ok"
      : job.status === "failed"
        ? "err"
        : job.status === "cancelled"
          ? "err"
          : "run";
  const title =
    job.status === "succeeded"
      ? "Ready to install"
      : job.status === "failed"
        ? "Build failed"
        : job.status === "cancelled"
          ? "Build cancelled"
          : "Building…";
  const startedMs = job.createdAt ? Date.parse(job.createdAt) : NaN;
  const elapsed =
    live && !Number.isNaN(startedMs)
      ? (() => {
          const sec = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
          if (sec < 60) return `${sec}s`;
          const min = Math.floor(sec / 60);
          return min < 60 ? `${min}m ${sec % 60}s` : `${Math.floor(min / 60)}h ${min % 60}m`;
        })()
      : "";

  return `<div class="card job-card ${live ? "is-live" : ""} ${job.status === "succeeded" ? "is-ready" : ""}">
    <div class="job-head">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted job-meta">${escapeHtml(job.scheme || job.repository)} · ${escapeHtml(job.ref)} · ${escapeHtml(job.deployMode)}${
          elapsed ? ` · ${escapeHtml(elapsed)}` : ""
        }</p>
      </div>
      <span class="badge ${statusClass}">${escapeHtml(job.status)}</span>
    </div>
    ${
      live && latestLog
        ? `<p class="job-latest"><span class="pulse" aria-hidden="true"></span>${escapeHtml(latestLog)}</p>`
        : ""
    }
    ${
      live
        ? `<button type="button" class="secondary" id="cancelJobBtn" ${
            state.cancelling ? "disabled" : ""
          } style="margin-top:0.65rem">${
            state.cancelling ? "Cancelling…" : "Cancel build"
          }</button>`
        : ""
    }
    ${job.installUrl ? `<a class="primary" href="${escapeAttr(job.installUrl)}">Install on this iPhone</a>` : ""}
    ${job.itmsUrl && !job.installUrl ? `<a class="primary" href="${escapeAttr(job.itmsUrl)}">Install via itms-services</a>` : ""}
    ${
      job.testflightNote
        ? `<p class="success">${escapeHtml(job.testflightNote)}</p>
           <a class="secondary block" href="https://appstoreconnect.apple.com/apps" target="_blank" rel="noopener" style="margin-top:0.5rem">Open App Store Connect</a>
           <a class="secondary block" href="itms-beta://" style="margin-top:0.5rem">Open TestFlight app</a>`
        : ""
    }
    ${job.error && job.status !== "cancelled" ? `<p class="error">${escapeHtml(job.error)}</p>` : ""}
    ${
      logs.length
        ? `${
            !live
              ? `<button type="button" class="text-btn" id="toggleLogs">${state.showLogs ? "Hide log" : "Show log"}</button>`
              : `<p class="hint" style="margin-top:0.65rem">Live log · updates every few seconds</p>`
          }
           ${showFullLogs ? `<pre class="log">${escapeHtml(logs.slice(-40).join("\n"))}</pre>` : ""}`
        : live
          ? `<p class="muted" style="margin-top:0.65rem">Waiting for first log line…</p>`
          : ""
    }
  </div>`;
}

function renderModeSeg() {
  const modes = [
    { id: "ota", title: "OTA", desc: "Fast · Tailscale" },
    { id: "testflight", title: "TestFlight", desc: "Works anywhere" },
    { id: "direct", title: "This device", desc: state.platform === "watchos" ? "Paired Watch" : "Paired phone" },
  ];
  // "both" lives in Advanced
  return `<div class="seg seg-3" role="radiogroup" aria-label="How to install">
    ${modes
      .map(
        (m) => `<button type="button" class="seg-option ${
          state.deployMode === m.id ? "active" : ""
        }" data-mode="${m.id}" role="radio" aria-checked="${
          state.deployMode === m.id ? "true" : "false"
        }">
          <span class="seg-title">${escapeHtml(m.title)}</span>
          <span class="seg-desc">${escapeHtml(m.desc)}</span>
        </button>`,
      )
      .join("")}
  </div>`;
}

function renderPlatformSeg() {
  const platforms = [
    { id: "ios", title: "iPhone", desc: "iOS (+ companion Watch)" },
    { id: "watchos", title: "Apple Watch", desc: "watchOS scheme" },
  ];
  return `<div class="seg seg-2" role="radiogroup" aria-label="Device platform">
    ${platforms
      .map(
        (p) => `<button type="button" class="seg-option ${
          state.platform === p.id ? "active" : ""
        }" data-platform="${p.id}" role="radio" aria-checked="${
          state.platform === p.id ? "true" : "false"
        }">
          <span class="seg-title">${escapeHtml(p.title)}</span>
          <span class="seg-desc">${escapeHtml(p.desc)}</span>
        </button>`,
      )
      .join("")}
  </div>`;
}

function renderProjects() {
  const repoOptions = state.repos
    .map(
      (r) =>
        `<option value="${escapeAttr(r.full_name)}" ${
          r.full_name === state.selectedRepo ? "selected" : ""
        }>${escapeHtml(r.name)}${r.favorite ? " ★" : ""}</option>`,
    )
    .join("");
  const branchOptions = state.branches
    .map(
      (b) =>
        `<option value="${escapeAttr(b.name)}" ${
          b.name === state.selectedRef ? "selected" : ""
        }>${escapeHtml(b.name)}</option>`,
    )
    .join("");

  const iosProjects = state.ios?.projects || [];
  const modeHelp = {
    ota:
      state.platform === "watchos"
        ? "Safari itms-services is iPhone-oriented — prefer Direct to a paired Watch. Companion Watch apps usually ship inside an iPhone build."
        : "Install over Tailscale from the couch.",
    direct:
      state.platform === "watchos"
        ? "Install on a Watch paired via Core Device (Developer Mode on)."
        : "Install on a phone paired to this Mac.",
    both: "OTA page plus direct install if paired.",
    testflight:
      state.platform === "watchos"
        ? "Upload for TestFlight. Watch-only apps usually need an iOS container scheme. Check ASC Builds after upload — processing can take a while."
        : "Upload to App Store Connect. Watch status in ASC → TestFlight → Builds (phone app hides Processing).",
  };
  const watchOtaWarn =
    state.platform === "watchos" &&
    (state.deployMode === "ota" || state.deployMode === "both");

  const summaryBits = [
    state.platform === "watchos" ? "watchOS" : "iOS",
    state.scheme || null,
    state.projectPath && state.projectPath !== "." ? state.projectPath : null,
  ].filter(Boolean);

  const ctaLabel = state.busy
    ? "Building…"
    : state.deployMode === "testflight"
      ? "Build & upload"
      : "Build & install";

  const jobFirst =
    state.activeJob &&
    (isLiveJob(state.activeJob) ||
      state.activeJob.status === "succeeded" ||
      state.activeJob.status === "failed" ||
      state.activeJob.status === "cancelled");

  return `
    ${renderSetupBanner()}
    ${jobFirst ? renderJobCard() : ""}
    <div class="card build-card ${state.busy ? "is-dim" : ""}">
      <div class="step">
        <div class="step-label">1 · What</div>
        <div class="field-pair">
          <div class="field">
            <label for="repoSelect">App</label>
            <select id="repoSelect">${repoOptions || "<option value=''>No apps</option>"}</select>
          </div>
          <div class="field">
            <label for="branchSelect">Branch</label>
            <select id="branchSelect">${branchOptions || `<option>${escapeHtml(state.selectedRef || "")}</option>`}</select>
          </div>
        </div>
        <div class="field" style="margin-top:0.65rem">
          <label>Device</label>
          ${renderPlatformSeg()}
        </div>
        ${
          summaryBits.length && !state.showAdvanced
            ? `<p class="summary-line">${escapeHtml(summaryBits.join(" · "))}</p>`
            : ""
        }
      </div>

      <div class="step">
        <div class="step-label">2 · Install</div>
        ${renderModeSeg()}
        <p class="hint">${escapeHtml(
          state.deployMode === "both"
            ? "OTA + Direct selected in Advanced."
            : modeHelp[state.deployMode] || "",
        )}</p>
        ${
          watchOtaWarn
            ? `<p class="hint warn-inline">Watch + OTA is often a dead end on the Watch itself — switch to <strong>This device</strong> (Direct) unless you know you need the IPA page.</p>`
            : ""
        }
      </div>

      <button class="primary" id="deployBtn" ${state.busy || !state.scheme || !state.selectedRepo ? "disabled" : ""}>
        ${escapeHtml(ctaLabel)}
      </button>
      ${state.message ? `<p class="success">${escapeHtml(state.message)}</p>` : ""}
      ${state.warning ? `<p class="hint">${escapeHtml(state.warning)}</p>` : ""}
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}

      <button type="button" class="disclosure" id="toggleAdvanced" aria-expanded="${state.showAdvanced}">
        <span>${state.showAdvanced ? "Hide advanced" : "Advanced"}</span>
        <span class="chev ${state.showAdvanced ? "open" : ""}" aria-hidden="true"></span>
      </button>

      <div class="advanced ${state.showAdvanced ? "" : "hidden"}">
        <div class="field-pair">
          <div class="field">
            <label for="pathInput">Project path</label>
            <input id="pathInput" value="${escapeAttr(state.projectPath || ".")}" autocomplete="off" />
          </div>
          <div class="field">
            <label for="schemeInput">Scheme</label>
            <input id="schemeInput" value="${escapeAttr(state.scheme || "")}" placeholder="GuideAI" autocomplete="off" />
          </div>
        </div>
        <div class="field" style="margin-top:0.65rem">
          <label for="engineSelect">Build on</label>
          <select id="engineSelect">
            <option value="local" ${state.engine === "local" ? "selected" : ""}>This Mac</option>
            <option value="actions" ${state.engine === "actions" ? "selected" : ""}>GitHub Actions runner</option>
          </select>
        </div>
        <div class="field" style="margin-top:0.65rem">
          <label>Also</label>
          <button type="button" class="seg-option ${state.deployMode === "both" ? "active" : ""}" data-mode="both" style="width:100%">
            <span class="seg-title">OTA + Direct</span>
            <span class="seg-desc">Both install paths at once</span>
          </button>
        </div>
        ${
          iosProjects.length
            ? `<div class="field" style="margin-top:0.85rem">
                <label>Detected apps</label>
                ${iosProjects
                  .map(
                    (p) =>
                      `                      <button type="button" class="list-item tappable pick-ios" data-path="${escapeAttr(
                        p.projectPath,
                      )}" data-scheme="${escapeAttr(p.name)}" data-platform="${escapeAttr(
                        (p.platforms && p.platforms[0]) || "ios",
                      )}">
                        <span class="title">${escapeHtml(p.name)}</span>
                        <span class="badge">${escapeHtml(p.kind)}</span>
                        ${(p.platforms || ["ios"])
                          .map((pl) => `<span class="badge">${escapeHtml(pl)}</span>`)
                          .join("")}
                        <div class="muted">${escapeHtml(p.projectPath)}</div>
                      </button>`,
                  )
                  .join("")}
              </div>`
            : ""
        }
      </div>
    </div>
    ${!jobFirst ? renderJobCard() : ""}
  `;
}

function renderCursor() {
  if (state.openingAgentId) {
    const pending =
      state.agents.find((a) => a.id === state.openingAgentId) || null;
    const title = pending?.name || "Agent";
    return `
      <div class="card">
        <button class="text-btn" id="backAgents" type="button">← Cancel</button>
        <div class="loading-panel" role="status" aria-live="polite">
          <div class="spinner" aria-hidden="true"></div>
          <div>
            <h2 style="margin:0">${escapeHtml(title)}</h2>
            <p class="muted lead" style="margin:0.35rem 0 0">Opening agent…</p>
          </div>
        </div>
        <div class="skeleton-block" aria-hidden="true"></div>
        <div class="skeleton-block short" aria-hidden="true"></div>
      </div>
    `;
  }

  if (state.agentDetail) {
    const d = state.agentDetail;
    const userMsgs = (d.userMessages || []).slice().reverse().slice(0, 6);
    const branch = (d.agent.branches || []).find((b) => b.branch);
    return `
      <div class="card">
        <button class="text-btn" id="backAgents" type="button">← All agents</button>
        <h2 style="margin-top:0.5rem">${escapeHtml(d.agent.name)}</h2>
        <p class="muted lead">${escapeHtml(d.agent.status || "")}${
          d.agent.archived || isArchivedAgent(d.agent) ? " · archived" : ""
        } · ${escapeHtml(fmtTime(d.agent.updatedAt))}</p>
        ${
          branch
            ? `<p class="summary-line"><strong>${escapeHtml(branch.branch || "")}</strong>
                ${branch.prUrl ? ` · <a href="${escapeAttr(branch.prUrl)}" target="_blank" rel="noopener">PR</a>` : ""}
               </p>`
            : ""
        }
        <button class="primary" id="deployAgentBtn" type="button">Build this branch</button>
        <a class="secondary block" href="${escapeAttr(d.cursorUrl)}" target="_blank" rel="noopener" style="margin-top:0.55rem">Open in Cursor</a>
      </div>
      ${
        userMsgs.length || d.lastAssistantMessage
          ? `<div class="card">
              <h2>Context</h2>
              ${userMsgs.map((t) => `<div class="prompt">${escapeHtml(t)}</div>`).join("")}
              ${
                d.lastAssistantMessage
                  ? `<div class="prompt assistant">${escapeHtml(d.lastAssistantMessage)}</div>`
                  : ""
              }
            </div>`
          : ""
      }
    `;
  }

  const filtered = filteredAgents();
  const archivedCount = (state.agents || []).filter(isArchivedAgent).length;
  const hiddenByFilter =
    (state.agents || []).length - filtered.length;

  return `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div>
          <h2>Agents</h2>
          <p class="muted lead" style="margin-bottom:0">Pick a Cloud Agent branch to build.</p>
        </div>
        <button class="secondary" id="refreshAgents" type="button" ${
          state.agentsLoading ? "disabled" : ""
        }>${state.agentsLoading ? "Loading…" : "Refresh"}</button>
      </div>

      <div class="filter-bar">
        <label class="sr-only" for="agentsQuery">Search agents</label>
        <input
          id="agentsQuery"
          type="search"
          enterkeyhint="search"
          placeholder="Search name or branch…"
          value="${escapeAttr(state.agentsQuery)}"
          autocomplete="off"
        />
        <label class="check-row">
          <input type="checkbox" id="agentsShowArchived" ${
            state.agentsShowArchived ? "checked" : ""
          } />
          <span>Show archived${archivedCount ? ` (${archivedCount})` : ""}</span>
        </label>
      </div>

      ${state.warning ? `<p class="hint">${escapeHtml(state.warning)}</p>` : ""}
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}

      ${
        state.agentsLoading && !state.agents.length
          ? `<div class="loading-panel" role="status" aria-live="polite" style="margin-top:0.85rem">
              <div class="spinner" aria-hidden="true"></div>
              <p class="muted" style="margin:0">Loading agents…</p>
            </div>
            <div class="skeleton-block" aria-hidden="true"></div>
            <div class="skeleton-block" aria-hidden="true"></div>
            <div class="skeleton-block short" aria-hidden="true"></div>`
          : filtered.length
            ? `<div class="stack" style="margin-top:0.75rem">
                ${filtered
                  .map(
                    (a) => `<button type="button" class="list-item tappable ${
                      isArchivedAgent(a) ? "is-archived" : ""
                    }" data-agent="${escapeAttr(a.id)}">
                      <div class="title">${escapeHtml(a.name)}
                        ${a.relevance > 40 ? `<span class="badge fav">likely</span>` : ""}
                        ${agentStatusBadge(a)}
                      </div>
                      <div class="muted">${escapeHtml(fmtTime(a.updatedAt))}</div>
                    </button>`,
                  )
                  .join("")}
              </div>
              ${
                hiddenByFilter
                  ? `<p class="hint">${hiddenByFilter} hidden by filters</p>`
                  : ""
              }`
            : `<p class="muted" style="margin-top:0.75rem">${
                state.agents.length
                  ? "No agents match these filters."
                  : 'No agents yet. Add <code>CURSOR_API_KEY</code> in <code>.env</code>.'
              }</p>`
      }
    </div>
  `;
}

function renderStatus() {
  const missing = setupMissing();
  const needToken = state.apiAuthRequired && !state.apiToken;
  const health = state.config
    ? `<div class="kv"><span>Tailscale</span><code>${escapeHtml(state.config.tsHost || "unset")}</code></div>
       <div class="kv"><span>Engine</span><code>${escapeHtml(state.config.deployEngine || "local")}</code></div>`
    : "";
  const devices = state.devices
    ? (() => {
        const phones = state.devices.phones || [];
        const watches = state.devices.watches || [];
        if (!phones.length && !watches.length) {
          return `<p class="muted">None paired — OTA and TestFlight still work.</p>`;
        }
        return [
          ...phones.map((p) => `<div class="list-item"><span class="badge">iPhone</span> ${escapeHtml(p)}</div>`),
          ...watches.map((w) => `<div class="list-item"><span class="badge">Watch</span> ${escapeHtml(w)}</div>`),
        ].join("");
      })()
    : `<p class="muted">Device probe unavailable.</p>`;
  const localJobs = (state.jobs || []).slice(0, 6);
  const jobsHtml = localJobs.length
    ? localJobs
        .map(
          (j) => `<div class="list-item">
            <span class="badge ${
              j.status === "succeeded"
                ? "ok"
                : j.status === "failed" || j.status === "cancelled"
                  ? "err"
                  : "run"
            }">${escapeHtml(j.status)}</span>
            <span class="title">${escapeHtml(j.scheme)}</span>
            <div class="muted">${escapeHtml(j.ref)} · ${escapeHtml(fmtTime(j.updatedAt))}</div>
            ${j.installUrl ? `<a class="secondary" href="${escapeAttr(j.installUrl)}" style="margin-top:0.5rem">Install</a>` : ""}
          </div>`,
        )
        .join("")
    : `<p class="muted">No builds yet.</p>`;
  const runs = (state.deploys || []).slice(0, 5);
  const runsHtml = runs.length
    ? runs
        .map((r) => {
          const badge =
            r.status === "completed"
              ? r.conclusion === "success"
                ? "ok"
                : "err"
              : "run";
          return `<div class="list-item">
            <span class="title">${escapeHtml(r.display_title || r.name || String(r.id))}</span>
            <span class="badge ${badge}">${escapeHtml(r.status)}</span>
            <div class="muted"><a href="${escapeAttr(r.html_url)}" target="_blank" rel="noopener">View on GitHub</a></div>
          </div>`;
        })
        .join("")
    : `<p class="muted">None (normal for local builds).</p>`;
  const arts = (state.artifacts || []).slice(0, 5);
  const artsHtml = arts.length
    ? arts
        .map(
          (a) => `<div class="list-item">
            <div class="title">${escapeHtml(a.title || a.id)}</div>
            ${a.installUrl ? `<a class="secondary" href="${escapeAttr(a.installUrl)}" style="margin-top:0.4rem">Install page</a>` : ""}
          </div>`,
        )
        .join("")
    : `<p class="muted">None yet.</p>`;

  return `
    ${
      needToken || state.apiAuthRequired
        ? `<div class="card ${needToken ? "card-emphasis" : ""}">
            <h2>API token</h2>
            <p class="muted lead">Paste <code>BSL_API_TOKEN</code> from your Mac’s <code>.env</code>.</p>
            <label for="apiTokenInput">Token</label>
            <input id="apiTokenInput" type="password" autocomplete="off" value="${escapeAttr(state.apiToken)}" placeholder="BSL_API_TOKEN" />
            <div class="section-actions">
              <button class="primary" id="saveApiToken" type="button" style="margin-top:0.5rem">Save</button>
            </div>
            ${
              needToken
                ? `<p class="error">Required before you can build.</p>`
                : state.apiToken
                  ? `<p class="success">Saved on this phone.</p>`
                  : ""
            }
          </div>`
        : ""
    }
    ${renderSetupBanner()}
    ${
      !missing.length && state.setup
        ? `<div class="banner ok compact">All required setup looks good.</div>`
        : ""
    }
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h2 style="margin:0">Recent builds</h2>
        <button class="secondary" id="refreshStatus" type="button">Refresh</button>
      </div>
      <div style="margin-top:0.75rem">${jobsHtml}</div>
    </div>
    <button type="button" class="disclosure block-disclosure" id="toggleStatusMore" aria-expanded="${state.showStatusMore}">
      <span>${state.showStatusMore ? "Hide details" : "Environment & more"}</span>
      <span class="chev ${state.showStatusMore ? "open" : ""}" aria-hidden="true"></span>
    </button>
    <div class="${state.showStatusMore ? "" : "hidden"}">
      <div class="card">
        <h2>Environment</h2>
        ${health}
      </div>
      <div class="card"><h2>Paired devices</h2>${devices}</div>
      <div class="card"><h2>GitHub Actions</h2>${runsHtml}</div>
      <div class="card"><h2>OTA pages</h2>${artsHtml}</div>
    </div>
  `;
}

function renderShellOnce() {
  if (app.querySelector("nav.tabs") && app.querySelector("#view")) return;

  app.innerHTML = `
    <header class="appbar">
      <div class="brand">
        <h1>buildswiftlazily</h1>
        <span class="tagline">couch → phone</span>
      </div>
      <div class="pill" id="statusPill">…</div>
    </header>
    <main id="view"></main>
    <nav class="tabs" aria-label="Primary">
      <button type="button" data-tab="projects" aria-current="false">
        ${TAB_ICONS.projects}<span>Build</span>
      </button>
      <button type="button" data-tab="cursor" aria-current="false">
        ${TAB_ICONS.cursor}<span>Agents</span>
      </button>
      <button type="button" data-tab="status" aria-current="false">
        ${TAB_ICONS.status}<span>Setup</span>
      </button>
    </nav>
  `;

  app.querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => setTab(btn.getAttribute("data-tab"))),
  );
}

function bindViewEvents(view) {
  view.querySelectorAll("[data-tab-jump]").forEach((btn) =>
    btn.addEventListener("click", () => setTab(btn.getAttribute("data-tab-jump"))),
  );

  const repoSelect = view.querySelector("#repoSelect");
  if (repoSelect) {
    repoSelect.addEventListener("change", async (e) => {
      const full = e.target.value;
      const meta = state.repos.find((r) => r.full_name === full);
      await selectRepo(full, meta?.default_branch, meta);
    });
  }
  const branchSelect = view.querySelector("#branchSelect");
  if (branchSelect) {
    branchSelect.addEventListener("change", async (e) => {
      state.selectedRef = e.target.value;
      try {
        await refreshIos();
      } catch (err) {
        state.error = String(err.message || err);
      }
      render();
    });
  }
  const pathInput = view.querySelector("#pathInput");
  if (pathInput) pathInput.addEventListener("change", (e) => (state.projectPath = e.target.value));
  const schemeInput = view.querySelector("#schemeInput");
  if (schemeInput) {
    schemeInput.addEventListener("input", (e) => {
      state.scheme = e.target.value;
      const btn = view.querySelector("#deployBtn");
      if (btn) btn.disabled = state.busy || !state.scheme || !state.selectedRepo;
    });
  }
  view.querySelectorAll("[data-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.deployMode = btn.getAttribute("data-mode") || "ota";
      render();
    }),
  );
  view.querySelectorAll("[data-platform]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.platform = btn.getAttribute("data-platform") || "ios";
      render();
    }),
  );
  const engineSelect = view.querySelector("#engineSelect");
  if (engineSelect)
    engineSelect.addEventListener("change", (e) => (state.engine = e.target.value));
  const deployBtn = view.querySelector("#deployBtn");
  if (deployBtn) deployBtn.addEventListener("click", deploy);
  const cancelJobBtn = view.querySelector("#cancelJobBtn");
  if (cancelJobBtn) cancelJobBtn.addEventListener("click", cancelActiveJob);
  view.querySelectorAll(".pick-ios").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.projectPath = btn.getAttribute("data-path") || ".";
      state.scheme = btn.getAttribute("data-scheme") || state.scheme;
      const pl = btn.getAttribute("data-platform");
      if (pl === "ios" || pl === "watchos") state.platform = pl;
      render();
    }),
  );

  const toggleAdvanced = view.querySelector("#toggleAdvanced");
  if (toggleAdvanced)
    toggleAdvanced.addEventListener("click", () => {
      state.showAdvanced = !state.showAdvanced;
      render();
    });
  const toggleLogs = view.querySelector("#toggleLogs");
  if (toggleLogs)
    toggleLogs.addEventListener("click", () => {
      state.showLogs = !state.showLogs;
      render();
    });
  const toggleStatusMore = view.querySelector("#toggleStatusMore");
  if (toggleStatusMore)
    toggleStatusMore.addEventListener("click", () => {
      state.showStatusMore = !state.showStatusMore;
      render();
    });

  const refreshAgents = view.querySelector("#refreshAgents");
  if (refreshAgents) refreshAgents.addEventListener("click", loadAgents);

  const agentsQuery = view.querySelector("#agentsQuery");
  if (agentsQuery) {
    agentsQuery.addEventListener("input", (e) => {
      state.agentsQuery = e.target.value || "";
      persistAgentsFilters();
      const start = agentsQuery.selectionStart;
      const end = agentsQuery.selectionEnd;
      render();
      const again = app.querySelector("#agentsQuery");
      if (again) {
        again.focus();
        try {
          again.setSelectionRange(start, end);
        } catch {
          /* ignore */
        }
      }
    });
  }
  const agentsShowArchived = view.querySelector("#agentsShowArchived");
  if (agentsShowArchived) {
    agentsShowArchived.addEventListener("change", (e) => {
      state.agentsShowArchived = Boolean(e.target.checked);
      persistAgentsFilters();
      render();
    });
  }

  view.querySelectorAll("[data-agent]").forEach((btn) =>
    btn.addEventListener("click", () => openAgent(btn.getAttribute("data-agent"))),
  );
  const backAgents = view.querySelector("#backAgents");
  if (backAgents)
    backAgents.addEventListener("click", () => {
      state.agentDetail = null;
      state.openingAgentId = null;
      render();
    });
  const deployAgentBtn = view.querySelector("#deployAgentBtn");
  if (deployAgentBtn) deployAgentBtn.addEventListener("click", deployFromAgent);

  const refreshStatus = view.querySelector("#refreshStatus");
  if (refreshStatus) refreshStatus.addEventListener("click", loadStatus);

  const saveApiToken = view.querySelector("#saveApiToken");
  if (saveApiToken) {
    saveApiToken.addEventListener("click", async () => {
      const input = view.querySelector("#apiTokenInput");
      state.apiToken = (input?.value || "").trim();
      try {
        if (state.apiToken) localStorage.setItem(TOKEN_KEY, state.apiToken);
        else localStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
      state.message = "API token saved on this device";
      state.error = "";
      await bootstrap();
    });
  }
}

/** Stable identity for #view content; scroll is kept only across same-key renders. */
let lastScrollViewKey = "";
function scrollViewKey() {
  if (state.tab === "cursor") {
    if (state.openingAgentId || state.agentDetail) return "cursor:detail";
    return "cursor:list";
  }
  return state.tab;
}

function nearBottom(el, px = 48) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= px;
}

/** Update shell chrome (pill + tabs) without touching #view. */
function updateShellChrome() {
  const statusLabel = state.busy
    ? "building…"
    : state.openingAgentId || state.agentsLoading
      ? "loading…"
      : setupMissing().length
        ? "setup needed"
        : "ready";

  const pill = app.querySelector("#statusPill");
  if (pill) {
    pill.textContent = statusLabel;
    pill.className = `pill ${
      state.busy || state.openingAgentId || state.agentsLoading
        ? "pill-busy"
        : setupMissing().length
          ? "pill-warn"
          : "pill-ok"
    }`;
  }

  app.querySelectorAll("nav.tabs [data-tab]").forEach((btn) => {
    const tab = btn.getAttribute("data-tab");
    const active = tab === state.tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-current", active ? "page" : "false");
  });
}

/**
 * In-place patch for live job polls so #view / log console don't jump to top.
 * Returns true when the DOM was patched without a full innerHTML swap.
 */
function tryPatchLiveJobCard(view) {
  if (state.tab !== "projects") return false;
  const job = state.activeJob;
  if (!job || !isLiveJob(job)) return false;
  const card = view.querySelector(".job-card.is-live");
  if (!card) return false;

  const badge = card.querySelector(".badge");
  if (badge) {
    badge.textContent = job.status;
    badge.className = `badge run`;
  }

  const meta = card.querySelector(".job-meta");
  if (meta) {
    const startedMs = job.createdAt ? Date.parse(job.createdAt) : NaN;
    let elapsed = "";
    if (!Number.isNaN(startedMs)) {
      const sec = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
      if (sec < 60) elapsed = `${sec}s`;
      else {
        const min = Math.floor(sec / 60);
        elapsed =
          min < 60 ? `${min}m ${sec % 60}s` : `${Math.floor(min / 60)}h ${min % 60}m`;
      }
    }
    meta.textContent = `${job.scheme || job.repository} · ${job.ref} · ${job.deployMode}${
      elapsed ? ` · ${elapsed}` : ""
    }`;
  }

  const logs = job.logs || [];
  const latestLog = logs.length ? logs[logs.length - 1] : "";
  let latest = card.querySelector(".job-latest");
  if (latestLog) {
    if (!latest) {
      latest = document.createElement("p");
      latest.className = "job-latest";
      const cancelBtn = card.querySelector("#cancelJobBtn");
      if (cancelBtn) card.insertBefore(latest, cancelBtn);
      else card.appendChild(latest);
    }
    latest.innerHTML = `<span class="pulse" aria-hidden="true"></span>${escapeHtml(latestLog)}`;
  } else if (latest) {
    latest.remove();
  }

  const cancelBtn = card.querySelector("#cancelJobBtn");
  if (cancelBtn) {
    cancelBtn.disabled = !!state.cancelling;
    cancelBtn.textContent = state.cancelling ? "Cancelling…" : "Cancel build";
  }

  let logPre = card.querySelector("pre.log");
  const logText = logs.length ? logs.slice(-40).join("\n") : "";
  if (logs.length) {
    if (!logPre) {
      const hint = card.querySelector(".hint");
      logPre = document.createElement("pre");
      logPre.className = "log";
      if (hint) hint.after(logPre);
      else card.appendChild(logPre);
    }
    const stick = nearBottom(logPre);
    if (logPre.textContent !== logText) {
      logPre.textContent = logText;
      if (stick) logPre.scrollTop = logPre.scrollHeight;
    }
  }

  const waiting = card.querySelector(".muted");
  if (waiting && /Waiting for first log/.test(waiting.textContent || "")) {
    if (logs.length) waiting.remove();
  }

  const deployBtn = view.querySelector("#deployBtn");
  if (deployBtn) {
    deployBtn.disabled = state.busy || !state.scheme || !state.selectedRepo;
    deployBtn.textContent = state.busy
      ? "Building…"
      : state.deployMode === "testflight"
        ? "Build & upload"
        : "Build & install";
  }
  const buildCard = view.querySelector(".build-card");
  if (buildCard) buildCard.classList.toggle("is-dim", !!state.busy);

  return true;
}

function restoreScrollPositions(view, { viewScrollTop, logScrollTop, logStickBottom }) {
  const apply = () => {
    view.scrollTop = viewScrollTop;
    const logPre = view.querySelector("pre.log");
    if (!logPre) return;
    if (logStickBottom) logPre.scrollTop = logPre.scrollHeight;
    else if (logScrollTop != null) logPre.scrollTop = logScrollTop;
  };
  apply();
  // iOS Safari often ignores sync scrollTop right after innerHTML — re-apply twice.
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
}

function render(opts = {}) {
  const allowPatch = !!opts.allowPatch;
  renderShellOnce();
  updateShellChrome();

  const view = app.querySelector("#view");
  if (!view) return;
  const key = scrollViewKey();

  // Live poll path: patch the job card in place so the console doesn't jump.
  if (allowPatch && key === lastScrollViewKey && tryPatchLiveJobCard(view)) {
    return;
  }

  const body =
    state.tab === "projects"
      ? renderProjects()
      : state.tab === "cursor"
        ? renderCursor()
        : renderStatus();

  const sameKey = key === lastScrollViewKey;
  const viewScrollTop = sameKey ? view.scrollTop : 0;
  const logEl = view.querySelector("pre.log");
  const logScrollTop = sameKey && logEl ? logEl.scrollTop : null;
  const logStickBottom =
    !sameKey ||
    !logEl ||
    nearBottom(logEl) ||
    (state.activeJob && isLiveJob(state.activeJob));

  view.innerHTML = body;
  lastScrollViewKey = key;
  bindViewEvents(view);
  restoreScrollPositions(view, { viewScrollTop, logScrollTop, logStickBottom });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;");
}

let resumeOnShowTimer = null;
function scheduleResumeOnShow() {
  if (resumeOnShowTimer) clearTimeout(resumeOnShowTimer);
  resumeOnShowTimer = setTimeout(async () => {
    resumeOnShowTimer = null;
    // Skip if we are already polling a live job.
    if (state.pollTimer && state.activeJob && isLiveJob(state.activeJob)) return;
    try {
      const resumed = await resumeActiveJob();
      if (resumed) render();
    } catch {
      /* ignore */
    }
  }, 200);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleResumeOnShow();
});
window.addEventListener("pageshow", (e) => {
  // BFCache restores can leave timers dead — always try to reattach.
  if (e.persisted) scheduleResumeOnShow();
});

bootstrap();
