const STORAGE = {
  clientId: "cloudcodex.clientId",
  runnerId: "cloudcodex.runnerId",
  projectId: "cloudcodex.projectId",
  threadId: "cloudcodex.threadId",
  lastSequence: "cloudcodex.lastSequence",
};

const state = {
  authenticated: false,
  session: null,
  runners: [],
  projects: [],
  threads: [],
  approvals: [],
  events: [],
  loadedThreadIds: new Set(),
  selectedRunnerId: localStorage.getItem(STORAGE.runnerId) || "",
  selectedProjectId: localStorage.getItem(STORAGE.projectId) || "",
  selectedThreadId: localStorage.getItem(STORAGE.threadId) || "",
  lastSequence: Number(localStorage.getItem(STORAGE.lastSequence) || "0"),
  ws: null,
  reconnectTimer: null,
  reconnectDelayMs: 1000,
  busy: false,
};

const $ = (id) => document.getElementById(id);

const views = {
  overview: $("overviewView"),
  thread: $("threadView"),
  approvals: $("approvalsView"),
};

function clientId() {
  const existing = localStorage.getItem(STORAGE.clientId);
  if (existing) return existing;
  const next = `mobile_${crypto.randomUUID()}`;
  localStorage.setItem(STORAGE.clientId, next);
  return next;
}

function envelope(type, payload = {}) {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type,
    sentAt: new Date().toISOString(),
    payload,
  };
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const init = {
    credentials: "include",
    method: options.method || "GET",
    headers,
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }

  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function setStatus(text) {
  const suffix = state.lastSequence > 0 ? ` - seq ${state.lastSequence}` : "";
  $("connectionStatus").textContent = `${text}${suffix}`;
}

function setNotice(message, kind = "ok") {
  const notice = $("notice");
  notice.textContent = message;
  notice.className = `notice active ${kind}`;
}

function clearNotice() {
  const notice = $("notice");
  notice.textContent = "";
  notice.className = "notice";
}

function setBusy(value) {
  state.busy = value;
  $("refreshButton").disabled = value || !state.authenticated;
}

function setView(name) {
  for (const [viewName, element] of Object.entries(views)) {
    element.classList.toggle("active", viewName === name);
  }
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === name);
  });
}

async function bootstrap() {
  bindUi();
  render();
  await checkSession();
  if (state.authenticated) {
    await refreshAll({ silent: true });
    connectWs();
  }
}

async function checkSession() {
  try {
    state.session = await api("/api/session");
    state.authenticated = true;
    $("authPanel").classList.remove("active");
    clearNotice();
    setStatus("Authenticated");
  } catch {
    state.session = null;
    state.authenticated = false;
    $("authPanel").classList.add("active");
    setStatus("Pair required");
  }
  render();
}

function bindUi() {
  $("pairForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const pairingToken = $("pairingTokenInput").value.trim();
    const deviceName = $("deviceNameInput").value.trim();
    try {
      await api("/api/pairing/finish", {
        method: "POST",
        body: { pairingToken, deviceName, deviceKind: "client" },
      });
      $("pairingTokenInput").value = "";
      await checkSession();
      await refreshAll({ silent: true });
      connectWs();
    } catch (error) {
      setNotice(error.message, "error");
    }
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  });

  $("refreshButton").addEventListener("click", () => void refreshAll());
  $("runnerSelect").addEventListener("change", () => {
    selectRunner($("runnerSelect").value);
  });
  $("projectSelect").addEventListener("change", () => {
    selectProject($("projectSelect").value);
  });
  $("threadSelect").addEventListener("change", () => {
    void selectThread($("threadSelect").value);
  });
  $("newThreadButton").addEventListener("click", () => {
    selectThread("");
  });
  $("interruptButton").addEventListener("click", () => void interruptThread());
  $("promptForm").addEventListener("submit", (event) => void sendPrompt(event));
}

async function refreshAll(options = {}) {
  if (!state.authenticated) return;
  setBusy(true);
  try {
    const [runners, projects, threads, approvals] = await Promise.all([
      api("/api/runners"),
      api("/api/projects"),
      api("/api/threads"),
      api("/api/approvals?status=pending"),
    ]);
    state.runners = runners.runners || [];
    state.projects = projects.projects || [];
    state.threads = threads.threads || [];
    state.approvals = approvals.approvals || [];
    ensureSelections();
    await fetchMissedEvents();
    if (state.selectedThreadId) {
      await fetchThreadEvents(state.selectedThreadId);
    }
    render();
    if (!options.silent) setNotice("Refreshed", "ok");
  } catch (error) {
    if (error.status === 401) {
      await checkSession();
      disconnectWs();
    }
    setNotice(error.message, "error");
  } finally {
    setBusy(false);
  }
}

function connectWs() {
  disconnectWs(false);
  const url = new URL("/ws/client", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.addEventListener("open", () => {
    state.reconnectDelayMs = 1000;
    setStatus("Live");
    ws.send(JSON.stringify(envelope("client.hello", { clientId: clientId() })));
    ws.send(JSON.stringify(envelope("events.list", { afterSequence: state.lastSequence, limit: 500 })));
    void refreshAll({ silent: true });
  });

  ws.addEventListener("message", (event) => {
    try {
      handleWsMessage(JSON.parse(event.data));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Invalid WebSocket message", "error");
    }
  });

  ws.addEventListener("close", () => {
    if (state.ws !== ws) return;
    state.ws = null;
    setStatus("Reconnecting");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    setStatus("WebSocket error");
  });
}

function disconnectWs(shouldReconnect = false) {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  const ws = state.ws;
  if (!ws) return;
  state.ws = null;
  ws.close();
  if (shouldReconnect) scheduleReconnect();
}

function scheduleReconnect() {
  if (!state.authenticated || state.reconnectTimer) return;
  const delay = state.reconnectDelayMs;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, 10000);
    void fetchMissedEvents()
      .catch(() => undefined)
      .finally(connectWs);
  }, delay);
}

function handleWsMessage(message) {
  if (message.type === "event.appended") {
    applyEvent(message.payload.event);
    render();
    return;
  }
  if (message.type === "events.list.result") {
    for (const event of message.payload.events || []) applyEvent(event);
    render();
    return;
  }
  if (message.type === "thread.status.result" && message.payload.thread) {
    upsertById(state.threads, message.payload.thread, "cloudThreadId");
    render();
    return;
  }
  if (message.type === "turn.start.accepted") {
    state.selectedThreadId = message.payload.cloudThreadId;
    remember(STORAGE.threadId, state.selectedThreadId);
    upsertById(
      state.threads,
      {
        cloudThreadId: message.payload.cloudThreadId,
        runnerId: message.payload.runnerId,
        projectId: message.payload.projectId,
        status: message.payload.status,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      "cloudThreadId",
    );
    render();
    return;
  }
  if (message.type === "approval.updated") {
    upsertApproval(message.payload.approval);
    render();
    return;
  }
  if (message.type === "error") {
    setNotice(message.payload.message || message.payload.code || "WebSocket error", "error");
  }
}

async function fetchMissedEvents() {
  await fetchEvents({ afterSequence: state.lastSequence });
}

async function fetchThreadEvents(threadId) {
  if (!threadId) return;
  const afterSequence = state.loadedThreadIds.has(threadId) ? maxThreadSequence(threadId) : 0;
  await fetchEvents({ afterSequence, threadId });
  state.loadedThreadIds.add(threadId);
}

async function fetchEvents({ afterSequence = 0, threadId = "" }) {
  let after = afterSequence;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({
      afterSequence: String(after),
      limit: "500",
    });
    if (threadId) params.set("threadId", threadId);
    const body = await api(`/api/events?${params.toString()}`);
    const events = body.events || [];
    if (events.length === 0) break;
    for (const event of events) {
      applyEvent(event);
      after = Math.max(after, event.sequence);
    }
    if (events.length < 500) break;
  }
  setStatus(state.ws ? "Live" : "Authenticated");
}

function applyEvent(event) {
  if (state.events.some((existing) => existing.sequence === event.sequence)) return;
  state.events.push(event);
  state.events.sort((a, b) => a.sequence - b.sequence);
  if (event.sequence > state.lastSequence) {
    state.lastSequence = event.sequence;
    remember(STORAGE.lastSequence, String(state.lastSequence));
  }
}

function upsertById(list, item, key) {
  const index = list.findIndex((entry) => entry[key] === item[key]);
  if (index === -1) list.unshift(item);
  else list[index] = item;
}

function upsertApproval(approval) {
  upsertById(state.approvals, approval, "approvalId");
  if (approval.status !== "pending") {
    state.approvals = state.approvals.filter((item) => item.status === "pending");
  }
}

function ensureSelections() {
  if (!state.runners.some((runner) => runner.runnerId === state.selectedRunnerId)) {
    state.selectedRunnerId = state.runners[0]?.runnerId || "";
  }
  const projects = projectsForRunner();
  if (!projects.some((project) => project.projectId === state.selectedProjectId)) {
    state.selectedProjectId = projects[0]?.projectId || "";
  }
  const threads = threadsForSelections();
  if (!threads.some((thread) => thread.cloudThreadId === state.selectedThreadId)) {
    state.selectedThreadId = threads[0]?.cloudThreadId || "";
  }
  remember(STORAGE.runnerId, state.selectedRunnerId);
  remember(STORAGE.projectId, state.selectedProjectId);
  remember(STORAGE.threadId, state.selectedThreadId);
}

function selectRunner(runnerId) {
  state.selectedRunnerId = runnerId;
  state.selectedProjectId = projectsForRunner()[0]?.projectId || "";
  state.selectedThreadId = "";
  remember(STORAGE.runnerId, state.selectedRunnerId);
  remember(STORAGE.projectId, state.selectedProjectId);
  remember(STORAGE.threadId, state.selectedThreadId);
  render();
}

function selectProject(projectId) {
  state.selectedProjectId = projectId;
  const project = state.projects.find((entry) => entry.projectId === projectId);
  if (project) state.selectedRunnerId = project.runnerId;
  state.selectedThreadId = "";
  remember(STORAGE.runnerId, state.selectedRunnerId);
  remember(STORAGE.projectId, state.selectedProjectId);
  remember(STORAGE.threadId, state.selectedThreadId);
  render();
}

async function selectThread(threadId) {
  state.selectedThreadId = threadId;
  const thread = selectedThread();
  if (thread) {
    state.selectedRunnerId = thread.runnerId;
    state.selectedProjectId = thread.projectId;
  }
  remember(STORAGE.runnerId, state.selectedRunnerId);
  remember(STORAGE.projectId, state.selectedProjectId);
  remember(STORAGE.threadId, state.selectedThreadId);
  if (threadId) await fetchThreadEvents(threadId);
  render();
}

function remember(key, value) {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

function projectsForRunner() {
  return state.projects.filter(
    (project) => !state.selectedRunnerId || project.runnerId === state.selectedRunnerId,
  );
}

function threadsForSelections() {
  return state.threads.filter((thread) => {
    if (state.selectedRunnerId && thread.runnerId !== state.selectedRunnerId) return false;
    if (state.selectedProjectId && thread.projectId !== state.selectedProjectId) return false;
    return true;
  });
}

function selectedThread() {
  return state.threads.find((thread) => thread.cloudThreadId === state.selectedThreadId) || null;
}

function maxThreadSequence(threadId) {
  return state.events
    .filter((event) => event.threadId === threadId)
    .reduce((max, event) => Math.max(max, event.sequence), 0);
}

function render() {
  renderSelects();
  renderRunners();
  renderProjects();
  renderThreads();
  renderTimeline();
  renderApprovals();
}

function renderSelects() {
  $("runnerSelect").innerHTML =
    option("", "Select runner", state.selectedRunnerId) +
    state.runners
      .map((runner) => option(runner.runnerId, runner.name, state.selectedRunnerId))
      .join("");
  $("projectSelect").innerHTML =
    option("", "Select project", state.selectedProjectId) +
    projectsForRunner()
      .map((project) => option(project.projectId, project.name, state.selectedProjectId))
      .join("");
  $("threadSelect").innerHTML =
    option("", "New thread", state.selectedThreadId) +
    threadsForSelections()
      .map((thread) =>
        option(
          thread.cloudThreadId,
          `${shortId(thread.cloudThreadId)} - ${thread.status}`,
          state.selectedThreadId,
        ),
      )
      .join("");
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function renderRunners() {
  $("runnerList").innerHTML = state.runners.length
    ? state.runners
        .map((runner) =>
          itemHtml({
            id: runner.runnerId,
            title: runner.name,
            meta: `${runner.runnerId} - ${relativeTime(runner.lastSeenAt)}`,
            pill: runner.connected ? "connected" : "offline",
            active: runner.runnerId === state.selectedRunnerId,
          }),
        )
        .join("")
    : empty("No runners connected");
  bindItemClicks("runnerList", (id) => selectRunner(id));
}

function renderProjects() {
  const projects = projectsForRunner();
  $("projectList").innerHTML = projects.length
    ? projects
        .map((project) =>
          itemHtml({
            id: project.projectId,
            title: project.name,
            meta: project.runnerId,
            pill: "project",
            active: project.projectId === state.selectedProjectId,
          }),
        )
        .join("")
    : empty("No projects registered");
  bindItemClicks("projectList", (id) => selectProject(id));
}

function renderThreads() {
  const threads = threadsForSelections();
  $("threadList").innerHTML = threads.length
    ? threads
        .map((thread) =>
          itemHtml({
            id: thread.cloudThreadId,
            title: thread.projectId,
            meta: `${shortId(thread.cloudThreadId)} - ${relativeTime(thread.updatedAt)}`,
            pill: thread.status,
            active: thread.cloudThreadId === state.selectedThreadId,
          }),
        )
        .join("")
    : empty("No threads yet");
  bindItemClicks("threadList", (id) => {
    setView("thread");
    void selectThread(id);
  });
}

function itemHtml({ id, title, meta, pill, active }) {
  return `<button class="item ${active ? "active" : ""}" data-id="${escapeHtml(id)}" type="button">
    <span class="row"><strong>${escapeHtml(title)}</strong><span class="pill ${escapeHtml(pill)}">${escapeHtml(pill)}</span></span>
    <span class="meta">${escapeHtml(meta || "")}</span>
  </button>`;
}

function bindItemClicks(containerId, callback) {
  document.querySelectorAll(`#${containerId} .item`).forEach((item) => {
    item.addEventListener("click", () => callback(item.dataset.id));
  });
}

function renderTimeline() {
  const thread = selectedThread();
  $("threadTitle").textContent = thread ? thread.projectId : "New Thread";
  $("threadMeta").textContent = thread
    ? `${thread.status} - ${thread.cloudThreadId}`
    : "Choose a runner and project";
  $("interruptButton").disabled =
    !thread || !["queued", "starting", "running"].includes(thread.status);

  const events = state.selectedThreadId
    ? state.events.filter((event) => event.threadId === state.selectedThreadId)
    : [];
  $("timeline").innerHTML = events.length
    ? events.map(renderEvent).join("")
    : empty("No events for this thread");
}

function renderEvent(event) {
  const data = normalizePayload(event.payload);
  const kind = eventKind(event, data);
  const title = titleForEvent(event, data);
  const body = bodyForEvent(event, data, kind);
  return `<article class="event ${escapeHtml(kind)}">
    <div class="event-title"><span>${escapeHtml(title)}</span><span>#${event.sequence}</span></div>
    <div class="event-body">${body}</div>
  </article>`;
}

function normalizePayload(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in payload) {
    return payload.data || {};
  }
  return payload || {};
}

function eventMethod(event, data) {
  if (typeof data.method === "string") return data.method;
  return event.type || "event";
}

function eventKind(event, data) {
  const lower = `${event.type} ${eventMethod(event, data)}`.toLowerCase();
  if (lower.includes("approval")) return "approval";
  if (lower.includes("error") || lower.includes("stderr")) return "error";
  if (lower.includes("plan")) return "plan";
  if (lower.includes("command") || lower.includes("execution")) return "command";
  if (lower.includes("file") || lower.includes("diff")) return "file";
  if (lower.includes("agent") || lower.includes("message")) return "agent";
  return "event";
}

function titleForEvent(event, data) {
  const method = eventMethod(event, data);
  const lower = `${event.type} ${method}`.toLowerCase();
  if (lower.includes("approval")) return "Pending Approval";
  if (lower.includes("agent") && lower.includes("delta")) return "Agent Message Delta";
  if (lower.includes("agent") || lower.includes("message")) return "Agent Message";
  if (lower.includes("plan")) return "Plan Update";
  if (lower.includes("command") || lower.includes("execution")) return "Command Output";
  if (lower.includes("file") || lower.includes("diff")) return "File Change";
  if (lower.includes("error") || lower.includes("stderr")) return "Error";
  return method;
}

function bodyForEvent(event, data, kind) {
  if (kind === "agent") {
    const text = extractString(data, [
      "params.delta",
      "params.text",
      "params.message",
      "delta",
      "text",
      "message",
    ]);
    return text ? escapeHtml(text) : pre(data);
  }
  if (kind === "plan") {
    const plan = extractArray(data, ["params.plan", "params.steps", "plan", "steps"]);
    return plan ? renderPlan(plan) : pre(data);
  }
  if (kind === "command") {
    const output = extractString(data, [
      "params.delta",
      "params.output",
      "params.stdout",
      "params.stderr",
      "delta",
      "output",
      "message",
    ]);
    return output ? `<pre>${escapeHtml(output)}</pre>` : pre(data);
  }
  if (kind === "file") {
    const diff = extractString(data, [
      "params.diff",
      "params.unifiedDiff",
      "params.patch",
      "diff",
      "unifiedDiff",
      "patch",
      "delta",
    ]);
    return diff ? `<pre>${escapeHtml(diff)}</pre>` : pre(data);
  }
  if (kind === "error") {
    const message = extractString(data, [
      "params.error.message",
      "params.message",
      "error.message",
      "message",
    ]);
    return message ? escapeHtml(message) : pre(data);
  }
  if (kind === "approval") {
    return pre(data);
  }

  const text = extractString(data, ["text", "message", "params.text", "params.message"]);
  return text ? escapeHtml(text) : pre(data);
}

function renderPlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return "";
  return `<ol>${plan
    .map((step) => {
      if (typeof step === "string") return `<li>${escapeHtml(step)}</li>`;
      const label = step.step || step.title || step.text || JSON.stringify(step);
      const status = step.status ? ` (${step.status})` : "";
      return `<li>${escapeHtml(`${label}${status}`)}</li>`;
    })
    .join("")}</ol>`;
}

function renderApprovals() {
  const pending = state.approvals.filter((approval) => approval.status === "pending");
  $("approvalList").innerHTML = pending.length
    ? pending
        .map(
          (approval) => `<article class="approval-card">
        <div class="row"><strong>${escapeHtml(approval.approvalType)}</strong><span class="pill approval">pending</span></div>
        <div class="meta">${escapeHtml(approval.cloudThreadId)} - ${escapeHtml(approval.projectId)}</div>
        <pre>${escapeHtml(JSON.stringify(approval.payload, null, 2))}</pre>
        <div class="approval-actions">
          <button data-approval="${escapeHtml(approval.approvalId)}" data-decision="accept" type="button">Accept</button>
          <button data-approval="${escapeHtml(approval.approvalId)}" data-decision="decline" type="button">Decline</button>
          <button data-approval="${escapeHtml(approval.approvalId)}" data-decision="cancel" type="button">Cancel</button>
        </div>
      </article>`,
        )
        .join("")
    : empty("No pending approvals");
  document.querySelectorAll("[data-approval]").forEach((button) => {
    button.addEventListener("click", () =>
      void resolveApproval(button.dataset.approval, button.dataset.decision),
    );
  });
}

async function sendPrompt(event) {
  event.preventDefault();
  const prompt = $("promptInput").value.trim();
  if (!prompt) return;
  if (!state.selectedRunnerId || !state.selectedProjectId) {
    setNotice("Select a runner and project first.", "error");
    return;
  }

  try {
    const thread = selectedThread();
    if (thread) {
      await api(`/api/threads/${encodeURIComponent(thread.cloudThreadId)}/steer`, {
        method: "POST",
        body: { prompt },
      });
      setNotice("Prompt sent to selected thread.", "ok");
    } else {
      const result = await api("/api/turns/start", {
        method: "POST",
        body: {
          runnerId: state.selectedRunnerId,
          projectId: state.selectedProjectId,
          prompt,
        },
      });
      state.selectedThreadId = result.cloudThreadId;
      remember(STORAGE.threadId, state.selectedThreadId);
      upsertById(
        state.threads,
        {
          cloudThreadId: result.cloudThreadId,
          runnerId: result.runnerId,
          projectId: result.projectId,
          status: result.status,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        "cloudThreadId",
      );
      setView("thread");
      setNotice("Thread started.", "ok");
    }
    $("promptInput").value = "";
    await refreshAll({ silent: true });
  } catch (error) {
    setNotice(error.message, "error");
  }
}

async function interruptThread() {
  const thread = selectedThread();
  if (!thread) return;
  try {
    await api(`/api/threads/${encodeURIComponent(thread.cloudThreadId)}/interrupt`, {
      method: "POST",
      body: {},
    });
    setNotice("Interrupt sent.", "ok");
  } catch (error) {
    setNotice(error.message, "error");
  }
}

async function resolveApproval(approvalId, decision) {
  if (!approvalId || !decision) return;
  try {
    await api(`/api/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: "POST",
      body: { decision },
    });
    state.approvals = state.approvals.filter((approval) => approval.approvalId !== approvalId);
    renderApprovals();
    setNotice(`Approval ${decision} sent.`, "ok");
  } catch (error) {
    setNotice(error.message, "error");
  }
}

function extractString(value, paths) {
  for (const path of paths) {
    const found = getPath(value, path);
    if (typeof found === "string" && found.length > 0) return found;
    if (Array.isArray(found)) return found.join(" ");
  }
  return "";
}

function extractArray(value, paths) {
  for (const path of paths) {
    const found = getPath(value, path);
    if (Array.isArray(found)) return found;
  }
  return null;
}

function getPath(value, path) {
  return path.split(".").reduce((current, part) => {
    if (current && typeof current === "object" && part in current) return current[part];
    return undefined;
  }, value);
}

function pre(value) {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function shortId(value) {
  const text = String(value || "");
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

function relativeTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(time).toLocaleString();
}

function empty(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

void bootstrap();
