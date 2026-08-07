# Issue tracker: GitHub

Issues, PRDs and wayfinder maps for this repo live as GitHub issues on
**`autoprintworks/t3code`**. Use the `gh` CLI for all operations.

## Always pass `--repo`

This clone has two remotes — `origin` (`autoprintworks/t3code`, where issues live) and
`upstream` (`pingdotgg/t3code`, the fork source) — and no default repo is set. `gh` cannot
resolve a single repo on its own here, so **every command must carry
`--repo autoprintworks/t3code`**. Without it a command either prompts or resolves upstream,
where none of this repo's issues exist.

Alternatively, run `gh repo set-default autoprintworks/t3code` once; until someone does, treat
`--repo` as mandatory. Never file an issue against `pingdotgg/t3code` — that is the upstream
project, not ours.

## Conventions

- **Create an issue**: `gh issue create --repo autoprintworks/t3code --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo autoprintworks/t3code --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --repo autoprintworks/t3code --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo autoprintworks/t3code --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo autoprintworks/t3code --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo autoprintworks/t3code --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr`
equivalents: `gh pr view <n> --comments`, `gh pr diff <n>`, `gh pr list --state open --json
number,title,body,labels,author,authorAssociation,comments` keeping only `authorAssociation` of
`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR` or `NONE`, then `gh pr comment` / `gh pr edit
--add-label` / `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve
with `gh pr view 42` and fall back to `gh issue view 42`. This repo already has the collision:
`#17` is a PR sitting between tickets `#16` and `#18`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `autoprintworks/t3code`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo autoprintworks/t3code --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --repo autoprintworks/t3code --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/autoprintworks/t3code/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/autoprintworks/t3code/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --repo autoprintworks/t3code --state open`, scoped to the map's sub-issues), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --repo autoprintworks/t3code --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --repo autoprintworks/t3code --body "<answer>"`, then `gh issue close <n> --repo autoprintworks/t3code`, then append a context pointer (gist + link) to the map's Decisions-so-far.

### Local conventions this repo has already established

These were settled in practice before this file existed. They are the convention now; follow
them rather than re-deciding per session.

- **A second label, `repo:<name>`**, rides alongside `wayfinder:<type>` to record which
  codebase a ticket's answer lands in — `repo:t3code` or `repo:firstmate`. Tickets live here
  even when the code they describe lives in `autoprintworks/firstmate-claude-code`.
- **Research and prototype findings are committed to `main`** under
  `experiments/<name>/README.md`, not to a throwaway `research/<name>` branch as the wayfinder
  skill's charting step suggests. Commit subject:
  `chore(experiments): record the <name> spike for #<n>`. The ticket's resolution comment links
  the directory.
- **Wire blocking edges as part of creating a ticket**, not only during the charting session.
  Tickets added mid-map (`#11`–`#15`, `#18`) have no edges, so GitHub's UI cannot render the
  frontier for them and the map body is the only source of ordering.
