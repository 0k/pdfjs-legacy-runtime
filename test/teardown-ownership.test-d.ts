/**
 * ⚠ Teardown has exactly ONE owner, and this file is where that is
 * enforced.
 *
 * The rule cannot be tested at runtime: an omitted interface member is
 * erased, so there is nothing to assert about. It is a TYPE rule, and
 * the only thing that can fail on it is the compiler — which is why
 * this file is picked up by `tsc --noEmit` (via `npm run typecheck`,
 * itself part of `npm run check`) rather than by vitest.
 *
 * The rule: `PdfLoadingTask.destroy()` "aborts all network requests and
 * destroys the worker" (v3.11.174 `api.d.ts`). The real
 * `PDFDocumentProxy` ALSO exposes a `destroy` that terminates the same
 * worker. Two callable teardowns for one resource is two chances to
 * release it twice, or to believe it released when it did not — so
 * `PdfDocument` omits it and `doc.destroy()` becomes a compile error.
 */
import type { PdfDocument, PdfLoadingTask } from "../src/index.js";

/** True only when `T` has no member named `K`. */
type Lacks<T, K extends PropertyKey> = K extends keyof T ? false : true;

/** Compile-time assertion: instantiating with `false` is an error. */
function assertTrue<_T extends true>(): void {}

// ⚠ If someone adds `destroy()` to `PdfDocument`, THIS LINE fails to
// compile — which is the entire mechanism. Do not "fix" a failure here
// by relaxing the assertion; fix it by removing the member.
assertTrue<Lacks<PdfDocument, "destroy">>();

// The loading task is the owner, so it MUST keep `destroy`. Losing it
// would leave no way to release the worker at all — the opposite
// failure, and just as silent.
assertTrue<"destroy" extends keyof PdfLoadingTask ? true : false>();

// The document keeps exactly the two members consumers need to read it.
assertTrue<"numPages" extends keyof PdfDocument ? true : false>();
assertTrue<"getPage" extends keyof PdfDocument ? true : false>();
