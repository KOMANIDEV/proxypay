import { queryRead, queryWrite } from "../config/database";
import { v4 as uuidv4 } from "uuid";

export interface ReceiptBranding {
  businessName?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  footerText?: string;
  address?: string;
  phoneNumber?: string;
  website?: string;
  [key: string]: unknown;
}

export interface ReceiptTemplate {
  id: string;
  merchantId: string | null;
  name: string;
  version: number;
  htmlBody: string;
  plainBody: string | null;
  branding: ReceiptBranding;
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReceiptTemplateInput {
  merchantId?: string | null;
  name: string;
  htmlBody: string;
  plainBody?: string | null;
  branding?: ReceiptBranding;
  isActive?: boolean;
  createdBy?: string | null;
}

const TEMPLATE_SELECT_COLUMNS = `
  id,
  merchant_id AS "merchantId",
  name,
  version,
  html_body AS "htmlBody",
  plain_body AS "plainBody",
  branding,
  is_active AS "isActive",
  created_by AS "createdBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRowToTemplate(row: any): ReceiptTemplate {
  return {
    id: row.id,
    merchantId: row.merchantId ?? null,
    name: row.name,
    version: row.version,
    htmlBody: row.htmlBody,
    plainBody: row.plainBody ?? null,
    branding: row.branding || {},
    isActive: row.isActive,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Receipt template storage with per-template versioning.
 *
 * Saving a new revision of a template (by merchant + name) increments its
 * version and, by default, activates the new revision while deactivating the
 * earlier ones.
 */
export class ReceiptTemplateModel {
  async create(input: ReceiptTemplateInput): Promise<ReceiptTemplate> {
    const id = uuidv4();
    const merchantId = input.merchantId ?? null;

    const result = await queryWrite(
      `INSERT INTO receipt_templates (
         id, merchant_id, name, version, html_body, plain_body,
         branding, is_active, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
      [
        id,
        merchantId,
        input.name,
        input.isActive ? 2 : 1,
        input.htmlBody,
        input.plainBody ?? null,
        JSON.stringify(input.branding || {}),
        input.isActive ?? false,
        input.createdBy ?? null,
      ],
    );

    return mapRowToTemplate(result.rows[0]);
  }

  async findById(id: string): Promise<ReceiptTemplate | null> {
    const result = await queryRead(
      `SELECT ${TEMPLATE_SELECT_COLUMNS} FROM receipt_templates WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapRowToTemplate(result.rows[0]);
  }

  async findActive(
    merchantId: string | null,
    name: string,
  ): Promise<ReceiptTemplate | null> {
    const result = await queryRead(
      `SELECT ${TEMPLATE_SELECT_COLUMNS}
       FROM receipt_templates
       WHERE merchant_id IS NOT DISTINCT FROM $1 AND name = $2 AND is_active = TRUE
       ORDER BY version DESC
       LIMIT 1`,
      [merchantId, name],
    );
    if (result.rows.length === 0) return null;
    return mapRowToTemplate(result.rows[0]);
  }

  async findLatest(
    merchantId: string | null,
    name: string,
  ): Promise<ReceiptTemplate | null> {
    const result = await queryRead(
      `SELECT ${TEMPLATE_SELECT_COLUMNS}
       FROM receipt_templates
       WHERE merchant_id IS NOT DISTINCT FROM $1 AND name = $2
       ORDER BY version DESC
       LIMIT 1`,
      [merchantId, name],
    );
    if (result.rows.length === 0) return null;
    return mapRowToTemplate(result.rows[0]);
  }

  async listVersions(
    merchantId: string | null,
    name: string,
  ): Promise<ReceiptTemplate[]> {
    const result = await queryRead(
      `SELECT ${TEMPLATE_SELECT_COLUMNS}
       FROM receipt_templates
       WHERE merchant_id IS NOT DISTINCT FROM $1 AND name = $2
       ORDER BY version DESC`,
      [merchantId, name],
    );
    return result.rows.map((row: any) => mapRowToTemplate(row));
  }

  async listByMerchant(merchantId: string | null): Promise<ReceiptTemplate[]> {
    const result = await queryRead(
      `SELECT ${TEMPLATE_SELECT_COLUMNS}
       FROM receipt_templates
       WHERE merchant_id IS NOT DISTINCT FROM $1 AND is_active = TRUE
       ORDER BY name ASC, version DESC`,
      [merchantId],
    );
    return result.rows.map((row: any) => mapRowToTemplate(row));
  }

  async saveRevision(
    input: ReceiptTemplateInput,
  ): Promise<ReceiptTemplate> {
    const merchantId = input.merchantId ?? null;
    const latest = await this.findLatest(merchantId, input.name);
    const nextVersion = (latest?.version ?? 0) + 1;

    const id = uuidv4();

    const result = await queryWrite(
      `INSERT INTO receipt_templates (
         id, merchant_id, name, version, html_body, plain_body,
         branding, is_active, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
      [
        id,
        merchantId,
        input.name,
        nextVersion,
        input.htmlBody,
        input.plainBody ?? null,
        JSON.stringify(input.branding || {}),
        input.isActive ?? true,
        input.createdBy ?? null,
      ],
    );

    if (input.isActive ?? true) {
      await this.deactivateExcept(merchantId, input.name, id);
    }

    return mapRowToTemplate(result.rows[0]);
  }

  async activate(id: string): Promise<ReceiptTemplate | null> {
    const template = await this.findById(id);
    if (!template) return null;

    await queryWrite(
      `UPDATE receipt_templates SET is_active = FALSE WHERE merchant_id IS NOT DISTINCT FROM $1 AND name = $2`,
      [template.merchantId, template.name],
    );

    const result = await queryWrite(
      `UPDATE receipt_templates
       SET is_active = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
      [id],
    );

    return mapRowToTemplate(result.rows[0]);
  }

  async deactivate(id: string): Promise<ReceiptTemplate | null> {
    const result = await queryWrite(
      `UPDATE receipt_templates
       SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING ${TEMPLATE_SELECT_COLUMNS}`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapRowToTemplate(result.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const result = await queryWrite(
      "DELETE FROM receipt_templates WHERE id = $1",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async deactivateExcept(
    merchantId: string | null,
    name: string,
    exceptId: string,
  ): Promise<void> {
    await queryWrite(
      `UPDATE receipt_templates
       SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE merchant_id IS NOT DISTINCT FROM $1 AND name = $2 AND id <> $3`,
      [merchantId, name, exceptId],
    );
  }
}
