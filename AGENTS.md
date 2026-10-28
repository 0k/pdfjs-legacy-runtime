# @0k/pdfjs-legacy-runtime

One PDF.js compatibility policy for every consumer (see `README.org`).

## Rules

- `pdfjs-dist` stays an EXACT dependency on `3.11.174`.  Never widen it
  to a range: `test/compat.test.ts` guards both the exact declaration and
  the installed bundles' syntax.
- `getDocument` always passes `isEvalSupported: false` after the caller's
  options (CVE-2024-4367, unfixable under the pin).  Never remove it or
  let a caller override it.
- `dist/` is plain `tsc` output.  It must keep the dynamic
  `import("pdfjs-dist/legacy/build/pdf.js")` and
  `new URL("pdfjs-dist/legacy/build/pdf.worker.min.js", import.meta.url)`
  verbatim, so the application's bundler resolves the worker against its
  own chunk (`test/dist.test.ts`).  Never add a bundling step that
  rewrites them.
- Verify with `npm run check` (typecheck, build, tests).

## Delivery

Published to npm as `@0k/pdfjs-legacy-runtime` with `pkg`, from a git
tag: the `version` in `package.json` is `%%version%%`, substituted at
release time.  To try an unreleased change in a consumer, link this
checkout there with an uncommitted local override (`npm link`), and
run `npm run build` after each change since consumers import `dist/`; never
bump the version for that, and never commit a `file:` dependency or a
vendored tarball into a consumer.
