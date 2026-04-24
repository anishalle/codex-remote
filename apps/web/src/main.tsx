import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  AlertTriangleIcon,
  BanIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  FolderPlusIcon,
  ClockIcon,
  FolderIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  PlusIcon,
  RadioIcon,
  RefreshCwIcon,
  SendIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
  UserIcon,
  WifiIcon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";

import "./index.css";
import type {
  AppActivity,
  AppApproval,
  AppMessage,
  AppSnapshot,
  AppThreadDetail,
  AppThreadSummary,
  ProjectSummary,
  RunnerSummary,
} from "../../../packages/protocol/src/index.ts";

document.documentElement.classList.add("dark");

const STORAGE = {
  threadId: "cloudcodex.web.threadId",
  projectId: "cloudcodex.web.projectId",
  runnerId: "cloudcodex.web.runnerId",
  clientId: "cloudcodex.web.clientId",
  collapsedProjects: "cloudcodex.web.collapsedProjects",
};

type ConnectionState = "pair-required" | "loading" | "live" | "reconnecting" | "offline";
type Notice = { kind: "ok" | "error"; text: string } | null;
type ProjectCreateInput = { readonly runnerId: string; readonly projectId: string; readonly name?: string };

interface Envelope<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
}

function clientId(): string {
  const existing = localStorage.getItem(STORAGE.clientId);
  if (existing) return existing;
  const next = `web_${crypto.randomUUID()}`;
  localStorage.setItem(STORAGE.clientId, next);
  return next;
}

function envelope(type: string, payload: unknown = {}) {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type,
    sentAt: new Date().toISOString(),
    payload,
  };
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const init: RequestInit = {
    ...options,
    credentials: "include",
    headers,
  };
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message || `HTTP ${response.status}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return body as T;
}

function remember(key: string, value: string | null): void {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

function statusTone(status: string): string {
  if (status === "ready" || status === "connected") return "text-success";
  if (status === "running" || status === "starting" || status === "queued") return "text-warning";
  if (status === "error" || status === "offline") return "text-destructive";
  return "text-muted-foreground";
}

function formatRelativeTime(value: string | undefined): string {
  if (!value) return "never";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return new Date(time).toLocaleDateString();
}

function shortId(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}...${value.slice(-5)}`;
}

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function latestProjectForThread(
  projects: readonly ProjectSummary[],
  thread: AppThreadSummary | null,
): ProjectSummary | null {
  if (!thread) return null;
  return (
    projects.find(
      (project) => project.projectId === thread.projectId && project.runnerId === thread.runnerId,
    ) ?? null
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [threadDetail, setThreadDetail] = useState<AppThreadDetail | null>(null);
  const [selectedThreadId, setSelectedThreadIdState] = useState<string | null>(
    () => localStorage.getItem(STORAGE.threadId) || null,
  );
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(
    () => localStorage.getItem(STORAGE.projectId) || null,
  );
  const [selectedRunnerId, setSelectedRunnerIdState] = useState<string | null>(
    () => localStorage.getItem(STORAGE.runnerId) || null,
  );
  const [draftMode, setDraftMode] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [notice, setNotice] = useState<Notice>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimer = useRef<number | null>(null);

  const selectedThread = useMemo(
    () => snapshot?.threads.find((thread) => thread.cloudThreadId === selectedThreadId) ?? null,
    [selectedThreadId, snapshot?.threads],
  );

  const selectedProject = useMemo(() => {
    if (!snapshot) return null;
    if (selectedThread) return latestProjectForThread(snapshot.projects, selectedThread);
    return (
      snapshot.projects.find(
        (project) => project.projectId === selectedProjectId && project.runnerId === selectedRunnerId,
      ) ??
      snapshot.projects.find((project) => project.projectId === selectedProjectId) ??
      snapshot.projects[0] ??
      null
    );
  }, [selectedProjectId, selectedRunnerId, selectedThread, snapshot]);

  const selectedRunner = useMemo(() => {
    if (!snapshot) return null;
    const runnerId = selectedThread?.runnerId ?? selectedProject?.runnerId ?? selectedRunnerId;
    return snapshot.runners.find((runner) => runner.runnerId === runnerId) ?? snapshot.runners[0] ?? null;
  }, [selectedProject?.runnerId, selectedRunnerId, selectedThread?.runnerId, snapshot]);

  const setSelectedThreadId = useCallback((threadId: string | null, draft = false) => {
    setDraftMode(draft);
    setSelectedThreadIdState(threadId);
    remember(STORAGE.threadId, threadId);
  }, []);

  const setSelectedProject = useCallback((project: ProjectSummary | null) => {
    setSelectedProjectIdState(project?.projectId ?? null);
    setSelectedRunnerIdState(project?.runnerId ?? null);
    remember(STORAGE.projectId, project?.projectId ?? null);
    remember(STORAGE.runnerId, project?.runnerId ?? null);
  }, []);

  const loadThreadDetail = useCallback(async (threadId: string | null) => {
    if (!threadId) {
      setThreadDetail(null);
      return;
    }
    const detail = await api<AppThreadDetail>(`/api/app/threads/${encodeURIComponent(threadId)}`);
    setThreadDetail(detail);
  }, []);

  const refreshSnapshot = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setRefreshing(true);
      try {
        const next = await api<AppSnapshot>("/api/app/snapshot");
        setSnapshot(next);
        setConnection((current) => (current === "loading" || current === "pair-required" ? "offline" : current));
        const storedThread =
          selectedThreadId && next.threads.some((thread) => thread.cloudThreadId === selectedThreadId)
            ? selectedThreadId
            : null;
        if (storedThread) {
          await loadThreadDetail(storedThread);
        } else if (!draftMode && next.threads[0]) {
          setSelectedThreadId(next.threads[0].cloudThreadId);
          setSelectedProject(
            next.projects.find(
              (project) =>
                project.projectId === next.threads[0].projectId &&
                project.runnerId === next.threads[0].runnerId,
            ) ?? null,
          );
          await loadThreadDetail(next.threads[0].cloudThreadId);
        } else {
          await loadThreadDetail(null);
        }
      } catch (error) {
        if ((error as Error & { status?: number }).status === 401) {
          setSnapshot(null);
          setThreadDetail(null);
          setConnection("pair-required");
          return;
        }
        setNotice({ kind: "error", text: error instanceof Error ? error.message : "Refresh failed" });
        setConnection("offline");
      } finally {
        setRefreshing(false);
      }
    },
    [
      draftMode,
      loadThreadDetail,
      selectedThreadId,
      setSelectedProject,
      setSelectedThreadId,
    ],
  );

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshSnapshot({ silent: true });
    }, 120);
  }, [refreshSnapshot]);

  useEffect(() => {
    void refreshSnapshot({ silent: true });
    return () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    let closed = false;
    let reconnectTimer: number | null = null;
    let reconnectDelay = 1000;
    let ws: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      const url = new URL("/ws/client", window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url);

      ws.addEventListener("open", () => {
        reconnectDelay = 1000;
        setConnection("live");
        ws?.send(JSON.stringify(envelope("client.hello", { clientId: clientId() })));
      });

      ws.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data) as Envelope;
          if (
            message.type === "event.appended" ||
            message.type === "thread.status.result" ||
            message.type === "approval.updated" ||
            message.type === "turn.start.accepted"
          ) {
            const accepted = message.payload as { cloudThreadId?: string };
            if (accepted.cloudThreadId) {
              setSelectedThreadId(accepted.cloudThreadId);
            }
            scheduleRefresh();
          }
          if (message.type === "error") {
            const payload = message.payload as { message?: string; code?: string };
            setNotice({ kind: "error", text: payload.message ?? payload.code ?? "WebSocket error" });
          }
        } catch (error) {
          setNotice({
            kind: "error",
            text: error instanceof Error ? error.message : "Invalid WebSocket message",
          });
        }
      });

      ws.addEventListener("close", () => {
        if (closed) return;
        setConnection("reconnecting");
        reconnectTimer = window.setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 10000);
          connect();
        }, reconnectDelay);
      });

      ws.addEventListener("error", () => {
        setConnection("offline");
      });
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [scheduleRefresh, setSelectedThreadId, snapshot?.session.sessionId]);

  useEffect(() => {
    if (!snapshot || !selectedThreadId) return;
    void loadThreadDetail(selectedThreadId).catch((error) =>
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Thread load failed" }),
    );
  }, [loadThreadDetail, selectedThreadId, snapshot]);

  const handlePair = useCallback(
    async (pairingToken: string, deviceName: string) => {
      await api("/api/pairing/finish", {
        method: "POST",
        body: JSON.stringify({ pairingToken, deviceName, deviceKind: "client" }),
      });
      setNotice({ kind: "ok", text: "Browser paired" });
      await refreshSnapshot({ silent: true });
    },
    [refreshSnapshot],
  );

  const handleSelectThread = useCallback(
    (thread: AppThreadSummary) => {
      setSelectedThreadId(thread.cloudThreadId);
      setSelectedProject(
        snapshot?.projects.find(
          (project) => project.projectId === thread.projectId && project.runnerId === thread.runnerId,
        ) ?? null,
      );
    },
    [setSelectedProject, setSelectedThreadId, snapshot?.projects],
  );

  const handleNewThread = useCallback(
    (project?: ProjectSummary) => {
      const nextProject = project ?? selectedProject ?? snapshot?.projects[0] ?? null;
      setSelectedProject(nextProject);
      setSelectedThreadId(null, true);
      setThreadDetail(null);
    },
    [selectedProject, setSelectedProject, setSelectedThreadId, snapshot?.projects],
  );

  const handleCreateProject = useCallback(
    async (input: ProjectCreateInput) => {
      await api("/api/cloud-projects", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setNotice({ kind: "ok", text: "Project creation sent" });
      scheduleRefresh();
      window.setTimeout(() => void refreshSnapshot({ silent: true }), 1000);
    },
    [refreshSnapshot, scheduleRefresh],
  );

  const handleDeleteProject = useCallback(
    async (project: ProjectSummary) => {
      const confirmed = window.confirm(`Delete workspace "${project.name}" from ${project.runnerId}?`);
      if (!confirmed) return;
      try {
        await api(
          `/api/cloud-projects/${encodeURIComponent(project.runnerId)}/${encodeURIComponent(project.projectId)}`,
          {
            method: "DELETE",
          },
        );
        if (
          selectedProject?.projectId === project.projectId &&
          selectedProject.runnerId === project.runnerId
        ) {
          setSelectedProject(null);
          setSelectedThreadId(null, true);
          setThreadDetail(null);
        }
        setNotice({ kind: "ok", text: "Workspace delete sent" });
        scheduleRefresh();
        window.setTimeout(() => void refreshSnapshot({ silent: true }), 1000);
      } catch (caught) {
        setNotice({ kind: "error", text: caught instanceof Error ? caught.message : "Delete failed" });
      }
    },
    [refreshSnapshot, scheduleRefresh, selectedProject, setSelectedProject, setSelectedThreadId],
  );

  const handleSendPrompt = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const thread = threadDetail?.thread ?? selectedThread;
      const runnerId = thread?.runnerId ?? selectedRunner?.runnerId;
      const projectId = thread?.projectId ?? selectedProject?.projectId;
      if (!runnerId || !projectId) {
        setNotice({ kind: "error", text: "Select a runner and project first." });
        return;
      }
      if (thread) {
        await api(`/api/threads/${encodeURIComponent(thread.cloudThreadId)}/steer`, {
          method: "POST",
          body: JSON.stringify({ prompt: trimmed }),
        });
      } else {
        const accepted = await api<{ cloudThreadId: string }>("/api/turns/start", {
          method: "POST",
          body: JSON.stringify({ runnerId, projectId, prompt: trimmed }),
        });
        setSelectedThreadId(accepted.cloudThreadId);
        setDraftMode(false);
      }
      setNotice(null);
      await refreshSnapshot({ silent: true });
    },
    [
      refreshSnapshot,
      selectedProject?.projectId,
      selectedRunner?.runnerId,
      selectedThread,
      setSelectedThreadId,
      threadDetail?.thread,
    ],
  );

  const handleInterrupt = useCallback(async () => {
    const thread = threadDetail?.thread ?? selectedThread;
    if (!thread) return;
    await api(`/api/threads/${encodeURIComponent(thread.cloudThreadId)}/interrupt`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setNotice({ kind: "ok", text: "Interrupt sent" });
    scheduleRefresh();
  }, [scheduleRefresh, selectedThread, threadDetail?.thread]);

  const handleApprovalDecision = useCallback(
    async (approvalId: string, decision: "accept" | "decline" | "cancel") => {
      await api(`/api/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      setNotice({ kind: "ok", text: `Approval ${decision} sent` });
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  if (connection === "pair-required") {
    return <PairingScreen notice={notice} onPair={handlePair} />;
  }

  if (!snapshot) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-foreground">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" />
          Loading workspace
        </div>
      </div>
    );
  }

  return (
    <WorkspaceShell
      connection={connection}
      detail={threadDetail}
      notice={notice}
      onApprovalDecision={handleApprovalDecision}
      onCreateProject={handleCreateProject}
      onDeleteProject={handleDeleteProject}
      onInterrupt={handleInterrupt}
      onNewThread={handleNewThread}
      onRefresh={() => void refreshSnapshot()}
      onSelectProject={setSelectedProject}
      onSelectThread={handleSelectThread}
      onSendPrompt={handleSendPrompt}
      refreshing={refreshing}
      selectedProject={selectedProject}
      selectedRunner={selectedRunner}
      selectedThreadId={selectedThreadId}
      snapshot={snapshot}
    />
  );
}

function PairingScreen(props: {
  readonly notice: Notice;
  readonly onPair: (pairingToken: string, deviceName: string) => Promise<void>;
}) {
  const [pairingToken, setPairingToken] = useState("");
  const [deviceName, setDeviceName] = useState("web browser");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onPair(pairingToken.trim(), deviceName.trim() || "web browser");
      setPairingToken("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Pairing failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex h-full items-center justify-center bg-background p-4 text-foreground">
      <form
        onSubmit={submit}
        className="subtle-enter grid w-full max-w-sm gap-5 rounded-lg border border-border bg-background/90 p-5 shadow-2xl shadow-black/20"
      >
        <div className="grid gap-2">
          <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <KeyRoundIcon className="size-4" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Pair browser</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter a client pairing token to open codex-remote.
            </p>
          </div>
        </div>
        <label className="grid gap-1.5 text-sm">
          <span className="text-muted-foreground">Client pairing token</span>
          <input
            autoComplete="one-time-code"
            className="h-10 rounded-md border border-input bg-background px-3 outline-none ring-primary/0 transition focus:ring-2 focus:ring-primary/40"
            required
            value={pairingToken}
            onChange={(event) => setPairingToken(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="text-muted-foreground">Device name</span>
          <input
            className="h-10 rounded-md border border-input bg-background px-3 outline-none ring-primary/0 transition focus:ring-2 focus:ring-primary/40"
            required
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
          />
        </label>
        {(error || props.notice) && (
          <p
            className={cn(
              "rounded-md border px-3 py-2 text-sm",
              error || props.notice?.kind === "error"
                ? "border-destructive/30 text-destructive"
                : "border-success/30 text-success",
            )}
          >
            {error ?? props.notice?.text}
          </p>
        )}
        <button
          disabled={busy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:brightness-110"
          type="submit"
        >
          {busy ? <LoaderCircleIcon className="size-4 animate-spin" /> : <KeyRoundIcon className="size-4" />}
          Pair
        </button>
      </form>
    </main>
  );
}

function WorkspaceShell(props: {
  readonly snapshot: AppSnapshot;
  readonly detail: AppThreadDetail | null;
  readonly selectedThreadId: string | null;
  readonly selectedProject: ProjectSummary | null;
  readonly selectedRunner: RunnerSummary | null;
  readonly connection: ConnectionState;
  readonly refreshing: boolean;
  readonly notice: Notice;
  readonly onRefresh: () => void;
  readonly onSelectThread: (thread: AppThreadSummary) => void;
  readonly onSelectProject: (project: ProjectSummary | null) => void;
  readonly onNewThread: (project?: ProjectSummary) => void;
  readonly onCreateProject: (input: ProjectCreateInput) => Promise<void>;
  readonly onDeleteProject: (project: ProjectSummary) => Promise<void>;
  readonly onSendPrompt: (prompt: string) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onApprovalDecision: (approvalId: string, decision: "accept" | "decline" | "cancel") => Promise<void>;
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-1 bg-background text-foreground md:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_320px]">
      <Sidebar
        connection={props.connection}
        onCreateProject={props.onCreateProject}
        onDeleteProject={props.onDeleteProject}
        onNewThread={props.onNewThread}
        onRefresh={props.onRefresh}
        onSelectProject={props.onSelectProject}
        onSelectThread={props.onSelectThread}
        refreshing={props.refreshing}
        selectedProject={props.selectedProject}
        selectedThreadId={props.selectedThreadId}
        snapshot={props.snapshot}
      />
      <ThreadWorkspace
        detail={props.detail}
        notice={props.notice}
        onApprovalDecision={props.onApprovalDecision}
        onInterrupt={props.onInterrupt}
        onSendPrompt={props.onSendPrompt}
        selectedProject={props.selectedProject}
        selectedRunner={props.selectedRunner}
      />
      <ContextPanel
        approvals={props.snapshot.approvals}
        detail={props.detail}
        onApprovalDecision={props.onApprovalDecision}
        selectedProject={props.selectedProject}
        selectedRunner={props.selectedRunner}
      />
    </div>
  );
}

function Sidebar(props: {
  readonly snapshot: AppSnapshot;
  readonly selectedThreadId: string | null;
  readonly selectedProject: ProjectSummary | null;
  readonly connection: ConnectionState;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly onNewThread: (project?: ProjectSummary) => void;
  readonly onCreateProject: (input: ProjectCreateInput) => Promise<void>;
  readonly onDeleteProject: (project: ProjectSummary) => Promise<void>;
  readonly onSelectThread: (thread: AppThreadSummary) => void;
  readonly onSelectProject: (project: ProjectSummary | null) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => {
    const raw = localStorage.getItem(STORAGE.collapsedProjects);
    if (!raw) return new Set<string>();
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? new Set(parsed.filter((value): value is string => typeof value === "string"))
        : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });
  const grouped = useMemo(
    () =>
      props.snapshot.projects.map((project) => ({
        project,
        threads: props.snapshot.threads.filter(
          (thread) => thread.projectId === project.projectId && thread.runnerId === project.runnerId,
        ),
        runner: props.snapshot.runners.find((runner) => runner.runnerId === project.runnerId) ?? null,
      })),
    [props.snapshot.projects, props.snapshot.runners, props.snapshot.threads],
  );
  const toggleProject = useCallback(
    (project: ProjectSummary) => {
      props.onSelectProject(project);
      setCollapsedProjects((current) => {
        const key = `${project.runnerId}:${project.projectId}`;
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        localStorage.setItem(STORAGE.collapsedProjects, JSON.stringify(Array.from(next)));
        return next;
      });
    },
    [props.onSelectProject],
  );

  return (
    <aside className="flex min-h-0 flex-col border-b border-border bg-background/95 md:border-b-0 md:border-r">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">codex-remote</div>
          <ConnectionBadge state={props.connection} />
        </div>
        <div className="flex items-center gap-1">
          <IconButton label="Refresh" onClick={props.onRefresh}>
            <RefreshCwIcon className={cn("size-4", props.refreshing && "animate-spin")} />
          </IconButton>
          <IconButton label="Create project" onClick={() => setCreateOpen((open) => !open)}>
            <FolderPlusIcon className="size-4" />
          </IconButton>
          <IconButton label="New thread" onClick={() => props.onNewThread()}>
            <PlusIcon className="size-4" />
          </IconButton>
        </div>
      </div>
      {createOpen && (
        <ProjectCreateForm
          runners={props.snapshot.runners}
          selectedRunnerId={props.selectedProject?.runnerId}
          onCreate={async (input) => {
            await props.onCreateProject(input);
            setCreateOpen(false);
          }}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {grouped.length === 0 ? (
          <EmptyState title="No projects" detail="Connect a runner to register projects." />
        ) : (
          <div className="grid gap-1">
            {grouped.map(({ project, threads, runner }) => (
              <ProjectGroup
                key={`${project.runnerId}:${project.projectId}`}
                project={project}
                runner={runner}
                threads={threads}
                selectedProject={props.selectedProject}
                selectedThreadId={props.selectedThreadId}
                collapsed={collapsedProjects.has(`${project.runnerId}:${project.projectId}`)}
                onDeleteProject={props.onDeleteProject}
                onNewThread={props.onNewThread}
                onSelectProject={props.onSelectProject}
                onSelectThread={props.onSelectThread}
                onToggleProject={toggleProject}
              />
            ))}
          </div>
        )}
      </div>
      <div className="hidden border-t border-border p-2 text-xs text-muted-foreground md:block">
        {props.snapshot.runners.length} runners · {props.snapshot.threads.length} threads · seq{" "}
        {props.snapshot.lastSequence}
      </div>
    </aside>
  );
}

function ProjectCreateForm(props: {
  readonly runners: readonly RunnerSummary[];
  readonly selectedRunnerId?: string;
  readonly onCreate: (input: ProjectCreateInput) => Promise<void>;
}) {
  const firstRunner = props.runners.find((runner) => runner.connected) ?? props.runners[0] ?? null;
  const [runnerId, setRunnerId] = useState(props.selectedRunnerId ?? firstRunner?.runnerId ?? "");
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedProjectId = projectId.trim();
    if (!runnerId || !trimmedProjectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onCreate({
        runnerId,
        projectId: trimmedProjectId,
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setProjectId("");
      setName("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Project creation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="grid gap-2 border-b border-border p-2" onSubmit={(event) => void submit(event)}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <select
          className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-primary/35"
          disabled={busy || props.runners.length === 0}
          value={runnerId}
          onChange={(event) => setRunnerId(event.target.value)}
        >
          {props.runners.length === 0 ? (
            <option value="">No runner</option>
          ) : (
            props.runners.map((runner) => (
              <option key={runner.runnerId} value={runner.runnerId}>
                {runner.name}
              </option>
            ))
          )}
        </select>
        <button
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition hover:brightness-110"
          disabled={busy || !runnerId || !projectId.trim()}
          type="submit"
        >
          {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <FolderPlusIcon className="size-3.5" />}
          Create
        </button>
      </div>
      <input
        className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/35"
        disabled={busy}
        placeholder="workspace-id"
        value={projectId}
        onChange={(event) => setProjectId(event.target.value)}
      />
      <input
        className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/35"
        disabled={busy}
        placeholder="Name (optional)"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

function ProjectGroup(props: {
  readonly project: ProjectSummary;
  readonly runner: RunnerSummary | null;
  readonly threads: readonly AppThreadSummary[];
  readonly selectedProject: ProjectSummary | null;
  readonly selectedThreadId: string | null;
  readonly collapsed: boolean;
  readonly onSelectProject: (project: ProjectSummary | null) => void;
  readonly onSelectThread: (thread: AppThreadSummary) => void;
  readonly onNewThread: (project?: ProjectSummary) => void;
  readonly onDeleteProject: (project: ProjectSummary) => Promise<void>;
  readonly onToggleProject: (project: ProjectSummary) => void;
}) {
  const activeProject =
    props.selectedProject?.projectId === props.project.projectId &&
    props.selectedProject?.runnerId === props.project.runnerId;
  return (
    <section className="grid gap-0.5">
      <div
        className={cn(
          "group flex min-h-9 items-center gap-2 rounded-md px-2 text-left text-sm transition",
          activeProject ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
        )}
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
          type="button"
          onClick={() => props.onToggleProject(props.project)}
        >
          {props.collapsed ? (
            <ChevronRightIcon className="size-3.5 shrink-0" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0" />
          )}
          <FolderIcon className="size-4 shrink-0" />
          <span className="truncate font-medium">{props.project.name}</span>
        </button>
        <span className={cn("hidden text-[11px] sm:inline", props.runner?.connected ? "text-success" : "text-muted-foreground")}>
          {props.runner?.connected ? "live" : "offline"}
        </span>
        <button
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-80 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
          title="New thread in project"
          type="button"
          onClick={() => props.onNewThread(props.project)}
        >
            <PlusIcon className="size-3.5" />
        </button>
        <button
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-80 transition hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          title="Delete workspace"
          type="button"
          onClick={() => void props.onDeleteProject(props.project)}
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
      <div className={cn("ml-3 grid gap-0.5 border-l border-border pl-2", props.collapsed && "hidden")}>
        {props.threads.length === 0 ? (
          <button
            className="rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
            type="button"
            onClick={() => props.onNewThread(props.project)}
          >
            New thread
          </button>
        ) : (
          props.threads.map((thread) => (
            <ThreadRow
              key={thread.cloudThreadId}
              active={thread.cloudThreadId === props.selectedThreadId}
              thread={thread}
              onSelect={props.onSelectThread}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ThreadRow(props: {
  readonly thread: AppThreadSummary;
  readonly active: boolean;
  readonly onSelect: (thread: AppThreadSummary) => void;
}) {
  return (
    <button
      className={cn(
        "grid min-h-12 rounded-md px-2 py-1.5 text-left transition",
        props.active ? "bg-primary/12 text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      type="button"
      onClick={() => props.onSelect(props.thread)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ThreadStatusDot status={props.thread.status} />
        <span className="truncate text-sm font-medium">{props.thread.title}</span>
        {props.thread.hasPendingApprovals && (
          <span className="ml-auto rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
            approval
          </span>
        )}
      </span>
      <span className="ml-4 truncate text-[11px] text-muted-foreground">
        {props.thread.lastActivityLabel ?? props.thread.status} · {formatRelativeTime(props.thread.updatedAt)}
      </span>
    </button>
  );
}

function ThreadWorkspace(props: {
  readonly detail: AppThreadDetail | null;
  readonly selectedProject: ProjectSummary | null;
  readonly selectedRunner: RunnerSummary | null;
  readonly notice: Notice;
  readonly onSendPrompt: (prompt: string) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onApprovalDecision: (approvalId: string, decision: "accept" | "decline" | "cancel") => Promise<void>;
}) {
  const thread = props.detail?.thread ?? null;
  const busy = thread ? ["queued", "starting", "running"].includes(thread.status) : false;
  return (
    <main className="flex min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3 md:px-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">
              {thread?.title ?? props.selectedProject?.name ?? "New thread"}
            </h1>
            {thread && <StatusPill status={thread.status} />}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {props.selectedRunner?.name ?? "No runner"} · {props.selectedProject?.name ?? "No project"}
            {thread?.providerThreadId ? ` · ${shortId(thread.providerThreadId)}` : ""}
          </p>
        </div>
        <button
          disabled={!busy}
          className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:hover:bg-transparent"
          type="button"
          onClick={() => void props.onInterrupt()}
        >
          <SquareIcon className="size-3.5" />
          Interrupt
        </button>
      </header>
      {props.notice && (
        <div
          className={cn(
            "mx-3 mt-3 rounded-md border px-3 py-2 text-sm md:mx-4",
            props.notice.kind === "error"
              ? "border-destructive/30 text-destructive"
              : "border-success/30 text-success",
          )}
        >
          {props.notice.text}
        </div>
      )}
      <MessagesTimeline detail={props.detail} onApprovalDecision={props.onApprovalDecision} />
      <Composer
        disabled={!props.selectedProject || !props.selectedRunner}
        isWorking={busy}
        onSendPrompt={props.onSendPrompt}
        placeholder={
          thread
            ? "Send a follow-up"
            : props.selectedProject
              ? `Start a thread in ${props.selectedProject.name}`
              : "Select a project"
        }
      />
    </main>
  );
}

type TimelineRow =
  | { kind: "message"; sortKey: string; sequence: number; message: AppMessage }
  | { kind: "activity"; sortKey: string; sequence: number; activity: AppActivity }
  | { kind: "approval"; sortKey: string; sequence: number; approval: AppApproval };

function MessagesTimeline(props: {
  readonly detail: AppThreadDetail | null;
  readonly onApprovalDecision: (approvalId: string, decision: "accept" | "decline" | "cancel") => Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo<TimelineRow[]>(() => {
    const detail = props.detail;
    if (!detail) return [];
    return [
      ...detail.messages.map((message) => ({
        kind: "message" as const,
        sortKey: message.createdAt,
        sequence: message.sequence ?? 0,
        message,
      })),
      ...detail.activities.map((activity) => ({
        kind: "activity" as const,
        sortKey: activity.createdAt,
        sequence: activity.sequence ?? 0,
        activity,
      })),
      ...detail.approvals
        .filter((approval) => approval.status === "pending")
        .map((approval) => ({
          kind: "approval" as const,
          sortKey: approval.createdAt,
          sequence: 0,
          approval,
        })),
    ].sort((left, right) => left.sortKey.localeCompare(right.sortKey) || left.sequence - right.sequence);
  }, [props.detail]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [rows.length]);

  if (!props.detail) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
        <EmptyState title="New thread" detail="Choose a project and send a prompt." />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
        <EmptyState title="No events yet" detail="The runner has not sent thread output." />
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="timeline-scroll min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-4">
      <div className="mx-auto grid w-full max-w-3xl gap-4">
        {rows.map((row) => {
          if (row.kind === "message") return <MessageBubble key={`m-${row.message.id}`} message={row.message} />;
          if (row.kind === "approval") {
            return (
              <ApprovalInline
                key={`a-${row.approval.approvalId}`}
                approval={row.approval}
                onDecision={props.onApprovalDecision}
              />
            );
          }
          return <ActivityRow key={`w-${row.activity.id}`} activity={row.activity} />;
        })}
      </div>
    </div>
  );
}

function MessageBubble(props: { readonly message: AppMessage }) {
  const assistant = props.message.role === "assistant";
  return (
    <article
      className={cn(
        "subtle-enter flex gap-3",
        props.message.role === "user" && "justify-end",
      )}
    >
      {assistant && (
        <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-muted-foreground">
          <BotIcon className="size-4" />
        </div>
      )}
      <div
        className={cn(
          "max-w-[86%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm leading-6",
          props.message.role === "user"
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-background",
        )}
      >
        {props.message.text}
      </div>
      {props.message.role === "user" && (
        <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <UserIcon className="size-4" />
        </div>
      )}
    </article>
  );
}

function ActivityRow(props: { readonly activity: AppActivity }) {
  const Icon =
    props.activity.tone === "error"
      ? AlertTriangleIcon
      : props.activity.tone === "tool"
        ? TerminalIcon
        : props.activity.tone === "thinking"
          ? LoaderCircleIcon
          : props.activity.tone === "approval"
            ? KeyRoundIcon
            : ClockIcon;
  return (
    <div className="subtle-enter mx-auto flex w-full max-w-2xl items-start gap-2 text-xs text-muted-foreground">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-accent">
        <Icon className={cn("size-3.5", props.activity.tone === "thinking" && "animate-spin")} />
      </div>
      <div className="min-w-0 border-l border-border pl-3">
        <div className="font-medium text-foreground/80">{props.activity.label}</div>
        {props.activity.detail && <div className="mt-0.5 break-words">{props.activity.detail}</div>}
      </div>
    </div>
  );
}

function ApprovalInline(props: {
  readonly approval: AppApproval;
  readonly onDecision: (approvalId: string, decision: "accept" | "decline" | "cancel") => Promise<void>;
}) {
  return (
    <section className="subtle-enter rounded-lg border border-warning/25 bg-warning/5 p-3">
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-warning/15 text-warning">
          <KeyRoundIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{props.approval.title}</h2>
          {props.approval.detail && (
            <p className="mt-1 break-words text-sm text-muted-foreground">{props.approval.detail}</p>
          )}
          {props.approval.command && (
            <pre className="mt-2 max-h-28 overflow-auto rounded-md border border-border bg-background p-2 text-xs text-muted-foreground">
              {props.approval.command}
            </pre>
          )}
          <ApprovalActions approvalId={props.approval.approvalId} onDecision={props.onDecision} />
        </div>
      </div>
    </section>
  );
}

function ApprovalActions(props: {
  readonly approvalId: string;
  readonly onDecision: (approvalId: string, decision: "accept" | "decline" | "cancel") => Promise<void>;
}) {
  const [busyDecision, setBusyDecision] = useState<string | null>(null);
  const decide = async (decision: "accept" | "decline" | "cancel") => {
    setBusyDecision(decision);
    try {
      await props.onDecision(props.approvalId, decision);
    } finally {
      setBusyDecision(null);
    }
  };
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <SmallActionButton busy={busyDecision === "accept"} onClick={() => void decide("accept")}>
        <CheckIcon className="size-3.5" />
        Accept
      </SmallActionButton>
      <SmallActionButton busy={busyDecision === "decline"} onClick={() => void decide("decline")}>
        <XIcon className="size-3.5" />
        Decline
      </SmallActionButton>
      <SmallActionButton busy={busyDecision === "cancel"} onClick={() => void decide("cancel")}>
        <BanIcon className="size-3.5" />
        Cancel
      </SmallActionButton>
    </div>
  );
}

function Composer(props: {
  readonly disabled: boolean;
  readonly isWorking: boolean;
  readonly placeholder: string;
  readonly onSendPrompt: (prompt: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const prompt = value.trim();
    if (!prompt || props.disabled || sending) return;
    setSending(true);
    try {
      await props.onSendPrompt(prompt);
      setValue("");
    } finally {
      setSending(false);
    }
  };
  return (
    <form className="shrink-0 border-t border-border bg-background/95 p-3" onSubmit={(event) => void submit(event)}>
      <div className="mx-auto grid max-w-3xl gap-2 rounded-lg border border-border bg-background p-2 shadow-2xl shadow-black/10">
        <textarea
          className="max-h-40 min-h-20 resize-none rounded-md bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground"
          disabled={props.disabled || sending}
          placeholder={props.placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              void submit();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            {props.isWorking ? (
              <>
                <LoaderCircleIcon className="size-3.5 animate-spin" />
                Running
              </>
            ) : (
              <>
                <CircleIcon className="size-3 fill-current" />
                Ready
              </>
            )}
          </div>
          <button
            className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition hover:brightness-110"
            disabled={props.disabled || sending || !value.trim()}
            type="submit"
          >
            {sending ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <SendIcon className="size-3.5" />}
            Send
          </button>
        </div>
      </div>
    </form>
  );
}

function ContextPanel(props: {
  readonly detail: AppThreadDetail | null;
  readonly approvals: readonly AppApproval[];
  readonly selectedProject: ProjectSummary | null;
  readonly selectedRunner: RunnerSummary | null;
  readonly onApprovalDecision: (approvalId: string, decision: "accept" | "decline" | "cancel") => Promise<void>;
}) {
  const threadApprovals =
    props.detail?.approvals.filter((approval) => approval.status === "pending") ?? [];
  const otherApprovals = props.approvals.filter(
    (approval) => !threadApprovals.some((threadApproval) => threadApproval.approvalId === approval.approvalId),
  );
  return (
    <aside className="hidden min-h-0 flex-col border-l border-border bg-background/95 xl:flex">
      <div className="flex h-14 shrink-0 items-center border-b border-border px-3">
        <div>
          <h2 className="text-sm font-semibold">Context</h2>
          <p className="text-xs text-muted-foreground">Runner, project, approvals</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <section className="grid gap-2 border-b border-border pb-4">
          <InfoLine label="Runner" value={props.selectedRunner?.name ?? "None"} />
          <InfoLine
            label="Runner state"
            value={props.selectedRunner?.connected ? "Connected" : "Offline"}
            tone={props.selectedRunner?.connected ? "success" : "muted"}
          />
          <InfoLine label="Project" value={props.selectedProject?.name ?? "None"} />
          <InfoLine label="Thread" value={props.detail?.thread ? shortId(props.detail.thread.cloudThreadId) : "Draft"} />
          <InfoLine label="Events" value={String(props.detail?.rawEventCount ?? 0)} />
        </section>
        <section className="grid gap-3 py-4">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">Approvals</h3>
          {threadApprovals.length === 0 && otherApprovals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending approvals.</p>
          ) : (
            <>
              {threadApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  onDecision={props.onApprovalDecision}
                />
              ))}
              {otherApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  onDecision={props.onApprovalDecision}
                />
              ))}
            </>
          )}
        </section>
      </div>
    </aside>
  );
}

function ApprovalCard(props: {
  readonly approval: AppApproval;
  readonly onDecision: (approvalId: string, decision: "accept" | "decline" | "cancel") => Promise<void>;
}) {
  return (
    <article className="rounded-lg border border-border p-3">
      <div className="flex items-start gap-2">
        <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <h4 className="truncate text-sm font-medium">{props.approval.title}</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {props.approval.projectId} · {formatRelativeTime(props.approval.createdAt)}
          </p>
        </div>
      </div>
      {props.approval.detail && (
        <p className="mt-2 break-words text-xs text-muted-foreground">{props.approval.detail}</p>
      )}
      <ApprovalActions approvalId={props.approval.approvalId} onDecision={props.onDecision} />
    </article>
  );
}

function InfoLine(props: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "success" | "muted";
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{props.label}</span>
      <span className={cn("truncate text-right font-medium", props.tone === "success" && "text-success")}>
        {props.value}
      </span>
    </div>
  );
}

function ConnectionBadge(props: { readonly state: ConnectionState }) {
  const Icon = props.state === "live" ? WifiIcon : props.state === "reconnecting" ? RadioIcon : WifiOffIcon;
  const label =
    props.state === "live"
      ? "Live"
      : props.state === "reconnecting"
        ? "Reconnecting"
        : props.state === "loading"
          ? "Loading"
          : props.state === "pair-required"
            ? "Pair required"
            : "Offline";
  return (
    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className={cn("size-3.5", props.state === "live" && "text-success")} />
      {label}
    </div>
  );
}

function ThreadStatusDot(props: { readonly status: string }) {
  return <span className={cn("size-2 rounded-full bg-current", statusTone(props.status))} />;
}

function StatusPill(props: { readonly status: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded px-1.5 text-[11px] font-medium",
        props.status === "ready"
          ? "bg-success/12 text-success"
          : props.status === "error"
            ? "bg-destructive/12 text-destructive"
            : ["queued", "starting", "running"].includes(props.status)
              ? "bg-warning/12 text-warning"
              : "bg-accent text-muted-foreground",
      )}
    >
      {props.status}
    </span>
  );
}

function EmptyState(props: { readonly title: string; readonly detail: string }) {
  return (
    <div className="grid justify-items-center gap-1 text-center">
      <ChevronRightIcon className="size-4 text-muted-foreground/60" />
      <h3 className="text-sm font-medium">{props.title}</h3>
      <p className="max-w-60 text-sm text-muted-foreground">{props.detail}</p>
    </div>
  );
}

function IconButton(props: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
      title={props.label}
      type="button"
      onClick={props.onClick}
    >
      {props.children}
      <span className="sr-only">{props.label}</span>
    </button>
  );
}

function SmallActionButton(props: {
  readonly children: React.ReactNode;
  readonly busy: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
      disabled={props.busy}
      type="button"
      onClick={props.onClick}
    >
      {props.busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : props.children}
    </button>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
