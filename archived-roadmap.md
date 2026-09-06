# WAS Sync Roadmap -- archived (completed) items

Completed items from [ROADMAP.md](ROADMAP.md), moved here verbatim when they
ship so that item-number references (WS-N) in the active roadmap, commit
messages, and design docs keep resolving. Append-only: newest at the bottom; do
not rewrite or summarize items on the way in. Ids remain permanent and are never
reused. CHANGELOG.md stays the record of _what_ landed; this file preserves each
item's acceptance criteria and context.

---

### WS-11: Replace `FakeWasServer` with a live in-process was-teaching-server

- status: done
- done: 2026-09-05
- priority: high
- labels: testing, integration, fixtures
- touches:
  - was-sync (ARCHITECTURE.md: `./testing` entry description, invariant 15;
    AGENTS.md: Tests section and Project Overview's `FakeWasServer` note; README
    if it names the fixture)
  - was-react (no consumer of `@interop/was-sync/testing` found; confirm and
    waive)
  - freewallet (same)
- acceptance:
  - [x] `test/node/replication.integration.test.ts` runs against `createApp`
        from `was-teaching-server` (devDependency, registry version) listening
        on an ephemeral port, with a throwaway `FileSystemBackend` directory per
        suite, using the `beforeAll` / `listen` pattern was-react's
        `test/node/conditionalWrites.test.ts` already uses
  - [x] The port under test is the real `createWasSyncPort` from was-client
        against that server, on the default configuration, so the port-shape
        findings (WS-1, WS-2, WS-4, WS-7) are reproducible in this repo
  - [x] `FakeWasServer` is deleted from `src/testing.ts`; `stubSyncPort`,
        `memorySchedule`, and `memoryOnlineSource` stay (or move to `test/`) as
        decided during the change
  - [x] Invariant 15 in ARCHITECTURE.md is rewritten for what `./testing` still
        carries, or the subpath is removed if nothing consumer-facing remains
  - [x] Coverage the fake gave for free (feed paging, tombstones in the feed,
        412 on stale `If-Match`, `/meta` writes, server-assigned `createdBy`) is
        asserted against the live server, not lost
  - [x] `touches:` entries resolved

Context: `FakeWasServer` accepts every write and serves a plausible feed. It is
a second implementation of the WAS contract, maintained here, and it has already
diverged from the server in ways that hide bugs: it synthesizes a 412 for a
header-less DELETE (WS-3), never assigns `createdBy` (WS-6), and raises error
shapes the default was-client port does not (WS-1, WS-4). The review findings
WS-1 through WS-7 all involve behavior the fake gets wrong or does not model.
was-teaching-server exports an in-process `createApp` factory, supports the
`changes` query profile, conditional writes with 412 on resources and `/meta`,
tombstones in the feed, and `/meta` writes, and was-react's node tests already
run against it in-process. Running the integration suite on the live server
removes a fixture that would otherwise need to track the spec by hand.

discovered-from: the 2026-09-05 code review that produced WS-1 through WS-10.

### WS-1: Delete 404 on the default port wedges the push batch

- status: done
- done: 2026-09-05
- priority: high
- labels: push, correctness, was-client-port
- acceptance:
  - [x] A not-found error from `deleteContent` is treated as a benign
        already-gone outcome on both port configurations (default and
        `mapAuthErrors: true`), matched by `err.name` (invariant 5)
  - [x] A push test on the default port shape (plain `NotFoundError`, no
        `status`) shows the batch completing and the other rows landing
  - [x] The hazard note in `src/types.ts` (around line 349) is either removed or
        turned into a statement of what the driver guarantees

Context: The push handler treats every `deleteContent` rejection as fatal unless
it matches the conflict or auth predicates. was-client's port only swallows a
delete 404 when it is built with `mapAuthErrors: true`, and Freewallet builds
the default port. Deleting a row the server never held (a create whose push
never landed) or one another replica already deleted throws
`WasSyncNotFoundError`, the whole `Promise.all` rejects, and RxDB re-sends the
identical batch on every retry. The collection pins to `error` and every other
row in that batch never reaches the server. `src/pushWrites.ts:204` is the
rethrow; `src/types.ts:349-353` documents the hazard without enforcing it.

Outcome: `pushRow` reads was-client's not-found signal (`isSyncNotFoundError`,
by `err.name`) from either `deleteContent` call (the first delete and the
benign-412 retry) as the already-gone outcome, so both port configurations
complete the batch. One correction to the premise above: per the WAS spec an
authorized DELETE of an absent resource returns `204` (the teaching server
does), so a delete `404` on a conformant server is the masked authorization
refusal rather than the never-pushed row. The driver now swallows it on the
default port the same way was-client already does under `mapAuthErrors`, and
revoked access still surfaces on the next feed pull. The integration suite pins
the spec-conformant `204` path; the `404` shape is covered by the push unit
suite.
