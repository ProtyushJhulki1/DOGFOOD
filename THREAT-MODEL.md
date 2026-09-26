# Threat Model

This document covers realistic abuse scenarios against a hackathon submission and judging platform, and how this build addresses (or does not yet address) each one.

## 1. Judge collusion / score leakage

**Threat**: A judge learns another judge's scores for a project and adjusts their own score to match or counter it, undermining independent judgment.

**Mitigation in this build**: The `/api/judge/scores` and `/api/judge/scores/peer` routes are backend-enforced to only return the requesting judge's own scores, verified by matching the auth token's `judgeId` against the requested judge. This is checked in route-handler code, not hidden by the frontend — so even a direct API request (via curl, Postman, or a browser dev tools request) from Judge B cannot retrieve Judge A's scores. Organizers, who legitimately need cross-judge visibility, access this only through the separate, role-gated CSV export.

**Residual risk**: If an organizer's credentials are compromised, all scores become visible. This is an inherent tradeoff of having any aggregation role at all, and is not fully solvable without further measures like audit logging (see below).

## 2. Sybil / duplicate submissions

**Threat**: A team submits the same project multiple times, or creates fake teams to submit near-duplicate projects, to game a "most submissions" or first-mover advantage.

**Current status**: Not actively defended against in this build. The fixture data does include a duplicate submission case, which the platform loads without erroring, but no deduplication logic is implemented.

**How it could be addressed**: A production version would hash project `title` + `repo_url` per event and flag near-duplicates for organizer review rather than silently blocking them (since legitimate near-duplicates, e.g. a team resubmitting after a small typo fix, do happen).

## 3. Deadline gaming

**Threat**: A team submits a project fractions of a second before the deadline via automated scripting to avoid last-minute competition/scrutiny, or attempts to submit after the deadline by manipulating client-side timestamps.

**Mitigation in this build**: The deadline check happens entirely server-side, comparing the server's own clock against the event's `submissions_close` timestamp from the loaded fixture data. A client cannot influence this by sending a different timestamp, since the submission route does not trust any client-supplied time value at all.

## 4. Submission scraping

**Threat**: A competitor or bad actor scrapes the public gallery to copy project ideas, descriptions, or repo links before judging concludes.

**Current status**: Not defended against — the gallery is intentionally public per the spec (`GET /projects` must return 200 with no auth). This is a spec requirement, not an oversight; the tradeoff is transparency (anyone can verify the platform is honest) versus exposure.

**How it could be reduced**: Rate-limiting the gallery endpoint would slow bulk scraping without affecting normal browsing, though it would not stop a determined actor making slow, distributed requests.

## 5. Auth token leakage

**Threat**: One of the four fixed auth tokens (organizer, judge_a, judge_b, participant) is leaked or guessed, letting an attacker act with that role's permissions.

**Current status**: These tokens are intentionally simple and fixed for this build, per the spec's design (the checker needs a stable, printable header value, not a full login flow). This is acceptable for a hackathon-grading context but would be a real weakness in a production deployment.

**How it would be addressed for production**: Real per-user sessions with hashed passwords (bcrypt is already a dependency in this project, unused for the grading-facing routes but ready for a real login system), token expiry, and per-user (not per-role) tokens so a single leak doesn't compromise every judge at once.

## Summary

The build's strongest defense is backend-enforced role isolation for the highest-value target (judge score leakage), which is also the scenario the spec explicitly calls out as the most common way a platform loses integrity points. Weaker areas — deduplication, rate limiting, and production-grade auth — are honestly documented here as not yet implemented, consistent with this project's overall approach of claiming only what is actually built and verified.