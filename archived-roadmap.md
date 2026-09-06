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
