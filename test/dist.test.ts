/**
 * The published `dist/index.js` keeps the two expressions the
 * application's bundler must see verbatim: the dynamic import of the
 * legacy build, and the worker's `new URL(…, import.meta.url)`. A
 * compiler or bundler step that rewrote either would freeze the worker
 * URL against this package's layout instead of the application's chunk.
 *
 * Runs against the output of `npm run build`.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIST = new URL("../dist/index.js", import.meta.url);

describe("the built dist/index.js", () => {
  it("exists (run `npm run build` first)", () => {
    expect(existsSync(DIST)).toBe(true);
  });

  const src = existsSync(DIST) ? readFileSync(DIST, "utf8") : "";

  it("imports the legacy build dynamically, unbundled", () => {
    expect(src).toMatch(/import\(\s*"pdfjs-dist\/legacy\/build\/pdf\.js"\s*\)/);
  });

  it("resolves the worker with new URL(…, import.meta.url), unrewritten", () => {
    expect(src).toMatch(
      /new URL\(\s*"pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.js",\s*import\.meta\.url,?\s*\)/,
    );
  });

  it("forces isEvalSupported to false after the caller's options", () => {
    expect(src).toMatch(/\.\.\.params,\s*isEvalSupported:\s*false/);
  });
});
