/**
 * Preference Change Service
 *
 * Turns settings mutations into an append-only audit trail
 * (`preference_change_log`) and at-least-once webhook notifications
 * (enqueued into the shared `webhook_outbox` table, event type
 * `preference.changed`). The webhook_outbox entries are picked up by the
 * existing outbox delivery worker, so notification delivery is retried with
 * backoff instead of being fire-and-forget.
 *
 * Usage: register `createPreferenceChangeHandler()` with
 * `onSettingsChanged()` in the API layer.
 */

import { pool } from "../config/database";
import logger from "../utils/logger";
import type { SettingsChangeEvent } from "../utils/settingsPanel";

export interface PreferenceChangeEntry {
  id: string;
  userId: string;
  actorId: string | null;
  action: "update" | "reset" | "delete";
  previousVersion: number;
  newVersion: number;
  changes: Record<string, unknown>;
  source: string | null;
  createdAt: Date;
}

/**
 * Build a listener suitable for `onSettingsChanged()` that persists the
 * audit entry and enqueues the change webhook. Errors are logged and
 * swallowed so a failed audit write never breaks the settings update.
 */
export function createPreferenceChangeHandler(): (
  event: SettingsChangeEvent,
) => void {
  return (event: SettingsChangeEvent) => {
    void recordPreferenceChange(event)
      .then(() => enqueuePreferenceWebhook(event))
      .catch((err: unknown) => {
        logger.error(
          { err, userId: event.userId, action: event.action },
          "[preferences] Failed to record preference change",
        );
      });
  };
}

/**
 * Append an entry to the preference change audit log.
 */
export async function recordPreferenceChange(
  event: SettingsChangeEvent,
): Promise<PreferenceChangeEntry> {
  const { rows } = await pool.query(
    `INSERT INTO preference_change_log (
       user_id, actor_id, action, previous_version, new_version, changes, source
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, user_id, actor_id, action, previous_version, new_version,
               changes, source, created_at`,
    [
      event.userId,
      event.actorId ?? null,
      event.action,
      event.previousVersion,
      event.newVersion,
      JSON.stringify(event.changes ?? {}),
      event.source ?? "api",
    ],
  );

  const row = rows[0];
  return {
    id: String(row.id),
    userId: row.user_id,
    actorId: row.actor_id ?? null,
    action: row.action,
    previousVersion: Number(row.previous_version),
    newVersion: Number(row.new_version),
    changes: row.changes ?? {},
    source: row.source ?? null,
    createdAt: new Date(row.created_at),
  };
}

/**
 * Fetch a user's preference change history, newest first.
 */
export async function getPreferenceChangeHistory(
  userId: string,
  limit = 50,
  offset = 0,
): Promise<{ entries: PreferenceChangeEntry[]; total: number }> {
  const capped = Math.min(Math.max(limit, 1), 200);
  const safeOffset = Math.max(offset, 0);

  const [entriesRes, countRes] = await Promise.all([
    pool.query(
      `SELECT id, user_id, actor_id, action, previous_version, new_version,
              changes, source, created_at
       FROM preference_change_log
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, capped, safeOffset],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM preference_change_log WHERE user_id = $1`,
      [userId],
    ),
  ]);

  return {
    entries: entriesRes.rows.map((row: any) => ({
      id: String(row.id),
      userId: row.user_id,
      actorId: row.actor_id ?? null,
      action: row.action,
      previousVersion: Number(row.previous_version),
      newVersion: Number(row.new_version),
      changes: row.changes ?? {},
      source: row.source ?? null,
      createdAt: new Date(row.created_at),
    })),
    total: Number(countRes.rows[0]?.total ?? 0),
  };
}

/**
 * Enqueue a `preference.changed` webhook into the shared outbox table.
 * Returns the outbox entry id, or null when the insert failed.
 */
export async function enqueuePreferenceWebhook(
  event: SettingsChangeEvent,
): Promise<string | null> {
  const payload = {
    event_id: `pev_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    event_type: "preference.changed",
    timestamp: new Date().toISOString(),
    data: {
      user_id: event.userId,
      action: event.action,
      previous_version: event.previousVersion,
      new_version: event.newVersion,
      changes: event.changes ?? {},
      source: event.source,
    },
  };

  const { rows } = await pool.query(
    `INSERT INTO webhook_outbox (
       event_type, payload, status, attempts, max_attempts, next_attempt_at
     ) VALUES ($1,$2,'pending',0,5,NOW())
     RETURNING id`,
    ["preference.changed", JSON.stringify(payload)],
  );

  return rows[0] ? String(rows[0].id) : null;
}
