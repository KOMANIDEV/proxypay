import { pool } from '../config/database';
import { PaginatedResult, createPaginatedResponse, parsePaginationParams, buildCursorWhere } from '../utils/pagination';

export enum InvoiceStatus {
  Pending = 'pending',
  Generated = 'generated',
  Sent = 'sent',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  userId: string;
  merchantId?: string;
  templateId?: string;
  billingMonth: number;
  billingYear: number;
  currencySummary: Record<string, any>;
  status: InvoiceStatus;
  pdfStorageKey?: string;
  pdfSizeBytes?: number;
  sentAt?: Date;
  emailMessageId?: string;
  deliveryError?: string;
  generatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class InvoiceModel {
  /**
   * Create a new invoice record
   */
  async create(invoice: Omit<Invoice, 'id' | 'invoiceNumber' | 'createdAt' | 'updatedAt'>): Promise<Invoice> {
    const invoiceNumber = await this.generateInvoiceNumber();
    
    const { rows } = await pool.query<any>(
      `INSERT INTO invoices (
        invoice_number, user_id, merchant_id, template_id,
        billing_month, billing_year, currency_summary, status,
        pdf_storage_key, pdf_size_bytes, sent_at, email_message_id,
        delivery_error, generated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id, invoice_number, user_id, merchant_id, template_id,
                billing_month, billing_year, currency_summary, status,
                pdf_storage_key, pdf_size_bytes, sent_at, email_message_id,
                delivery_error, generated_at, created_at, updated_at`,
      [
        invoiceNumber,
        invoice.userId,
        invoice.merchantId,
        invoice.templateId,
        invoice.billingMonth,
        invoice.billingYear,
        JSON.stringify(invoice.currencySummary),
        invoice.status || InvoiceStatus.Pending,
        invoice.pdfStorageKey,
        invoice.pdfSizeBytes,
        invoice.sentAt,
        invoice.emailMessageId,
        invoice.deliveryError,
        invoice.generatedAt,
      ]
    );

    return this.mapRow(rows[0]);
  }

  /**
   * Find an invoice by ID
   */
  async findById(id: string): Promise<Invoice | null> {
    const { rows } = await pool.query<any>(
      `SELECT * FROM invoices WHERE id = $1`,
      [id]
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  /**
   * Find invoices by user ID with pagination
   */
  async findByUserId(
    userId: string,
    query: Record<string, unknown> = {}
  ): Promise<PaginatedResult<Invoice>> {
    const paginationParams = parsePaginationParams(query, { maxLimit: 100 });

    const whereClause = paginationParams.after
      ? buildCursorWhere(
          { v: 1, t: '', id: paginationParams.after },
          { column: 'created_at', order: 'desc', direction: 'forward' }
        )
      : null;

    const sql = whereClause
      ? `SELECT * FROM invoices WHERE user_id = $1 AND ${whereClause.clause} ORDER BY created_at DESC LIMIT $${2 + whereClause.params.length + 1}`
      : `SELECT * FROM invoices WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`;

    const params = [userId, ...(whereClause?.params || []), paginationParams.limit + 1];

    const { rows } = await pool.query<any>(sql, params);
    const invoices = rows.map((row) => this.mapRow(row));

    return createPaginatedResponse({
      rows: invoices,
      limit: paginationParams.limit,
      getSortValue: (inv) => inv.createdAt,
      getId: (inv) => inv.id,
    });
  }

  /**
   * Find invoices by billing period
   */
  async findByBillingPeriod(
    billingMonth: number,
    billingYear: number
  ): Promise<Invoice[]> {
    const { rows } = await pool.query<any>(
      `SELECT * FROM invoices WHERE billing_month = $1 AND billing_year = $2`,
      [billingMonth, billingYear]
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Find existing invoice for a user and billing period
   */
  async findByUserAndPeriod(
    userId: string,
    billingMonth: number,
    billingYear: number
  ): Promise<Invoice | null> {
    const { rows } = await pool.query<any>(
      `SELECT * FROM invoices
       WHERE user_id = $1 AND billing_month = $2 AND billing_year = $3`,
      [userId, billingMonth, billingYear]
    );
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  /**
   * Update invoice status and related fields
   */
  async updateStatus(
    id: string,
    status: InvoiceStatus,
    updates: Partial<Invoice> = {}
  ): Promise<Invoice> {
    const setClauses = ['status = $2', 'updated_at = NOW()'];
    const values: any[] = [id, status];
    let paramIndex = 3;

    if (updates.pdfStorageKey) {
      setClauses.push(`pdf_storage_key = $${paramIndex++}`);
      values.push(updates.pdfStorageKey);
    }
    if (updates.pdfSizeBytes) {
      setClauses.push(`pdf_size_bytes = $${paramIndex++}`);
      values.push(updates.pdfSizeBytes);
    }
    if (updates.sentAt) {
      setClauses.push(`sent_at = $${paramIndex++}`);
      values.push(updates.sentAt);
    }
    if (updates.emailMessageId) {
      setClauses.push(`email_message_id = $${paramIndex++}`);
      values.push(updates.emailMessageId);
    }
    if (updates.deliveryError) {
      setClauses.push(`delivery_error = $${paramIndex++}`);
      values.push(updates.deliveryError);
    }
    if (updates.generatedAt) {
      setClauses.push(`generated_at = $${paramIndex++}`);
      values.push(updates.generatedAt);
    }
    if (updates.currencySummary) {
      setClauses.push(`currency_summary = $${paramIndex++}`);
      values.push(JSON.stringify(updates.currencySummary));
    }

    const sql = `UPDATE invoices SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`;

    const { rows } = await pool.query<any>(sql, values);
    if (rows.length === 0) {
      throw new Error(`Invoice ${id} not found`);
    }
    return this.mapRow(rows[0]);
  }

  /**
   * List invoices by status
   */
  async findByStatus(status: InvoiceStatus): Promise<Invoice[]> {
    const { rows } = await pool.query<any>(
      `SELECT * FROM invoices WHERE status = $1 ORDER BY created_at DESC`,
      [status]
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Get pending invoices for processing
   */
  async getPendingInvoices(limit = 100): Promise<Invoice[]> {
    const { rows } = await pool.query<any>(
      `SELECT * FROM invoices WHERE status = $1 ORDER BY created_at ASC LIMIT $2`,
      [InvoiceStatus.Pending, limit]
    );
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Generate the next invoice number
   */
  async generateInvoiceNumber(): Promise<string> {
    const { rows } = await pool.query<{ generate_invoice_number: string }>(
      `SELECT generate_invoice_number() as generate_invoice_number`
    );
    return rows[0].generate_invoice_number;
  }

  /**
   * Cancel an invoice
   */
  async cancel(id: string): Promise<Invoice> {
    return this.updateStatus(id, InvoiceStatus.Cancelled);
  }

  /**
   * Count invoices by status
   */
  async countByStatus(status: InvoiceStatus): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM invoices WHERE status = $1`,
      [status]
    );
    return parseInt(rows[0].count, 10);
  }

  private mapRow(row: any): Invoice {
    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      userId: row.user_id,
      merchantId: row.merchant_id,
      templateId: row.template_id,
      billingMonth: row.billing_month,
      billingYear: row.billing_year,
      currencySummary: typeof row.currency_summary === 'string'
        ? JSON.parse(row.currency_summary)
        : row.currency_summary,
      status: row.status as InvoiceStatus,
      pdfStorageKey: row.pdf_storage_key,
      pdfSizeBytes: row.pdf_size_bytes,
      sentAt: row.sent_at ? new Date(row.sent_at) : undefined,
      emailMessageId: row.email_message_id,
      deliveryError: row.delivery_error,
      generatedAt: row.generated_at ? new Date(row.generated_at) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}
