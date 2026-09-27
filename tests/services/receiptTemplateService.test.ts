import { ReceiptTemplateService } from "../../src/services/receiptTemplateService";
import { ReceiptTemplateModel } from "../../src/models/receiptTemplate";

function mockModel(overrides: Partial<ReceiptTemplateModel> = {}): ReceiptTemplateModel {
  const model = new ReceiptTemplateModel();
  Object.assign(model, {
    findActive: jest.fn(),
    findLatest: jest.fn(),
    saveRevision: jest.fn(),
    listVersions: jest.fn(),
    listByMerchant: jest.fn(),
    activate: jest.fn(),
    findById: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  });
  return model;
}

function buildTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "tx-123",
    referenceNumber: "TXN-20260829-00001",
    type: "deposit",
    amount: "10000",
    fee: "100",
    provider: "mtn",
    status: "completed",
    phoneNumber: "+237670000000",
    stellarAddress: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    transactionHash: "7a8b9c123456",
    userId: "user-1",
    createdAt: new Date("2026-08-29T10:30:00Z"),
    updatedAt: new Date("2026-08-29T10:30:00Z"),
    ...overrides,
  } as any;
}

describe("ReceiptTemplateService (Handlebars rendering)", () => {
  let service: ReceiptTemplateService;
  let model: ReceiptTemplateModel;

  beforeEach(() => {
    model = mockModel();
    service = new ReceiptTemplateService(model);
  });

  describe("built-in fallback rendering", () => {
    it("renders a receipt with branding when no custom template is active", async () => {
      (model.findActive as jest.Mock).mockResolvedValue(null);

      const result = await service.renderReceipt({
        transaction: buildTransaction(),
        businessName: "Acme Coffee",
        logoUrl: "https://example.com/logo.png",
        primaryColor: "#123456",
      });

      expect(result.renderingEngine).toBe("built-in");
      expect(result.html).toContain("Transaction Receipt");
      expect(result.html).toContain("Acme Coffee");
      expect(result.html).toContain("https://example.com/logo.png");
      expect(result.html).toContain("#123456");
      expect(result.html).toContain("10,100 XAF");
      expect(result.plain).toContain("Acme Coffee");
      expect(result.plain).toContain("TRANSACTION RECEIPT");
    });

    it("renders the default fallback with no branding", async () => {
      (model.findActive as jest.Mock).mockResolvedValue(null);

      const result = await service.renderReceipt({
        transaction: buildTransaction(),
      });

      expect(result.renderingEngine).toBe("built-in");
      expect(result.html).toContain("Mobile Money");
    });
  });

  describe("custom Handlebars template rendering", () => {
    const customActive = {
      id: "tpl-1",
      merchantId: "m1",
      name: "standard-receipt",
      version: 2,
      htmlBody: `
        <div style="background:{{{branding.primaryColor}}}">
          <img src="{{branding.logoUrl}}" />
          <h1>{{branding.businessName}}</h1>
          <p>{{transaction.referenceNumber}}</p>
          <p>{{transaction.total}}</p>
          <p>{{receipt.date}}</p>
        </div>
      `,
      plainBody: "Receipt {{transaction.referenceNumber}} for {{branding.businessName}}",
      branding: {
        businessName: "Stored Business",
        logoUrl: "https://example.com/stored-logo.png",
        primaryColor: "#0f172a",
      },
      isActive: true,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any;

    it("renders using the active Handlebars template with branding", async () => {
      (model.findActive as jest.Mock).mockResolvedValue(customActive);

      const result = await service.renderReceipt({
        transaction: buildTransaction(),
        merchantId: "m1",
      });

      expect(result.renderingEngine).toBe("handlebars");
      expect(result.version).toBe(2);
      expect(result.html).toContain("background:#0f172a");
      expect(result.html).toContain("https://example.com/stored-logo.png");
      expect(result.html).toContain("Stored Business");
      expect(result.html).toContain("TXN-20260829-00001");
      expect(result.html).toContain("10,100 XAF");
    });

    it("renders plain text body when provided", async () => {
      (model.findActive as jest.Mock).mockResolvedValue(customActive);

      const result = await service.renderReceipt({
        transaction: buildTransaction(),
        merchantId: "m1",
      });

      expect(result.plain).toContain("Receipt TXN-20260829-00001 for Stored Business");
    });

    it("overrides stored branding with per-call branding", async () => {
      (model.findActive as jest.Mock).mockResolvedValue(customActive);

      const result = await service.renderReceipt({
        transaction: buildTransaction(),
        merchantId: "m1",
        businessName: "Override Brand",
        logoUrl: "https://example.com/override.png",
      });

      expect(result.html).toContain("Override Brand");
      expect(result.html).toContain("https://example.com/override.png");
    });

    it("escapes HTML inserted via Handlebars variables", async () => {
      (model.findActive as jest.Mock).mockResolvedValue({
        ...customActive,
        htmlBody: `<p>{{transaction.referenceNumber}}</p>`,
      });

      const result = await service.renderReceipt({
        transaction: buildTransaction({ referenceNumber: "<script>alert(1)</script>" }),
        merchantId: "m1",
      });

      expect(result.html).not.toContain("<script>alert(1)</script>");
      expect(result.html).toContain("&lt;script&gt;");
    });
  });

  describe("template management", () => {
    it("delegates save to the model with default template name", async () => {
      (model.findLatest as jest.Mock).mockResolvedValue(null);
      (model.saveRevision as jest.Mock).mockResolvedValue({ version: 1 } as any);

      const result = await service.saveTemplate({
        htmlBody: "<p>hi</p>",
        branding: { businessName: "X" },
      });

      expect(model.saveRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "standard-receipt",
          htmlBody: "<p>hi</p>",
          isActive: true,
        }),
      );
      expect(result.version).toBe(1);
    });

    it("activates a specific version", async () => {
      const v1 = { id: "v1", version: 1 } as any;
      const v2 = { id: "v2", version: 2 } as any;
      (model.listVersions as jest.Mock).mockResolvedValue([v2, v1]);
      (model.activate as jest.Mock).mockResolvedValue(v2);

      const activated = await service.activateTemplate("m1", "standard-receipt", 2);

      expect(model.activate).toHaveBeenCalledWith("v2");
      expect(activated).toBe(v2);
    });

    it("returns null when activating a non-existent version", async () => {
      (model.listVersions as jest.Mock).mockResolvedValue([{ id: "v1", version: 1 } as any]);

      const activated = await service.activateTemplate("m1", "standard-receipt", 99);

      expect(activated).toBeNull();
      expect(model.activate).not.toHaveBeenCalled();
    });

    it("lists templates and versions through the model", async () => {
      (model.listByMerchant as jest.Mock).mockResolvedValue([1, 2]);
      (model.listVersions as jest.Mock).mockResolvedValue([3, 4]);

      await expect(service.listTemplates("m1")).resolves.toEqual([1, 2]);
      await expect(service.listTemplateVersions("m1", "standard-receipt")).resolves.toEqual([3, 4]);
    });
  });
});
