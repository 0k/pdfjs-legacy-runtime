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

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A stand-in for the legacy PDF.js module, recording what it is given. */
function fakePdfjs(workerReady = Promise.resolve()) {
  const task = {
    promise: Promise.resolve({ numPages: 1, getPage: async () => null }),
    destroy: vi.fn(async (): Promise<void> => undefined),
  };
  const workers: { promise: Promise<void>; destroy: ReturnType<typeof vi.fn> }[] = [];
  return {
    task,
    workers,
    module: {
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: vi.fn((_params: Record<string, unknown>) => task),
      PDFWorker: vi.fn(function () {
        const worker = { promise: workerReady, destroy: vi.fn() };
        workers.push(worker);
        return worker;
      }),
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
    const task = runtime.getDocument({ url: "u" });
    expect(task.promise).toBe(pdfjs.task.promise);
    await task.destroy();
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
    const first = runtime.getDocument({
      url: "document.pdf",
      disableAutoFetch: true,
      disableStream: true,
    });
    // A caller smuggling the flag through an untyped object cannot win.
    const second = runtime.getDocument({ url: "x", isEvalSupported: true } as never);

    await first.destroy();
    await second.destroy();
    expect(pdfjs.workers).toHaveLength(2);
    expect(pdfjs.workers[0]).not.toBe(pdfjs.workers[1]);

    expect(pdfjs.module.getDocument.mock.calls).toEqual([
      [
        {
          url: "document.pdf",
          disableAutoFetch: true,
          disableStream: true,
          worker: pdfjs.workers[0],
          isEvalSupported: false,
        },
      ],
      [{ url: "x", worker: pdfjs.workers[1], isEvalSupported: false }],
    ]);
  });

  it("destroys the dedicated worker and rethrows the same synchronous getDocument error", async () => {
    const error = new Error("Invalid parameter object: need either .data, .range or .url");
    // Like PDF.js 3.11: destroying a starting worker rejects its promise
    // once the thread is stopped, with nobody else listening.
    const starting = deferred();
    const pdfjs = fakePdfjs(starting.promise);
    pdfjs.module.getDocument.mockImplementation(() => {
      throw error;
    });
    pdfjs.module.PDFWorker.mockImplementation(function () {
      const worker = {
        promise: starting.promise,
        destroy: vi.fn(() => starting.reject(new Error("Worker was destroyed"))),
      };
      pdfjs.workers.push(worker);
      return worker;
    });
    vi.doMock(LEGACY, () => pdfjs.module);
    const runtime = await loadPdfRuntime();

    let thrown: unknown;
    try {
      runtime.getDocument({ url: "" });
    } catch (reason) {
      thrown = reason;
    }

    expect(thrown).toBe(error);
    expect(pdfjs.workers).toHaveLength(1);
    expect(pdfjs.workers[0]?.destroy).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)(
    "keeps destroy pending until a starting worker's promise settles (%s)",
    async (settlement) => {
      const ready = deferred();
      const pdfjs = fakePdfjs(ready.promise);
      vi.doMock(LEGACY, () => pdfjs.module);
      const runtime = await loadPdfRuntime();
      const task = runtime.getDocument({ url: "document.pdf" });
      let settled = false;
      const destroying = task.destroy().then(() => {
        settled = true;
      });

      try {
        await vi.waitFor(() => expect(pdfjs.task.destroy).toHaveBeenCalledOnce());
        // Drain the transport continuation without relying on a wall-clock delay.
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(pdfjs.workers[0]?.destroy).toHaveBeenCalledOnce();
      } finally {
        // A readiness rejection is expected when PDF.js cancels startup.
        if (settlement === "reject" && pdfjs.workers.length) {
          ready.reject(new Error("Worker was destroyed"));
        } else {
          ready.resolve();
        }
        await destroying;
      }
      expect(settled).toBe(true);
    },
  );

  it("destroys an already-ready worker after transport teardown and before resolving", async () => {
    const transport = deferred();
    const pdfjs = fakePdfjs();
    pdfjs.task.destroy.mockImplementation(() => transport.promise);
    vi.doMock(LEGACY, () => pdfjs.module);
    const runtime = await loadPdfRuntime();
    const task = runtime.getDocument({ url: "document.pdf" });
    const destroying = task.destroy();
    try {
      expect(pdfjs.workers[0]?.destroy).not.toHaveBeenCalled();
    } finally {
      transport.resolve();
      await destroying;
    }
    expect(pdfjs.workers[0]?.destroy).toHaveBeenCalledOnce();
  });

  it("finishes worker teardown before rethrowing the original transport error", async () => {
    const ready = deferred();
    const error = new Error("transport teardown failed");
    const pdfjs = fakePdfjs(ready.promise);
    pdfjs.task.destroy.mockRejectedValue(error);
    vi.doMock(LEGACY, () => pdfjs.module);
    const runtime = await loadPdfRuntime();
    const task = runtime.getDocument({ url: "document.pdf" });
    let settled = false;
    const destroying = task.destroy().then(
      () => {
        settled = true;
        return undefined;
      },
      (reason: unknown) => {
        settled = true;
        return reason;
      },
    );
    try {
      await vi.waitFor(() => expect(pdfjs.task.destroy).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(pdfjs.workers[0]?.destroy).toHaveBeenCalledOnce();
    } finally {
      if (pdfjs.workers.length) ready.reject(new Error("Worker was destroyed"));
      else ready.resolve();
      expect(await destroying).toBe(error);
    }
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
