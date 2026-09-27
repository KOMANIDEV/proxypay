import { KYCService } from "../../services/kyc";
import { Pool } from "pg";

// Mock axios so KYCService constructor doesn't error on missing API key,
// and so we can control HTTP responses.
jest.mock("axios", () => {
  const mockCreate = jest.fn().mockReturnValue({
    post: jest.fn(),
    get: jest.fn(),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  });
  return { default: { create: mockCreate }, create: mockCreate };
});

// Provide a minimal KYC_API_KEY so the constructor doesn't throw in test env
process.env.KYC_API_KEY = "test_key";
process.env.NODE_ENV = "test";

describe("KYCService — createApplicant deduplication", () => {
  let service: KYCService;
  let mockDb: jest.Mocked<Pool>;
  let mockApi: any;

  const existingApplicant = {
    id: "existing-applicant-id",
    first_name: "Alice",
    last_name: "Nkomo",
    dob: "1990-05-15",
    email: "alice@example.com",
    phone_number: "+237600000001",
    created_at: "2026-01-01T00:00:00Z",
    sandbox: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Build a mock Pool whose .query can be controlled per-test
    mockDb = {
      query: jest.fn(),
      connect: jest.fn(),
      end: jest.fn(),
    } as unknown as jest.Mocked<Pool>;

    service = new KYCService(mockDb);

    // Grab the axios instance created inside the constructor
    const axios = require("axios");
    mockApi = axios.create.mock.results[axios.create.mock.results.length - 1].value;
  });

  describe("createApplicant — duplicate detected", () => {
    it("returns the existing record without calling the external API", async () => {
      // findDuplicateApplicant query returns a matching row
      mockDb.query.mockResolvedValueOnce({
        rows: [{ applicant_data: existingApplicant }],
        rowCount: 1,
      } as any);

      const result = await service.createApplicant({
        first_name: "Alice",
        last_name: "Nkomo",
        dob: "1990-05-15",
      });

      expect(result).toEqual(existingApplicant);
      // The remote API must NOT have been called
      expect(mockApi.post).not.toHaveBeenCalled();
      // Only one DB query (the duplicate check)
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it("returns the existing record even when dob is undefined and duplicate exists", async () => {
      const existingNoDob = { ...existingApplicant, dob: undefined };

      // findDuplicateApplicant query returns a match (no dob filter)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ applicant_data: existingNoDob }],
        rowCount: 1,
      } as any);

      const result = await service.createApplicant({
        first_name: "Alice",
        last_name: "Nkomo",
        // no dob
      });

      expect(result).toEqual(existingNoDob);
      expect(mockApi.post).not.toHaveBeenCalled();
    });
  });

  describe("createApplicant — no duplicate", () => {
    it("calls the external API and stores the new applicant when no duplicate exists", async () => {
      const newApplicant = {
        id: "new-applicant-id",
        first_name: "Bob",
        last_name: "Kamara",
        dob: "1985-03-22",
        email: "bob@example.com",
        created_at: "2026-09-24T15:00:00Z",
        sandbox: false,
      };

      // findDuplicateApplicant: no match
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // storeApplicantReference INSERT: success
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      // API returns the new applicant
      mockApi.post.mockResolvedValueOnce({ data: newApplicant });

      const result = await service.createApplicant({
        first_name: "Bob",
        last_name: "Kamara",
        dob: "1985-03-22",
        email: "bob@example.com",
      });

      expect(result).toEqual(newApplicant);
      // The remote API was called once
      expect(mockApi.post).toHaveBeenCalledTimes(1);
      expect(mockApi.post).toHaveBeenCalledWith("/applicants", expect.objectContaining({
        first_name: "Bob",
        last_name: "Kamara",
      }));
      // DB called twice: duplicate check + store
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it("passes validation errors through for invalid input", async () => {
      await expect(
        service.createApplicant({
          first_name: "",   // fails min(1)
          last_name: "Smith",
        }),
      ).rejects.toThrow(/Invalid applicant data/);

      // No DB queries should have been made
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });

  describe("findDuplicateApplicant — DB failure is non-fatal", () => {
    it("falls through to API call when DB check throws", async () => {
      const newApplicant = {
        id: "fallback-applicant-id",
        first_name: "Carol",
        last_name: "Mensah",
        dob: "1992-07-10",
        created_at: "2026-09-24T15:00:00Z",
        sandbox: false,
      };

      // findDuplicateApplicant throws
      mockDb.query.mockRejectedValueOnce(new Error("DB connection error"));
      // storeApplicantReference INSERT: success
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      mockApi.post.mockResolvedValueOnce({ data: newApplicant });

      const result = await service.createApplicant({
        first_name: "Carol",
        last_name: "Mensah",
        dob: "1992-07-10",
      });

      expect(result).toEqual(newApplicant);
      expect(mockApi.post).toHaveBeenCalledTimes(1);
    });
  });
});
