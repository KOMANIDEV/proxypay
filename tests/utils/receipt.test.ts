import {
  generateReceipt,
  generateReceiptHtml,
  generateReceiptNumber,
  RECEIPT_PRINT_STYLES,
} from "../../src/utils/receipt";

describe("receipt utilities", () => {
  const baseTransaction = {
    id: "abc123-def456",
    amount: "10000",
    fee: "100",
    provider: "MTN Mobile Money",
    status: "completed",
    phoneNumber: "+237 6XX XXX XXX",
    stellarAddress: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    transactionHash: "7a8b9c123456",
    referenceNumber: "TXN-20260322-00001",
  };

  it("generates receipt numbers in the expected format", () => {
    const receiptNumber = generateReceiptNumber("2026-03-22T10:30:00Z");

    expect(receiptNumber).toMatch(/^RCP-20260322-\d{5}$/);
  });

  it("generates unique receipt numbers for the same day", () => {
    const first = generateReceiptNumber("2026-03-23T08:00:00Z");
    const second = generateReceiptNumber("2026-03-23T09:00:00Z");

    expect(first).not.toBe(second);
  });

  it("renders a readable plain-text receipt with transaction details", () => {
    const receipt = generateReceipt(baseTransaction, {
      generatedAt: "2026-03-24T10:30:00Z",
      receiptNumber: "RCP-20260324-00042",
    });

    expect(receipt).toContain("TRANSACTION RECEIPT");
    expect(receipt).toContain("Receipt No: RCP-20260324-00042");
    expect(receipt).toContain("Date: March 24, 2026");
    expect(receipt).toContain("- Amount: 10,000 XAF");
    expect(receipt).toContain("- Fee: 100 XAF");
    expect(receipt).toContain("- Total: 10,100 XAF");
    expect(receipt).toContain("- Provider: MTN Mobile Money");
    expect(receipt).toContain("- Status: Completed");
    expect(receipt).toContain("From: +237 6XX XXX XXX");
    expect(receipt).toContain("To: GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    expect(receipt).toContain("Transaction ID: abc123-def456");
    expect(receipt).toContain("Reference No: TXN-20260322-00001");
    expect(receipt).toContain("Stellar Hash: 7a8b9c123456");
  });

  it("omits the stellar hash section when no hash is available", () => {
    const receipt = generateReceipt(
      {
        ...baseTransaction,
        transactionHash: undefined,
      },
      {
        generatedAt: "2026-03-25T10:30:00Z",
        receiptNumber: "RCP-20260325-00001",
      },
    );

    expect(receipt).not.toContain("Stellar Hash:");
  });

  it("generates an HTML receipt for email delivery", () => {
    const html = generateReceiptHtml(
      {
        ...baseTransaction,
        provider: "MTN <strong>Mobile</strong> Money",
      },
      {
        generatedAt: "2026-03-26T10:30:00Z",
        receiptNumber: "RCP-20260326-00010",
      },
    );

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("RCP-20260326-00010");
    expect(html).toContain("10,100 XAF");
    expect(html).toContain("GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    expect(html).toContain("MTN &lt;strong&gt;Mobile&lt;/strong&gt; Money");
  });

  it("renders HTML receipt with business branding (logo, name, color)", () => {
    const html = generateReceiptHtml(baseTransaction, {
      generatedAt: "2026-03-27T10:30:00Z",
      receiptNumber: "RCP-20260327-00001",
      branding: {
        businessName: "Acme Coffee",
        logoUrl: "https://example.com/acme-logo.png",
        primaryColor: "#123456",
        footerText: "Thanks for your business!",
      },
    });

    expect(html).toContain("Acme Coffee");
    expect(html).toContain("https://example.com/acme-logo.png");
    expect(html).toContain("#123456");
    expect(html).toContain("Thanks for your business!");
  });

  it("embeds an inline print stylesheet so receipts print cleanly", () => {
    const html = generateReceiptHtml(baseTransaction, {
      generatedAt: "2026-03-28T10:30:00Z",
      receiptNumber: "RCP-20260328-00001",
    });

    expect(html).toContain("<style>");
    expect(html).toContain("@media print");
    expect(html).toContain("@page");
    expect(html).toContain("size: A4 portrait");
    expect(html).toContain("receipt-wrapper");
    expect(html).toContain('class="receipt-header"');
    expect(html).toContain('class="receipt-table"');
    expect(html).toContain('class="receipt-footer"');
    expect(html).toContain("<title>Mobile Money — Transaction Receipt</title>");
  });

  it("uses black text on a white background for print legibility", () => {
    expect(RECEIPT_PRINT_STYLES).toContain("color: #000000");
    expect(RECEIPT_PRINT_STYLES).toContain("background: #ffffff !important");
    expect(RECEIPT_PRINT_STYLES).toContain("border-collapse: collapse !important");
  });
});
