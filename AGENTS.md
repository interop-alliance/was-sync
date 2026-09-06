# Agent Guidelines

## Project Overview

`@interop/was-sync` is the WAS replication driver for RxDB: the changes-feed
pull handler, the conditional-write push handler with its conflict assembler and
benign-412 delete retry, the conflict-handler seam, the synced-document schema,
the writer-id mint, and the session controller core. It was extracted from the
two copies that had drifted apart in `@interop/was-react` (`src/sync/`) and in
the Freewallet browser wallet (`src/lib/sync/`), neither of which may depend on
the other. The placement is recorded in
[decisions/0001](decisions/0001-rxdb-replication-driver-package.md) and the
current shape in [ARCHITECTURE.md](ARCHITECTURE.md) -- read both before making
changes.

Three entries, and the split is a contract rather than a convenience. The root
entry is free of `rxdb` in its module graph AND in its emitted declarations, so
an app that never builds a replica resolves it with `rxdb` absent; `./rxdb`
carries everything that needs the peer; `./testing` carries the fixtures. A
change that puts an `rxdb` import (a type import included) anywhere the root
entry reaches breaks the contract, and `test/packaging/` is what catches it.

What does NOT belong here: WAS HTTP, the sync port, the wire vocabulary, the
error classes, and the four `err.name` predicates (`@interop/was-client`, its
`/sync` subpath); the last-write-wins comparison rule (`@interop/social-core`);
ciphers, key epochs, and any other key handling (`@interop/was-client/edv` and
each consuming app); the session gates, the status store, and the platform
wiring (each app's binding); and the replica-less change engine
(`@interop/wallet-core/sync`), which is this driver's sibling rather than its
other half.

The `./testing` subpath (`src/testing.ts`) is test fixtures only; never import
it from production code (an eslint rule enforces that inside `src/`, and each
consumer keeps the same restriction). The stub port refuses every call and the
memory ports never fire on their own, so a production import would leave a
replica that never syncs. There is no fake WAS server: the integration suite
runs against a live in-process `was-teaching-server` (a devDependency from the
registry), so the server's real conditional-write, tombstone, and feed behavior
is what the driver is tested against. A fake would be a second implementation of
the WAS contract maintained here, and the one this package started with had
already drifted from the server in ways that hid bugs.

## Toolchain & Project Layout

### Package Manager

Use `pnpm` (not `npm` or `yarn`). The lockfile is `pnpm-lock.yaml`. Install deps
with `pnpm install`; run scripts with `pnpm run <script>` or `pnpm <script>`.

### Build

The library is built with `tsc` (not `vite build`). `vite.config.ts` exists only
to configure Vitest and to run `vite dev` as a server for Playwright. Running
`pnpm run build` compiles `src/` to `dist/` via `tsconfig.json`.

### Two tsconfigs

- `tsconfig.json` — library build only; includes `src/**/*`
- `tsconfig.dev.json` — extends the above with `noEmit: true`; adds `test/**/*`,
  `vite.config.ts`, and `playwright.config.ts` so ESLint's type-aware rules
  cover all files

Do not add test files to `tsconfig.json` — they would be emitted into `dist/`.

### Tests

- `test/node/` — Vitest unit tests (`pnpm run test:node`); run in Node, with no
  DOM anywhere. The push, pull, conflict, and feed-read suites drive fake ports;
  the integration suite drives a real RxDB memory-storage collection against a
  live in-process `was-teaching-server`, over the real `createWasSyncPort` from
  `@interop/was-client` on its default configuration, with one plaintext
  collection provisioned per test; the controller suite mocks
  `wasReplication.js`, so it exercises the lifecycle without opening a database.
- `test/packaging/` — the packaging suite (`pnpm run test:packaging`, which
  builds first and runs under `vitest.packaging.config.ts`). It walks the
  emitted module and declaration graphs to hold the root entry free of `rxdb`
  (ARCHITECTURE.md invariant 14). It is not part of `test:node`, because it
  asserts over `dist/`.
- `test/browser/` — Playwright smoke test (`pnpm run test:browser`); loads the
  ROOT entry in real Chromium via a Vite dev server (`pnpm run dev`), which is
  the entry a consumer must be able to load with `rxdb` absent.

The `dev` script exists solely to give Playwright a server that can serve and
transform TypeScript source files on the fly. There is no browser app.

### ESM & import paths

The package is ESM-only (`"type": "module"`). Local imports must use the `.js`
extension even though source files are `.ts` — e.g.
`import { syncedDocSchema } from '../../src/index.js'`. TypeScript's
`moduleResolution: Bundler` resolves these to the `.ts` source at compile time.

## Architecture

The current shape of the library lives in [ARCHITECTURE.md](./ARCHITECTURE.md),
rationale inline, updated in the same change set that alters the shape. It is
load-bearing for the conventions below: the design gate scopes on the invariants
it documents, `touches:` entries name it as a deliverable, and the
breaking-release audit checks it against the code.

### Domain language

ARCHITECTURE.md's Glossary is the repo's vocabulary. Use its terms as written in
code identifiers, test names, docs, commit messages, and conversation, and treat
the `Avoid:` synonyms as banned.

Refine the glossary as you work, in the same change set that settles a term.
When a term in the conversation conflicts with the glossary, say so before using
it. When a term is vague or overloaded, propose one canonical term and record
it. When a new module or concept needs a name the glossary lacks, add the entry.
A new term that becomes a wire artifact (a field name, a log entry kind, an
error name) is a wire-level convention and still needs core-contributor sign-off
before it is coded; the glossary entry is written after that sign-off, not
instead of it.

Skills and agent instructions written for other conventions refer to a
`CONTEXT.md` or `CONTEXT-MAP.md` glossary and a `docs/adr/` directory. In this
ecosystem those map to ARCHITECTURE.md's Glossary section and the repo's
`decisions/` directory. Do not create `CONTEXT.md`, `CONTEXT-MAP.md`, or
`docs/adr/`. The context map is the ecosystem itself: each repo's "What lives
elsewhere" and "Ownership heuristics" sections state the relationships between
repos.

## Roadmap & Task Conventions

All roadmap tracking lives in [ROADMAP.md](./ROADMAP.md): narrative context plus
structured work items. Never create a parallel task list elsewhere (no
`TODO.md`, no task lists in other docs).

Each work item follows this schema:

- A heading `### WS-N: Title`, then a field block, then free prose context.
- The prose opens with a `Context:` paragraph: a few plain-language sentences
  stating what is wrong today, how it came about, and why it matters, readable
  on its own without following any file pointer. The detailed mechanics
  (file:line cites, stage orders, edge cases) follow in ordinary prose after it.
  Acceptance boxes record exit criteria, not motivation, so the Context
  paragraph is where a returning reader or an agent picks up the problem; on a
  design-gated item it also seeds the design doc's Problem-and-scope section.
  Items predating the convention (added 2026-08-25) are backfilled when next
  touched, not in bulk.
- Fields: `status` (`todo` / `in-progress` / `draft` / `done`), `priority`
  (`high` / `medium` / `low`), `labels` (comma-separated), optional `blocked-by`
  (other `WS-N` ids), a `touches:` list where the rule below applies,
  `design:` + `design-approved:` where the design gate below applies, and an
  `acceptance:` checklist.
- `draft` marks items with no actionable done-state yet (blocked externally or
  parking records); a draft states _why_ instead of acceptance criteria and must
  gain acceptance criteria when promoted to `todo`.
- `touches:` is required for any item that changes a spec, a wire contract, or a
  shared `@interop/*` API. It lists every affected repo AND that repo's
  ARCHITECTURE/AGENTS files -- the docs are entries in their own right, not an
  afterthought, since doc drift is what the field exists to prevent. Each entry
  starts unresolved and is resolved in place: marked shipped (naming what
  landed) or explicitly waived as `unaffected: <repo> (<why>)`.

Rules:

- Item ids are permanent and never reused. A new item takes the next unused
  number, regardless of which section it lands in.
- Every non-draft item needs acceptance criteria before it may be moved to
  `in-progress`.
- Statuses are edited in place (change the `status:` field); acceptance
  checkboxes are ticked as they are met.
- An item carrying a `touches:` field may not flip to `done` while any entry in
  it is unresolved -- an unresolved entry is unfinished work of the item itself,
  not a follow-up.
- Completed items move **verbatim** (number, title, field block, prose, with
  their `done` date) from ROADMAP.md to
  [archived-roadmap.md](./archived-roadmap.md) once shipped, append-only -- this
  keeps WS-N references resolvable. CHANGELOG.md remains the permanent record of
  what landed. Do not rewrite or summarize items on the way in, and do not fix
  old references.
- Work discovered mid-implementation gets its own item immediately, noting
  `discovered-from: WS-N` in its prose, plus a `blocked-by` link if it blocks
  anything.
- **The design gate**: a cross-cutting item (one that changes persistence
  semantics, key custody, a ceremony's stage order, or any invariant the repo's
  ARCHITECTURE.md documents) carries `design:` (a doc per
  [designs/TEMPLATE.md](./designs/TEMPLATE.md)) and `design-approved:` (a date
  only core contributors set), and no implementation starts until the doc is
  approved. Approval extracts the design's durable decisions -- contract-binding
  ones, and do-not-reopen rejections of an approach -- into tracked `decisions/`
  records. The full definition is canonical in isomorphic-lib-template's
  `designs/` directory; the local copy lives in [designs/](./designs/).
- Reference item ids in commit messages and PR descriptions where relevant.

## Decision Records

Cross-repo decisions -- the ones whose driving roadmap item carries a `touches:`
field -- get a durable record in the owning repo's `decisions/` directory
(`decisions/NNNN-slug.md`). The convention and template are canonical in
isomorphic-lib-template's `decisions/` directory, copied here as
[decisions/](./decisions/): required sections Context / Decision / Consequences
/ Revisit Criteria, Rejected Alternatives where applicable, records superseded
in place rather than rewritten. A pre-implementation design review may
additionally mint a record for a repo-internal do-not-reopen decision (an
approach rejected with concrete revisit criteria); other repo-internal decisions
stay in ARCHITECTURE.md prose and do not get a record. The full scope rule lives
in the decisions/ README. Within either case, a record is written only when the
decision passes the qualifying test in that README (hard to reverse, surprising
without context, a real trade-off); a skill's offer to "write an ADR" is a
proposal for such a record, pending that test and core-contributor approval, and
uses `decisions/TEMPLATE.md`.

## Releasing

The `@interop/*` publish convention is canonical in isomorphic-lib-template's
AGENTS.md ("Releasing"), restated here for the parts this package exercises:

- The version published is the one the CHANGELOG's top entry names; its `TBD`
  date is replaced with the release date at publish time.
- **Breaking-release doc-vs-code audit.** Before publishing a version whose
  CHANGELOG carries a breaking entry, audit the ARCHITECTURE/AGENTS files of the
  consumers named in the affected contract's "Parties to this contract" registry
  (the AGENTS.md tables in app-connect-spec, encrypted-collections-spec, and the
  WAS spec repo), and file roadmap items for what the audit finds. The cheap
  mechanism, as run 2026-08-11: parallel read-only agents, one per consumer
  repo, each checking that repo's ARCHITECTURE/AGENTS statements against its own
  code and the new contract -- a recipe, not an aspiration. A consumer with
  nothing affected is recorded as `unaffected: <repo> (<why>)` on the driving
  roadmap item.
- A breaking profile change also bumps the profile's version handle where the
  contract states one (e.g. the App Connect context URL) and the CHANGELOG names
  the profile version the package now speaks.

## Conventions

Code style, refactoring, JSDoc, comment, and error-handling conventions live in
@CONTRIBUTING.md -- follow them. That file's marked conventions block is the
canonical shared core copied across `@interop/*` repos; edit it in
isomorphic-lib-template, not here.

Two conventions this package leans on hardest, both ARCHITECTURE.md invariants:
cross-package errors are matched by `err.name` and never with `instanceof`
(invariant 5), and no `rxdb` import of any kind -- a type import included -- may
appear anywhere the root entry reaches (invariant 14).

## Ecosystem conventions

- Cross-repo lessons (invariants, gotchas, and process recipes that span repos)
  live in the ecosystem learnings file,
  [byoe-ecosystem/LEARNINGS.md](https://github.com/interop-alliance/byoe-ecosystem/blob/main/LEARNINGS.md)
  (usually checked out beside this repo as `../byoe-ecosystem`); read it at the
  start of any cross-repo task, and write a lesson produced by a task here into
  it in the same working session.
- The consumers to walk for a contract change are the "Parties to this contract"
  tables in the spec repos' AGENTS.md files. This package holds no row of its
  own there (see ARCHITECTURE.md, "Parties to the specs"); its consumers do.

## Reference material (read-only, outside this repo)

Separate repositories. Use them to ground changes against the actual source
rather than memory; check with the user before editing anything in them.

- [was-client](https://github.com/interop-alliance/was-client) -- the WAS HTTP
  client, the sync port this driver runs on, the wire vocabulary, the error
  classes, and the four `err.name` predicates.
- [was-react](https://github.com/interop-alliance/was-react) and the Freewallet
  browser wallet -- the two consumers, and the two copies this package was
  merged from.
- [wallet-core](https://github.com/interop-alliance/wallet-core) -- the
  replica-less change engine (`/sync`) and the contacts head-conflict resolver a
  wallet injects here.
- [wallet-attached-storage-spec](https://github.com/w3c-ccg/wallet-attached-storage-spec)
  -- the `changes` query profile, conditional writes, and tombstones this driver
  replicates over.
