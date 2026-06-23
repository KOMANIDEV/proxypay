const baseConfig = require("./jest.config");

module.exports = {
  ...baseConfig,
  testMatch: [
    "<rootDir>/tests/services/retry.test.ts",
    "<rootDir>/tests/services/fraud.test.ts",
  ],
};
