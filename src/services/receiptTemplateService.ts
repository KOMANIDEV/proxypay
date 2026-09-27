import Handlebars from "handlebars";
import {
  ReceiptTemplate,
  ReceiptTemplateModel,
  ReceiptBranding,
} from "../models/receiptTemplate";
import {
  GenerateReceiptHtmlOptions,
  ReceiptViewModel,
  generatePlainTextReceipt,
} from "../utils/receipt";
import { Transaction } from "../models/transaction";
import { maskPhoneNumber, maskStellarAddress, maskEmail } from "../utils/masking";

export interface ReceiptRenderResult {
  html: string;
  plain: string;
  template: ReceiptTemplate | null;
  templateName: string;
  version: number;
  renderingEngine: "handlebars" | "built-in";
}

export interface RenderReceiptInput {
  transaction: Transaction;
  merchantId?: string | null;
  merchantDisplayName?: string | null;
  businessName?: string | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
  locale?: string;
  generatedAt?: string | Date;
}

export const DEFAULT_RECEIPT_TEMPLATE_NAME = "standard-receipt";

/**
 * Template management + Handlebars rendering for transaction receipts.
 *
 * Businesses can store custom, versioned Handlebars templates (with branding
 * such as logo, business name and colors). When no custom template is active
 * for a business, receipts fall back to the built-in renderer.
 */
export class ReceiptTemplateService {
  private readonly model: ReceiptTemplateModel;
  private readonly templateCache = new Map<string, Handlebars.TemplateDelegate>();

  constructor(model?: ReceiptTemplateModel) {
    this.model = model ?? new ReceiptTemplateModel();
  }

  private clearCache(merchantId: string | null, name: string): void {
    const key = this.cacheKey(merchantId, name);
    this.templateCache.delete(key);
  }

  private cacheKey(merchantId: string | null, name: string): string {
    return `${merchantId ?? "default"}::${name}`;
  }

  private compile(source: string): Handlebars.TemplateDelegate {
    return Handlebars.compile(source, { noEscape: false });
  }

  async saveTemplate(
    input: {
      merchantId?: string | null;
      name?: string;
      htmlBody: string;
      plainBody?: string | null;
      branding?: ReceiptBranding;
      createdBy?: string | null;
      activate?: boolean;
    },
  ): Promise<ReceiptTemplate> {
    const name = input.name ?? DEFAULT_RECEIPT_TEMPLATE_NAME;
    const saved = await this.model.saveRevision({
      merchantId: input.merchantId ?? null,
      name,
      htmlBody: input.htmlBody,
      plainBody: input.plainBody ?? null,
      branding: input.branding ?? {},
      isActive: input.activate ?? true,
      createdBy: input.createdBy ?? null,
    });
    this.clearCache(input.merchantId ?? null, name);
    return saved;
  }

  async activateTemplate(
    merchantId: string | null,
    name: string,
    version: number,
  ): Promise<ReceiptTemplate | null> {
    const versions = await this.model.listVersions(merchantId, name);
    const target = versions.find((v) => v.version === version);
    if (!target) return null;
    const activated = await this.model.activate(target.id);
    this.clearCache(merchantId, name);
    return activated;
  }

  async listTemplates(merchantId: string | null): Promise<ReceiptTemplate[]> {
    return this.model.listByMerchant(merchantId);
  }

  async listTemplateVersions(
    merchantId: string | null,
    name: string,
  ): Promise<ReceiptTemplate[]> {
    return this.model.listVersions(merchantId, name);
  }

  async deleteTemplate(id: string): Promise<boolean> {
    const template = await this.model.findById(id);
    if (template) {
      this.clearCache(template.merchantId, template.name);
    }
    return this.model.delete(id);
  }

  async renderReceipt(input: RenderReceiptInput): Promise<ReceiptRenderResult> {
    const name = DEFAULT_RECEIPT_TEMPLATE_NAME;
    const merchantId = input.merchantId ?? null;

    const active = await this.model.findActive(merchantId, name);

    const templateName = active?.name ?? name;
    const version = active?.version ?? 1;
    const branding = this.resolveBranding({
      templateBranding: active?.branding,
      businessName: input.businessName,
      merchantDisplayName: input.merchantDisplayName,
      logoUrl: input.logoUrl,
      primaryColor: input.primaryColor,
    });

    const viewModel = this.buildViewModel(input, branding);

    if (active) {
      const compiled = this.getCompiledTemplate(merchantId, templateName, active);
      const html = compiled(viewModel);
      const plain = active.plainBody
        ? this.getCompiledPlain(merchantId, templateName, active)(viewModel)
        : generatePlainTextReceipt(viewModel, branding);
      return {
        html,
        plain,
        template: active,
        templateName,
        version,
        renderingEngine: "handlebars",
      };
    }

    return {
      html: this.renderBuiltInHtml(viewModel, branding),
      plain: generatePlainTextReceipt(viewModel, branding),
      template: null,
      templateName,
      version,
      renderingEngine: "built-in",
    };
  }

  private getCompiledTemplate(
    merchantId: string | null,
    name: string,
    template: ReceiptTemplate,
  ): Handlebars.TemplateDelegate {
    const key = this.cacheKey(merchantId, name);
    let compiled = this.templateCache.get(key);
    if (!compiled) {
      compiled = this.compile(template.htmlBody);
      this.templateCache.set(key, compiled);
    }
    return compiled;
  }

  private getCompiledPlain(
    merchantId: string | null,
    name: string,
    template: ReceiptTemplate,
  ): Handlebars.TemplateDelegate {
    const key = `${this.cacheKey(merchantId, name)}::plain`;
    let compiled = this.templateCache.get(key);
    if (!compiled) {
      compiled = this.compile(template.plainBody ?? "");
      this.templateCache.set(key, compiled);
    }
    return compiled;
  }

  private resolveBranding(opts: {
    templateBranding?: ReceiptBranding;
    businessName?: string | null;
    merchantDisplayName?: string | null;
    logoUrl?: string | null;
    primaryColor?: string | null;
  }): ReceiptBranding {
    const templateBranding = opts.templateBranding ?? {};
    return {
      businessName:
        opts.businessName ??
        opts.merchantDisplayName ??
        templateBranding.businessName ??
        process.env.ORG_NAME ??
        "Mobile Money",
      logoUrl: opts.logoUrl ?? templateBranding.logoUrl ?? null,
      primaryColor:
        opts.primaryColor ?? templateBranding.primaryColor ?? "#0f172a",
      accentColor: templateBranding.accentColor ?? "#3498db",
      footerText:
        templateBranding.footerText ??
        process.env.ORG_DESCRIPTION ??
        "Thank you for using our service!",
      address: templateBranding.address ?? process.env.ORG_ADDRESS ?? null,
      phoneNumber: templateBranding.phoneNumber ?? null,
      website: templateBranding.website ?? process.env.ORG_URL ?? null,
    };
  }

  private buildViewModel(
    input: RenderReceiptInput,
    branding: ReceiptBranding,
  ): ReceiptViewModel {
    const t = input.transaction;
    const amount = parseNumber(t.amount);
    const fee = parseNumber(t.fee);
    const total = t.total != null ? parseNumber(t.total) : amount + fee;
    const currency = t.currency ?? "XAF";

    return {
      ...buildReceiptView(input, branding),
      branding: {
        raw: branding,
        logo: branding.logoUrl ?? null,
        logoUrl: branding.logoUrl ?? null,
        name: branding.businessName ?? branding.businessName ?? "",
        businessName: branding.businessName ?? "",
        primaryColor: branding.primaryColor ?? "#0f172a",
        accentColor: branding.accentColor ?? "#3498db",
        footerText: branding.footerText ?? "",
        address: branding.address ?? null,
        phoneNumber: branding.phoneNumber ?? null,
        website: branding.website ?? null,
      },
      transaction: {
        id: t.id,
        referenceNumber: t.referenceNumber,
        type: t.type,
        status: humanize(t.status),
        amount: formatAmount(amount, currency),
        amountRaw: amount,
        fee: formatAmount(fee, currency),
        feeRaw: fee,
        total: formatAmount(total, currency),
        totalRaw: total,
        currency,
        provider: t.provider,
        phoneNumber: t.phoneNumber,
        sender: maskIfNeeded(t.phoneNumber),
        receiver: maskIfNeeded(t.stellarAddress),
        stellarAddress: maskIfNeeded(t.stellarAddress),
        transactionHash: t.transactionHash,
        createdAt: t.createdAt,
        createdDate: formatPrettyDate(t.createdAt),
        createdAtFormatted: formatPrettyDate(t.createdAt),
      },
      receipt: {
        number: t.referenceNumber,
        referenceNumber: t.referenceNumber,
        id: t.id,
        date: formatPrettyDate(t.createdAt),
      },
      amount,
      currency,
      provider: t.provider,
      status: humanize(t.status),
      referenceNumber: t.referenceNumber,
      transactionHash: t.transactionHash,
      createdDate: formatPrettyDate(t.createdAt),
      year: new Date().getFullYear(),
      locale: input.locale ?? "en",
    };
  }

  private renderBuiltInHtml(
    viewModel: ReceiptViewModel,
    branding: ReceiptBranding,
  ): string {
    const headerStyle = {
      background: branding.primaryColor || "#0f172a",
      color: isLightColor(branding.primaryColor || "#0f172a") ? "#0f172a" : "#ffffff",
    };
    const logo = branding.logoUrl
      ? `<img src="${escapeAttr(branding.logoUrl)}" alt="${escapeAttr(branding.businessName || "logo")}" style="max-height:60px;max-width:200px;margin-bottom:12px;display:block;" />`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f7fb;font-family:Arial,sans-serif;color:#0f172a;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #dbe4f0;border-radius:12px;overflow:hidden;">
      <div style="padding:24px;background:${headerStyle.background};color:${headerStyle.color};">
        ${logo}
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.8;">${escapeHtml(branding.businessName || "Transaction Receipt")}</p>
        <h1 style="margin:0;font-size:24px;">Transaction Receipt</h1>
        <p style="margin:8px 0 0;opacity:0.8;">${escapeHtml(viewModel.receipt.number)}</p>
        <p style="margin:4px 0 0;opacity:0.8;">${escapeHtml(viewModel.receipt.date)}</p>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#64748b;">Amount</td><td style="padding:8px 0;text-align:right;">${escapeHtml(viewModel.transaction.amount)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Fee</td><td style="padding:8px 0;text-align:right;">${escapeHtml(viewModel.transaction.fee)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Total</td><td style="padding:8px 0;text-align:right;">${escapeHtml(viewModel.transaction.total)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Provider</td><td style="padding:8px 0;text-align:right;">${escapeHtml(viewModel.transaction.provider)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Status</td><td style="padding:8px 0;text-align:right;">${escapeHtml(viewModel.transaction.status)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">From</td><td style="padding:8px 0;text-align:right;">${escapeHtml(viewModel.transaction.sender)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">To</td><td style="padding:8px 0;text-align:right;">${escapeHtml(viewModel.transaction.receiver)}</td></tr>
          <tr><td style="padding:8px 0;color:#64748b;">Transaction ID</td><td style="padding:8px 0;text-align:right;">${escapeHtml(viewModel.transaction.id)}</td></tr>
          ${
            viewModel.receipt.referenceNumber
              ? `<tr><td style="padding:8px 0;color:#64748b;">Reference No</td><td style="padding:8px 0;text-align:right;">${escapeHtml(viewModel.receipt.referenceNumber)}</td></tr>`
              : ""
          }
          ${
            viewModel.transaction.transactionHash
              ? `<tr><td style="padding:8px 0;color:#64748b;">Stellar Hash</td><td style="padding:8px 0;text-align:right;">${escapeHtml(viewModel.transaction.transactionHash)}</td></tr>`
              : ""
          }
        </table>
        <p style="margin:20px 0 0;color:#64748b;font-size:13px;">${escapeHtml(branding.footerText || "Thank you for using our service!")}</p>
      </div>
    </div>
  </body>
</html>`;
  }
}

function buildReceiptView(
  input: RenderReceiptInput,
  branding: ReceiptBranding,
) {
  return { branding };
}

function parseNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function formatAmount(value: number, currency: string): string {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 7,
  }).format(value)} ${currency}`;
}

function formatPrettyDate(value: unknown): string {
  if (!value) return "";
  const date = new Date(value as any);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function humanize(value: unknown): string {
  if (!value) return "";
  return String(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function maskIfNeeded(value?: string | null): string {
  if (!value) return "N/A";
  if (value.includes("@")) return maskEmail(value);
  if (value.startsWith("+") || /^\d{7,}$/.test(value.replace(/\s/g, "")))
    return maskPhoneNumber(value);
  if (value.length > 30) return maskStellarAddress(value);
  return value;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function isLightColor(hex: string): boolean {
  const match = hex.replace("#", "");
  if (match.length !== 6) return false;
  const r = parseInt(match.slice(0, 2), 16);
  const g = parseInt(match.slice(2, 4), 16);
  const b = parseInt(match.slice(4, 6), 16);
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 186;
}

export const receiptTemplateService = new ReceiptTemplateService();
