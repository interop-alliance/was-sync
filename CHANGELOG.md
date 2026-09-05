# @interop/isomorphic-lib-template Changelog

## 0.1.0 - TBD

### Added

- Initial commit.
- Decision-record convention: `decisions/` directory (README + TEMPLATE) for
  cross-repo decisions, plus the "Decision Records" section in AGENTS.md.
- Decision-record scope widened: a pre-implementation design review may also
  mint a record for a repo-internal do-not-reopen decision.
- Design-gate convention: `designs/` directory (README + TEMPLATE) for
  pre-implementation design docs on cross-cutting items, plus the
  `design:` / `design-approved:` item fields and gate rule in AGENTS.md.
- ARCHITECTURE.md skeleton (layer map, numbered invariants, ownership
  heuristics, current state labels), plus the "Architecture" section in
  AGENTS.md; the design gate, `touches:`, and the breaking-release audit
  all key on this file.
