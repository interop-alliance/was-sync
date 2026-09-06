/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The logging seam: the library port of the sibling logging package
 * (decision 0004 in its repo). This module deliberately declares its own
 * `Logger` type rather than importing it (even as a type-only import) from
 * that package, so the published artifact -- the emitted `dist/log.d.ts`
 * included -- carries no reference to its specifier; the
 * mutual-assignability check against the package's own `Logger` type lives
 * in `test/node/log.test.ts` instead. Call sites elsewhere in `src/` still
 * take it as a type-only import where useful (enforced by the eslint
 * `no-restricted-imports` rule); this one file is the stated exception.
 *
 * A consumer that never calls {@link setLogger} keeps a console fallback:
 * same channel and level as a bare `console.*` call, but with a
 * `'[was-sync]'` prefix and the call's `data` passed as a single trailing
 * argument (present only when supplied). An app wires a real logger once at
 * bootstrap, e.g. `setLogger(createLogger('sync'))`. The whole package emits
 * under that one namespace; the four-method port carries no namespace of its
 * own, so the area a line comes from (controller, conflict, push, pull) is
 * read off its message.
 */

/**
 * The structural logging port every call site in this package logs
 * through. Frozen at four two-arg methods (decision 0004 in the sibling
 * logging package's repo): a static message plus optional structured
 * context, with `data.err` reserved for an Error-ish value.
 */
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

const consoleFallback: Logger = {
  debug: (msg, data) =>
    console.debug('[was-sync]', msg, ...(data === undefined ? [] : [data])),
  info: (msg, data) =>
    console.info('[was-sync]', msg, ...(data === undefined ? [] : [data])),
  warn: (msg, data) =>
    console.warn('[was-sync]', msg, ...(data === undefined ? [] : [data])),
  error: (msg, data) =>
    console.error('[was-sync]', msg, ...(data === undefined ? [] : [data]))
}

let logger: Logger = consoleFallback

/**
 * Installs `next` as the logger every call site in this package logs
 * through, and returns the PREVIOUS logger -- so a test (or an app
 * reconfiguring at runtime) can restore it.
 *
 * @param next {Logger}
 * @returns {Logger} the logger that was installed before this call.
 */
export function setLogger(next: Logger): Logger {
  const previous = logger
  logger = next
  return previous
}

/**
 * The package-wide logger. Each method forwards to whichever logger is
 * currently installed, so call sites bound at import time still observe a
 * later {@link setLogger}.
 */
export const log: Logger = {
  debug: (msg, data) => logger.debug(msg, data),
  info: (msg, data) => logger.info(msg, data),
  warn: (msg, data) => logger.warn(msg, data),
  error: (msg, data) => logger.error(msg, data)
}
