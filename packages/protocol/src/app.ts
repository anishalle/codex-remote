import type {
  ApprovalDecision,
  DeviceKind,
  ProjectSummary,
  RunnerSummary,
  ThreadStatus,
} from "./messages.ts";

export interface AppSession {
  readonly authenticated: true;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceKind: DeviceKind;
  readonly deviceName: string;
  readonly expiresAt: string;
}

export interface AppThreadSummary {
  readonly id: string;
  readonly cloudThreadId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: ThreadStatus;
  readonly providerThreadId?: string;
  readonly activeTurnId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt?: string;
  readonly latestAssistantMessageAt?: string;
  readonly lastActivityLabel?: string;
  readonly hasPendingApprovals: boolean;
  readonly eventCount: number;
}

export interface AppMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sequence?: number;
  readonly streaming?: boolean;
}

export interface AppActivity {
  readonly id: string;
  readonly kind: "status" | "tool" | "approval" | "error" | "raw";
  readonly tone: "info" | "thinking" | "tool" | "approval" | "error";
  readonly label: string;
  readonly detail?: string;
  readonly createdAt: string;
  readonly sequence?: number;
}

export interface AppApproval {
  readonly approvalId: string;
  readonly runnerId: string;
  readonly cloudThreadId: string;
  readonly projectId: string;
  readonly approvalType: string;
  readonly status: "pending" | "resolved";
  readonly title: string;
  readonly detail?: string;
  readonly command?: string;
  readonly decision?: ApprovalDecision;
  readonly createdAt: string;
  readonly resolvedAt?: string;
}

export interface AppThreadDetail {
  readonly thread: AppThreadSummary | null;
  readonly messages: readonly AppMessage[];
  readonly activities: readonly AppActivity[];
  readonly approvals: readonly AppApproval[];
  readonly rawEventCount: number;
  readonly lastSequence: number;
}

export interface AppSnapshot {
  readonly session: AppSession;
  readonly runners: readonly RunnerSummary[];
  readonly projects: readonly ProjectSummary[];
  readonly threads: readonly AppThreadSummary[];
  readonly approvals: readonly AppApproval[];
  readonly lastSequence: number;
}
