# Dogfood Hackathon Platform

A self-hostable hackathon submission and judging platform, built solo for the Dogfood 2026 hackathon.

## What it does

- Public gallery of submitted projects (no login required)
- Submission endpoint that automatically closes once the event's deadline passes
- Judges can view their own scores, but are blocked from viewing another judge's scores (enforced in the backend, not just hidden in the UI)
- Organizers can export all scores as CSV

## Tiers claimed

T1 (Core) and T2 (Judging) — see `acceptance-report.txt` for the verified results.

## Tech stack

- Node.js + Express (server)
- EJS (templates)
- Node's built-in `node:sqlite` module (in-memory database, reloaded from `fixtures.json` on every boot)
- Docker + Docker Compose

## Running it

The server starts at `http://localhost:8080` and prints four auth tokens to the console — these correspond to the organizer, two judges, and one participant role, and are already filled into `.dogfood.toml`.

## Running the acceptance checker

## Honest limitations

- No real login/session system for end users yet — authentication for the checker is via a fixed header token, as the spec allows. A production version would need real user accounts.
- No frontend styling — pages are plain HTML for now.
- T3 (public voting) and T4 (stretch/API) are not implemented.
- Data does not persist between restarts (in-memory database, reseeded from fixtures each boot) — a deliberate simplicity tradeoff given the timeline.
