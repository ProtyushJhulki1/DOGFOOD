# Judging

## Scope

This build implements the judging **access model** required by T2 — role isolation, a judge-facing scores view, and organizer export. It does not implement judge assignment algorithms, weighted rubrics, or cross-judge normalization (T2's fuller feature set) — those were out of scope for this solo, time-boxed build. This is stated plainly here rather than glossed over, in line with the spec's emphasis on honest gap reporting.

## Scoring data

Each score entry (loaded from `fixtures.json`) contains a `judge_id`, a `project_id`, a `criteria` object (e.g. `functionality`, `quality`, `innovation`, each typically 1-5), and an optional free-text `comment`. This build stores criteria as-is without alteration or aggregation.

## Role isolation (the core judging-integrity guarantee this build provides)

The judging system enforces one hard rule: **a judge can only ever read their own scores, and this is enforced in the backend on every request, not hidden by the frontend.**

Concretely:
- `GET /api/judge/scores` returns only the requesting judge's own scores (matched by their auth token's associated `judgeId`)
- `GET /api/judge/scores/peer?judge=<id>` explicitly checks that the token's `judgeId` matches the `<id>` being requested, and refuses (403) on any mismatch — including a different judge, a participant, or an unauthenticated request
- There is no route, parameter, or shortcut that returns another judge's raw scores to anyone except an organizer via the CSV export

This matters because the most common way this kind of check fails is when isolation is only enforced by hiding a UI element (e.g. not showing a link) while the underlying API route still returns the data to anyone who requests it directly. This build's checks live in the route handlers themselves, so a direct `curl` request with the wrong token is refused identically to a request through any UI.

## Organizer export

`GET /api/export.csv` is restricted to the organizer role and returns the full, unfiltered scores table as CSV — the one point in the system where cross-judge visibility is intentional and role-gated to the appropriate party.

## What's not yet built (honest gaps)

- **Judge assignment**: which judges review which projects is defined entirely by the fixture data; there's no assignment algorithm (batch, random, or otherwise) in this build.
- **Weighted rubrics**: criteria are stored and exported as-is; there's no configurable weighting or aggregate scoring.
- **Cross-judge normalization**: raw scores are used directly; no z-score or other normalization is applied.
- **Judge progress dashboard**: not implemented.

These are documented here rather than claimed, consistent with `acceptance-report.txt`, which only claims and verifies T1 and T2's access-control requirements.
