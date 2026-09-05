# Decision records

Durable records of decisions: the decision, its rationale, the
alternatives rejected, and the conditions under which to revisit it. This
directory holds the convention and the template; each owning repo keeps its
own `decisions/` directory with its records.

## Scope rule

A decision earns a record in two cases.

Cross-repo: it changes a spec, a wire contract, or a shared `@interop/*`
API -- the same test that makes a roadmap item carry a `touches:` field.
The record lives in the repo that owns the contract (the spec repo for a
profile decision, the shared package for an API decision), regardless of
which repo's roadmap drove it.

Repo-internal do-not-reopen: a pre-implementation design review (a repo's
roadmap may gate cross-cutting items on one) rejects an approach with
concrete revisit criteria, and core contributors judge the rejection worth
a durable record. The record lives in the repo whose design rejected the
approach. Other repo-internal decisions stay in that repo's ARCHITECTURE.md
prose; recording them here would duplicate it.

## Qualifying test

The scope rule says where a record may come from. Within either case,
write a record only when all three hold:

1. Hard to reverse: changing course later has a real cost (a shipped
   wire format, a published API, a ceremony order other repos rely on).
2. Surprising without context: a reader of the code would wonder why it
   was done this way, or would assume the opposite.
3. A real trade-off: there were genuine alternatives and one was chosen
   for specific reasons.

A decision that is easy to reverse will just be reversed. One that is
not surprising needs no explanation. One with no real alternative is
"we did the obvious thing", and ARCHITECTURE.md prose covers it.

Decisions that usually pass: a deliberate deviation from the obvious
path (so the next contributor does not "fix" it); a rejected alternative
whose rejection is not obvious (so it is not re-proposed in six months);
a constraint not visible in the code (a partner's behaviour, a custody
rule, a compliance limit); a boundary decision stating what this repo
does not own. The explicit no is as valuable as the yes.

Create a repo's `decisions/` directory when its first record is written,
not at scaffold time.

## Conventions

- Files are `decisions/NNNN-kebab-case-slug.md`, zero-padded, sequential per
  repo, never reused or renumbered.
- Copy [TEMPLATE.md](TEMPLATE.md). The Context / Decision / Consequences /
  Revisit Criteria sections are required; Rejected Alternatives is required
  whenever an alternative was seriously considered.
- Write the record when the decision is made -- normally in the same pass
  that writes the decided block into the driving design doc or archives the
  deciding roadmap item. Describe the driving work by what it was; do not
  cite roadmap item ids (they live in gitignored planning files). The
  roadmap item may point at the record, not the other way around.
- Refinements and clarifications are amended in place: edit the record so
  its text states the current rule, and add a dated one-line entry to an
  `Amendments` list in the record's header block, so the change is visible
  without git archaeology. A reader should get the whole current decision
  from one document, without chasing pointers.
- A reversal still gets its own record; the old one's Status becomes
  `superseded by NNNN` and its text stays intact. A reversal's rationale
  argues against the old record rather than tightening it, and the old
  rationale must survive so the original position is not relitigated from
  scratch.
- Prefer Revisit Criteria over speculative flexibility: state the concrete
  evidence that would justify reopening, so a "deliberately not" rule does
  not depend on someone remembering why.
- Reference records from ARCHITECTURE.md / AGENTS.md where the resulting
  shape is described, not from code comments.
- Skills written for an ADR convention (`docs/adr/`, "offer an ADR") map
  onto this directory. Their offer is a proposal: the record is written
  from TEMPLATE.md, with all required sections, after the qualifying
  test and core-contributor approval. A one-paragraph ADR is not a
  record here; the Rejected Alternatives and Revisit Criteria sections
  are the parts that stop relitigation.
