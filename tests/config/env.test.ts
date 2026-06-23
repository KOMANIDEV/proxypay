process.env.DATABASE_URL = "test_db";
process.env.STELLAR_ISSUER_SECRET = "test_secret";
process.env.PORT = "3001";

describe("environment test bootstrap", () => {
  it("sets required environment variables for tests", () => {
    expect(process.env.DATABASE_URL).toBe("test_db");
    expect(process.env.STELLAR_ISSUER_SECRET).toBe("test_secret");
    expect(process.env.PORT).toBe("3001");
  });
});
