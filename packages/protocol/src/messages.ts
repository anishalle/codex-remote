import { randomUUID } from "node:crypto";

import {
  arraySchema,
  booleanSchema,
  literalSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  nullableSchema,
  objectSchema,
  optionalSchema,
  recordSchema,
  stringSchema,
  unionSchema,
  unknownSchema,
  type Schema,
} from "./schema.ts";

export const PROTOCOL_VERSION = 1 as const;

export type DeviceKind = "runner" | "client" | "owner";

export interface CloudEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly runnerId: string;
  readonly projectId?: string;
  readonly threadId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly receivedAt: string;
}

export interface Envelope<TType extends string = string, TPayload = unknown> {
  readonly version: typeof PROTOCOL_VERSION;
  readonly id: string;
  readonly type: TType;
  readonly sentAt: string;
  readonly payload: TPayload;
}

export interface PingPayload {
  readonly nonce?: string;
}

export interface PongPayload {
  readonly nonce?: string;
}

export interface ErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
}

export interface RunnerHelloPayload {
  readonly runnerId: string;
  readonly name: string;
  readonly version?: string;
  readonly capabilities?: readonly string[];
  readonly projects?: readonly RunnerProjectDescriptor[];
}

export interface RunnerHelloAckPayload {
  readonly runnerId: string;
  readonly connectionId: string;
}

export interface RunnerProjectDescriptor {
  readonly projectId: string;
  readonly name: string;
}

export interface RunnerProjectCreatePayload {
  readonly commandId: string;
  readonly projectId: string;
  readonly name?: string;
  readonly requestedAt: string;
}

export interface RunnerProjectCreatedPayload {
  readonly commandId: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface RunnerProjectDeletePayload {
  readonly commandId: string;
  readonly projectId: string;
  readonly requestedAt: string;
}

export interface RunnerProjectDeletedPayload {
  readonly commandId: string;
  readonly projectId: string;
  readonly deletedAt: string;
}

export interface RunnerWorkspaceUnpackPayload {
  readonly commandId: string;
  readonly uploadId: string;
  readonly projectId: string;
  readonly requestedAt: string;
}

export interface RunnerWorkspaceUnpackedPayload {
  readonly commandId: string;
  readonly uploadId: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface RunnerEventAppendPayload {
  readonly eventId: string;
  readonly projectId?: string;
  readonly threadId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: string;
}

export interface RunnerEventAckPayload {
  readonly eventId: string;
  readonly sequence: number;
}

export type ThreadStatus = "queued" | "starting" | "running" | "ready" | "error" | "closed";

export interface RunnerCommandAckPayload {
  readonly commandId: string;
  readonly accepted: boolean;
  readonly cloudThreadId?: string;
  readonly message?: string;
}

export interface RunnerThreadStatusPayload {
  readonly cloudThreadId: string;
  readonly projectId: string;
  readonly status: ThreadStatus;
  readonly providerThreadId?: string;
  readonly activeTurnId?: string;
  readonly lastEventSequence?: number;
  readonly message?: string;
}

export interface RunnerTurnStartPayload {
  readonly commandId: string;
  readonly cloudThreadId: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly requestedAt: string;
}

export interface RunnerTurnSteerPayload {
  readonly commandId: string;
  readonly cloudThreadId: string;
  readonly prompt: string;
  readonly requestedAt: string;
}

export interface RunnerTurnInterruptPayload {
  readonly commandId: string;
  readonly cloudThreadId: string;
  readonly requestedAt: string;
}

export type ApprovalDecision = "accept" | "decline" | "cancel";

export interface RunnerApprovalResolvePayload {
  readonly commandId: string;
  readonly approvalId: string;
  readonly cloudThreadId: string;
  readonly decision: ApprovalDecision;
  readonly requestedAt: string;
}

export interface RunnerApprovalOpenedPayload {
  readonly approvalId: string;
  readonly cloudThreadId: string;
  readonly projectId: string;
  readonly approvalType: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface RunnerApprovalResolvedPayload {
  readonly approvalId: string;
  readonly cloudThreadId: string;
  readonly decision: ApprovalDecision;
  readonly resolvedAt: string;
}

export interface ClientHelloPayload {
  readonly clientId?: string;
}

export interface ClientHelloAckPayload {
  readonly connectionId: string;
}

export interface EventsListPayload {
  readonly runnerId?: string;
  readonly threadId?: string;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface EventsListResultPayload {
  readonly events: readonly CloudEvent[];
}

export interface EventAppendedPayload {
  readonly event: CloudEvent;
}

export interface TurnStartPayload {
  readonly runnerId: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly cloudThreadId?: string;
}

export interface TurnStartAcceptedPayload {
  readonly commandId: string;
  readonly cloudThreadId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly status: ThreadStatus;
}

export interface ThreadsListPayload {
  readonly runnerId?: string;
  readonly projectId?: string;
}

export interface ThreadSummary {
  readonly cloudThreadId: string;
  readonly runnerId: string;
  readonly projectId: string;
  readonly status: ThreadStatus;
  readonly providerThreadId?: string;
  readonly activeTurnId?: string;
  readonly lastEventSequence?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadsListResultPayload {
  readonly threads: readonly ThreadSummary[];
}

export interface ThreadStatusPayload {
  readonly cloudThreadId: string;
}

export interface ThreadStatusResultPayload {
  readonly thread: ThreadSummary | null;
}

export interface RunnerSummary {
  readonly runnerId: string;
  readonly name: string;
  readonly version?: string;
  readonly capabilities: readonly string[];
  readonly connected: boolean;
  readonly lastSeenAt: string;
}

export interface ProjectSummary {
  readonly projectId: string;
  readonly runnerId: string;
  readonly name: string;
  readonly lastSeenAt: string;
}

export type ApprovalStatus = "pending" | "resolved";

export interface PendingApprovalSummary {
  readonly approvalId: string;
  readonly runnerId: string;
  readonly cloudThreadId: string;
  readonly projectId: string;
  readonly approvalType: string;
  readonly status: ApprovalStatus;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  readonly decision?: ApprovalDecision;
}

export interface ApprovalUpdatedPayload {
  readonly approval: PendingApprovalSummary;
}

export type RunnerToServerMessage =
  | Envelope<"ping", PingPayload>
  | Envelope<"runner.hello", RunnerHelloPayload>
  | Envelope<"runner.project.created", RunnerProjectCreatedPayload>
  | Envelope<"runner.project.deleted", RunnerProjectDeletedPayload>
  | Envelope<"runner.workspace.unpacked", RunnerWorkspaceUnpackedPayload>
  | Envelope<"runner.event.append", RunnerEventAppendPayload>
  | Envelope<"runner.command.ack", RunnerCommandAckPayload>
  | Envelope<"runner.thread.status", RunnerThreadStatusPayload>
  | Envelope<"runner.approval.opened", RunnerApprovalOpenedPayload>
  | Envelope<"runner.approval.resolved", RunnerApprovalResolvedPayload>;

export type ClientToServerMessage =
  | Envelope<"ping", PingPayload>
  | Envelope<"client.hello", ClientHelloPayload>
  | Envelope<"events.list", EventsListPayload>
  | Envelope<"turn.start", TurnStartPayload>
  | Envelope<"threads.list", ThreadsListPayload>
  | Envelope<"thread.status", ThreadStatusPayload>;

export type ServerToRunnerMessage =
  | Envelope<"pong", PongPayload>
  | Envelope<"error", ErrorPayload>
  | Envelope<"runner.hello.ack", RunnerHelloAckPayload>
  | Envelope<"runner.event.ack", RunnerEventAckPayload>
  | Envelope<"runner.project.create", RunnerProjectCreatePayload>
  | Envelope<"runner.project.delete", RunnerProjectDeletePayload>
  | Envelope<"runner.workspace.unpack", RunnerWorkspaceUnpackPayload>
  | Envelope<"runner.turn.start", RunnerTurnStartPayload>
  | Envelope<"runner.turn.steer", RunnerTurnSteerPayload>
  | Envelope<"runner.turn.interrupt", RunnerTurnInterruptPayload>
  | Envelope<"runner.approval.resolve", RunnerApprovalResolvePayload>;

export type ServerToClientMessage =
  | Envelope<"pong", PongPayload>
  | Envelope<"error", ErrorPayload>
  | Envelope<"client.hello.ack", ClientHelloAckPayload>
  | Envelope<"events.list.result", EventsListResultPayload>
  | Envelope<"event.appended", EventAppendedPayload>
  | Envelope<"turn.start.accepted", TurnStartAcceptedPayload>
  | Envelope<"threads.list.result", ThreadsListResultPayload>
  | Envelope<"thread.status.result", ThreadStatusResultPayload>
  | Envelope<"approval.updated", ApprovalUpdatedPayload>;

export type ServerMessage = ServerToRunnerMessage | ServerToClientMessage;

const VersionSchema = literalSchema(PROTOCOL_VERSION);

const IsoStringSchema = nonEmptyStringSchema;
const IdSchema = nonEmptyStringSchema;

const PingPayloadSchema = objectSchema({
  nonce: optionalSchema(stringSchema),
});

const PongPayloadSchema = objectSchema({
  nonce: optionalSchema(stringSchema),
});

const ErrorPayloadSchema = objectSchema({
  code: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  requestId: optionalSchema(nonEmptyStringSchema),
});

const RunnerHelloPayloadSchema = objectSchema({
  runnerId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  version: optionalSchema(nonEmptyStringSchema),
  capabilities: optionalSchema(arraySchema(nonEmptyStringSchema)),
  projects: optionalSchema(
    arraySchema(
      objectSchema({
        projectId: nonEmptyStringSchema,
        name: nonEmptyStringSchema,
      }),
    ),
  ),
});

const RunnerHelloAckPayloadSchema = objectSchema({
  runnerId: nonEmptyStringSchema,
  connectionId: nonEmptyStringSchema,
});

const RunnerProjectCreatePayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  name: optionalSchema(nonEmptyStringSchema),
  requestedAt: IsoStringSchema,
});

const RunnerProjectCreatedPayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  createdAt: IsoStringSchema,
});

const RunnerProjectDeletePayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  requestedAt: IsoStringSchema,
});

const RunnerProjectDeletedPayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  deletedAt: IsoStringSchema,
});

const RunnerWorkspaceUnpackPayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  uploadId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  requestedAt: IsoStringSchema,
});

const RunnerWorkspaceUnpackedPayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  uploadId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  createdAt: IsoStringSchema,
});

const RunnerEventAppendPayloadSchema = objectSchema({
  eventId: nonEmptyStringSchema,
  projectId: optionalSchema(nonEmptyStringSchema),
  threadId: nonEmptyStringSchema,
  type: nonEmptyStringSchema,
  payload: unknownSchema,
  occurredAt: IsoStringSchema,
});

const RunnerEventAckPayloadSchema = objectSchema({
  eventId: nonEmptyStringSchema,
  sequence: nonNegativeIntegerSchema,
});

const ThreadStatusSchema = unionSchema([
  literalSchema("queued"),
  literalSchema("starting"),
  literalSchema("running"),
  literalSchema("ready"),
  literalSchema("error"),
  literalSchema("closed"),
] as ReadonlyArray<Schema<ThreadStatus>>);

const RunnerCommandAckPayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  accepted: booleanSchema,
  cloudThreadId: optionalSchema(nonEmptyStringSchema),
  message: optionalSchema(nonEmptyStringSchema),
});

const RunnerThreadStatusPayloadSchema = objectSchema({
  cloudThreadId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  status: ThreadStatusSchema,
  providerThreadId: optionalSchema(nonEmptyStringSchema),
  activeTurnId: optionalSchema(nonEmptyStringSchema),
  lastEventSequence: optionalSchema(nonNegativeIntegerSchema),
  message: optionalSchema(nonEmptyStringSchema),
});

const RunnerTurnStartPayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  cloudThreadId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  prompt: nonEmptyStringSchema,
  requestedAt: IsoStringSchema,
});

const RunnerTurnSteerPayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  cloudThreadId: nonEmptyStringSchema,
  prompt: nonEmptyStringSchema,
  requestedAt: IsoStringSchema,
});

const RunnerTurnInterruptPayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  cloudThreadId: nonEmptyStringSchema,
  requestedAt: IsoStringSchema,
});

const ApprovalDecisionSchema = unionSchema([
  literalSchema("accept"),
  literalSchema("decline"),
  literalSchema("cancel"),
] as ReadonlyArray<Schema<ApprovalDecision>>);

const RunnerApprovalResolvePayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  approvalId: nonEmptyStringSchema,
  cloudThreadId: nonEmptyStringSchema,
  decision: ApprovalDecisionSchema,
  requestedAt: IsoStringSchema,
});

const RunnerApprovalOpenedPayloadSchema = objectSchema({
  approvalId: nonEmptyStringSchema,
  cloudThreadId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  approvalType: nonEmptyStringSchema,
  payload: unknownSchema,
  createdAt: IsoStringSchema,
});

const RunnerApprovalResolvedPayloadSchema = objectSchema({
  approvalId: nonEmptyStringSchema,
  cloudThreadId: nonEmptyStringSchema,
  decision: ApprovalDecisionSchema,
  resolvedAt: IsoStringSchema,
});

const ClientHelloPayloadSchema = objectSchema({
  clientId: optionalSchema(nonEmptyStringSchema),
});

const ClientHelloAckPayloadSchema = objectSchema({
  connectionId: nonEmptyStringSchema,
});

const EventsListPayloadSchema = objectSchema({
  runnerId: optionalSchema(nonEmptyStringSchema),
  threadId: optionalSchema(nonEmptyStringSchema),
  afterSequence: optionalSchema(nonNegativeIntegerSchema),
  limit: optionalSchema(nonNegativeIntegerSchema),
});

export const CloudEventSchema: Schema<CloudEvent> = objectSchema({
  sequence: nonNegativeIntegerSchema,
  eventId: nonEmptyStringSchema,
  runnerId: nonEmptyStringSchema,
  projectId: optionalSchema(nonEmptyStringSchema),
  threadId: nonEmptyStringSchema,
  type: nonEmptyStringSchema,
  payload: unknownSchema,
  occurredAt: IsoStringSchema,
  receivedAt: IsoStringSchema,
});

const EventsListResultPayloadSchema = objectSchema({
  events: arraySchema(CloudEventSchema),
});

const EventAppendedPayloadSchema = objectSchema({
  event: CloudEventSchema,
});

const TurnStartPayloadSchema = objectSchema({
  runnerId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  prompt: nonEmptyStringSchema,
  cloudThreadId: optionalSchema(nonEmptyStringSchema),
});

const TurnStartAcceptedPayloadSchema = objectSchema({
  commandId: nonEmptyStringSchema,
  cloudThreadId: nonEmptyStringSchema,
  runnerId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  status: ThreadStatusSchema,
});

const ThreadsListPayloadSchema = objectSchema({
  runnerId: optionalSchema(nonEmptyStringSchema),
  projectId: optionalSchema(nonEmptyStringSchema),
});

export const ThreadSummarySchema: Schema<ThreadSummary> = objectSchema({
  cloudThreadId: nonEmptyStringSchema,
  runnerId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  status: ThreadStatusSchema,
  providerThreadId: optionalSchema(nonEmptyStringSchema),
  activeTurnId: optionalSchema(nonEmptyStringSchema),
  lastEventSequence: optionalSchema(nonNegativeIntegerSchema),
  createdAt: IsoStringSchema,
  updatedAt: IsoStringSchema,
});

const ThreadsListResultPayloadSchema = objectSchema({
  threads: arraySchema(ThreadSummarySchema),
});

const ThreadStatusPayloadSchema = objectSchema({
  cloudThreadId: nonEmptyStringSchema,
});

const ThreadStatusResultPayloadSchema = objectSchema({
  thread: nullableSchema(ThreadSummarySchema),
});

export const RunnerSummarySchema: Schema<RunnerSummary> = objectSchema({
  runnerId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  version: optionalSchema(nonEmptyStringSchema),
  capabilities: arraySchema(nonEmptyStringSchema),
  connected: booleanSchema,
  lastSeenAt: IsoStringSchema,
});

export const ProjectSummarySchema: Schema<ProjectSummary> = objectSchema({
  projectId: nonEmptyStringSchema,
  runnerId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  lastSeenAt: IsoStringSchema,
});

const ApprovalStatusSchema = unionSchema([
  literalSchema("pending"),
  literalSchema("resolved"),
] as ReadonlyArray<Schema<ApprovalStatus>>);

export const PendingApprovalSummarySchema: Schema<PendingApprovalSummary> = objectSchema({
  approvalId: nonEmptyStringSchema,
  runnerId: nonEmptyStringSchema,
  cloudThreadId: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  approvalType: nonEmptyStringSchema,
  status: ApprovalStatusSchema,
  payload: unknownSchema,
  createdAt: IsoStringSchema,
  resolvedAt: optionalSchema(IsoStringSchema),
  decision: optionalSchema(ApprovalDecisionSchema),
});

const ApprovalUpdatedPayloadSchema = objectSchema({
  approval: PendingApprovalSummarySchema,
});

function envelopeSchema<TType extends string, TPayload>(
  type: TType,
  payload: Schema<TPayload>,
): Schema<Envelope<TType, TPayload>> {
  return objectSchema({
    version: VersionSchema,
    id: IdSchema,
    type: literalSchema(type),
    sentAt: IsoStringSchema,
    payload,
  });
}

export const RunnerToServerMessageSchema: Schema<RunnerToServerMessage> = unionSchema([
  envelopeSchema("ping", PingPayloadSchema),
  envelopeSchema("runner.hello", RunnerHelloPayloadSchema),
  envelopeSchema("runner.project.created", RunnerProjectCreatedPayloadSchema),
  envelopeSchema("runner.project.deleted", RunnerProjectDeletedPayloadSchema),
  envelopeSchema("runner.workspace.unpacked", RunnerWorkspaceUnpackedPayloadSchema),
  envelopeSchema("runner.event.append", RunnerEventAppendPayloadSchema),
  envelopeSchema("runner.command.ack", RunnerCommandAckPayloadSchema),
  envelopeSchema("runner.thread.status", RunnerThreadStatusPayloadSchema),
  envelopeSchema("runner.approval.opened", RunnerApprovalOpenedPayloadSchema),
  envelopeSchema("runner.approval.resolved", RunnerApprovalResolvedPayloadSchema),
] as ReadonlyArray<Schema<RunnerToServerMessage>>);

export const ClientToServerMessageSchema: Schema<ClientToServerMessage> = unionSchema([
  envelopeSchema("ping", PingPayloadSchema),
  envelopeSchema("client.hello", ClientHelloPayloadSchema),
  envelopeSchema("events.list", EventsListPayloadSchema),
  envelopeSchema("turn.start", TurnStartPayloadSchema),
  envelopeSchema("threads.list", ThreadsListPayloadSchema),
  envelopeSchema("thread.status", ThreadStatusPayloadSchema),
] as ReadonlyArray<Schema<ClientToServerMessage>>);

export const ServerMessageSchema: Schema<ServerMessage> = unionSchema([
  envelopeSchema("pong", PongPayloadSchema),
  envelopeSchema("error", ErrorPayloadSchema),
  envelopeSchema("runner.hello.ack", RunnerHelloAckPayloadSchema),
  envelopeSchema("runner.event.ack", RunnerEventAckPayloadSchema),
  envelopeSchema("runner.project.create", RunnerProjectCreatePayloadSchema),
  envelopeSchema("runner.project.delete", RunnerProjectDeletePayloadSchema),
  envelopeSchema("runner.workspace.unpack", RunnerWorkspaceUnpackPayloadSchema),
  envelopeSchema("runner.turn.start", RunnerTurnStartPayloadSchema),
  envelopeSchema("runner.turn.steer", RunnerTurnSteerPayloadSchema),
  envelopeSchema("runner.turn.interrupt", RunnerTurnInterruptPayloadSchema),
  envelopeSchema("runner.approval.resolve", RunnerApprovalResolvePayloadSchema),
  envelopeSchema("client.hello.ack", ClientHelloAckPayloadSchema),
  envelopeSchema("events.list.result", EventsListResultPayloadSchema),
  envelopeSchema("event.appended", EventAppendedPayloadSchema),
  envelopeSchema("turn.start.accepted", TurnStartAcceptedPayloadSchema),
  envelopeSchema("threads.list.result", ThreadsListResultPayloadSchema),
  envelopeSchema("thread.status.result", ThreadStatusResultPayloadSchema),
  envelopeSchema("approval.updated", ApprovalUpdatedPayloadSchema),
] as ReadonlyArray<Schema<ServerMessage>>);

export function createEnvelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  options: {
    readonly id?: string;
    readonly sentAt?: string;
  } = {},
): Envelope<TType, TPayload> {
  return {
    version: PROTOCOL_VERSION,
    id: options.id ?? randomUUID(),
    type,
    sentAt: options.sentAt ?? new Date().toISOString(),
    payload,
  };
}

export function createErrorEnvelope(
  input: {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
  },
  options: {
    readonly id?: string;
    readonly sentAt?: string;
  } = {},
): Envelope<"error", ErrorPayload> {
  return createEnvelope(
    "error",
    {
      code: input.code,
      message: input.message,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    },
    options,
  );
}

export const AuthenticatedWebSocketHeadersSchema = objectSchema({
  authorization: optionalSchema(nonEmptyStringSchema),
  cookie: optionalSchema(stringSchema),
  origin: optionalSchema(stringSchema),
  "sec-websocket-protocol": optionalSchema(stringSchema),
});

export const JsonObjectSchema = recordSchema(
  unionSchema([unknownSchema, nullableSchema(unknownSchema)]),
);
