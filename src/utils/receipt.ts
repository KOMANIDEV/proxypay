import { maskPhoneNumber, maskStellarAddress, maskEmail } from "./masking";

type ReceiptAmount = number | string | null | undefined;

type ReceiptDateInput = Date | string | number | null | undefined;

export interface ReceiptTransaction {
  id: string;
  amount: ReceiptAmount;
  provider: string;
  status: string;
  phoneNumber?: string;
  stellarAddress?: string;
  sender?: string;
  receiver?: string;
  fee?: ReceiptAmount;
  total?: ReceiptAmount;
  transactionHash?: string;
  referenceNumber?: string;
  createdAt?: ReceiptDateInput;
  currency?: string;
}

export interface ReceiptBrandingView {
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

export interface ReceiptOptions {
  generatedAt?: ReceiptDateInput;
  receiptNumber?: string;
  branding?: ReceiptBrandingView;
}

export interface ReceiptViewModel {
  receiptNumber: string;
  receiptDate: string;
  amount: string;
  fee: string;
  total: string;
  provider: string;
  status: string;
  sender: string;
  receiver: string;
  transactionId: string;
  referenceNumber?: string;
  transactionHash?: string;
  branding: Record<string, unknown>;
  transaction: Record<string, unknown>;
  receipt: Record<string, unknown>;
  amountRaw: number;
  feeRaw: number;
  totalRaw: number;
  currency: string;
  createdDate: string;
  year: number;
  locale: string;
}

export interface GenerateReceiptHtmlOptions extends ReceiptOptions {}

const RECEIPT_COUNTERS = new Map<string, number>();

function formatReceiptDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function nextReceiptSequence(dateStamp: string): number {
  const nextSequence = (RECEIPT_COUNTERS.get(dateStamp) ?? 0) + 1;
  RECEIPT_COUNTERS.set(dateStamp, nextSequence);
  return nextSequence;
}

function toDate(value?: ReceiptDateInput): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    return new Date(value);
  }
  return new Date();
}

function parseAmount(value: ReceiptAmount): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatAmount(value: ReceiptAmount, currency: string): string {
  const parsedValue = parseAmount(value);
  if (parsedValue === null) return `0 ${currency}`;

  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: Number.isInteger(parsedValue) ? 0 : 2,
    maximumFractionDigits: 7,
  }).format(parsedValue)} ${currency}`;
}

function formatDate(value?: ReceiptDateInput): string {
  const date = toDate(value);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildReceiptViewModel(
  transaction: ReceiptTransaction,
  options: ReceiptOptions = {},
) {
  const generatedAt = toDate(options.generatedAt ?? transaction.createdAt);
  const dateStamp = formatReceiptDateStamp(generatedAt);
  const receiptNumber =
    options.receiptNumber ??
    `RCP-${dateStamp}-${String(nextReceiptSequence(dateStamp)).padStart(5, "0")}`;
  const currency = transaction.currency ?? "XAF";
  const amountValue = parseAmount(transaction.amount) ?? 0;
  const feeValue = parseAmount(transaction.fee) ?? 0;
  const totalValue = parseAmount(transaction.total) ?? amountValue + feeValue;

  const senderRaw = transaction.sender ?? transaction.phoneNumber ?? "N/A";
  const receiverRaw = transaction.receiver ?? transaction.stellarAddress ?? "N/A";

  const maskValue = (val: string) => {
    if (!val || val === "N/A") return val;
    if (val.includes("@")) return maskEmail(val);
    if (val.startsWith("+") || /^\d{7,}$/.test(val.replace(/\s/g, "")))
      return maskPhoneNumber(val);
    if (val.length > 30) return maskStellarAddress(val);
    return val;
  };

  return {
    receiptNumber,
    receiptDate: formatDate(generatedAt),
    amount: formatAmount(amountValue, currency),
    fee: formatAmount(feeValue, currency),
    total: formatAmount(totalValue, currency),
    provider: transaction.provider,
    status: toTitleCase(transaction.status),
    sender: maskValue(senderRaw),
    receiver: maskValue(receiverRaw),
    transactionId: transaction.id,
    referenceNumber: transaction.referenceNumber,
    transactionHash: transaction.transactionHash,
    branding: options.branding ?? {},
    transaction: {},
    receipt: {},
    amountRaw: amountValue,
    feeRaw: feeValue,
    totalRaw: totalValue,
    currency,
    createdDate: formatDate(generatedAt),
    year: generatedAt.getFullYear(),
    locale: "en",
  };
}

/**
 * Generates a unique receipt number using the format `RCP-YYYYMMDD-XXXXX`.
 *
 * @example
 * const receiptNumber = generateReceiptNumber(new Date("2026-03-22T10:30:00Z"));
 * // RCP-20260322-00001
 */
export function generateReceiptNumber(generatedAt?: ReceiptDateInput): string {
  const date = toDate(generatedAt);
  const dateStamp = formatReceiptDateStamp(date);
  const sequence = nextReceiptSequence(dateStamp);
  return `RCP-${dateStamp}-${String(sequence).padStart(5, "0")}`;
}

/**
 * Generates a plain-text transaction receipt suitable for SMS previews or email bodies.
 *
 * @example
 * const receipt = generateReceipt({
 *   id: "abc123",
 *   amount: "10000",
 *   fee: "100",
 *   provider: "MTN Mobile Money",
 *   status: "completed",
 *   phoneNumber: "+237 6XX XXX XXX",
 *   stellarAddress: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
 *   createdAt: "2026-03-22T10:30:00Z",
 * });
 */
export function generateReceipt(
  transaction: ReceiptTransaction,
  options: ReceiptOptions = {},
): string {
  const receipt = buildReceiptViewModel(transaction, options);
  const lines = [
    "========================================",
    "        TRANSACTION RECEIPT",
    "========================================",
    `Receipt No: ${receipt.receiptNumber}`,
    `Date: ${receipt.receiptDate}`,
    "",
    "Transaction Details:",
    `- Amount: ${receipt.amount}`,
    `- Fee: ${receipt.fee}`,
    `- Total: ${receipt.total}`,
    `- Provider: ${receipt.provider}`,
    `- Status: ${receipt.status}`,
    "",
    `From: ${receipt.sender}`,
    `To: ${receipt.receiver}`,
    "",
    `Transaction ID: ${receipt.transactionId}`,
  ];

  if (receipt.referenceNumber) {
    lines.push(`Reference No: ${receipt.referenceNumber}`);
  }

  if (receipt.transactionHash) {
    lines.push(`Stellar Hash: ${receipt.transactionHash}`);
  }

  lines.push(
    "",
    "Thank you for using our service!",
    "========================================",
  );

  return lines.join("\n");
}

/**
 * Generates a plain-text transaction receipt from a pre-built view model.
 * Used both by the built-in path and as the plain-text fallback for
 * custom Handlebars receipts.
 *
 * @example
 * const text = generatePlainTextReceipt(viewModel, branding);
 */
export function generatePlainTextReceipt(
  receipt: ReceiptViewModel,
  branding: ReceiptBrandingView = {},
): string {
  const lines = [
    "========================================",
    "        TRANSACTION RECEIPT",
    "========================================",
  ];

  const businessName = branding.businessName || "Mobile Money";
  if (businessName) lines.push(businessName);

  lines.push(
    `Receipt No: ${receipt.receiptNumber}`,
    `Date: ${receipt.receiptDate}`,
    "",
    "Transaction Details:",
    `- Amount: ${receipt.amount}`,
    `- Fee: ${receipt.fee}`,
    `- Total: ${receipt.total}`,
    `- Provider: ${receipt.provider}`,
    `- Status: ${receipt.status}`,
    "",
    `From: ${receipt.sender}`,
    `To: ${receipt.receiver}`,
    "",
    `Transaction ID: ${receipt.transactionId}`,
  );

  if (receipt.referenceNumber) {
    lines.push(`Reference No: ${receipt.referenceNumber}`);
  }

  if (receipt.transactionHash) {
    lines.push(`Stellar Hash: ${receipt.transactionHash}`);
  }

  lines.push(
    "",
    branding.footerText || "Thank you for using our service!",
    "========================================",
  );

  return lines.join("\n");
}

/**
 * Print stylesheet applied to HTML receipts when they are rendered on paper or
 * exported to PDF (e.g. the browser's "Print" dialog). Kept inline because
 * receipts are also delivered by email, where external stylesheets are stripped.
 *
 * Rules:
 *  - Removes the screen-only card chrome (shadow, rounded corners, background).
 *  - Forces a white background / black text so receipts stay legible on
 *    monochrome printers.
 *  - Adds row separators and page margins for multi-item receipts.
 */
export const RECEIPT_PRINT_STYLES = `
    @media print {
      @page { size: A4 portrait; margin: 12mm; }
      html, body {
        background: #ffffff !important;
        margin: 0 !important;
        padding: 0 !important;
        color: #000000;
        font-size: 12pt;
      }
      .receipt-wrapper {
        max-width: 100% !important;
        margin: 0 !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }
      .receipt-header {
        background: #ffffff !important;
        color: #000000 !important;
        border-bottom: 2px solid #000000;
        padding: 0 0 12px !important;
      }
      .receipt-header img { max-height: 48px !important; }
      .receipt-title { font-size: 18pt !important; }
      .receipt-table { width: 100% !important; border-collapse: collapse !important; }
      .receipt-table td {
        padding: 6px 0 !important;
        border-bottom: 1px solid #cbd5e1;
        color: #000000 !important;
      }
      .receipt-footer {
        border-top: 1px solid #cbd5e1;
        padding-top: 8px;
        color: #000000 !important;
      }
      a { color: #000000 !important; text-decoration: none !important; }
    }`;

/**
 * Generates an HTML receipt for email delivery. Supports business branding
 * (logo, business name, primary color) passed through ReceiptOptions.branding.
 * The markup includes an inline print stylesheet (see RECEIPT_PRINT_STYLES) so
 * the receipt prints cleanly when a customer saves it as PDF.
 *
 * @example
 * const html = generateReceiptHtml(transaction, { branding: { businessName: "Acme", logoUrl: "...", primaryColor: "#123456" } });
 */
export function generateReceiptHtml(
  transaction: ReceiptTransaction,
  options: GenerateReceiptHtmlOptions = {},
): string {
  const receipt = buildReceiptViewModel(transaction, options);
  const branding = options.branding ?? {};
  const businessName = branding.businessName || "Mobile Money";
  const primaryColor = branding.primaryColor || "#0f172a";
  const headerFg =
    primaryColor === "#ffffff" || isLightColor(primaryColor) ? "#0f172a" : "#ffffff";
  const logoUrl = branding.logoUrl;

  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(businessName)}" style="max-height:60px;max-width:200px;margin-bottom:12px;display:block;" />`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(businessName)} — Transaction Receipt</title>
    <style>${RECEIPT_PRINT_STYLES}
    </style>
  </head>
  <body style="margin:0;padding:24px;background:#f5f7fb;font-family:Arial,sans-serif;color:#0f172a;">
    <div class="receipt-wrapper" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dbe4f0;border-radius:12px;overflow:hidden;">
      <div class="receipt-header" style="padding:24px;background:${primaryColor};color:${headerFg};">
        ${logo}
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.8;">${escapeHtml(businessName)}</p>
        <h1 class="receipt-title" style="margin:0;font-size:24px;">Transaction Receipt</h1>
        <p style="margin:8px 0 0;opacity:0.8;">${escapeHtml(receipt.receiptNumber)}</p>
        <p style="margin:4px 0 0;opacity:0.8;">${escapeHtml(receipt.receiptDate)}</p>
      </div>
      <div style="padding:24px;">
        <h2 style="margin:0 0 12px;font-size:16px;">Transaction Details</h2>
        <table class="receipt-table" style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#64748b;">Amount</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.amount)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Fee</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.fee)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Total</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.total)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Provider</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.provider)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Status</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.status)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">From</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.sender)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">To</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.receiver)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Transaction ID</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.transactionId)}</td></tr>
          ${
            receipt.referenceNumber
              ? `<tr><td style="padding:8px 0;color:#64748b;">Reference No</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.referenceNumber)}</td></tr>`
              : ""
          }
          ${
            receipt.transactionHash
              ? `<tr><td style="padding:8px 0;color:#64748b;">Stellar Hash</td><td style="padding:8px 0;text-align:right;">${escapeHtml(receipt.transactionHash)}</td></tr>`
              : ""
          }
        </table>
        <p class="receipt-footer" style="margin:20px 0 0;color:#64748b;font-size:13px;">${escapeHtml(branding.footerText || "Thank you for using our service!")}</p>
      </div>
    </div>
  </body>
</html>`;
}

function isLightColor(hex: string): boolean {
  const match = hex.replace("#", "");
  if (match.length !== 6) return false;
  const r = parseInt(match.slice(0, 2), 16);
  const g = parseInt(match.slice(2, 4), 16);
  const b = parseInt(match.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 186;
}
