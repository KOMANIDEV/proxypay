# Pagination

Large result sets (transactions, statements, events, ...) should be paginated
with **cursor-based pagination** instead of `LIMIT/OFFSET`. Cursor pagination
keeps pages stable while new rows are inserted and never degrades on deep
pages.

The shared implementation lives in `src/utils/pagination.ts` and is used by
`GET /api/transactions` (cursor mode). This document covers how to use it and
the conventions to follow.

## Why cursors over offset

| | `LIMIT/OFFSET` | Cursor-based |
|---|---|---|
| New rows inserted between page fetches | Rows shift — duplicates/skips | Stable — pages don't move |
| Deep pages (offset 1,000,000) | Slow — scans and discards rows | Fast — index seek to boundary |
| Cost | `COUNT(*)` needed for `hasMore` | Free — fetch `limit + 1` rows |
| Random access to page N | Easy (`?page=N`) | Not directly supported |

Use offset pagination only for small, static, admin-only tables.

## Quick start

### 1. Encode / decode cursors

```ts
import { createCursor, decodeCursor } from "../utils/pagination";

// Response side
const cursor = createCursor(item.createdAt, item.id); // opaque base64url string

// Request side
const { t, id } = decodeCursor(req.query.after); // throws PaginationError
```

Cursors are opaque to clients — never document their internal format. The
legacy `<timestamp>|<id>` base64 format is still accepted on decode for
backward compatibility.

### 2. Query the page boundary in SQL

```ts
import { buildCursorWhere } from "../utils/pagination";

const { clause, params } = buildCursorWhere(cursor, {
  column: "created_at",
  order: "desc",      // must match your ORDER BY
  direction: "forward",
});

await pool.query(
  `SELECT * FROM transactions
   WHERE ${whereSql} AND ${clause}
   ORDER BY created_at DESC, id DESC
   LIMIT ${limit + 1}`,
  [...whereParams, ...params, limit + 1],
);
```

- Fetch **`limit + 1`** rows — the overflow row means `hasMore`.
- Order by `(created_at, id)` and add a composite index on those columns.
- The row-value predicate `(created_at, id) < ($1, $2)` stays index-friendly.

### 3. Build the response

```ts
import { createPaginatedResponse } from "../utils/pagination";

const result = createPaginatedResponse({
  rows,                        // limit + 1 rows from the query
  limit,
  getSortValue: (tx) => tx.createdAt,
  getId: (tx) => tx.id,
});

res.json(result);
// → { data: [...], pagination: { limit, nextCursor, prevCursor, hasMore } }
```

### 4. Parse incoming params

```ts
import { parsePaginationParams } from "../utils/pagination";

const params = parsePaginationParams(req.query);
// { limit: 20, offset: 0, after: "…", before: undefined }
```

`limit` is clamped to `[1, 100]`, `cursor` is treated as `after`, and
`before` + `after` together are rejected with `PaginationError` — return
`400` when that happens.

## Automatic chunking

For jobs that must process an entire result set (batch payouts, exports,
reconciliation), use the chunking helpers instead of hand-rolling loops:

```ts
import { paginateAll, chunkResults, chunkArray } from "../utils/pagination";

// Stream item-by-item (never buffers the full set)
for await (const tx of paginateAll(fetchPage, { limit: 100 })) {
  await process(tx);
}

// Or collect everything, with progress callbacks
const all = await chunkResults(fetchPage, {
  limit: 100,
  onChunk: (chunk) => logger.info(`processed ${chunk.length}`),
});

// Or chunk an already-loaded array
for (const batch of chunkArray(rows, 250)) {
  await batchInsert(batch);
}
```

`fetchPage` looks like:

```ts
async function fetchPage(cursor?: string) {
  const rows = await loadPage(cursor);   // your model/query
  return { rows, nextCursor: rows.length ? cursorFor(rows[rows.length - 1]) : null };
}
```

A `maxPages` safety cap (default 10,000) aborts runaway cursors with
`PaginationError` instead of looping forever.

## Best practices

1. **Cursor = last item of the previous page.** The next page starts strictly
   *after* the cursor's `(sortValue, id)`, never at it.
2. **Always tie-break with a unique `id`.** Two rows with identical
   `created_at` would otherwise be skipped or duplicated across pages.
3. **Match `buildCursorWhere` to your `ORDER BY`.** `order: "desc"` requires
   `ORDER BY created_at DESC, id DESC`. Getting this wrong silently corrupts
   paging.
4. **Index `(sort_column, id)`.** Row-value predicates are only fast with a
   matching composite index.
5. **Return `nextCursor` only when `hasMore`.** Clients can stop early; they
   must treat a missing `nextCursor` as end-of-list.
6. **Keep cursors opaque and versioned.** Bump `v` if the encoding ever
   changes; always support decoding the previous version for a grace period.
7. **Never trust client cursors.** Always `decodeCursor` defensively and
   return `400` on `PaginationError` — never pass raw strings into SQL.
8. **Favor `after` for forward traversal.** `before` (backward paging) is
   supported but used sparingly; it reverses ordering on the query side.

## Testing

```bash
npm test -- tests/utils/pagination.test.ts
```

The suite covers cursor round-tripping (including legacy format), param
validation, SQL predicate generation, overflow-row `hasMore` detection, and
automatic chunking with the runaway-cursor guard.
