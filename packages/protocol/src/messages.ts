import { randomUUID } from "node:crypto";

import {
  arraySchema,
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
}

export interface RunnerHelloAckPayload {
  readonly runnerId: string;
  readonly connectionId: string;
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

export type RunnerToServerMessage =
  | Envelope<"ping", PingPayload>
  | Envelope<"runner.hello", RunnerHelloPayload>
  | Envelope<"runner.event.append", RunnerEventAppendPayload>;

export type ClientToServerMessage =
  | Envelope<"ping", PingPayload>
  | Envelope<"client.hello", ClientHelloPayload>
  | Envelope<"events.list", EventsListPayload>;

export type ServerToRunnerMessage =
  | Envelope<"pong", PongPayload>
  | Envelope<"error", ErrorPayload>
  | Envelope<"runner.hello.ack", RunnerHelloAckPayload>
  | Envelope<"runner.event.ack", RunnerEventAckPayload>;

export type ServerToClientMessage =
  | Envelope<"pong", PongPayload>
  | Envelope<"error", ErrorPayload>
  | Envelope<"client.hello.ack", ClientHelloAckPayload>
  | Envelope<"events.list.result", EventsListResultPayload>
  | Envelope<"event.appended", EventAppendedPayload>;

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
});

const RunnerHelloAckPayloadSchema = objectSchema({
  runnerId: nonEmptyStringSchema,
  connectionId: nonEmptyStringSchema,
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
  envelopeSchema("runner.event.append", RunnerEventAppendPayloadSchema),
] as ReadonlyArray<Schema<RunnerToServerMessage>>);

export const ClientToServerMessageSchema: Schema<ClientToServerMessage> = unionSchema([
  envelopeSchema("ping", PingPayloadSchema),
  envelopeSchema("client.hello", ClientHelloPayloadSchema),
  envelopeSchema("events.list", EventsListPayloadSchema),
] as ReadonlyArray<Schema<ClientToServerMessage>>);

export const ServerMessageSchema: Schema<ServerMessage> = unionSchema([
  envelopeSchema("pong", PongPayloadSchema),
  envelopeSchema("error", ErrorPayloadSchema),
  envelopeSchema("runner.hello.ack", RunnerHelloAckPayloadSchema),
  envelopeSchema("runner.event.ack", RunnerEventAckPayloadSchema),
  envelopeSchema("client.hello.ack", ClientHelloAckPayloadSchema),
  envelopeSchema("events.list.result", EventsListResultPayloadSchema),
  envelopeSchema("event.appended", EventAppendedPayloadSchema),
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
