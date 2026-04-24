export const HANDOFF_MANIFEST_VERSION = 1 as const;
export const HANDOFF_PACKAGE_KIND = "cloudcodex.handoff-package" as const;

export interface HandoffManifest {
  readonly version: typeof HANDOFF_MANIFEST_VERSION;
  readonly createdAt: string;
  readonly source: {
    readonly workspaceName: string;
    readonly gitHead: string;
    readonly gitBranch?: string;
    readonly dirtyTracked: readonly string[];
  };
  readonly bundle: {
    readonly mode: "git-bundle";
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly overlay: {
    readonly mode: "approved-untracked";
    readonly files: readonly OverlayFileManifest[];
  };
  readonly conversation: {
    readonly localThreadId?: string;
    readonly exportedEventCount: number;
    readonly summary: string;
  };
}

export interface OverlayFileManifest {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: number;
}

export interface OverlayFile extends OverlayFileManifest {
  readonly contentBase64: string;
}

export interface HandoffPackage {
  readonly kind: typeof HANDOFF_PACKAGE_KIND;
  readonly manifest: HandoffManifest;
  readonly gitBundleBase64: string;
  readonly overlayFiles: readonly OverlayFile[];
  readonly handoffPrompt: string;
}

export class ManifestValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ManifestValidationError";
    this.code = code;
  }
}

export function validateHandoffManifest(value: unknown): HandoffManifest {
  const manifest = asRecord(value, "manifest");
  if (manifest.version !== HANDOFF_MANIFEST_VERSION) {
    throw new ManifestValidationError("manifest_version_invalid", "Unsupported handoff manifest version.");
  }
  const createdAt = requiredString(manifest, "createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new ManifestValidationError("manifest_created_at_invalid", "createdAt must be an ISO date.");
  }
  const source = asRecord(manifest.source, "source");
  const bundle = asRecord(manifest.bundle, "bundle");
  const overlay = asRecord(manifest.overlay, "overlay");
  const conversation = asRecord(manifest.conversation, "conversation");
  if (bundle.mode !== "git-bundle") {
    throw new ManifestValidationError("bundle_mode_invalid", "Only git-bundle mode is supported.");
  }
  if (overlay.mode !== "approved-untracked") {
    throw new ManifestValidationError(
      "overlay_mode_invalid",
      "Only approved-untracked overlay mode is supported.",
    );
  }

  return {
    version: HANDOFF_MANIFEST_VERSION,
    createdAt,
    source: {
      workspaceName: requiredString(source, "workspaceName"),
      gitHead: requiredHex(source, "gitHead", 40),
      ...(typeof source.gitBranch === "string" && source.gitBranch.trim()
        ? { gitBranch: source.gitBranch.trim() }
        : {}),
      dirtyTracked: readonlyStringArray(source.dirtyTracked, "source.dirtyTracked"),
    },
    bundle: {
      mode: "git-bundle",
      sha256: requiredHex(bundle, "sha256", 64),
      bytes: requiredNonNegativeInteger(bundle, "bytes"),
    },
    overlay: {
      mode: "approved-untracked",
      files: readonlyArray(overlay.files, "overlay.files").map(validateOverlayFileManifest),
    },
    conversation: {
      ...(typeof conversation.localThreadId === "string" && conversation.localThreadId.trim()
        ? { localThreadId: conversation.localThreadId.trim() }
        : {}),
      exportedEventCount: requiredNonNegativeInteger(conversation, "exportedEventCount"),
      summary: requiredString(conversation, "summary"),
    },
  };
}

export function validateHandoffPackage(value: unknown): HandoffPackage {
  const record = asRecord(value, "package");
  if (record.kind !== HANDOFF_PACKAGE_KIND) {
    throw new ManifestValidationError("package_kind_invalid", "Invalid handoff package kind.");
  }
  const manifest = validateHandoffManifest(record.manifest);
  const gitBundleBase64 = requiredString(record, "gitBundleBase64");
  const overlayFiles = readonlyArray(record.overlayFiles, "overlayFiles").map(validateOverlayFile);
  const handoffPrompt = requiredString(record, "handoffPrompt");
  return {
    kind: HANDOFF_PACKAGE_KIND,
    manifest,
    gitBundleBase64,
    overlayFiles,
    handoffPrompt,
  };
}

export function createPackageFromJson(raw: string): HandoffPackage {
  return validateHandoffPackage(JSON.parse(raw));
}

function validateOverlayFileManifest(value: unknown): OverlayFileManifest {
  const record = asRecord(value, "overlayFile");
  return {
    path: validateRelativePath(requiredString(record, "path")),
    sha256: requiredHex(record, "sha256", 64),
    bytes: requiredNonNegativeInteger(record, "bytes"),
    mode: requiredMode(record, "mode"),
  };
}

function validateOverlayFile(value: unknown): OverlayFile {
  const manifest = validateOverlayFileManifest(value);
  const contentBase64 = requiredString(asRecord(value, "overlayFile"), "contentBase64");
  return {
    ...manifest,
    contentBase64,
  };
}

export function validateRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ManifestValidationError("path_invalid", `Invalid relative path ${JSON.stringify(path)}.`);
  }
  return normalized;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestValidationError("schema_invalid", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ManifestValidationError("schema_invalid", `${key} is required.`);
  }
  return value.trim();
}

function requiredHex(record: Record<string, unknown>, key: string, length: number): string {
  const value = requiredString(record, key);
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(value)) {
    throw new ManifestValidationError("schema_invalid", `${key} must be ${length} lowercase hex chars.`);
  }
  return value;
}

function requiredNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ManifestValidationError("schema_invalid", `${key} must be a non-negative integer.`);
  }
  return value;
}

function requiredMode(record: Record<string, unknown>, key: string): number {
  const value = requiredNonNegativeInteger(record, key);
  if (value !== 0o600 && value !== 0o644 && value !== 0o700 && value !== 0o755) {
    throw new ManifestValidationError("mode_invalid", `${key} has an unsupported file mode.`);
  }
  return value;
}

function readonlyStringArray(value: unknown, label: string): readonly string[] {
  return readonlyArray(value, label).map((entry) => {
    if (typeof entry !== "string") {
      throw new ManifestValidationError("schema_invalid", `${label} must contain strings.`);
    }
    return entry;
  });
}

function readonlyArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ManifestValidationError("schema_invalid", `${label} must be an array.`);
  }
  return value;
}
