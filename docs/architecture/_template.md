# ADR NNNN — <title: the decision, not the topic>

- Status: proposed | accepted | superseded.
- Supersedes: none | ADR NNNN.
- Superseded-by: none | ADR NNNN.

## Context

What was true before, and what forced a decision. Facts and constraints, not
the answer — a reader who disagrees with the decision should still recognise
this section as an honest account of the problem.

## Decision

What was decided, stated so it can be checked. Name the mechanism, not the
intention: which module, which rule, which gate. If a fence law enforces this
record, name it here.

## Why <the alternative> was not chosen

One section per real alternative, and only real ones. An alternative nobody
seriously considered does not belong here; an alternative that was rejected for
a reason worth remembering does. This is the part of a record that is still
useful in two years.

## Consequences

What this costs, what it makes impossible, and what it obliges future work to
do. Include the consequences that are inconvenient — a record that lists only
benefits is a decision that was never really weighed.

## Not in this record

The adjacent questions this record deliberately leaves open, and where they are
answered instead.

---

Conventions: numbers are unique and contiguous, and the architecture fence
enforces both. The corpus is append-only — never edit a landed record to
reflect a later decision; write a new one and set the `Supersedes` /
`Superseded-by` pair on both. Add the new record to `index.md` in the same
commit; the docs gate asserts the index and the corpus are a bijection.
