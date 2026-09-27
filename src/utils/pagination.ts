/**
 * Cursor-based pagination utilities.
 *
 * Large result sets (transactions, statements, events, ...) are paged with
 * opaque cursors instead of `LIMIT/OFFSET` so pages stay stable while new
 * rows are inserted and deep pages don't degrade in performance.
 *
 * This module provides:
 *   - `encodeCursor` / `decodeCursor` — opaque, URL-safe cursor values
 *   - `parsePaginationParams`         — normalize/validate query params
 *   - `buildCursorWhere`              — SQL predicate for the page boundary
 *   - `createPaginatedResponse`       — uniform response shape
 *   - `chunkArray` / `paginateAll` / `chunkResults` — automatic chunking
 */

// ---------------------------------------------------------------------------
// Cursor encoding
// ---------------------------------------------------------------------------

export interface CursorPayload {
  /** Cursor format version — bump when the encoding changes. */
  v: 1;
  /** Sort value of the boundary item (e.g. ISO-8601 timestamp). */
  t: string;
  /** Unique id of the boundary item — breaks ties when `t` collides. */
  id: string;
}

export class PaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaginationError";
  }
}

/** Regex that matches any character that is NOT URL-safe in a base64url string. */
const UNSAFE_CURSOR_CHARS = /[+/=]/;

/**
 * Validate that an encoded cursor string is URL-safe (base64url alphabet only).
 * Throws `PaginationError` when the value contains `+`, `/`, or `=`.
 *
 * This guard is called automatically by `encodeCursor` to catch edge cases
 * where the substitution logic might have been bypassed or overridden.
 *
 * @internal
 */
export function validateUrlSafeCursor(encoded: string): void {
  if (UNSAFE_CURSOR_CHARS.test(encoded)) {
    const unsafe = encoded
      .split("")
      .filter((c) => UNSAFE_CURSOR_CHARS.test(c))
      .filter((c, i, a) => a.indexOf(c) === i) // deduplicate
      .map((c) => JSON.stringify(c))
      .join(", ");
    throw new PaginationError(
      `Cursor encoding produced unsafe character(s): ${unsafe}. ` +
        "Expected base64url output with no +, /, or = characters.",
    );
  }
}

/**
 * Encode a cursor payload into an opaque, URL-safe string.
 * The payload is JSON-serialized and base64url-encoded (no padding, so the
 * value is safe to embed in query strings).
 *
 * @throws {PaginationError} when the encoded output contains unsafe characters
 *   (`+`, `/`, or `=`). This is a defensive guard against encoding regressions.
 */
export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  validateUrlSafeCursor(encoded);

  return encoded;
}

/**
 * Decode a cursor previously produced by `encodeCursor`.
 *
 * For backward compatibility, cursors in the legacy
 * `<iso-timestamp>|<id>` format are also accepted and normalized to the
 * current payload shape.
 *
 * @throws {PaginationError} when the cursor is malformed.
 */
export function decodeCursor(cursor: string): CursorPayload {
  if (!cursor || typeof cursor !== "string") {
    throw new PaginationError("Invalid cursor");
  }

  const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding ? normalized + "=".repeat(4 - padding) : normalized;

  let decoded: string;
  try {
    decoded = Buffer.from(padded, "base64").toString("utf8");
  } catch {
    throw new PaginationError("Invalid cursor");
  }

  // New JSON format
  try {
    const payload = JSON.parse(decoded) as Partial<CursorPayload>;
    if (payload && payload.v === 1 && typeof payload.t === "string" && payload.id) {
      return { v: 1, t: payload.t, id: payload.id };
    }
  } catch {
    // fall through to legacy format
  }

  // Legacy format: `<iso-timestamp>|<id>`
  const separator = decoded.lastIndexOf("|");
  if (separator !== -1) {
    const timestamp = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!Number.isNaN(new Date(timestamp).getTime()) && id) {
      return { v: 1, t: timestamp, id };
    }
  }

  throw new PaginationError("Invalid cursor");
}

/**
 * Build a cursor payload for an item. `sortValue` must be the value used in
 * the ORDER BY clause (e.g. `createdAt.toISOString()`), `id` the unique id
 * used to break ties.
 */
export function createCursor(
  sortValue: string | number | Date,
  id: string,
): string {
  const t =
    sortValue instanceof Date
      ? sortValue.toISOString()
      : String(sortValue);
  return encodeCursor({ v: 1, t, id });
}

// ---------------------------------------------------------------------------
// Query param parsing
// ---------------------------------------------------------------------------

export interface PaginationParams {
  limit: number;
  offset: number;
  /** Cursor for the next page (rows after the boundary). */
  after?: string;
  /** Cursor for the previous page (rows before the boundary). */
  before?: string;
  /** Generic cursor alias (treated as `after`). */
  cursor?: string;
}

export interface ParsePaginationOptions {
  /** Upper bound for `limit`. Defaults to 100. */
  maxLimit?: number;
  /** Default limit when not provided. Defaults to 20. */
  defaultLimit?: number;
}

/**
 * Normalize and validate pagination query parameters.
 *
 * - `limit` is clamped to `[1, maxLimit]`
 * - `offset` is clamped to `>= 0`
 * - `cursor` is treated as `after` when `after` is absent
 * - Providing both `before` and `after` is rejected
 *
 * @throws {PaginationError} when both `before` and `after` are supplied.
 */
export function parsePaginationParams(
  query: Record<string, unknown>,
  options: ParsePaginationOptions = {},
): PaginationParams {
  const maxLimit = options.maxLimit ?? 100;
  const defaultLimit = options.defaultLimit ?? 20;

  const rawLimit =
    typeof query.limit === "string" ? parseInt(query.limit, 10) : NaN;
  const rawOffset =
    typeof query.offset === "string" ? parseInt(query.offset, 10) : 0;

  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(maxLimit, rawLimit))
    : defaultLimit;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

  const after =
    typeof query.after === "string" && query.after ? query.after : undefined;
  const before =
    typeof query.before === "string" && query.before ? query.before : undefined;
  const cursor =
    typeof query.cursor === "string" && query.cursor ? query.cursor : undefined;

  if (after && before) {
    throw new PaginationError("Use either before or after cursor, not both");
  }

  return {
    limit,
    offset,
    after: after ?? cursor,
    before,
  };
}

// ---------------------------------------------------------------------------
// SQL predicate builder
// ---------------------------------------------------------------------------

export interface CursorWhereOptions {
  /** Column used in ORDER BY (e.g. `created_at`). */
  column: string;
  /** Tie-breaker column (e.g. `id`). Defaults to `id`. */
  idColumn?: string;
  /** Sort order of the query. Defaults to `desc` (newest first). */
  order?: "asc" | "desc";
  /** `forward` = fetch the next page, `backward` = fetch the previous page. */
  direction?: "forward" | "backward";
  /** 1-based index for the first `$N` placeholder. Defaults to 1. */
  paramOffset?: number;
}

export interface CursorWhere {
  clause: string;
  params: string[];
}

/**
 * Build the SQL predicate that selects rows strictly after (forward) or
 * strictly before (backward) the boundary item, assuming the query orders by
 * `(column, idColumn)` in the given `order`.
 *
 * Row-value comparison `(a, b) < ($1, $2)` keeps the predicate index-friendly
 * when a composite index on `(column, idColumn)` exists.
 *
 * Example (newest-first list, fetch next page):
 * ```ts
 * buildCursorWhere({ column: "created_at", order: "desc", direction: "forward" })
 * // → { clause: "(created_at, id) < ($1, $2)", params: [...] }
 * ```
 */
export function buildCursorWhere(
  cursor: CursorPayload,
  options: CursorWhereOptions,
): CursorWhere {
  const column = options.column;
  const idColumn = options.idColumn ?? "id";
  const order = options.order ?? "desc";
  const direction = options.direction ?? "forward";
  const paramOffset = options.paramOffset ?? 1;

  const operator =
    (order === "desc") === (direction === "forward") ? "<" : ">";

  const cursorParam = paramOffset;
  const idParam = paramOffset + 1;

  return {
    clause: `(${column}, ${idColumn}) ${operator} ($${cursorParam}, $${idParam})`,
    params: [cursor.t, cursor.id],
  };
}

// ---------------------------------------------------------------------------
// Response builder
// ---------------------------------------------------------------------------

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    limit: number;
    /** Cursor to fetch the next page; null when no more rows. */
    nextCursor: string | null;
    /** Cursor to fetch the previous page; null on the first page. */
    prevCursor: string | null;
    hasMore: boolean;
  };
}

export interface CreatePaginatedResponseOptions<T> {
  /** Rows fetched with `limit + 1` — the overflow row signals `hasMore`. */
  rows: T[];
  limit: number;
  /** Extract the ORDER BY sort value from an item. */
  getSortValue: (item: T) => string | number | Date;
  /** Extract the unique tie-breaker id from an item. */
  getId: (item: T) => string;
}

/**
 * Build a uniform cursor-paginated response from `limit + 1` fetched rows.
 *
 * - `hasMore` is derived from the overflow row (no COUNT query needed).
 * - `nextCursor` points at the last returned item so the next page continues
 *   right after it; `prevCursor` points at the first item for backward paging.
 */
export function createPaginatedResponse<T>(
  options: CreatePaginatedResponseOptions<T>,
): PaginatedResult<T> {
  const { rows, limit, getSortValue, getId } = options;
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  let prevCursor: string | null = null;

  if (data.length > 0) {
    prevCursor = createCursor(getSortValue(data[0]), getId(data[0]));
    if (hasMore) {
      const last = data[data.length - 1];
      nextCursor = createCursor(getSortValue(last), getId(last));
    }
  }

  return {
    data,
    pagination: { limit, nextCursor, prevCursor, hasMore },
  };
}

// ---------------------------------------------------------------------------
// Automatic result set chunking
// ---------------------------------------------------------------------------

/**
 * Split an array into fixed-size chunks. Useful for batching large in-memory
 * result sets (e.g. batch payouts, exports).
 */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new PaginationError("Chunk size must be a positive integer");
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface FetchPageResult<T> {
  rows: T[];
  /** Cursor to pass back for the next page; null/undefined when exhausted. */
  nextCursor?: string | null;
}

export interface PaginateAllOptions {
  /** Page size. Defaults to 100. */
  limit?: number;
  /**
   * Safety cap on the number of pages fetched, protecting against a
   * misbehaving `fetchPage` that never terminates. Defaults to 10,000.
   */
  maxPages?: number;
}

/**
 * Lazily fetch every page of a cursor-paginated source, automatically
 * following `nextCursor` until the result set is exhausted. Results are
 * yielded item-by-item so large result sets never need to be fully buffered.
 *
 * @throws {PaginationError} when `maxPages` is exceeded (runaway cursor).
 */
export async function* paginateAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<FetchPageResult<T>>,
  options: PaginateAllOptions = {},
): AsyncGenerator<T> {
  const maxPages = options.maxPages ?? 10_000;
  let cursor: string | undefined;
  let fetched = 0;
  let pages = 0;

  do {
    if (pages >= maxPages) {
      throw new PaginationError(
        `paginateAll exceeded maxPages (${maxPages}) — cursor did not terminate`,
      );
    }
    pages += 1;
    const page = await fetchPage(cursor);
    for (const item of page.rows) {
      yield item;
    }
    fetched += page.rows.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor && fetched > 0);
}

/**
 * Fetch a full cursor-paginated result set into a single array, chunk by
 * chunk. `onChunk` (if provided) is invoked after every page fetch — useful
 * for progress reporting or streaming writes.
 */
export async function chunkResults<T>(
  fetchPage: (cursor: string | undefined) => Promise<FetchPageResult<T>>,
  options: PaginateAllOptions & { onChunk?: (chunk: T[]) => void } = {},
): Promise<T[]> {
  const results: T[] = [];
  for await (const item of paginateAll(fetchPage, options)) {
    results.push(item);
  }
  options.onChunk?.(results);
  return results;
}
