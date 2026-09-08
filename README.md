# WAS Replication Driver for RxDB _(@interop/was-sync)_

[![Node.js CI](https://github.com/interop-alliance/was-sync/workflows/CI/badge.svg)](https://github.com/interop-alliance/was-sync/actions?query=workflow%3A%22CI%22)
[![NPM Version](https://img.shields.io/npm/v/@interop/was-sync.svg)](https://npm.im/@interop/was-sync)

> The WAS replication driver for RxDB: the changes-feed pull handler, the
> conditional-write push handler with its conflict assembler, the
> conflict-handler seam, the synced-document schema, the writer-id mint, and the
> session controller core. For the browser, Node.js, and React Native.

## Table of Contents

- [Background](#background)
- [Security](#security)
- [Install](#install)
- [Usage](#usage)
- [Contribute](#contribute)
- [License](#license)

## Background

A WAS Collection is replicated into a local RxDB replica by pulling the
`changes` feed and pushing conditional writes back. This library owns that
driver: mapping the feed's wire documents into replica documents and applying
the checkpoint rule, routing each local change to the content endpoint, the
metadata endpoint, or a delete, assembling the conflict entry RxDB asks for when
a conditional write is refused with `412`, recovering the one benign `412` (a
delete refused on a drifted revision whose body is unchanged), writing each
accepted write's acked revision back into the local row, and running one
replication per collection for a session behind a serialized start and stop.

It was extracted from the two copies that had drifted apart in
`@interop/was-react` and in the Freewallet browser wallet, neither of which may
depend on the other. The placement is recorded in
[decisions/0001](decisions/0001-rxdb-replication-driver-package.md) and the
current shape in [ARCHITECTURE.md](ARCHITECTURE.md).

What deliberately lives elsewhere: the WAS HTTP client, the sync port, the wire
vocabulary, the error classes, and the `err.name` predicates that classify them
(`@interop/was-client`, its `/sync` subpath); the last-write-wins comparison
rule itself (`@interop/social-core`); document ciphers, key epochs, and every
other kind of key handling (`@interop/was-client/edv` and each consuming app);
and the change engine a replica-less wallet drives instead of RxDB
(`@interop/wallet-core/sync`).

### Three entries

- `@interop/was-sync` -- the types, the synced-document schema, the
  conflict-handler seam and its last-write-wins default, and the writer-id mint.
  Free of RxDB in its module graph AND in its emitted declarations, so an app
  that never builds a replica resolves it with `rxdb` absent.
- `@interop/was-sync/rxdb` -- the pull and push handlers, the
  `replicateRxCollection` wiring, the opt-in feed-backed conflict re-read, and
  the controller core. `rxdb` is this subpath's peer dependency (declared
  optional, since only this subpath needs it).
- `@interop/was-sync/testing` -- test fixtures. It loads without `rxdb` too.

`@interop/was-client` is a peer dependency rather than a dependency, so the
consumer's single range decides which copy resolves. The package constructs none
of its error classes and matches every one of them by `err.name`.

The `react-native` export condition is carried on all three subpaths, but it is
forward-looking: there is no React Native consumer of this driver today, and
RxDB's own React Native story is not exercised here. The writer-id mint takes an
injected storage port rather than reaching for `localStorage`, which is part of
what keeps the root entry loadable there.

## Security

The driver moves stored bodies verbatim and holds no key material. `data` is the
stored content body (plaintext JSON, or an EDV envelope on an encrypted
collection) and `custom` is the stored metadata body; encrypting and decrypting
stay above this layer. The one place a decision cannot be body-opaque is a
mutable-head conflict, whose sides have to be compared: that decision is
injected as a closure, so no cipher, key, or descriptor reaches this package. On
an encrypted collection that closure should be a refreshing cipher's decrypt
(`createRefreshingEdvDocCipher` from `@interop/was-client/edv`), which carries
the once-per-session unknown-epoch re-read; the driver runs no refresh itself.

The writer id is an unkeyed, clearable, unrecoverable attribution label, never
an identity: it derives from no secret, and it can vanish and be re-minted with
nothing carried over.

Test fixtures ship on the `@interop/was-sync/testing` subpath: a stub sync port
and memory implementations of the controller's timer and reachability ports.
They are for tests only. Keep the subpath out of production import globs (an
eslint `no-restricted-imports` pattern is what each consumer uses). There is no
fake WAS server; the integration suite runs against a live in-process
`was-teaching-server`.

## Install

- Node.js 24+ is recommended.

### PNPM

To install via PNPM:

```
pnpm install @interop/was-sync
```

An app that builds a local replica also installs the `rxdb` peer:

```
pnpm install rxdb
```

### Development

To install locally (for development):

```
git clone https://github.com/interop-alliance/was-sync.git
cd was-sync
pnpm install
```

## Usage

The schema and the conflict handler are collection-creation options:

```ts
import { makeLwwConflictHandler, syncedDocSchema } from '@interop/was-sync'

await database.addCollections({
  contacts: {
    schema: syncedDocSchema(),
    // Mutable-head collections need a rule; a content-addressed collection
    // takes RxDB's default handler instead.
    conflictHandler: makeLwwConflictHandler(envelope =>
      cipher.decrypt(envelope)
    )
  }
})
```

A whole session's replication runs behind the controller core:

```ts
import { createSyncController } from '@interop/was-sync/rxdb'

const controller = createSyncController({
  port: {
    wasClient,
    spaceId,
    serverUrl,
    collections: [{ key: 'contacts', id: 'contacts' }],
    rxCollection: key => database.collections[key]
  },
  onStatus: (key, collectionId, status) => setStatus(collectionId, status),
  onlineSource: {
    isOnline: () => navigator.onLine,
    subscribe: onOnline => {
      window.addEventListener('online', onOnline)
      return () => window.removeEventListener('online', onOnline)
    }
  },
  pollMs: 30_000
})

await controller.start()
// ... and on logout. `stop()` is terminal for an instance: a session that
// replicates again constructs a fresh controller.
await controller.stop()
```

`pollMs` is required rather than defaulted, because two consumers poll at
different rates and a package default would silently change one app's background
request rate.

### Logging

The package logs through a structural `Logger` port (four two-arg methods:
`debug`, `info`, `warn`, `error`, each taking a static message and an optional
`data` object, with `data.err` reserved for an Error). An app that never wires
one gets a console fallback prefixed `[was-sync]`. To route the package's events
into the app's own sinks, install a logger once at bootstrap:

```ts
import { createLogger } from '@interop/logger'
import { setLogger } from '@interop/was-sync'

setLogger(createLogger('sync'))
```

`setLogger` returns the previously installed logger, so a test can restore it in
`afterEach`. `@interop/logger` is not a dependency of this package; any object
with the four methods works.

## Contribute

PRs accepted. See [CONTRIBUTING.md](CONTRIBUTING.md) for editor setup (Prettier,
ESLint, and EditorConfig) and how it maps to CI.

If editing the Readme, please conform to the
[standard-readme](https://github.com/RichardLitt/standard-readme) specification.

## License

[MIT License](LICENSE.md) © 2026 Interop Alliance.
