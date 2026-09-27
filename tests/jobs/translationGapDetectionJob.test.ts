import { providerErrorMapService } from "../../src/services/providerErrorMap";
import {
  buildTranslationGapReport,
  detectTranslationGaps,
  runTranslationGapDetectionJob,
} from "../../src/jobs/translationGapDetectionJob";

describe("Translation gap detection job (#641)", () => {
  beforeEach(() => {
    providerErrorMapService.clearTranslationGaps();
  });

  it("reports static gaps for every non-English locale", () => {
    const gaps = detectTranslationGaps();

    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((gap) => gap.locale !== "en")).toBe(true);
    expect(gaps.every((gap) => gap.fallbackLocale === "en")).toBe(true);
  });

  it("merges runtime gaps into the report", () => {
    providerErrorMapService.getLocalizedError("mtn", "4001", "sw");

    const report = buildTranslationGapReport();

    expect(report.runtimeGaps).toEqual([
      expect.objectContaining({ locale: "sw", code: "INVALID_CREDENTIALS" }),
    ]);
    expect(
      report.gaps.some(
        (gap) => gap.locale === "sw" && gap.code === "INVALID_CREDENTIALS",
      ),
    ).toBe(true);
  });

  it("does not report a gap for a locale that has the translation", () => {
    providerErrorMapService.getLocalizedError("mtn", "4001", "fr");

    const report = buildTranslationGapReport();
    const matching = report.gaps.filter(
      (gap) => gap.locale === "fr" && gap.code === "INVALID_CREDENTIALS",
    );

    expect(matching).toHaveLength(0);
    expect(report.runtimeGaps).toHaveLength(0);
  });

  it("runs the job and returns the report", async () => {
    const report = await runTranslationGapDetectionJob();

    expect(report.generatedAt).toBeTruthy();
    expect(Array.isArray(report.gaps)).toBe(true);
    expect(report.gaps.length).toBeGreaterThan(0);
  });
});
