#!/usr/bin/env node
/**
 * One-click deployment environment setup helper (Issue #418).
 *
 * Generates a ready-to-use `.env` file (or prints platform-specific variable
 * blocks) by reading `.env.example`, generating strong secrets for the secret
 * fields, and letting the user supply the platform-managed connection strings
 * (Postgres / Redis) afterwards.
 *
 * Usage:
 *   node scripts/deploy/setup-env.js                    # write ./.env
 *   node scripts/deploy/setup-env.js --print heroku     # print Heroku config block
 *   node scripts/deploy/setup-env.js --print cloudrun   # print Cloud Run block
 *   node scripts/deploy/setup-env.js --help
 *
 * Exit codes:
 *   0  success
 *   1  example file missing or not a file
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const EXAMPLE_PATH = path.join(ROOT, ".env.example");
const ENV_PATH = path.join(ROOT, ".env");

// Variables whose values are secrets and should be auto-generated when the
// example value matches the "replace/your/development" placeholder pattern.
// "KEY" covers *_API_KEY, *_ENCRYPTION_KEY, *_MASTER_KEY and similar.
const SECRET_HINTS = [
  "KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "ACCESS",
  "AUTH",
  "SID",
];

function isPlaceholder(value) {
  const v = (value || "").toLowerCase();
  if (!v) return false;
  return (
    v.startsWith("replace-") ||
    v.startsWith("your_") ||
    v.startsWith("dev-") ||
    v.includes("placeholder") ||
    v === "changeme" ||
    v === "secret"
  );
}

function isSecretField(key) {
  return SECRET_HINTS.some((hint) => key.toUpperCase().includes(hint));
}

function generateSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function parseExample(content) {
  const vars = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    vars.push({ key, value });
  }
  return vars;
}

function renderBlock(vars) {
  return vars.map(({ key, value }) => `${key}=${value}`).join("\n");
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      [
        "Proxypay deployment environment setup helper",
        "",
        "Usage:",
        "  node scripts/deploy/setup-env.js                     write ./.env",
        "  node scripts/deploy/setup-env.js --print heroku      print Heroku block",
        "  node scripts/deploy/setup-env.js --print cloudrun    print Cloud Run block",
        "  node scripts/deploy/setup-env.js --help",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }

  if (!fs.existsSync(EXAMPLE_PATH) || !fs.statSync(EXAMPLE_PATH).isFile()) {
    process.stderr.write(
      `[setup-env] expected ${path.relative(ROOT, EXAMPLE_PATH)} to exist\n`,
    );
    process.exit(1);
  }

  const content = fs.readFileSync(EXAMPLE_PATH, "utf8");
  const vars = parseExample(content)
    .map(({ key, value }) => {
      if (isSecretField(key) && isPlaceholder(value)) {
        return { key, value: generateSecret() };
      }
      return { key, value };
    })
    // Remove duplicate keys, keeping the last occurrence (matches last-wins
    // behaviour of dotenv for a single .env file).
    .reduce((acc, cur) => {
      const idx = acc.findIndex((v) => v.key === cur.key);
      if (idx !== -1) acc.splice(idx, 1);
      acc.push(cur);
      return acc;
    }, []);

  const printIdx = args.indexOf("--print");
  if (printIdx !== -1) {
    const platform = args[printIdx + 1];
    if (platform !== "heroku" && platform !== "cloudrun") {
      process.stderr.write(
        `[setup-env] unknown platform "${platform}". Use "heroku" or "cloudrun".\n`,
      );
      process.exit(1);
    }
    process.stdout.write(renderBlock(vars) + "\n");
    process.exit(0);
  }

  fs.writeFileSync(ENV_PATH, renderBlock(vars) + "\n", "utf8");
  process.stdout.write(
    [
      `[setup-env] wrote ${path.relative(ROOT, ENV_PATH)} with ${vars.length} variables`,
      `[setup-env] secrets were auto-generated for placeholder/secret fields`,
      `[setup-env] set DATABASE_URL, REDIS_URL and STELLAR_ISSUER_SECRET after provisioning`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

main();
