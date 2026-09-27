import { pool } from "../config/database";

/**
 * KYC Deduplication Job
 * Schedule: Daily at 3:00 AM (0 3 * * *)
 * Scans the kyc_applicants table for records sharing the same
 * (first_name, last_name, dob) combination.
 *
 * For each duplicate group:
 *   - The oldest record (by created_at) is kept as the canonical entry.
 *   - All other records are marked with is_duplicate = true and
 *     canonical_id pointing to the oldest record's id.
 */
export async function runKycDeduplicationJob(): Promise<void> {
  // Find all (first_name, last_name, dob) groups that have more than one record
  const groupsResult = await pool.query<{
    first_name: string;
    last_name: string;
    dob: string | null;
    count: string;
  }>(`
    SELECT
      applicant_data->>'first_name' AS first_name,
      applicant_data->>'last_name'  AS last_name,
      applicant_data->>'dob'        AS dob,
      COUNT(*)                      AS count
    FROM kyc_applicants
    WHERE (is_duplicate IS NULL OR is_duplicate = false)
    GROUP BY
      applicant_data->>'first_name',
      applicant_data->>'last_name',
      applicant_data->>'dob'
    HAVING COUNT(*) > 1
  `);

  const duplicateGroups = groupsResult.rows;

  if (duplicateGroups.length === 0) {
    console.log("[kyc-dedup] No duplicate applicant groups found — nothing to do");
    return;
  }

  console.log(`[kyc-dedup] Found ${duplicateGroups.length} duplicate group(s) to process`);

  let totalMarked = 0;

  for (const group of duplicateGroups) {
    // Fetch all records in this group, oldest first
    const membersResult = await pool.query<{ id: string }>(
      `
      SELECT id
      FROM kyc_applicants
      WHERE applicant_data->>'first_name' = $1
        AND applicant_data->>'last_name'  = $2
        AND ($3::text IS NULL OR applicant_data->>'dob' = $3)
        AND (is_duplicate IS NULL OR is_duplicate = false)
      ORDER BY created_at ASC
      `,
      [group.first_name, group.last_name, group.dob ?? null],
    );

    const members = membersResult.rows;
    if (members.length < 2) continue;

    const [canonical, ...duplicates] = members;
    const duplicateIds = duplicates.map((m) => m.id);

    // Mark duplicates
    const markResult = await pool.query(
      `
      UPDATE kyc_applicants
      SET is_duplicate  = true,
          canonical_id  = $1,
          updated_at    = CURRENT_TIMESTAMP
      WHERE id = ANY($2::uuid[])
      `,
      [canonical.id, duplicateIds],
    );

    const marked = markResult?.rowCount ?? 0;
    totalMarked += marked;

    console.log(
      `[kyc-dedup] Group "${group.first_name} ${group.last_name}" (dob: ${group.dob ?? 'n/a'}): ` +
        `canonical=${canonical.id}, marked ${marked} duplicate(s)`,
    );
  }

  console.log(
    `[kyc-dedup] Completed — ${duplicateGroups.length} group(s) processed, ${totalMarked} record(s) marked as duplicate`,
  );
}
