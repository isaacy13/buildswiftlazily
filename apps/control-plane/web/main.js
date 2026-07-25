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
  agents: [],
  agentDetail: null,
  deploys: [],
  artifacts: [],
  devices: null,
  jobs: [],
  activeJobId: null,
  activeJob: null,
  busy: false,
  message: "",
  error: "",
  warning: "",
  pollTimer: null,
};

const app = document.getElementById("app");

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
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
    state.config = await api("/api/config");
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
    state.error = String(e.message || e);
  }
  render();
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
    if (job.status === "succeeded" || job.status === "failed") {
      stopPoll();
      state.busy = false;
      if (job.status === "succeeded") {
        if (job.installUrl) {
          state.message = "Build ready — tap Install below.";
        } else if (job.testflightNote) {
          state.message = job.testflightNote;
        } else {
          state.message = "Deploy finished.";
        }
      } else {
        state.error = job.error || "Deploy failed — see log.";
      }
      await loadStatus();
    }
  } catch (e) {
    state.error = String(e.message || e);
    stopPoll();
    state.busy = false;
  }
  render();
}

async function deploy() {
  if (!state.scheme?.trim()) {
    state.error = "Enter an Xcode scheme (e.g. GuideAI).";
    render();
    return;
  }
  state.busy = true;
  state.error = "";
  state.message = "";
  state.activeJob = null;
  stopPoll();
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
        title: state.scheme,
      }),
    });
    state.message = result.message;
    state.activeJobId = result.jobId;
    if (result.engine === "local" && result.jobId) {
      state.pollTimer = setInterval(() => pollJob(result.jobId), 1500);
      await pollJob(result.jobId);
    } else {
      state.busy = false;
      await loadStatus();
      render();
    }
  } catch (e) {
    state.error = String(e.message || e);
    state.busy = false;
    render();
  }
}

async function loadAgents() {
  try {
    const data = await api("/api/cursor/agents");
    state.agents = data.agents || [];
    if (data.warning) state.warning = data.warning;
    if (data.error) state.error = data.error;
  } catch (e) {
    state.error = String(e.message || e);
  }
  render();
}

async function openAgent(id) {
  state.agentDetail = null;
  state.busy = true;
  render();
  try {
    state.agentDetail = await api(`/api/cursor/agents/${encodeURIComponent(id)}`);
  } catch (e) {
    state.error = String(e.message || e);
  } finally {
    state.busy = false;
    render();
  }
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

function renderSetupBanner() {
  if (!state.setup) return "";
  const missing = (state.setup.items || []).filter((i) => i.required && !i.ok);
  const optionalBad = (state.setup.items || []).filter((i) => !i.required && !i.ok);
  if (!missing.length && state.tab !== "status") {
    return `<div class="banner ok">Ready for local builds on this Mac. Prefer <strong>OTA</strong> on the couch, <strong>TestFlight</strong> when you want Apple-hosted installs.</div>`;
  }
  if (state.tab === "projects" && missing.length) {
    return `<div class="banner warn">
      <strong>Finish setup</strong> (${missing.map((m) => m.label).join(", ")})
      <div class="muted" style="margin-top:0.35rem">Open the Status tab for the checklist · see docs/SETUP.md</div>
    </div>`;
  }
  if (state.tab === "status") {
    return `<div class="card"><h2>Setup checklist</h2>
      ${(state.setup.items || [])
        .map(
          (i) => `<div class="list-item">
            <span class="badge ${i.ok ? "ok" : i.required ? "err" : "run"}">${i.ok ? "OK" : "TODO"}</span>
            <span class="title">${escapeHtml(i.label)}</span>
            ${i.hint && !i.ok ? `<div class="muted">${escapeHtml(i.hint)}</div>` : ""}
          </div>`,
        )
        .join("")}
      ${
        optionalBad.length
          ? `<p class="muted">Optional still open: ${escapeHtml(optionalBad.map((x) => x.label).join(", "))}</p>`
          : ""
      }
    </div>`;
  }
  return "";
}

function renderJobCard() {
  const job = state.activeJob;
  if (!job) return "";
  const logs = (job.logs || []).slice(-12).join("\n");
  return `<div class="card">
    <h2>Live deploy <span class="badge ${job.status === "succeeded" ? "ok" : job.status === "failed" ? "err" : "run"}">${escapeHtml(job.status)}</span></h2>
    <p class="muted">${escapeHtml(job.engine)} · ${escapeHtml(job.repository)}@${escapeHtml(job.ref)} · ${escapeHtml(job.deployMode)}</p>
    ${job.installUrl ? `<a class="primary" href="${escapeAttr(job.installUrl)}">Install on this iPhone</a>` : ""}
    ${job.itmsUrl && !job.installUrl ? `<a class="primary" href="${escapeAttr(job.itmsUrl)}">itms-services install</a>` : ""}
    ${job.testflightNote ? `<p class="success">${escapeHtml(job.testflightNote)}</p><a class="secondary" href="itms-beta://" style="margin-top:0.5rem;width:100%">Open TestFlight</a>` : ""}
    ${job.error ? `<p class="error">${escapeHtml(job.error)}</p>` : ""}
    <pre class="log">${escapeHtml(logs)}</pre>
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
  const iosInfo = state.ios
    ? state.ios.projects?.length
      ? state.ios.projects
          .map(
            (p) =>
              `<button type="button" class="secondary pick-ios" data-path="${escapeAttr(
                p.projectPath,
              )}" data-scheme="${escapeAttr(p.name)}" style="width:100%;margin-top:0.4rem;text-align:left">
                <strong>${escapeHtml(p.name)}</strong> <span class="badge">${escapeHtml(p.kind)}</span>
                <div class="muted">${escapeHtml(p.projectPath)}</div>
              </button>`,
          )
          .join("")
      : `<p class="muted">No Xcode projects auto-detected — set path & scheme manually (common for private GuideAI until token can scan).</p>`
    : `<p class="muted">Select a repo/branch to scan.</p>`;

  const modeHelp = {
    ota: "Fast couch install via Tailscale (Ad Hoc). Works off home Wi‑Fi.",
    direct: "Install+launch on a phone paired to this Mac (USB/Wi‑Fi).",
    both: "OTA page + direct install if paired.",
    testflight: "Upload to App Store Connect → install from TestFlight app (anywhere, slower processing).",
  };

  return `
    ${renderSetupBanner()}
    <div class="card">
      <h2>Build & ship</h2>
      <p class="muted">Pick a branch → tap Build. Default engine runs <strong>on this Mac</strong> (works even if the Actions runner is down).</p>
      <label>Repository</label>
      <select id="repoSelect">${repoOptions || "<option value=''>No repos</option>"}</select>
      <label>Branch</label>
      <select id="branchSelect">${branchOptions || `<option>${escapeHtml(state.selectedRef || "")}</option>`}</select>
      <label>Project path</label>
      <input id="pathInput" value="${escapeAttr(state.projectPath || ".")}" />
      <label>Scheme</label>
      <input id="schemeInput" value="${escapeAttr(state.scheme || "")}" placeholder="GuideAI" />
      <label>How to install</label>
      <select id="modeSelect">
        <option value="ota" ${state.deployMode === "ota" ? "selected" : ""}>OTA (Tailscale) — couch default</option>
        <option value="testflight" ${state.deployMode === "testflight" ? "selected" : ""}>TestFlight — anywhere</option>
        <option value="direct" ${state.deployMode === "direct" ? "selected" : ""}>Direct to paired iPhone</option>
        <option value="both" ${state.deployMode === "both" ? "selected" : ""}>OTA + Direct</option>
      </select>
      <p class="muted">${escapeHtml(modeHelp[state.deployMode] || "")}</p>
      <label>Build where</label>
      <select id="engineSelect">
        <option value="local" ${state.engine === "local" ? "selected" : ""}>This Mac (local) — recommended</option>
        <option value="actions" ${state.engine === "actions" ? "selected" : ""}>GitHub Actions self-hosted runner</option>
      </select>
      <button class="primary" id="deployBtn" ${state.busy || !state.scheme || !state.selectedRepo ? "disabled" : ""}>
        ${state.busy ? "Building…" : state.deployMode === "testflight" ? "Build & Upload to TestFlight" : "Build & Install"}
      </button>
      ${state.message ? `<p class="success">${escapeHtml(state.message)}</p>` : ""}
      ${state.warning ? `<p class="muted">${escapeHtml(state.warning)}</p>` : ""}
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
    </div>
    ${renderJobCard()}
    <div class="card">
      <h2>Detected iOS apps</h2>
      <p class="muted">Tap one to fill path + scheme.</p>
      ${iosInfo}
    </div>
  `;
}

function renderCursor() {
  if (state.agentDetail) {
    const d = state.agentDetail;
    const userMsgs = (d.userMessages || []).slice().reverse().slice(0, 8);
    const runs = (d.runs || []).slice(0, 8);
    return `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <button class="secondary" id="backAgents">← Agents</button>
          <a class="secondary" href="${escapeAttr(d.cursorUrl)}" target="_blank" rel="noopener">Open in Cursor</a>
        </div>
        <h2 style="margin-top:0.75rem">${escapeHtml(d.agent.name)}</h2>
        <p class="muted">${escapeHtml(d.agent.status || "")} · ${escapeHtml(fmtTime(d.agent.updatedAt))}</p>
        ${(d.agent.branches || [])
          .map(
            (b) =>
              `<div class="muted">🌿 ${escapeHtml(b.repoUrl || "")} <strong>${escapeHtml(
                b.branch || "",
              )}</strong>${b.prUrl ? ` · <a href="${escapeAttr(b.prUrl)}" target="_blank">PR</a>` : ""}</div>`,
          )
          .join("")}
        <button class="primary" id="deployAgentBtn">Use this branch to build</button>
      </div>
      <div class="card">
        <h2>Your recent messages</h2>
        ${
          userMsgs.length
            ? userMsgs.map((t) => `<div class="prompt">${escapeHtml(t)}</div>`).join("")
            : `<p class="muted">No user prompts in API history for this agent.</p>`
        }
      </div>
      <div class="card">
        <h2>Latest assistant result</h2>
        <div class="prompt">${escapeHtml(d.lastAssistantMessage || "—")}</div>
      </div>
      <div class="card">
        <h2>Runs</h2>
        ${
          runs.length
            ? runs
                .map(
                  (r) => `<div class="list-item"><span class="title">${escapeHtml(
                    r.status || "",
                  )}</span> <span class="muted">${escapeHtml(fmtTime(r.updatedAt || r.createdAt))}</span>
                  ${r.result ? `<div class="prompt">${escapeHtml(r.result.slice(0, 500))}</div>` : ""}
                  </div>`,
                )
                .join("")
            : `<p class="muted">No runs.</p>`
        }
      </div>
    `;
  }

  return `
    <div class="card">
      <h2>What were you testing?</h2>
      <p class="muted">Recent Cursor Cloud Agents — prompts, branches, results. Local desktop chats aren’t in the API.</p>
      <button class="secondary" id="refreshAgents">Refresh</button>
      ${state.warning ? `<p class="muted">${escapeHtml(state.warning)}</p>` : ""}
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
      ${
        state.agents.length
          ? state.agents
              .map(
                (a) => `<div class="list-item">
                  <div class="title">${escapeHtml(a.name)}
                    ${a.relevance > 40 ? `<span class="badge fav">GuideAI?</span>` : ""}
                    ${a.status ? `<span class="badge">${escapeHtml(a.status)}</span>` : ""}
                  </div>
                  <div class="muted">${escapeHtml(fmtTime(a.updatedAt))}</div>
                  <button class="secondary" data-agent="${escapeAttr(a.id)}" style="margin-top:0.5rem">Open</button>
                </div>`,
              )
              .join("")
          : `<p class="muted">No agents yet. Set CURSOR_API_KEY in .env.</p>`
      }
    </div>
  `;
}

function renderStatus() {
  const health = state.config
    ? `<div class="muted">Tailscale: <code>${escapeHtml(state.config.tsHost || "unset")}</code> · Engine: <code>${escapeHtml(state.config.deployEngine || "local")}</code></div>`
    : "";
  const devices = state.devices
    ? state.devices.phones?.length
      ? state.devices.phones.map((p) => `<div class="list-item">${escapeHtml(p)}</div>`).join("")
      : `<p class="muted">No paired iPhone (OTA / TestFlight still work).</p>`
    : `<p class="muted">Device probe unavailable.</p>`;
  const localJobs = (state.jobs || [])
    .map(
      (j) => `<div class="list-item">
        <span class="badge ${j.status === "succeeded" ? "ok" : j.status === "failed" ? "err" : "run"}">${escapeHtml(j.status)}</span>
        <span class="title">${escapeHtml(j.scheme)} · ${escapeHtml(j.deployMode)}</span>
        <div class="muted">${escapeHtml(j.repository)}@${escapeHtml(j.ref)} · ${escapeHtml(fmtTime(j.updatedAt))}</div>
        ${j.installUrl ? `<a class="secondary" href="${escapeAttr(j.installUrl)}" style="margin-top:0.4rem">Install</a>` : ""}
        ${j.testflightNote ? `<div class="muted">${escapeHtml(j.testflightNote)}</div>` : ""}
      </div>`,
    )
    .join("") || `<p class="muted">No local jobs yet.</p>`;
  const runs = (state.deploys || [])
    .map((r) => {
      const badge =
        r.status === "completed"
          ? r.conclusion === "success"
            ? "ok"
            : "err"
          : "run";
      return `<div class="list-item">
        <span class="title">${escapeHtml(r.display_title || r.name || String(r.id))}</span>
        <span class="badge ${badge}">${escapeHtml(r.status)}${r.conclusion ? "/" + r.conclusion : ""}</span>
        <div class="muted">${escapeHtml(fmtTime(r.updated_at))} · <a href="${escapeAttr(r.html_url)}" target="_blank">Actions</a></div>
      </div>`;
    })
    .join("") || `<p class="muted">No Actions runs (fine if you use local engine).</p>`;
  const arts = (state.artifacts || [])
    .map(
      (a) => `<div class="list-item">
        <div class="title">${escapeHtml(a.title || a.id)}</div>
        <div class="muted">${escapeHtml(a.createdAt || "")}</div>
        ${a.installUrl ? `<a class="primary" href="${escapeAttr(a.installUrl)}">Install page</a>` : ""}
      </div>`,
    )
    .join("") || `<p class="muted">No OTA artifacts yet.</p>`;

  return `
    ${renderSetupBanner()}
    <div class="card"><h2>Environment</h2>${health}
      <button class="secondary" id="refreshStatus" style="margin-top:0.75rem">Refresh</button>
    </div>
    <div class="card"><h2>Recent local jobs</h2>${localJobs}</div>
    <div class="card"><h2>Paired devices</h2>${devices}</div>
    <div class="card"><h2>GitHub Actions runs</h2>${runs}</div>
    <div class="card"><h2>OTA install pages</h2>${arts}</div>
  `;
}

function render() {
  const body =
    state.tab === "projects"
      ? renderProjects()
      : state.tab === "cursor"
        ? renderCursor()
        : renderStatus();

  app.innerHTML = `
    <header class="appbar">
      <h1>buildswiftlazily</h1>
      <div class="pill">couch → phone</div>
    </header>
    ${body}
    <nav class="tabs">
      <button class="${state.tab === "projects" ? "active" : ""}" data-tab="projects">Build</button>
      <button class="${state.tab === "cursor" ? "active" : ""}" data-tab="cursor">Cursor</button>
      <button class="${state.tab === "status" ? "active" : ""}" data-tab="status">Status</button>
    </nav>
  `;

  app.querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => setTab(btn.getAttribute("data-tab"))),
  );

  const repoSelect = app.querySelector("#repoSelect");
  if (repoSelect) {
    repoSelect.addEventListener("change", async (e) => {
      const full = e.target.value;
      const meta = state.repos.find((r) => r.full_name === full);
      await selectRepo(full, meta?.default_branch, meta);
    });
  }
  const branchSelect = app.querySelector("#branchSelect");
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
  const pathInput = app.querySelector("#pathInput");
  if (pathInput) pathInput.addEventListener("change", (e) => (state.projectPath = e.target.value));
  const schemeInput = app.querySelector("#schemeInput");
  if (schemeInput) schemeInput.addEventListener("input", (e) => (state.scheme = e.target.value));
  const modeSelect = app.querySelector("#modeSelect");
  if (modeSelect)
    modeSelect.addEventListener("change", (e) => {
      state.deployMode = e.target.value;
      render();
    });
  const engineSelect = app.querySelector("#engineSelect");
  if (engineSelect)
    engineSelect.addEventListener("change", (e) => (state.engine = e.target.value));
  const deployBtn = app.querySelector("#deployBtn");
  if (deployBtn) deployBtn.addEventListener("click", deploy);
  app.querySelectorAll(".pick-ios").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.projectPath = btn.getAttribute("data-path") || ".";
      state.scheme = btn.getAttribute("data-scheme") || state.scheme;
      render();
    }),
  );

  const refreshAgents = app.querySelector("#refreshAgents");
  if (refreshAgents) refreshAgents.addEventListener("click", loadAgents);
  app.querySelectorAll("[data-agent]").forEach((btn) =>
    btn.addEventListener("click", () => openAgent(btn.getAttribute("data-agent"))),
  );
  const backAgents = app.querySelector("#backAgents");
  if (backAgents)
    backAgents.addEventListener("click", () => {
      state.agentDetail = null;
      render();
    });
  const deployAgentBtn = app.querySelector("#deployAgentBtn");
  if (deployAgentBtn) deployAgentBtn.addEventListener("click", deployFromAgent);

  const refreshStatus = app.querySelector("#refreshStatus");
  if (refreshStatus) refreshStatus.addEventListener("click", loadStatus);
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

bootstrap();
