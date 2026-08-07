# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Labels already in use here

These are **not** triage labels and never substitute for one. They carry separate meaning and
are applied in addition:

- `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`,
  `wayfinder:task` — `/wayfinder` artifacts. See `issue-tracker.md`.
- `repo:t3code`, `repo:firstmate` — which codebase a wayfinder ticket's answer lands in.

None of the five canonical triage labels exist in the repo yet, so `/triage` will need to create
them on first use.
