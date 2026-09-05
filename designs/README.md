# Design documents (the design gate)

Pre-implementation design docs for cross-cutting roadmap items. This
directory holds the convention and the template; each repo keeps its
actual design docs beside its own roadmap (a tracked `designs/`
directory where the roadmap is tracked, as here; the planning dir's
`designs/` subdirectory where the roadmap lives in a gitignored
planning dir).

## The gate

A cross-cutting item requires an approved design document before
implementation starts. Cross-cutting means the item changes
persistence semantics, key material custody or handling, a ceremony's
stage order, a session or login/logout bootstrap path, or any other
invariant the repo's ARCHITECTURE.md documents. When in doubt: labels
like `session`, `keys`, `ceremony`, or `persistence`, or a `touches:`
block naming a shared package, mean the gate applies. Small
single-surface items (a copy change, a local bug fix, a test) skip it.

The gate exists to move the interaction enumeration in front of the
code. Its absence has a known failure mode: an item states goals,
implementation discovers the blast radius, and the post-implementation
review becomes the enumerator -- a fan-out of follow-up defect items,
each an interaction bug that would have cost a paragraph edit at
design time.

## Mechanics

- The item carries two fields: `design:` naming the doc
  (`designs/<ID>-slug.md`, structured per [TEMPLATE.md](TEMPLATE.md)),
  and `design-approved:` holding a date that only core contributors
  set.
  The item stays `todo` until both are filled; moving it to
  `in-progress` or writing implementation code before approval is out
  of process.
- The doc's core sections are the enumeration: the invariants touched
  and how each is upheld, every call site or flow whose behavior
  changes, the interaction matrix against existing ceremonies and
  postures, the chosen seams with rejected alternatives, and the test
  plan.
- Before approval the doc gets an adversarial review pass: the
  code-review posture aimed at the design ("which consumer of the
  changed state breaks under this?"), findings folded back into the
  doc rather than opened as items.
- Approval covers the design, not its wire artifacts. A wire-level
  convention named in the doc (a field name, salt, layout, encoding)
  still needs its own explicit sign-off, and the doc must flag each
  such decision it contains.
- Approval also extracts the durable decisions into tracked
  [`decisions/`](../decisions/) records: contract-binding decisions
  into the owning repo, and do-not-reopen rejections of an approach
  into the repo whose design rejected them, with Revisit Criteria.
  The design doc then cites the records instead of carrying the
  canonical text.
- Acceptance boxes on a gated item verify the doc's enumerated sites
  ("each write site in design section N is handled or exempted,
  exemption recorded"), rather than restating the goal.

## Lifecycle

A design doc is a working artifact, not a durable record. Once the
item lands, the extracted decision records and the repo's
ARCHITECTURE.md hold everything durable (the decisions, and the
resulting shape); the doc itself may go stale without maintenance.
Repos may keep a specialized copy of TEMPLATE.md beside their own
roadmap (for example, pre-filling the interaction matrix's rows with
their standing ceremonies); this directory's copy stays generic and
canonical.
