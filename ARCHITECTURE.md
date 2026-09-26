# Architecture

## Overview

A single Node.js process serves the entire application — one Express server, one in-memory SQLite database, no external services. This was a deliberate choice for a solo build under a 72-hour deadline: fewer moving parts means fewer failure points.

## Request flow

1. Server boots (`server.js`)
2. `db/init.js` creates an in-memory SQLite database using Node's built-in `node:sqlite` module
3. `fixtures.json` is read and loaded into the database tables
4. Four fixed auth tokens are generated, mapped to roles (organizer, judge_a, judge_b, participant), and printed to the console
5. Express starts listening on port 8080

## Authentication model

There is no login flow for grading purposes. Instead, each request carries a custom header:

The server looks up this token against an in-memory map built at boot time, and attaches the matching role (and, for judges, their specific `judgeId`) to the request. This satisfies the spec's requirement that auth be checkable without the grader needing to log in through a UI.

## Role isolation (the part that matters most)

Every route that needs role-based access control checks the token **on the backend**, inside the route handler itself — never by hiding a button or relying on the frontend. Specifically:

- `/api/judge/scores` — requires the `judge` role; returns only that judge's own scores, filtered by their `judgeId`
- `/api/judge/scores/peer?judge=<id>` — explicitly checks that the requesting judge's own ID matches the `<id>` being asked for; any mismatch (including a different judge, or a non-judge role) returns `403`
- `/api/export.csv` — requires the `organizer` role

This design means a request from `curl` with the wrong token is blocked identically to a request from the app's own UI — there is no separate, weaker path.

## Data model

See `DATA-MODEL.md` for the full schema. In short: `events`, `tracks`, `judges`, `teams`, `team_members`, `projects`, `scores` — a direct mapping of the shape described in `fixtures.json`.

## Why an in-memory database

Given the fixture data is reloaded fresh on every boot anyway, persistence added complexity without benefit for this scope. If judges request a persistence path (e.g. real submissions surviving a restart), the schema is designed to move to a file-backed SQLite database with a one-line change (`new DatabaseSync(':memory:')` → `new DatabaseSync('./data.db')`).

## Deployment

`docker-compose.yml` builds the app from the provided `Dockerfile` (Node 24 Alpine base image) and exposes port 8080. No external services, hosted databases, or network calls are required — `docker compose up` alone brings up a fully working, seeded portal.
