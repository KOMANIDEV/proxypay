/**
 * Lightweight SQL preprocessing used by migration validation and impact
 * analysis.
 *
 * The parser is intentionally conservative: it understands enough of the SQL
 * lexical rules (line/block comments, single/double quotes, and dollar-quoted
 * strings such as function bodies) to split a script into top-level statements
 * without being confused by `;` characters inside triggers or plpgsql bodies.
 *
 * Comments are excluded from the returned statements, so statement text can be
 * matched against regexes without false positives from comment prose.
 */

export interface ParsedScript {
  /** Top-level statements with comments removed. Whitespace is preserved. */
  statements: string[];
  /** True when the script could not be parsed (unterminated quote/comment). */
  unterminated: boolean;
  /** Index (0-based) of the first unterminated construct, when relevant. */
  unterminatedAt?: number;
}

/**
 * Split a SQL script into top-level statements, dropping comments.
 *
 * A statement is only returned when it terminates with `;` at top level. A
 * non-empty tail without a trailing `;` is returned as the final statement
 * (PostgreSQL accepts it), but `unterminated` is set when a quote or comment
 * never closes, which is a hard error for a migration file.
 */
export function splitSqlStatements(sql: string): ParsedScript {
  const statements: string[] = [];
  const length = sql.length;
  let i = 0;
  let inStatement = false;
  let chunks: string[] = [];

  const isWhitespace = (c: string) => /\s/.test(c);

  const startStatement = () => {
    if (!inStatement) {
      inStatement = true;
      chunks = [];
    }
  };

  const flush = () => {
    const stmt = chunks.join("").trim();
    if (stmt.length > 0) {
      statements.push(stmt);
    }
    inStatement = false;
    chunks = [];
  };

  while (i < length) {
    const c = sql[i];
    const next = sql[i + 1];

    // Line comment: -- ... until end of line
    if (c === "-" && next === "-") {
      if (inStatement) chunks.push(" ");
      while (i < length && sql[i] !== "\n") i++;
      continue;
    }

    // Block comment: /* ... */
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        flush();
        return { statements, unterminated: true, unterminatedAt: i };
      }
      if (inStatement) chunks.push(" ");
      i = end + 2;
      continue;
    }

    // Dollar-quoted string: $tag$ ... $tag$ (e.g. plpgsql function bodies)
    if (c === "$") {
      const tagEnd = sql.indexOf("$", i + 1);
      if (tagEnd !== -1) {
        const tag = sql.slice(i, tagEnd + 1);
        const close = sql.indexOf(tag, tagEnd + 1);
        if (close === -1) {
          flush();
          return { statements, unterminated: true, unterminatedAt: i };
        }
        startStatement();
        chunks.push(sql.slice(i, close + tag.length));
        i = close + tag.length;
        continue;
      }
    }

    // Single-quoted string with '' escape
    if (c === "'") {
      let j = i + 1;
      while (j < length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= length) {
        flush();
        return { statements, unterminated: true, unterminatedAt: i };
      }
      startStatement();
      chunks.push(sql.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    // Double-quoted identifier with "" escape
    if (c === '"') {
      let j = i + 1;
      while (j < length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= length) {
        flush();
        return { statements, unterminated: true, unterminatedAt: i };
      }
      startStatement();
      chunks.push(sql.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    if (!isWhitespace(c)) {
      startStatement();
    }

    if (c === ";") {
      flush();
      i++;
      continue;
    }

    if (inStatement) {
      chunks.push(c);
    }
    i++;
  }

  if (inStatement) {
    const tail = chunks.join("").trim();
    if (tail.length > 0) {
      statements.push(tail);
    }
  }

  return { statements, unterminated: false };
}

/** Strip comments from a SQL script, preserving statement structure. */
export function stripComments(sql: string): string {
  return splitSqlStatements(sql).statements.join("; ");
}
