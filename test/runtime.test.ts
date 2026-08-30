/**
 * The behavioural half of the policy, made executable.
 *
 * Two kinds of test live here:
 *
 * - "the real loader" runs `loadPdfRuntime()` itself, with the PDF.js
 *   import replaced by a vitest module mock: memoisation, retry after a
 *   rejected import, worker wiring and the forced `isEvalSupported`.
 * - the `__setPdfRuntimeForTest` cases check the seam applications use
 *   in their own tests.
 *
 * The type-level rule (teardown has one owner) cannot be asserted at
 * runtime, because an omitted member is erased. It is checked by
 * `test/teardown-ownership.test-d.ts` instead, which fails
 * `tsc --noEmit` if `PdfDocument` ever grows a `destroy`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setPdfRuntimeForTest,
  loadPdfRuntime,
  type PdfLoadingTask,
  type PdfRuntime,
} from "../src/index.js";

function fakeRuntime(): PdfRuntime {
  return {
    getDocument: () =>
      ({
        promise: Promise.resolve({ numPages: 1, getPage: async () => null }),
        destroy: async () => undefined,
      }) as unknown as PdfLoadingTask,
  };
}

afterEach(() => {
  __setPdfRuntimeForTest(null);
  vi.restoreAllMocks();
});

const LEGACY = "pdfjs-dist/legacy/build/pdf.js";

/** A stand-in for the legacy PDF.js module, recording what it is given. */
function fakePdfjs() {
  const task = {
    promise: Promise.resolve({ numPages: 1, getPage: async () => null }),
    destroy: async () => undefined,
  };
  return {
    task,
    module: {
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: vi.fn((_params: Record<string, unknown>) => task),
    },
  };
}

describe("the real loader", () => {
  afterEach(() => {
    vi.doUnmock(LEGACY);
    vi.resetModules();
  });

  it("imports PDF.js once and returns the SAME promise across calls", async () => {
    const pdfjs = fakePdfjs();
    vi.doMock(LEGACY, () => pdfjs.module);

    const a = loadPdfRuntime();
    const b = loadPdfRuntime();

    expect(a).toBe(b);
    await a;
  });

  it("⚠ does NOT memoise a REJECTED import, so a retry can still succeed", async () => {
    // The defect this guards: with the failure cached, a reader whose
    // first open lost a chunk is told "no" by a cache rather than by
    // the network, for as long as the page lives.
    vi.doMock(LEGACY, () => {
      throw new Error("chunk did not arrive");
    });
    // vitest wraps a throwing factory in its own error: any rejection
    // stands for the failed import here.
    await expect(loadPdfRuntime()).rejects.toBeInstanceOf(Error);

    vi.doUnmock(LEGACY);
    vi.resetModules();
    const pdfjs = fakePdfjs();
    vi.doMock(LEGACY, () => pdfjs.module);

    const runtime = await loadPdfRuntime();
    expect(runtime.getDocument({ url: "u" })).toBe(pdfjs.task);
    // ...and the successful load IS memoised.
    expect(loadPdfRuntime()).toBe(loadPdfRuntime());
  });

  it("points the worker at the legacy build's minified worker", async () => {
    const pdfjs = fakePdfjs();
    vi.doMock(LEGACY, () => pdfjs.module);

    await loadPdfRuntime();

    expect(pdfjs.module.GlobalWorkerOptions.workerSrc).toMatch(
      /\/pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.js$/,
    );
  });

  it("⚠ forwards the caller's options with isEvalSupported forced to false", async () => {
    // CVE-2024-4367: with eval enabled, a crafted font runs script in the
    // page's origin. The pinned 3.11.174 cannot be upgraded past it.
    const pdfjs = fakePdfjs();
    vi.doMock(LEGACY, () => pdfjs.module);

    const runtime = await loadPdfRuntime();
    runtime.getDocument({
      url: "document.pdf",
      disableAutoFetch: true,
      disableStream: true,
    });
    // A caller smuggling the flag through an untyped object cannot win.
    runtime.getDocument({ url: "x", isEvalSupported: true } as never);

    expect(pdfjs.module.getDocument.mock.calls).toEqual([
      [
        {
          url: "document.pdf",
          disableAutoFetch: true,
          disableStream: true,
          isEvalSupported: false,
        },
      ],
      [{ url: "x", isEvalSupported: false }],
    ]);
  });
});

describe("the __setPdfRuntimeForTest seam", () => {
  it("accepts a DEFERRED runtime, so teardown-mid-import is testable", async () => {
    // Lets an application test tearing a widget down while the dynamic
    // import is still in flight, which is unreachable if the seam only
    // accepts an already-resolved runtime.
    let release!: (runtime: PdfRuntime) => void;
    const pending = new Promise<PdfRuntime>((resolve) => {
      release = resolve;
    });
    __setPdfRuntimeForTest(pending);

    const inFlight = loadPdfRuntime();
    let settled = false;
    void inFlight.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const runtime = fakeRuntime();
    release(runtime);
    expect(await inFlight).toBe(runtime);
  });

  it("reuses a supplied promise rather than double-wrapping it", async () => {
    const runtime = fakeRuntime();
    __setPdfRuntimeForTest(Promise.resolve(runtime));
    expect(await loadPdfRuntime()).toBe(runtime);
  });

  it("clears the memo when passed null, so tests do not leak into each other", async () => {
    const first = fakeRuntime();
    __setPdfRuntimeForTest(first);
    expect(await loadPdfRuntime()).toBe(first);

    __setPdfRuntimeForTest(null);

    const second = fakeRuntime();
    __setPdfRuntimeForTest(second);
    expect(await loadPdfRuntime()).toBe(second);
  });
});
