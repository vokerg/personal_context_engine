/**
 * Worker-facing, provider-neutral content storage contract.
 *
 * Revisions identify the exact bytes observed by an adapter, NOT a note's identity.
 * Paths are relative POSIX content paths; implementations must validate them.
 */
export interface ContentRef {
  readonly path: string;
  readonly revision: string;
}

export interface ContentFile extends ContentRef {
  readonly content: string;
}

export interface PendingPage {
  readonly files: readonly ContentRef[];
  /** Opaque seek cursor, absent when the scan has reached the end. */
  readonly nextCursor?: string;
}

export interface ListPendingOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface TransitionRequest {
  readonly sourcePath: string;
  readonly expectedRevision: string;
}

export interface FinalizeRequest extends TransitionRequest {
  /** Must be a canonical notes/YYYY/MM/*.md destination. */
  readonly destinationPath: string;
}

export interface TransitionResult extends ContentRef {
  readonly status: "moved" | "recovered" | "already_finalized";
}

export type ContentStoreErrorCode =
  | "INVALID_PATH"
  | "INVALID_CURSOR"
  | "INVALID_LIMIT"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "DESTINATION_CONFLICT"
  | "UNSAFE_ENTRY"
  | "INVALID_CONTENT"
  | "PERMISSION_DENIED"
  | "IO_ERROR";

/** Never attach private Markdown, tokens, or full OS error messages. */
export class ContentStoreError extends Error {
  constructor(
    public readonly code: ContentStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContentStoreError";
  }
}

export interface ContentStore {
  /** Only discover pending inbox entries; never scan finalized notes or ledgers. */
  listPending(options?: ListPendingOptions): Promise<PendingPage>;
  /** Read a single source with its exact current revision. */
  read(path: string): Promise<ContentFile>;
  /** Probe either pending or finalized paths for crash reconciliation. */
  stat(path: string): Promise<ContentRef | null>;
  /** Never overwrite an existing destination or finalize a changed source. */
  finalize(request: FinalizeRequest): Promise<TransitionResult>;
  /** Preserve invalid source under rejected/, without generating side effects. */
  reject(request: TransitionRequest): Promise<TransitionResult>;
}

/** Independently allowlisted, read-only GitHub research ingestion. */
export interface ResearchIngressStore {
  /** Lists only research/inbox/<report-id>.json; no note or unrelated file. */
  listResearch(options?: ListPendingOptions): Promise<PendingPage>;
  /** Reads an immutable observed revision; caller verifies it still matches. */
  readResearch(path: string): Promise<ContentFile>;
}
