/**
 * Narrow, lazily-loaded boundary over `pdfjs-dist` (PDF.js).
 *
 * This module is a **compatibility policy**, not a utility. It states,
 * in one place, five rules that every consuming application would
 * otherwise have to write out and keep true separately:
 *
 * 1. the exact `pdfjs-dist` version, and why it may not float;
 * 2. that the `legacy/` build is loaded, not the default one;
 * 3. that the worker is resolved as a build-emitted asset URL;
 * 4. that a REJECTED load is not memoised, so a retry can succeed;
 * 5. that teardown has exactly ONE owner.
 *
 * It also forces one security setting, see below.
 *
 * ## ⚠ Version pin: EXACTLY 3.11.174, and the `legacy/` build
 *
 * Measured on the SM-N910C, which ships Android System WebView 91. Its
 * V8 cannot parse two constructs that later PDF.js emits *even in its
 * legacy bundle* — ES2022 class static-init blocks (`static { … }`) and
 * ES2024 `Promise.withResolvers()`. On device a v6 legacy worker fails
 * with `Setting up fake worker failed: Unexpected token '{'`.
 * v3.11.174's legacy bundle predates both constructs.
 *
 * The pin is an EXACT `dependency` of this package, so the copy this
 * module imports is always 3.11.174 whatever else the application
 * installs. A range would reintroduce a device-only failure that no
 * desktop run can see — and a silent one, because the reader is shown a
 * blank rectangle where the document should be. `test/compat.test.ts`
 * guards the declaration and scans the installed bundles for both
 * constructs.
 *
 * ## ⚠ `isEvalSupported` is forced to `false` (CVE-2024-4367)
 *
 * PDF.js up to 4.1.392 lets a crafted font in a PDF run arbitrary
 * JavaScript in the page's origin when `isEvalSupported` is `true`, its
 * default (GHSA-wgrm-67xf-hhpq). The pin above rules out the upgrade
 * that fixes it, so {@link PdfRuntime.getDocument} always passes
 * `isEvalSupported: false`, after the caller's options, so no caller can
 * turn it back on. The cost is that PDF.js interprets glyph outlines
 * instead of compiling them to functions: slower font rendering, same
 * output.
 *
 * ## ⚠ Nothing here is imported until a reader opens a document
 *
 * The library plus its worker is ~2 MB. Everything PDF.js-related
 * therefore sits behind the async {@link loadPdfRuntime}, which
 * dynamically `import()`s once and memoises the result.
 */

/** Rendering viewport: pixel dimensions at a chosen scale. */
export interface PdfViewport {
  readonly width: number;
  readonly height: number;
}

/** Parameters accepted by {@link PdfPage.render}. */
export interface PdfRenderParams {
  readonly canvasContext: CanvasRenderingContext2D;
  readonly viewport: PdfViewport;
  /**
   * Additional transform (device-pixel-ratio scale) applied before the
   * viewport transform. `[dpr,0,0,dpr,0,0]` renders at HiDPI while the
   * CSS box stays at the logical viewport size.
   */
  readonly transform?: number[] | null;
}

/** In-flight render; can be cancelled before its promise settles. */
export interface PdfRenderTask {
  readonly promise: Promise<void>;
  cancel(): void;
}

/** A single page proxy: measure a viewport, render it, release it. */
export interface PdfPage {
  getViewport(params: { scale: number }): PdfViewport;
  render(params: PdfRenderParams): PdfRenderTask;
  /** Release page resources held by the worker. */
  cleanup(): void;
}

/**
 * A loaded document: page count + page access.
 *
 * ⚠ **`destroy()` is deliberately ABSENT, and that absence is the
 * contract.** Teardown of network / transport / worker is owned SOLELY
 * by the {@link PdfLoadingTask} wrapper, whose `destroy()` stops the
 * dedicated worker as well as the underlying loading task. The real v3
 * `PDFDocumentProxy.destroy()` only delegates to that underlying task,
 * which skips a supplied worker: document-level teardown would leave
 * our dedicated worker running.
 *
 * Omitting it here makes `doc.destroy()` a COMPILE ERROR rather than a
 * second, incomplete path. Destroy the loading task instead.
 */
export interface PdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

/**
 * A loading task: awaitable to a document, abortable mid-flight.
 *
 * `destroy()` aborts all network requests and destroys the worker — it
 * is the SOLE owner of document/transport cleanup. Holding the task
 * for the lifetime of the document is therefore not bookkeeping: it is
 * how a consumer retains the ability to release the worker at all.
 * It settles only once the worker thread has stopped, even when destroyed
 * during startup. A worker script that never loads nor errors keeps it pending.
 */
export interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

/**
 * The subset of PDF.js `DocumentInitParameters` a consumer may set.
 *
 * For large files, pass `disableAutoFetch: true` AND
 * `disableStream: true` with a `url` whose server honours `Range`
 * requests: PDF.js then fetches the cross-reference table and the pages
 * being shown instead of the whole body. Per the installed `api.d.ts`,
 * `disableAutoFetch` defaults to `false`, and disabling prefetch only
 * works correctly when `disableStream` is also `true`. Leave
 * `disableRange` unset (false) so pages still arrive in chunks.
 */
export interface PdfGetDocumentParams {
  readonly url: string;
  readonly disableAutoFetch?: boolean;
  readonly disableStream?: boolean;
  readonly disableRange?: boolean;
}

/** The minimal PDF.js surface consumers depend on. */
export interface PdfRuntime {
  /**
   * Start loading a document. The caller's options are forwarded with
   * `isEvalSupported: false` added (see the module documentation).
   * Invalid URLs reject the returned task's `promise` with PDF.js's error
   * message without throwing synchronously or starting a worker. Other
   * synchronous PDF.js errors also reject the task; worker teardown starts
   * immediately, and `destroy()` waits for the thread to stop.
   */
  getDocument(params: PdfGetDocumentParams): PdfLoadingTask;
}

/**
 * Memoised runtime promise. The first {@link loadPdfRuntime} call kicks
 * off the dynamic import + worker wiring; every later call reuses it.
 *
 * ⚠ A REJECTED load is NOT cached. Memoising a failure makes a
 * transient one — a chunk that did not arrive, a worker that lost a
 * race at startup — permanent for the life of the page, so a reader
 * who retries is told "no" by a cache rather than by the network.
 */
let runtimePromise: Promise<PdfRuntime> | null = null;

/**
 * Lazily import PDF.js, wire its worker, and return the narrow runtime.
 *
 * ⚠ The worker is resolved as a build-emitted asset URL via
 * `new URL('pdfjs-dist/…/pdf.worker.min.js', import.meta.url)`. The
 * application's bundler rewrites that expression when it builds this
 * module: it emits the worker as its own asset and makes the URL
 * relative to the application's built chunk, so the worker loads
 * whether the application is served at `/` or under any sub-path behind
 * a reverse proxy. A root-absolute string path would 404 under a
 * sub-path. The published `dist/index.js` keeps the expression verbatim
 * (`test/dist.test.ts`), so it is the application's bundler that
 * resolves it.
 */
export function loadPdfRuntime(): Promise<PdfRuntime> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    // The LEGACY build. In pdfjs-dist 3.11.174 it is a UMD bundle
    // (`module.exports = pdfjsLib`, no ESM default) whose
    // `legacy/build/pdf.d.ts` re-exports the root package's
    // `types/src/pdf.d.ts` — so `getDocument`, `PDFWorker` and
    // `GlobalWorkerOptions` arrive as TYPED NAMED exports on the import namespace,
    // both at type-check time and (via the bundler's CJS interop that
    // lifts `module.exports` properties to named exports) at runtime.
    const { getDocument, PDFWorker, GlobalWorkerOptions } = await import(
      "pdfjs-dist/legacy/build/pdf.js"
    );
    // `.min.js` keeps the shipped worker small; it comes from the SAME
    // legacy build, so it is API-compatible with the module above.
    const workerUrl = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.js",
      import.meta.url,
    ).toString();
    GlobalWorkerOptions.workerSrc = workerUrl;
    return {
      getDocument: (params: PdfGetDocumentParams): PdfLoadingTask => {
        try {
          // Mirror 3.11.174's URL-only parameter checks before starting a worker.
          if (!params.url) {
            throw new Error("Invalid parameter object: need either .data, .range or .url");
          }
          // In Node PDF.js takes any non-empty string as a path, even with a
          // test DOM's `window`: use its own Node test (pdf.js `isNodeJS`).
          const isNodeJS = typeof process === "object" && process + "" === "[object process]"
            && !process.versions.nw
            && !(process.versions.electron && (process as { type?: string }).type
              && (process as { type?: string }).type !== "browser");
          if (!isNodeJS) {
            try {
              new URL(params.url, window.location.href);
            } catch {
              throw new Error("Invalid PDF url data: either string or URL-object is expected in the url property.");
            }
          }
        } catch (error) {
          const promise = Promise.reject<PdfDocument>(error);
          void promise.catch(() => undefined);
          return { promise, destroy: () => Promise.resolve() };
        }
        // Supplying a worker leaves task._worker unset: this wrapper is
        // its sole owner. A caller cannot replace it or re-enable eval.
        const worker = new PDFWorker({});
        let task: ReturnType<typeof getDocument>;
        try {
          task = getDocument({ ...params, worker, isEvalSupported: false });
        } catch (error) {
          // Safety net for other synchronous PDF.js failures after validation.
          // Stop ASAP; PDF.js stops a starting thread on its first reply.
          worker.destroy();
          const stopped = worker.promise.catch(() => undefined);
          const promise = Promise.reject<PdfDocument>(error);
          // Mark it handled without changing the rejection callers receive.
          void promise.catch(() => undefined);
          return { promise, destroy: () => stopped };
        }
        return {
          promise: task.promise,
          async destroy() {
            try {
              await task.destroy();
            } finally {
              // Release the worker even if transport teardown rejects;
              // the original rejection propagates after this finally.
              worker.destroy();
              // In 3.11, destroy during startup only marks the worker.
              // Its first reply/error terminates the thread, THEN rejects
              // this promise. A ready worker was terminated synchronously.
              await worker.promise.catch(() => undefined);
            }
          },
        };
      },
    };
  })().catch((err) => {
    // Don't memoise a failure — allow a later retry to re-import.
    runtimePromise = null;
    throw err;
  });
  return runtimePromise;
}

/**
 * Test seam: force a specific runtime (or clear the memo with `null`).
 *
 * For the unit tests of applications using this package: they inject a
 * fake PDF.js without a real dynamic import. Production code never
 * calls it; {@link loadPdfRuntime} owns the memo.
 *
 * Accepts either a resolved runtime OR a `Promise<PdfRuntime>`, so a
 * test can inject a DEFERRED import (a promise it resolves later) to
 * exercise the window where a consumer is awaiting the import and is
 * torn down mid-flight. `Promise.resolve` flattens an already-promise,
 * so the same pending promise is reused rather than double-wrapped.
 */
export function __setPdfRuntimeForTest(
  runtime: PdfRuntime | Promise<PdfRuntime> | null,
): void {
  runtimePromise = runtime ? Promise.resolve(runtime) : null;
}
