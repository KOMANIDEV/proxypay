/**
 * #480 – Advanced Transaction Filtering
 *
 * Two capabilities live here:
 *
 *   1. `compileFilterExpression()` – turns a nested, validated filter AST into
 *      parameterised SQL. The AST exists so a client can express
 *      "amount > 1000 AND (status = failed OR provider = momo) AND NOT
 *      (tagged = internal)" without string-concatenating SQL. Field names are
 *      resolved through a fixed whitelist, so a hostile payload can never
 *      reach the query as SQL – values are always bound parameters.
 *
 *   2. Saved filter templates – the same expressions are reused constantly, so
 *      they are persisted and can be exported/imported between environments.
 *
 * Guards against pathological input: the AST is depth- and node-limited, and
 * range/date operators reject inverted bounds at compile time rather than
 * returning an empty result set that looks like a data problem.
 */

import { z } from "zod";
import { queryRead, queryWrite } from "../config/database";
// Imported from the leaf module, not ../models/transaction: the model already
// imports this service, and a cycle back to the model would leave the enum
// undefined at module-initialisation time.
import { TransactionStatus } from "../utils/transactionFilters";

// ---------------------------------------------------------------------------
// Filter AST
// ---------------------------------------------------------------------------

export const FilterOperators = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

export const TextOperators = [
  "contains",
  "equals",
  "startsWith",
  "endsWith",
] as const;

const FilterPrimitive = z.union([z.string(), z.number(), z.boolean()]);

const RangeNodeSchema = z.object({
  type: z.literal("range"),
  field: z.string().min(1),
  min: z.number().optional(),
  max: z.number().optional(),
});

const CompareNodeSchema = z.object({
  type: z.literal("compare"),
  field: z.string().min(1),
  operator: z.enum(FilterOperators),
  value: FilterPrimitive,
});

const TextNodeSchema = z.object({
  type: z.literal("text"),
  field: z.string().min(1),
  operator: z.enum(TextOperators),
  value: z.string().min(1).max(500),
});

const InNodeSchema = z.object({
  type: z.literal("in"),
  field: z.string().min(1),
  values: z.array(FilterPrimitive).min(1).max(100),
});

const DateRangeNodeSchema = z.object({
  type: z.literal("dateRange"),
  field: z.string().min(1),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
});

/** Metadata key presence – the bridge to the #477 metadata search index. */
const ExistsNodeSchema = z.object({
  type: z.literal("exists"),
  metadataKey: z.string().min(1).max(100),
  value: z.boolean().default(true),
});

const AndOrNodeSchema = z.object({
  type: z.enum(["and", "or"]),
  conditions: z.array(z.unknown()).min(1).max(25),
});

const NotNodeSchema = z.object({
  type: z.literal("not"),
  condition: z.unknown(),
});

export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    AndOrNodeSchema.extend({
      conditions: z.array(FilterNodeSchema).min(1).max(25),
    }),
    NotNodeSchema.extend({ condition: FilterNodeSchema }),
    RangeNodeSchema,
    CompareNodeSchema,
    TextNodeSchema,
    InNodeSchema,
    DateRangeNodeSchema,
    ExistsNodeSchema,
  ]),
) as z.ZodType<FilterNode>;

export type FilterNode =
  | { type: "and"; conditions: FilterNode[] }
  | { type: "or"; conditions: FilterNode[] }
  | { type: "not"; condition: FilterNode }
  | {
      type: "range";
      field: string;
      min?: number;
      max?: number;
    }
  | {
      type: "compare";
      field: string;
      operator: (typeof FilterOperators)[number];
      value: string | number | boolean;
    }
  | {
      type: "text";
      field: string;
      operator: (typeof TextOperators)[number];
      value: string;
    }
  | { type: "in"; field: string; values: (string | number | boolean)[] }
  | { type: "dateRange"; field: string; start?: string; end?: string }
  | { type: "exists"; metadataKey: string; value: boolean };

/** Structural limits – a filter must never be able to become a denial of service. */
const MAX_DEPTH = 6;
const MAX_NODES = 100;

// ---------------------------------------------------------------------------
// Field whitelist
// ---------------------------------------------------------------------------

/**
 * Client-supplied field names are resolved here and nowhere else. Each entry
 * is the only SQL a client field can ever produce.
 *
 * Every column listed here must exist on `transactions`: a name that maps to a
 * missing column would compile cleanly and only fail at execution time.
 * `transactions` has no `completed_at` and no plain `fee` column – the fee
 * columns are `fee_amount` and `provider_fee` – so neither is offered.
 */
export const FILTERABLE_FIELDS: Record<
  string,
  { column: string; kind: "numeric" | "temporal" | "text" | "enum" }
> = {
  amount: { column: "amount", kind: "numeric" },
  originalAmount: { column: "original_amount", kind: "numeric" },
  convertedAmount: { column: "converted_amount", kind: "numeric" },
  feeAmount: { column: "fee_amount", kind: "numeric" },
  providerFee: { column: "provider_fee", kind: "numeric" },
  currency: { column: "currency", kind: "text" },
  provider: { column: "provider", kind: "text" },
  type: { column: "type", kind: "enum" },
  status: { column: "status", kind: "enum" },
  referenceNumber: { column: "reference_number", kind: "text" },
  providerReference: { column: "provider_reference", kind: "text" },
  phoneNumber: { column: "phone_number", kind: "text" },
  stellarAddress: { column: "stellar_address", kind: "text" },
  userId: { column: "user_id", kind: "text" },
  notes: { column: "notes", kind: "text" },
  createdAt: { column: "created_at", kind: "temporal" },
  updatedAt: { column: "updated_at", kind: "temporal" },
  tag: { column: "tags", kind: "text" },
};

export class FilterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterValidationError";
  }
}

/** Validate a client payload and return the typed AST. */
export function parseFilterExpression(input: unknown): FilterNode {
  const result = FilterNodeSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new FilterValidationError(
      `Invalid filter expression at ${first?.path?.join(".") || "root"}: ${
        first?.message ?? "invalid"
      }`,
    );
  }

  let nodes = 0;
  const walk = (node: FilterNode, depth: number): void => {
    nodes += 1;
    if (depth > MAX_DEPTH) {
      throw new FilterValidationError(
        `Filter expression exceeds maximum depth of ${MAX_DEPTH}`,
      );
    }
    if (nodes > MAX_NODES) {
      throw new FilterValidationError(
        `Filter expression exceeds maximum of ${MAX_NODES} conditions`,
      );
    }
    if (node.type === "and" || node.type === "or") {
      node.conditions.forEach((child) => walk(child, depth + 1));
    } else if (node.type === "not") {
      walk(node.condition, depth + 1);
    } else if (
      node.type === "range" &&
      node.min !== undefined &&
      node.max !== undefined &&
      node.min > node.max
    ) {
      throw new FilterValidationError(
        `Range filter on "${node.field}" has min greater than max`,
      );
    } else if (
      node.type === "dateRange" &&
      node.start &&
      node.end &&
      new Date(node.start) > new Date(node.end)
    ) {
      throw new FilterValidationError(
        `Date range filter on "${node.field}" starts after it ends`,
      );
    }
  };

  walk(result.data, 1);
  return result.data;
}

function resolveField(field: string): { column: string; kind: string } {
  const resolved = FILTERABLE_FIELDS[field];
  if (!resolved) {
    throw new FilterValidationError(
      `Unknown filter field "${field}". Filterable fields: ${Object.keys(
        FILTERABLE_FIELDS,
      ).join(", ")}`,
    );
  }
  return resolved;
}

const SQL_OPERATORS: Record<(typeof FilterOperators)[number], string> = {
  eq: "=",
  ne: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

const TEXT_OPERATORS: Record<(typeof TextOperators)[number], string> = {
  contains: "ILIKE",
  equals: "=",
  startsWith: "ILIKE",
  endsWith: "ILIKE",
};

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export interface CompiledFilter {
  sql: string;
  params: unknown[];
}

/**
 * Compile the AST to parameterised SQL.
 *
 * `startIndex` is the index of the first placeholder in the *final* query, so
 * the caller can splice the fragment into a larger statement without its
 * parameters being renumbered.
 */
export function compileFilterExpression(
  node: FilterNode,
  startIndex = 1,
): CompiledFilter {
  const params: unknown[] = [];
  let nextIndex = startIndex;

  const bind = (value: unknown): string => {
    params.push(value);
    return `$${nextIndex++}`;
  };

  const compile = (current: FilterNode): string => {
    switch (current.type) {
      case "and":
      case "or": {
        const joiner = current.type === "and" ? " AND " : " OR ";
        return `(${current.conditions.map(compile).join(joiner)})`;
      }

      case "not":
        return `NOT ${compile(current.condition)}`;

      case "range": {
        const { column } = resolveField(current.field);
        if (current.min === undefined && current.max === undefined) {
          throw new FilterValidationError(
            `Range filter on "${current.field}" needs at least one bound`,
          );
        }
        const parts: string[] = [];
        if (current.min !== undefined) parts.push(`${column} >= ${bind(current.min)}`);
        if (current.max !== undefined) parts.push(`${column} <= ${bind(current.max)}`);
        return `(${parts.join(" AND ")})`;
      }

      case "compare": {
        const { column, kind } = resolveField(current.field);
        if (kind === "numeric" && typeof current.value !== "number") {
          throw new FilterValidationError(
            `Field "${current.field}" requires a numeric value`,
          );
        }
        if (kind === "temporal") {
          // Compare temporally, not lexicographically: a string comparison of
          // two ISO timestamps happens to work, but casting keeps it honest
          // when the client sends a date-only string.
          return `(${column}::timestamptz ${SQL_OPERATORS[current.operator]} ${bind(
            new Date(String(current.value)).toISOString(),
          )})`;
        }
        return `(${column} ${SQL_OPERATORS[current.operator]} ${bind(current.value)})`;
      }

      case "text": {
        const { column } = resolveField(current.field);
        if (current.operator === "equals") {
          return `(${column} = ${bind(current.value)})`;
        }
        // Wildcards are added around an *escaped* value, so a user searching
        // for "50%" does not turn into a match-everything pattern.
        const escaped = current.value.replace(/[\\%_]/g, (c) => `\\${c}`);
        const pattern =
          current.operator === "contains"
            ? `%${escaped}%`
            : current.operator === "startsWith"
              ? `${escaped}%`
              : `%${escaped}`;
        return `(${column} ${TEXT_OPERATORS[current.operator]} ${bind(pattern)} ESCAPE '\\')`;
      }

      case "in": {
        const { column } = resolveField(current.field);
        return `(${column} = ANY(${bind(current.values)}))`;
      }

      case "dateRange": {
        const { column } = resolveField(current.field);
        if (!current.start && !current.end) {
          throw new FilterValidationError(
            `Date range filter on "${current.field}" needs a start or an end`,
          );
        }
        const parts: string[] = [];
        if (current.start) {
          parts.push(`${column} >= ${bind(new Date(current.start).toISOString())}`);
        }
        if (current.end) {
          parts.push(`${column} <= ${bind(new Date(current.end).toISOString())}`);
        }
        return `(${parts.join(" AND ")})`;
      }

      case "exists": {
        // `value: false` is a NOT EXISTS, which is the only way to express
        // "does not have this metadata key" with a GIN index.
        if (current.value) {
          return `(metadata ? ${bind(current.metadataKey)})`;
        }
        return `(NOT (metadata ? ${bind(current.metadataKey)}))`;
      }
    }
  };

  const sql = compile(node);
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Saved filter templates
// ---------------------------------------------------------------------------

export interface FilterTemplate {
  id: string;
  name: string;
  description: string | null;
  expression: FilterNode;
  isShared: boolean;
  isSystem: boolean;
  ownerId: string | null;
  usageCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const FilterTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  expression: z.unknown(),
  isShared: z.boolean().default(false),
});

export const FilterTemplateExportSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  templates: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        expression: z.unknown(),
        isShared: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(100),
});

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  expression: FilterNode;
  is_shared: boolean;
  is_system: boolean;
  owner_id: string | null;
  usage_count: string;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapTemplate(row: TemplateRow): FilterTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    expression: row.expression,
    isShared: row.is_shared,
    isSystem: row.is_system,
    ownerId: row.owner_id,
    usageCount: Number(row.usage_count),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const TEMPLATE_COLUMNS =
  "id, name, description, expression, is_shared, is_system, owner_id, " +
  "usage_count, last_used_at, created_at, updated_at";

/**
 * Templates visible to a user: their own, plus any shared or system template.
 * Mirrors how the rest of the app scopes per-user resources.
 */
export async function listFilterTemplates(
  ownerId?: string,
): Promise<FilterTemplate[]> {
  const { rows } = await queryRead<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM transaction_filter_templates
      WHERE owner_id = $1 OR is_shared = TRUE OR is_system = TRUE
      ORDER BY is_system DESC, name ASC`,
    [ownerId ?? null],
  );
  return rows.map(mapTemplate);
}

export async function getFilterTemplate(
  id: string,
  ownerId?: string,
): Promise<FilterTemplate | null> {
  const { rows } = await queryRead<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM transaction_filter_templates
      WHERE id = $1
        AND (owner_id = $2 OR is_shared = TRUE OR is_system = TRUE)`,
    [id, ownerId ?? null],
  );
  return rows[0] ? mapTemplate(rows[0]) : null;
}

export async function createFilterTemplate(
  input: z.infer<typeof FilterTemplateSchema>,
  ownerId?: string,
): Promise<FilterTemplate> {
  const parsed = FilterTemplateSchema.parse(input);
  // Validate before persisting: a stored expression that cannot compile is
  // worse than no template at all.
  const expression = parseFilterExpression(parsed.expression);
  const exportPayload = {
    version: 1,
    name: parsed.name,
    description: parsed.description ?? null,
    expression,
  };

  const { rows } = await queryWrite<FilterTemplateRow>(
    `INSERT INTO transaction_filter_templates
       (name, description, expression, export_payload, is_shared, owner_id)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6)
     RETURNING id`,
    [
      parsed.name,
      parsed.description ?? null,
      JSON.stringify(expression),
      JSON.stringify(exportPayload),
      parsed.isShared,
      ownerId ?? null,
    ],
  );

  const created = await getFilterTemplate(rows[0].id, ownerId);
  if (!created) throw new Error("Filter template was not persisted");
  return created;
}

interface FilterTemplateRow {
  id: string;
}

export async function updateFilterTemplate(
  id: string,
  input: Partial<z.infer<typeof FilterTemplateSchema>>,
  ownerId?: string,
): Promise<FilterTemplate | null> {
  const existing = await getFilterTemplate(id, ownerId);
  if (!existing) return null;
  // System templates ship with the product; overwriting them would change
  // behaviour for every user from a single API call.
  if (existing.isSystem) {
    throw new FilterValidationError("System templates cannot be modified");
  }

  const expression = input.expression
    ? parseFilterExpression(input.expression)
    : existing.expression;

  await queryWrite(
    `UPDATE transaction_filter_templates
        SET name         = $2,
            description  = $3,
            expression   = $4::jsonb,
            export_payload = $5::jsonb,
            is_shared    = $6,
            updated_at   = NOW()
      WHERE id = $1`,
    [
      id,
      input.name ?? existing.name,
      input.description ?? existing.description,
      JSON.stringify(expression),
      JSON.stringify({
        version: 1,
        name: input.name ?? existing.name,
        description: input.description ?? existing.description,
        expression,
      }),
      input.isShared ?? existing.isShared,
    ],
  );

  return getFilterTemplate(id, ownerId);
}

export async function deleteFilterTemplate(
  id: string,
  ownerId?: string,
): Promise<boolean> {
  const existing = await getFilterTemplate(id, ownerId);
  if (!existing) return false;
  if (existing.isSystem) {
    throw new FilterValidationError("System templates cannot be deleted");
  }
  // A shared template is editable by its author only when unshared; deleting
  // someone's shared template out from under other users is not allowed.
  if (existing.isShared && existing.ownerId !== (ownerId ?? null)) {
    throw new FilterValidationError(
      "Shared templates can only be deleted by their owner",
    );
  }

  const result = await queryWrite(
    `DELETE FROM transaction_filter_templates WHERE id = $1`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Record that a template was applied, keeping usage counters and history fresh. */
export async function recordTemplateUsage(
  id: string,
  usedBy?: string,
  resultCount?: number,
): Promise<void> {
  await queryWrite(
    `UPDATE transaction_filter_templates
        SET usage_count = usage_count + 1, last_used_at = NOW()
      WHERE id = $1`,
    [id],
  );
  await queryWrite(
    `INSERT INTO transaction_filter_usage (template_id, used_by, result_count)
     VALUES ($1,$2,$3)`,
    [id, usedBy ?? null, resultCount ?? null],
  );
}

/**
 * Export templates as a portable payload. System templates are included so a
 * fresh environment can be seeded with the same built-in filters.
 */
export async function exportFilterTemplates(
  ownerId?: string,
): Promise<z.infer<typeof FilterTemplateExportSchema>> {
  const templates = await listFilterTemplates(ownerId);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    templates: templates.map((template) => ({
      name: template.name,
      description: template.description ?? undefined,
      expression: template.expression,
      isShared: template.isShared,
    })),
  };
}

/**
 * Import a previously exported payload.
 *
 * Renames on conflict (`name` -> `name (imported)`) rather than overwriting:
 * an import must never clobber filters that are already in use.
 */
export async function importFilterTemplates(
  payload: unknown,
  ownerId?: string,
): Promise<{ imported: number; renamed: number; templates: FilterTemplate[] }> {
  const parsed = FilterTemplateExportSchema.parse(payload);
  const existingNames = new Set(
    (await listFilterTemplates(ownerId)).map((template) => template.name),
  );

  let renamed = 0;
  const created: FilterTemplate[] = [];

  for (const template of parsed.templates) {
    let name = template.name;
    if (existingNames.has(name)) {
      name = `${name} (imported)`;
      renamed += 1;
      // Suffix until it is actually unique.
      let suffix = 2;
      while (existingNames.has(name)) {
        name = `${template.name} (imported ${suffix++})`;
      }
    }
    existingNames.add(name);

    created.push(
      await createFilterTemplate({ ...template, name }, ownerId),
    );
  }

  return { imported: created.length, renamed, templates: created };
}

/** Convenience: the legacy flat filters mapped onto the AST. */
export function filtersToExpression(filters: {
  minAmount?: number;
  maxAmount?: number;
  provider?: string;
  statuses?: TransactionStatus[];
  referenceNumber?: string;
}): FilterNode | null {
  const conditions: FilterNode[] = [];

  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
    conditions.push({
      type: "range",
      field: "amount",
      ...(filters.minAmount !== undefined ? { min: filters.minAmount } : {}),
      ...(filters.maxAmount !== undefined ? { max: filters.maxAmount } : {}),
    });
  }
  if (filters.provider) {
    conditions.push({ type: "compare", field: "provider", operator: "eq", value: filters.provider });
  }
  if (filters.statuses?.length) {
    conditions.push({ type: "in", field: "status", values: filters.statuses });
  }
  if (filters.referenceNumber) {
    conditions.push({
      type: "compare",
      field: "referenceNumber",
      operator: "eq",
      value: filters.referenceNumber,
    });
  }

  if (conditions.length === 0) return null;
  return conditions.length === 1
    ? conditions[0]
    : { type: "and", conditions };
}
