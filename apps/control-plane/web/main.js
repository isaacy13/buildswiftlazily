const state = {
  tab: "projects",
  config: null,
  repos: [],
  branches: [],
  ios: null,
  selectedRepo: null,
  selectedRef: "",
  projectPath: ".",
  scheme: "",
  deployMode: "ota",
  agents: [],
  agentDetail: null,
  deploys: [],
  artifacts: [],
  devices: null,
  busy: false,
  message: "",
  error: "",
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
  if (tab === "cursor" && !state.agents.length) loadAgents();
  if (tab === "status") loadStatus();
}

async function bootstrap() {
  try {
    state.config = await api("/api/config");
    state.deployMode = state.config.defaults?.deploy_mode || "ota";
    const { repos } = await api("/api/repos");
    state.repos = repos;
    const fav =
      repos.find((r) => r.favorite) ||
      repos.find((r) => /guideai/i.test(r.name || r.full_name)) ||
      repos[0];
    if (fav) await selectRepo(fav.full_name, fav.default_branch || "main", fav);
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
    const { branches } = await api(
      `/api/repos/${fullName}/branches`,
    );
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
  if (!state.scheme && data.suggestedScheme) state.scheme = data.suggestedScheme;
  if (data.suggestedPath) state.projectPath = data.suggestedPath;
}

async function deploy() {
  state.busy = true;
  state.error = "";
  state.message = "";
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
        title: state.scheme,
      }),
    });
    state.message = result.message + " — watch Status tab for the Actions run.";
    await loadStatus();
  } catch (e) {
    state.error = String(e.message || e);
  } finally {
    state.busy = false;
    render();
  }
}

async function loadAgents() {
  try {
    const data = await api("/api/cursor/agents");
    state.agents = data.agents || [];
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
    const m = String(branchInfo.repoUrl).match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (m) repo = m[1];
  }
  if (!repo) {
    state.error = "Could not resolve repository from agent.";
    render();
    return;
  }
  state.tab = "projects";
  await selectRepo(repo, branchInfo.branch);
  state.message = `Prefilled from Cursor agent · ${repo}@${branchInfo.branch}`;
  render();
}

async function loadStatus() {
  try {
    const [deploys, artifacts, devices] = await Promise.all([
      api("/api/deploys").catch(() => ({ runs: [] })),
      api("/api/artifacts").catch(() => ({ artifacts: [] })),
      api("/api/devices").catch(() => null),
    ]);
    state.deploys = deploys.runs || [];
    state.artifacts = artifacts.artifacts || [];
    state.devices = devices;
  } catch (e) {
    state.error = String(e.message || e);
  }
  render();
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
              `<div class="list-item"><span class="title">${escapeHtml(
                p.name,
              )}</span> <span class="badge">${escapeHtml(p.kind)}</span><div class="muted">${escapeHtml(
                p.projectPath,
              )}</div></div>`,
          )
          .join("")
      : `<p class="muted">No Xcode projects detected on this ref (you can still set path/scheme manually).</p>`
    : `<p class="muted">Select a repo/branch to scan for iOS projects.</p>`;

  return `
    <div class="card">
      <h2>Project</h2>
      <label>Repository</label>
      <select id="repoSelect">${repoOptions}</select>
      <label>Branch</label>
      <select id="branchSelect">${branchOptions || `<option>${escapeHtml(state.selectedRef || "")}</option>`}</select>
      <label>Project path</label>
      <input id="pathInput" value="${escapeAttr(state.projectPath || ".")}" />
      <label>Scheme</label>
      <input id="schemeInput" value="${escapeAttr(state.scheme || "")}" placeholder="GuideAI" />
      <label>Deploy mode</label>
      <select id="modeSelect">
        <option value="ota" ${state.deployMode === "ota" ? "selected" : ""}>OTA (works off your home Wi‑Fi)</option>
        <option value="direct" ${state.deployMode === "direct" ? "selected" : ""}>Direct (device paired to Mac)</option>
        <option value="both" ${state.deployMode === "both" ? "selected" : ""}>Both</option>
      </select>
      <button class="primary" id="deployBtn" ${state.busy || !state.scheme ? "disabled" : ""}>
        ${state.busy ? "Dispatching…" : "Build & Install"}
      </button>
      ${state.message ? `<p class="success">${escapeHtml(state.message)}</p>` : ""}
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
    </div>
    <div class="card">
      <h2>Detected iOS roots</h2>
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
        <button class="primary" id="deployAgentBtn">Deploy this agent’s branch</button>
      </div>
      <div class="card">
        <h2>Your recent messages</h2>
        ${
          userMsgs.length
            ? userMsgs.map((t) => `<div class="prompt">${escapeHtml(t)}</div>`).join("")
            : `<p class="muted">No user prompts in API history for this agent. Assistant results may still appear below.</p>`
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
            : `<p class="muted">No runs list (v1) — conversation above may still be populated via v0.</p>`
        }
      </div>
    `;
  }

  return `
    <div class="card">
      <h2>Cursor Cloud Agents</h2>
      <p class="muted">What you were last testing — prompts, branches, and results. Local desktop chats are not available via API.</p>
      <button class="secondary" id="refreshAgents">Refresh</button>
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
          : `<p class="muted">No agents loaded. Set CURSOR_API_KEY in .env.</p>`
      }
    </div>
  `;
}

function renderStatus() {
  const health = state.config
    ? `<div class="muted">Tailscale host: <code>${escapeHtml(state.config.tsHost || "unset")}</code></div>`
    : "";
  const devices = state.devices
    ? state.devices.phones?.length
      ? state.devices.phones.map((p) => `<div class="list-item">${escapeHtml(p)}</div>`).join("")
      : `<p class="muted">No paired iPhone via devicectl (OTA still works).</p>`
    : `<p class="muted">Device probe unavailable on this host.</p>`;
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
    .join("") || `<p class="muted">No recent deploy runs.</p>`;
  const arts = (state.artifacts || [])
    .map(
      (a) => `<div class="list-item">
        <div class="title">${escapeHtml(a.title || a.id)}</div>
        <div class="muted">${escapeHtml(a.createdAt || "")}</div>
        ${a.installUrl ? `<a class="primary" href="${escapeAttr(a.installUrl)}">Install page</a>` : ""}
        ${a.itmsUrl ? `<a class="secondary" href="${escapeAttr(a.itmsUrl)}" style="margin-top:0.5rem;width:100%">itms-services install</a>` : ""}
      </div>`,
    )
    .join("") || `<p class="muted">No local OTA artifacts yet.</p>`;

  return `
    <div class="card"><h2>Environment</h2>${health}
      <button class="secondary" id="refreshStatus" style="margin-top:0.75rem">Refresh</button>
    </div>
    <div class="card"><h2>Paired devices</h2>${devices}</div>
    <div class="card"><h2>Recent deploys</h2>${runs}</div>
    <div class="card"><h2>Install artifacts</h2>${arts}</div>
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
      <div class="pill">couch deploy</div>
    </header>
    ${body}
    <nav class="tabs">
      <button class="${state.tab === "projects" ? "active" : ""}" data-tab="projects">Projects</button>
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
  if (modeSelect) modeSelect.addEventListener("change", (e) => (state.deployMode = e.target.value));
  const deployBtn = app.querySelector("#deployBtn");
  if (deployBtn) deployBtn.addEventListener("click", deploy);

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
