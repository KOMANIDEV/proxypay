import { Response } from "express";

// ---------------------------------------------------------------------------
// Streaming CSV Export for Large Result Sets (#416)
// ---------------------------------------------------------------------------

export interface StreamingCsvOptions {
  /** Number of rows to buffer before flushing to the response. Default: 1000 */
  chunkSize?: number;
  /** Filename for the Content-Disposition header. Default: export.csv */
  filename?: string;
  /** Whether to include a header row. Default: true */
  includeHeader?: boolean;
}

/**
 * Escapes a single CSV field value according to RFC 4180.
 * - Wraps in double-quotes if the value contains commas, double-quotes, or newlines
 * - Doubles any embedded double-quote characters
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";

  if (Array.isArray(value)) {
    value = value.join("|");
  }

  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialises a row object to a CSV line using the provided column order.
 */
export function rowToCsvLine(
  row: Record<string, unknown>,
  columns: string[],
): string {
  return columns.map((col) => escapeCsvField(row[col])).join(",") + "\n";
}

/**
 * Memory-efficient, streaming CSV exporter.
 *
 * Reads from any `AsyncIterable<Record<string, unknown>>` (e.g. a cursor,
 * generator, or async generator) and writes directly to an Express `Response`
 * in configurable chunks to keep memory usage flat regardless of result size.
 *
 * @example
 * const exporter = new StreamingCsvExporter();
 * await exporter.streamToResponse(
 *   db.cursor('SELECT * FROM transactions'),
 *   res,
 *   ['id', 'amount', 'status'],
 *   { chunkSize: 500, filename: 'transactions.csv' },
 * );
 */
export class StreamingCsvExporter {
  private readonly defaultChunkSize: number;

  constructor(defaultChunkSize = 1000) {
    this.defaultChunkSize = defaultChunkSize;
  }

  /**
   * Streams an async iterable of row objects to an Express response as CSV.
   *
   * Sets the following response headers:
   *   - `Content-Type: text/csv; charset=utf-8`
   *   - `Content-Disposition: attachment; filename="<filename>"`
   *   - `Transfer-Encoding: chunked`
   *   - `X-Export-Progress: <rowsWritten>` (updated after each chunk flush)
   *
   * @param query    - Async iterable data source (database cursor, generator, etc.)
   * @param res      - Express response object
   * @param columns  - Ordered list of column keys to include in the CSV
   * @param options  - Optional configuration (chunkSize, filename, includeHeader)
   */
  async streamToResponse(
    query: AsyncIterable<Record<string, unknown>>,
    res: Response,
    columns: string[],
    options: StreamingCsvOptions = {},
  ): Promise<void> {
    const chunkSize = options.chunkSize ?? this.defaultChunkSize;
    const filename = options.filename ?? "export.csv";
    const includeHeader = options.includeHeader !== false;

    // Set streaming headers before writing any body
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Export-Progress", "0");
    res.status(200);

    // Write the CSV header row
    if (includeHeader) {
      res.write(columns.map(escapeCsvField).join(",") + "\n");
    }

    let rowsWritten = 0;
    let buffer: string[] = [];

    const flush = (): void => {
      if (buffer.length === 0) return;
      res.write(buffer.join(""));
      rowsWritten += buffer.length;
      // Update progress header after each chunk (readable by polling clients)
      res.setHeader("X-Export-Progress", String(rowsWritten));
      buffer = [];
    };

    try {
      for await (const row of query) {
        buffer.push(rowToCsvLine(row, columns));

        if (buffer.length >= chunkSize) {
          flush();
        }
      }

      // Flush any remaining rows
      flush();
    } finally {
      res.end();
    }
  }

  /**
   * Returns the current default chunk size used when none is provided in options.
   */
  getDefaultChunkSize(): number {
    return this.defaultChunkSize;
  }
}

/** Singleton instance for convenience — import and use directly. */
export const streamingCsvExporter = new StreamingCsvExporter();
