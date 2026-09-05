# ID-N: Title (design)

- item: ID-N (the driving roadmap item)
- status: draft | reviewed | approved
- approved: (date, set by core contributors)
- wire-level decisions contained: none | listed in section 5 and
  individually signed off
- decision records extracted: none | the `decisions/NNNN-slug.md`
  records minted at approval (see sections 5 and 6)

Structure for every design doc behind the roadmap's design gate (see
this directory's README). Keep each section accurate and short; the doc
exists so the interaction enumeration happens before code, where a
finding costs a paragraph edit instead of a review-and-fix cycle.
Delete this preamble in a real doc.

This doc is a working artifact with a lifecycle: at approval, the
durable decisions in sections 5 and 6 are extracted into tracked
`decisions/` records (this repo's for internal do-not-reopen
rejections, the owning repo's for contract-binding decisions), and
the sections then cite the records instead of carrying the canonical
text. Once the item lands, the records and ARCHITECTURE.md hold
everything durable, and this doc may go stale without maintenance.

## 1. Problem and scope

What the item changes, in one or two paragraphs. Equally important:
what it explicitly does not change, so the review pass knows where the
edges are.

## 2. Invariant inventory

Every ARCHITECTURE.md invariant this design touches -- the repo's own,
and any shared package's whose behavior the design leans on. One entry
per invariant: its statement, whether the design upholds it or
deliberately changes it, and how. An invariant changed here must also
name the doc edit that will record the change.

Examples of the class: persist-before-publish orderings in ceremonies,
deletion-completeness promises ("removes every local trace"),
forward-only pins and counters, fail-closed refusal rules, cache
lifecycle assumptions.

## 3. Consumer enumeration

Every call site, flow, or stored artifact whose behavior or meaning
changes under this design. State how the list was produced (the grep,
the export map walk) so the review can check it for completeness
rather than re-derive it. A consumer that keeps working unchanged is
still listed if its correctness now rests on a new assumption.

## 4. Interaction matrix

The new behavior crossed against existing ceremonies, flows, postures,
and edge states. Rows are the repo's existing flows; columns are the
states the design introduces. Each cell is fine, changed (say how), or
refused (say where the refusal lands). Cells nobody filled are where
the next batch of review findings comes from.

## 5. Design

The chosen mechanism and interface, with enough precision that the
implementation has no silent decisions left: which modules change,
which stay, what the types say. Flag every wire-level convention
(field names, salts, KDF info strings, layouts, encodings, error
names) in its own list here; each needs individual sign-off and none
is covered by doc approval. A signed-off convention that binds a
shared contract additionally lands as a decision record in the
contract-owning repo at approval.

## 6. Alternatives rejected

Each alternative seriously considered, and the reason it lost. This is
the section that stops a future session from re-proposing a rejected
approach. Mark each rejection that is do-not-reopen; at approval those
are extracted to `decisions/` records with Revisit Criteria, and this
section then points at the record rather than restating it.

## 7. Test plan

What proves each section-2 invariant and each section-4 "changed"
cell: unit, e2e, and which existing suites must stay green. Name the
tests that would have caught the failure classes this design is most
exposed to.

## 8. Open questions

Anything unresolved at approval time, each with an owner and where its
answer will land. An empty section is a claim, so say "none" only
after the review pass.
