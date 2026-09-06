# 0001: The RxDB replication driver is its own package

- Status: accepted
- Date: 2026-09-05
- Driving work: the extraction of the WAS replication driver for RxDB from the
  two apps that each held a copy of it, on the design approved 2026-09-05. This
  record is the package's own half of that placement; the consuming wallet
  recorded its half at the same approval.
- Affects: `@interop/was-sync` (this package), `@interop/was-react` (its
  `src/sync/` deleted, its storage modules reduced to bindings, its root barrel
  narrowed), the Freewallet browser wallet (`src/lib/sync/` deleted, its sync
  controller reduced to a session binding), `@interop/was-client` (a peer of
  this package), `@interop/wallet-core` (unchanged, and stated here as
  unchanged), byoe-ecosystem's dependency layer map.

## Context

The WAS replication driver for RxDB existed twice. One copy lived in the
Freewallet browser wallet under `src/lib/sync/`; a more developed one lived in
`@interop/was-react` under `src/sync/`. They were forked from one origin and had
drifted: the was-react copy grew four modules the wallet's lacked, the two push
handlers differed by hundreds of lines, and was-react carried a last-write-wins
rule that disagreed with `@interop/social-core`'s on a pair where only one
`updatedAt` parses.

Neither consumer may depend on the other. The wallet is an application; was-react
is an app framework carrying React, MUI, and Zustand peers. So there is no
canonical copy for the other to import, and no amount of upstreaming produces
one.

A second constraint is packaging, and it points both ways. was-react re-exported
the whole driver from its root barrel and declared `rxdb` as a non-optional peer,
so an app that only reads shared collections still installed RxDB. The wallet has
the mirror-image constraint: its auth store imports the sync controller
statically, so the controller must not drag `rxdb` into the eager bundle chunk.

## Decision

The driver lives in `@interop/was-sync`, built from the was-react copy with the
wallet's behavioral deltas ported in before the move. Both apps consume it and
neither keeps a copy.

The package has three entries, and the split is part of the contract:

- The root entry is free of RxDB, in its module graph AND in its emitted
  declarations. It carries the shared types, the synced-document schema, the
  conflict-handler seam, the last-write-wins stamp accessor, and the writer-id
  mint. The schema and the handler declare structural types of their own for
  exactly this reason.
- `./rxdb` carries the replication wiring and the controller core. A consumer
  that must keep RxDB out of an eager chunk imports it dynamically; a
  replica-less consumer never resolves it at all.
- `./testing` carries the in-memory server fake, the stub port, and the memory
  schedule and online source the controller tests need. Each consumer keeps a
  lint restriction holding it out of production globs.

`rxdb` and `@interop/was-client` are peer dependencies; `rxdb` is marked
optional, since only `./rxdb` needs it. was-client is a peer rather than a
dependency so the consumer's single range decides which copy resolves, which is
what keeps error classification (by `err.name`) meeting one copy in practice.

The package holds no key material and no logging opinion. The conflict handler
takes an injected resolver, the controller core takes an injected access port, a
timer, a reachability source, and a log port, and the collection set, the
ciphers, and the session gates stay app-side.

## Rejected Alternatives

- **A `./sync` subpath in was-react, with `rxdb` as an optional peer.** The
  declined fallback rather than a do-not-reopen rejection. It answers the
  packaging constraint at near-zero cost and is what this work falls back to if
  the package is declined. It cannot be the primary, because the wallet must not
  depend on was-react: under it the duplication stays and so does the
  last-write-wins divergence. It is also a complement rather than only an
  alternative -- the package's RxDB-free root takes the driver out of a
  replica-less app's module graph, but was-react's own root barrel still
  value-exports its RxDB-backed local store, so a replica-less install without
  `rxdb` needs a was-react entry-point split as well. Choosing this path later
  is a decision record of its own.
- **Put the driver in `@interop/wallet-core`.** It would put an `rxdb` peer on a
  wallet library a React Native wallet installs, and that wallet has no RxDB
  anywhere. wallet-core's sync subpath runs on React Native with zero internal
  imports; a peer dependency on a browser storage engine inverts that. Do not
  reopen.
- **Put the driver in `@interop/was-client`.** was-client's scope is transport
  and the wire contract, held free of crypto by an import-graph test, and the
  ecosystem map keeps replica policy out of it. This driver is replica policy:
  checkpoint rules, write routing, conflict handling, the benign-412 delete
  retry. wallet-core's own placement record rejected the same move for the
  change engine on the same ground. Do not reopen.
- **Upstream the deltas and import one canonical copy.** That shape works when
  one side may depend on the other. Here neither may, so short of a third
  package there is nothing to upstream to. Do not reopen, for the same
  structural reason as the two above.
- **Move the change engine (`@interop/wallet-core/sync`) in the same work.**
  Deferred rather than rejected outright. It reopens that engine's own placement
  record, whose one-consumer premise still holds, and it adds obligations this
  driver does not have (a React Native export condition actually exercised by a
  mobile bundler, no Node builtins, the contacts conflict resolver staying
  behind in wallet-core). The `./rxdb` split leaves the root entry free for it.
- **Unify the engine and this driver into one algorithm.** The loops are
  inverted: the engine drives its own store and applies a page transactionally,
  while RxDB drives this driver's handlers and owns the transaction. The shared
  part is the types and the wire rules, which they already share through
  was-client. Forcing one algorithm means either wrapping RxDB in a store
  interface, losing its conflict handler and checkpoint machinery, or
  reimplementing RxDB's replication protocol. The inversion is structural; the
  record for it lives with the engine.

## Consequences

- One driver, one set of behaviors. The benign-412 delete retry, JCS-canonical
  body equality, the server-managed creator DID, and `err.name` classification
  now hold for both consumers rather than for whichever copy had them.
- The merged replica schema is the union of the two copies, shipped at
  `version: 0` with no migration strategy. Every remembered browser in both apps
  needs one forget-and-log-in-again after the upgrade. That is the greenfield
  stance rather than an oversight, and the CHANGELOG entries say so.
- The RxDB-free root is a testable property rather than a convention: the
  built-output suite walks the emitted module and declaration graphs. Adding a
  bare `import type` from `rxdb` to a root-reachable module fails the build's
  own tests.
- was-client is a peer, so a consumer that forgets to install it gets an install
  warning rather than a silently duplicated copy. The single-copy property the
  `err.name` rule exists to survive is checked by the consumer's lockfile audit;
  the rule is what makes a missed audit non-fatal.
- Costs accepted: one more package to version and publish, a release train
  across five repos, and a lockfile audit after each step for one resolved copy
  each of this package, was-client, wallet-core, and `rxdb`. Two RxDB copies in
  one tree is the sharp case, because it breaks late and quietly -- the
  leader-election plugin is installed on one copy's prototypes and the failure
  surfaces only when a tab is hidden.
- No Parties-table row lands in the WAS spec for this package. It speaks no WAS
  HTTP itself: every request goes through was-client's sync port, so by the
  table's admission rule it is a downstream consumer like the wallets, and
  was-client stays the one named speaker of the `changes` profile. The
  encrypted-collections table's `@interop/was-react` row is confirmed rather
  than rewritten, since the document cipher stays there. byoe-ecosystem's layer
  map gains this package's node and its edges instead.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. The wallet retires its RxDB driver for the shared change engine. Then there
   is one replica algorithm left, and this package's contents belong wherever
   that algorithm lives.
2. was-react and the wallet stop being independent, so one may depend on the
   other. That removes the structural reason the package exists, and the
   declined fallback above becomes available on its merits.
3. The change engine moves out of wallet-core. The RxDB-free root entry was left
   free for it deliberately, and this package's name and layout are worth
   re-examining at that point rather than before.
