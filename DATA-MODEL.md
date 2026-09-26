# Data Model

## Storage

An in-memory SQLite database (Node's built-in `node:sqlite` module), recreated fresh from `fixtures.json` every time the server boots. No separate database server, no persistence between restarts by design (see ARCHITECTURE.md for rationale).

## Schema

### events
| column | type | notes |
|---|---|---|
| id | TEXT (primary key) | e.g. `evt_01` |
| name | TEXT | |
| submissions_close | TEXT | ISO 8601 UTC timestamp; used to reject submissions after this point |

### tracks
| column | type | notes |
|---|---|---|
| id | TEXT (primary key) | e.g. `trk_01` |
| name | TEXT | e.g. "Developer tools" |

### judges
| column | type | notes |
|---|---|---|
| id | TEXT (primary key) | e.g. `jdg_01` |
| name | TEXT | |
| email | TEXT | |

### teams
| column | type | notes |
|---|---|---|
| id | TEXT (primary key) | e.g. `tm_01` |
| name | TEXT | |

### team_members
| column | type | notes |
|---|---|---|
| team_id | TEXT | foreign key → teams.id |
| email | TEXT | member's email |

### projects
| column | type | notes |
|---|---|---|
| id | TEXT (primary key) | e.g. `prj_01` |
| team_id | TEXT | foreign key → teams.id |
| track_id | TEXT | foreign key → tracks.id |
| title | TEXT | |
| summary | TEXT | one-line description |
| repo_url | TEXT | |
| submitted_at | TEXT | ISO 8601 UTC timestamp |

### scores
| column | type | notes |
|---|---|---|
| judge_id | TEXT | foreign key → judges.id |
| project_id | TEXT | foreign key → projects.id |
| criteria | TEXT | JSON string, e.g. `{"functionality":4,"quality":3}` |
| comment | TEXT | free text, sometimes empty |

## Import path

`fixtures.json` is loaded once at boot (`db/init.js`). Each top-level array in the fixtures file (`tracks`, `judges`, `teams`, `projects`, `scores`) is inserted directly into its matching table, with minimal transformation — mainly renaming `team`/`track`/`judge`/`project` fixture keys to the `_id`-suffixed foreign key columns used internally.

## Export path

`GET /api/export.csv` (organizer-only) reads the entire `scores` table and serializes it to CSV, one row per score entry, with the `criteria` JSON string properly escaped for CSV quoting.

## Known simplification

The `criteria` column stores a JSON string rather than being normalized into separate columns per rubric criterion (functionality, quality, innovation). This was a deliberate tradeoff — the fixture data's criteria keys aren't fixed across all entries, so a flexible JSON blob avoided a schema migration mid-build. A production version would likely normalize this into a `score_criteria` table keyed by `(judge_id, project_id, criterion_name)`.