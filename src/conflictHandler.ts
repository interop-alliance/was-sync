/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The RxDB conflict-handler seam for a mutable-head collection, and the
 * last-write-wins resolver that is its default.
 *
 * RxDB's own handler always drops the local fork and keeps the remote state,
 * which is correct for a content-addressed (immutable-per-id) collection but
 * wrong for a mutable head that two clients can edit concurrently. Settling
 * such a conflict needs a rule, and the rule is the consuming app's: a wallet
 * delegates the whole decision to its own contacts comparator, while an app
 * framework compares decrypted last-write-wins stamps. So this module owns the
 * RxDB-facing SHAPE ({@link makeConflictHandler}) and injects the decision.
 *
 * The handler holds no key material. A mutable-head conflict cannot be
 * body-opaque -- the conflicting bodies are opaque envelopes, so whatever
 * decides has to decrypt both sides -- and the decision is exactly what the
 * caller supplies, so no cipher, key, or descriptor reaches this module. The
 * default resolver takes a `decrypt` closure and never a key.
 *
 * The unknown-epoch refresh rule reaches this module the same way. An epoch
 * rotation emits no change-feed entry, so a conflict side can be sealed under
 * an epoch the caller's cipher has never seen; the once-per-session re-read
 * and retry that mends it is `@interop/was-client/edv`'s
 * (`createRefreshingEdvDocCipher`, whose decrypt is the closure a consumer
 * hands in). This module runs no refresh of its own: an `undecryptable` side
 * is whatever the closure could not open after its own policy ran, and the
 * warning names which of was-client's two no-key classes it was
 * (`isUnknownEpochError` / `isKeyUnwrapError`, matched by `err.name`), so a
 * reader can tell a spent refresh from a key this reader was never given.
 *
 * `isEqual` stays cheap and synchronous, as RxDB requires: a structural compare
 * of the opaque bodies plus the server revisions.
 */
import { remotePayloadWins } from '@interop/social-core'
import { isKeyUnwrapError, isUnknownEpochError } from '@interop/was-client/sync'
import { bodiesEqual, lwwFields } from './types.js'
import type { Json, LwwFields, SyncedDoc, WithDeleted } from './types.js'
import { log } from './log.js'

/**
 * The three states RxDB hands a conflict resolver: the state the server holds,
 * the local state that was refused, and the state this replica last synced
 * (absent when the row is a local create). The member names are RxDB's own and
 * stay as they are.
 */
export interface ConflictInput {
  realMasterState: WithDeleted<SyncedDoc>
  newDocumentState: WithDeleted<SyncedDoc>
  assumedMasterState?: WithDeleted<SyncedDoc>
}

/**
 * The RxDB conflict handler, declared structurally (RxDB's
 * `RxConflictHandler<SyncedDoc>` shape) so this module carries no `rxdb` import
 * in its emitted declarations. Pass it as a collection's `conflictHandler`
 * option at `addCollections`.
 */
export interface ConflictHandler {
  isEqual: (a: WithDeleted<SyncedDoc>, b: WithDeleted<SyncedDoc>) => boolean
  resolve: (input: ConflictInput) => Promise<WithDeleted<SyncedDoc>>
}

/**
 * Which side a resolver picked: the local row that was refused (`local`, RxDB's
 * `newDocumentState`) or the state the server holds (`remote`, RxDB's
 * `realMasterState`).
 */
export type ConflictWinner = 'local' | 'remote'

/**
 * The default structural equality RxDB asks for before it resolves anything.
 *
 * Non-async and fast, as RxDB requires. The server revisions (`version` /
 * `metaVersion`) participate deliberately: this replica's own write comes back
 * off the feed byte-identical but one revision ahead, and it must NOT compare
 * equal, or the higher revision is never adopted and every later conditional
 * write sends a stale `If-Match` (a guaranteed 412).
 *
 * @param a {WithDeleted<SyncedDoc>}
 * @param b {WithDeleted<SyncedDoc>}
 * @returns {boolean}
 */
export function statesEqual(
  a: WithDeleted<SyncedDoc>,
  b: WithDeleted<SyncedDoc>
): boolean {
  return (
    a._deleted === b._deleted &&
    a.version === b.version &&
    a.metaVersion === b.metaVersion &&
    bodiesEqual(a.data, b.data) &&
    bodiesEqual(a.custom, b.custom)
  )
}

/**
 * Builds an RxDB conflict handler around an injected decision. The resolver
 * receives the full RxDB conflict input -- `assumedMasterState` and both sides'
 * `custom` included, which the version-only and metadata-only rules need -- and
 * answers with the side that wins.
 *
 * A resolver that THROWS is the one thing the handler itself has to say. RxDB
 * treats a failed conflict resolution as a fatal replication error rather than
 * a retryable one, and the reason lives inside the injected decision (a cipher
 * that is gone, a comparator that met a shape it did not expect), so the
 * failure is logged with the row it happened on before it propagates.
 * Nothing else here logs: which side won is the resolver's story to tell, and
 * the default resolver tells it.
 *
 * @param options {object}
 * @param options.resolve {(input: ConflictInput) => Promise<ConflictWinner>}
 *   the app's decision; see {@link lwwResolver} for the default
 * @param [options.isEqual] {(a, b) => boolean}   defaults to
 *   {@link statesEqual}
 * @returns {ConflictHandler}
 */
export function makeConflictHandler({
  resolve,
  isEqual = statesEqual
}: {
  resolve: (input: ConflictInput) => Promise<ConflictWinner>
  isEqual?: (a: WithDeleted<SyncedDoc>, b: WithDeleted<SyncedDoc>) => boolean
}): ConflictHandler {
  return {
    isEqual,
    async resolve(input: ConflictInput): Promise<WithDeleted<SyncedDoc>> {
      let winner: ConflictWinner
      try {
        winner = await resolve(input)
      } catch (err) {
        log.error('Conflict resolution failed; the replication cycle fails', {
          id: input.realMasterState.id,
          err
        })
        throw err
      }
      return winner === 'local' ? input.newDocumentState : input.realMasterState
    }
  }
}

/**
 * One side's comparability for the LWW rules: `payload` (a decrypted LWW
 * stamp), `none` (a tombstone, an absent body, or a payload carrying no LWW
 * stamp), or `undecryptable` (the decrypt THREW -- an envelope written under an
 * unseen key epoch, say). `none` and `undecryptable` are deliberately distinct:
 * the former means "nothing there to compare", the latter means "something is
 * there that this client cannot read", and scoring the two the same silently
 * loses writes.
 */
type LwwSide =
  | { kind: 'payload'; payload: LwwFields }
  | { kind: 'none' }
  | { kind: 'undecryptable'; err: unknown }

/**
 * Decrypts one side's envelope into its LWW comparability (see LwwSide). A
 * payload carrying no LWW stamp reads as `none`, the same as a tombstone or an
 * absent body: nothing there to compare.
 *
 * @param doc {WithDeleted<SyncedDoc>}
 * @param decrypt {(envelope: Json) => Promise<Json>}
 * @returns {Promise<LwwSide>}
 */
async function lwwFieldsOf(
  doc: WithDeleted<SyncedDoc>,
  decrypt: (envelope: Json) => Promise<Json>
): Promise<LwwSide> {
  if (doc._deleted || doc.data === undefined) {
    return { kind: 'none' }
  }
  try {
    const payload = lwwFields(await decrypt(doc.data))
    return payload === null ? { kind: 'none' } : { kind: 'payload', payload }
  } catch (err) {
    return { kind: 'undecryptable', err }
  }
}

/**
 * Names why a side did not decrypt, for the undecryptable-side warnings:
 * `unknown-epoch` (the envelope's epoch is on no descriptor this reader holds,
 * so the caller's refresh either ran and was spent or was never wired),
 * `key-unwrap` (the epoch is listed and this reader was never a recipient, or
 * was removed and the epoch rotated), or `other`.
 *
 * @param err {unknown}
 * @returns {'unknown-epoch' | 'key-unwrap' | 'other'}
 */
function undecryptableReason(
  err: unknown
): 'unknown-epoch' | 'key-unwrap' | 'other' {
  if (isUnknownEpochError(err)) {
    return 'unknown-epoch'
  }
  if (isKeyUnwrapError(err)) {
    return 'key-unwrap'
  }
  return 'other'
}

/**
 * The last-write-wins resolver: the default decision {@link makeConflictHandler}
 * is built with, and the one every replica applies independently to converge.
 *
 * The server holds ONE winner of the push race as `realMasterState`; every
 * replica compares that same state against its own local edit, and
 * `payloadWins` is a total order over `(updatedAt, writerId)`, so the
 * globally-latest payload wins everywhere with no coordination.
 *
 * The rules, in order:
 *
 * 1. Version-only conflict: the server's whole content (`data` + `custom` +
 *    `_deleted`) still equals what this replica last synced, so the 412 came
 *    from a stale `If-Match` (typically this replica's own earlier write racing
 *    its feed echo). The local state -- edit or TOMBSTONE -- is re-asserted and
 *    re-pushed against the corrected revision. Without this rule a local delete
 *    would be dropped by rule 5 and the row would silently resurrect. `custom`
 *    must be part of the comparison, or a concurrent metadata-only edit
 *    committed on the server would be misclassified here and clobbered.
 * 2. Metadata conflict: `data` and `_deleted` are unchanged from the assumed
 *    state but `custom` differs -- a metadata-only edit committed on the server
 *    since this replica last synced. Metadata carries no LWW timestamp of its
 *    own (the payload `updatedAt` lives in the encrypted `data`, equal on both
 *    sides here), so the sound, replica-independent default is that the
 *    server-committed state wins. Without this rule the equal-`data` case would
 *    fall through to rule 4, where the two payloads compare equal and the tie
 *    keeps the local (stale) `custom`.
 * 3. An UNDECRYPTABLE side is never scored as the loser: it is presumed newer,
 *    not absent. An undecryptable remote is adopted (never re-pushed over with
 *    the possibly-older local payload); an undecryptable local row is
 *    re-asserted (the user's edit is not silently dropped); both undecryptable
 *    adopts the remote (deterministic and convergent). Each case is logged at
 *    `warn` -- distinguishable from the intended tombstone/absent-body `none`
 *    the remaining rules were written for.
 * 4. Both sides carry an LWW payload: pure payload LWW via `payloadWins`.
 * 5. A live local edit against an incomparable remote (a remote tombstone, say):
 *    the edit wins and is re-pushed (resurrection).
 * 6. Everything else -- a local tombstone against a REAL remote content change,
 *    or both sides incomparable: the remote wins. Together with rule 5 this
 *    makes the delete-vs-concurrent-edit rule "the edit wins" on every replica.
 *
 * @param options {object}
 * @param options.decrypt {(envelope: Json) => Promise<Json>}   this
 *   collection's decrypt, read lazily by the caller so a cipher swap is
 *   honored; on an encrypted collection, a refreshing cipher's
 *   (`createRefreshingEdvDocCipher` in `@interop/was-client/edv`), so an
 *   unseen-epoch side is re-read once before it counts as undecryptable
 * @param [options.payloadWins] {(remote: LwwFields, local: LwwFields) => boolean}
 *   the total-order comparator; defaults to social-core's `remotePayloadWins`
 *   (later `updatedAt` wins, `writerId` breaks a tie)
 * @returns {(input: ConflictInput) => Promise<ConflictWinner>}
 */
export function lwwResolver({
  decrypt,
  payloadWins = remotePayloadWins
}: {
  decrypt: (envelope: Json) => Promise<Json>
  payloadWins?: (remote: LwwFields, local: LwwFields) => boolean
}): (input: ConflictInput) => Promise<ConflictWinner> {
  return async function resolve({
    realMasterState,
    newDocumentState,
    assumedMasterState
  }: ConflictInput): Promise<ConflictWinner> {
    // Rule 1 -- version-only conflict.
    if (
      assumedMasterState !== undefined &&
      realMasterState._deleted === assumedMasterState._deleted &&
      bodiesEqual(realMasterState.data, assumedMasterState.data) &&
      bodiesEqual(realMasterState.custom, assumedMasterState.custom)
    ) {
      return 'local'
    }
    // Rule 2 -- metadata conflict: `data` and `_deleted` unchanged, `custom`
    // moved on the server.
    if (
      assumedMasterState !== undefined &&
      realMasterState._deleted === assumedMasterState._deleted &&
      bodiesEqual(realMasterState.data, assumedMasterState.data) &&
      !bodiesEqual(realMasterState.custom, assumedMasterState.custom)
    ) {
      return 'remote'
    }
    const [remote, local] = await Promise.all([
      lwwFieldsOf(realMasterState, decrypt),
      lwwFieldsOf(newDocumentState, decrypt)
    ])
    // Rule 3 -- an undecryptable side is presumed newer rather than absent.
    if (remote.kind === 'undecryptable' || local.kind === 'undecryptable') {
      if (remote.kind === 'undecryptable' && local.kind !== 'undecryptable') {
        log.warn(
          'LWW conflict: the remote state did not decrypt; adopting it ' +
            'rather than re-pushing the local payload over it.',
          {
            id: realMasterState.id,
            reason: undecryptableReason(remote.err),
            err: remote.err
          }
        )
        return 'remote'
      }
      if (local.kind === 'undecryptable' && remote.kind !== 'undecryptable') {
        log.warn(
          'LWW conflict: the local row did not decrypt; re-asserting it ' +
            'rather than dropping the local edit for the remote state.',
          {
            id: newDocumentState.id,
            reason: undecryptableReason(local.err),
            err: local.err
          }
        )
        return 'local'
      }
      log.warn(
        'LWW conflict: neither side decrypted; adopting the remote state ' +
          '(deterministic and convergent).',
        {
          id: realMasterState.id,
          reason:
            remote.kind === 'undecryptable'
              ? undecryptableReason(remote.err)
              : undefined,
          err: remote.kind === 'undecryptable' ? remote.err : undefined
        }
      )
      return 'remote'
    }
    // Rule 4 -- both sides comparable: pure payload LWW.
    if (remote.kind === 'payload' && local.kind === 'payload') {
      return payloadWins(remote.payload, local.payload) ? 'remote' : 'local'
    }
    // Rule 5 -- a live local edit against an incomparable remote.
    if (local.kind === 'payload' && remote.kind === 'none') {
      return 'local'
    }
    // Rule 6 -- everything else: the remote wins.
    return 'remote'
  }
}

/**
 * The LWW conflict handler in one call: {@link makeConflictHandler} over
 * {@link lwwResolver}. Kept as a named convenience because it is the shape
 * consumers already attach at `addCollections`.
 *
 * @param decrypt {(envelope: Json) => Promise<Json>}   this collection's decrypt
 * @param [payloadWins] {(remote: LwwFields, local: LwwFields) => boolean}
 * @returns {ConflictHandler}
 */
export function makeLwwConflictHandler(
  decrypt: (envelope: Json) => Promise<Json>,
  payloadWins: (
    remote: LwwFields,
    local: LwwFields
  ) => boolean = remotePayloadWins
): ConflictHandler {
  return makeConflictHandler({ resolve: lwwResolver({ decrypt, payloadWins }) })
}
