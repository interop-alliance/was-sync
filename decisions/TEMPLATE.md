# NNNN: Title (a short name for the decision, not a summary)

- Status: accepted | superseded by NNNN
- Date: YYYY-MM-DD
- Amendments: omit until the first in-place refinement; then one dated
  line per amendment (`YYYY-MM-DD: what changed, in one sentence`)
- Driving work: what prompted the decision, described as the work it was.
  Do not cite roadmap item ids; those live in gitignored planning files
  and mean nothing to a reader of the published record.
- Affects: the repos and modules bound by the decision (mirror the driving
  item's `touches:` entries, resolved)

## Context

What situation forced a choice. State the constraints that shaped it (wire
compatibility, key custody, an interop partner's behavior), not the history
of the discussion. Short sentences; a reader two years out should be able to
tell whether the constraints still hold.

## Decision

The decision itself, stated as the rule it establishes. Name the concrete
artifacts it binds (a spec section, an exported function, a wire field).

## Rejected Alternatives

One short subsection or bullet per alternative seriously considered: what it
was, and the specific reason it lost. This is the section that saves the
decision from being relitigated from scratch.

## Consequences

What follows -- costs accepted, invariants downstream code may now rely on,
work the decision creates or forecloses. Accurately describe the negatives.

## Revisit Criteria

Reopen this decision when one or more of the following holds:

1. A concrete, observable condition (evidence, scale, a partner shipping X),
   not "if we change our minds".
2. ...

If revisited, note any constraint on how (e.g. "as a new parallel profile,
not an in-place change to the shipped wire format").
