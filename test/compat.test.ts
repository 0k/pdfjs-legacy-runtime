/**
 * The compatibility pin.
 *
 * Two independent layers protect it, and both are needed:
 *
 * - `package.json` declares `pdfjs-dist` as an EXACT dependency, so the
 *   copy this package imports is always 3.11.174. The first cases below
 *   check that the declaration stays exact.
 * - The syntax scan reads the INSTALLED BUNDLES. A version number is a
 *   label; the two constructs that actually break Android System
 *   WebView 91 are in the bytes, so the bytes are what get scanned.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/**
 * The one version known to load under Android System WebView 91.
 *
 * Not a floor and not a preference: v3.11.174's `legacy/` bundle
 * predates both ES2022 class static-init blocks and ES2024
 * `Promise.withResolvers()`. On device a v6 legacy worker fails with
 * `Setting up fake worker failed: Unexpected token '{'`.
 */
const REQUIRED_PDFJS_VERSION = "3.11.174";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("the pdfjs-dist pin", () => {
  it("is declared as an EXACT dependency, with no ^ or ~", () => {
    const spec = pkg.dependencies?.["pdfjs-dist"];
    expect(spec).toBeDefined();
    // A range here would let an install pick a WebView-91-incompatible
    // build that no desktop run can tell apart.
    expect(spec).not.toMatch(/^[\^~]/);
    expect(spec).toBe(REQUIRED_PDFJS_VERSION);
  });

  it("is declared nowhere else, so no second spec can disagree", () => {
    expect(pkg.peerDependencies?.["pdfjs-dist"]).toBeUndefined();
    expect(pkg.devDependencies?.["pdfjs-dist"]).toBeUndefined();
  });

  it("resolves to exactly that version on disk", () => {
    const installed = require("pdfjs-dist/package.json") as {
      version: string;
    };
    expect(installed.version).toBe(REQUIRED_PDFJS_VERSION);
  });
});

/**
 * The two constructs measured to break the device, scanned in the two
 * bundles this module actually loads — the legacy main-thread build and
 * the matching legacy worker. Scanning the default (non-legacy) build
 * would prove nothing, since nothing here imports it.
 */
describe("the shipped legacy bundles", () => {
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const bundles: ReadonlyArray<readonly [string, string]> = [
    ["legacy main-thread", "legacy/build/pdf.js"],
    ["legacy worker", "legacy/build/pdf.worker.min.js"],
  ];

  for (const [label, relative] of bundles) {
    it(`${label} contains no ES2022 \`static {\` class blocks`, () => {
      const src = readFileSync(join(root, relative), "utf8");
      expect(src).not.toMatch(/\bstatic\s*\{/);
    });

    it(`${label} does not use ES2024 \`Promise.withResolvers\``, () => {
      const src = readFileSync(join(root, relative), "utf8");
      expect(src).not.toContain("withResolvers");
    });
  }
});
