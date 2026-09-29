const crypto = require('crypto');

module.exports = function mountVoting(app, db, getAuth, requirePageRole, csvCell) {
  const MAX_VOTES_CAP = 20;
  const USER_LIMIT = 20;
  const IP_LIMIT = 200;
  const WINDOW_MS = 60 * 1000;
  const COMMENT_MAX = 500;

  db.exec('CREATE TABLE IF NOT EXISTS voting_config (event_id TEXT PRIMARY KEY, enabled INTEGER, opens_at TEXT, closes_at TEXT, votes_per_voter INTEGER, eligibility TEXT, comments_enabled INTEGER, results_during INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS voting_allowlist (event_id TEXT, email TEXT, PRIMARY KEY (event_id, email))');
  db.exec('CREATE TABLE IF NOT EXISTS votes (event_id TEXT, project_id TEXT, voter TEXT, created_at TEXT, ip_hash TEXT, PRIMARY KEY (event_id, project_id, voter))');
  db.exec('CREATE TABLE IF NOT EXISTS vote_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, project_id TEXT, author TEXT, body TEXT, created_at TEXT, deleted INTEGER DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS voting_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT, event_id TEXT, project_id TEXT, detail TEXT)');

  const ERR = {
    'not-a-voter': 'Only participant accounts can vote. Log in with an account created on the signup page.',
    'not-eligible': 'Your account is not on the voter list for this event.',
    'voting-disabled': 'Voting is not active for this event.',
    'voting-upcoming': 'Voting has not opened yet.',
    'voting-closed': 'Voting has closed.',
    'no-such-project': 'That project is not part of this event.',
    'own-project': "You cannot vote for your own team's project.",
    'no-votes-left': 'You have used all of your votes. Remove one to vote for another project.',
    'already-voted': 'You have already voted for this project.',
    'no-such-vote': 'You had no vote on that project.',
    'comments-off': 'Comments are turned off for this event.',
    'comment-empty': 'Write something before posting.',
    'comment-long': 'Comments are limited to 500 characters.',
    'comment-duplicate': 'You already posted that exact comment on this project.',
    'bad-date': 'One of the dates is not valid.',
    'bad-window': 'The closing time must be after the opening time.',
    'bad-votes': 'Votes per voter must be a whole number from 1 to 20.',
    'bad-eligibility': 'Choose who may vote.'
  };
  const MSG = {
    'vote-recorded': 'Your vote was recorded.',
    'vote-removed': 'Your vote was removed.',
    'comment-posted': 'Comment posted.',
    'comment-deleted': 'Comment removed.',
    'config-saved': 'Voting settings saved.',
    'allowlist-updated': 'Voter list updated.'
  };
  const CSRF_MSG = 'Invalid or missing form token. Reload the page and try again.';

  function pick(map, code) {
    return code && Object.prototype.hasOwnProperty.call(map, code) ? map[code] : null;
  }
  function enc(s) { return encodeURIComponent(s); }

  // ---------- rate limiting (in memory, sliding window) ----------
  const hits = {};
  function rateHit(key, limit) {
    const now = Date.now();
    const arr = (hits[key] || []).filter(function (t) { return now - t < WINDOW_MS; });
    const blocked = arr.length >= limit;
    if (!blocked) arr.push(now);
    hits[key] = arr;
    return blocked;
  }
  function rateLimited(req, email) {
    if (Object.keys(hits).length > 5000) {
      Object.keys(hits).forEach(function (k) { delete hits[k]; });
    }
    const byUser = rateHit('u:' + email, USER_LIMIT);
    const byIp = rateHit('i:' + String(req.ip || ''), IP_LIMIT);
    return byUser || byIp;
  }

  // ---------- CSRF (session-cookie requests only; header-token clients are exempt) ----------
  function csrfToken(req) {
    if (!req.session) return '';
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
    return req.session.csrf;
  }
  function csrfOk(req) {
    if (req.headers['x-auth-token']) return true;
    const sent = String((req.body && req.body._csrf) || '');
    const real = req.session && req.session.csrf ? req.session.csrf : '';
    if (!real || sent.length !== real.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(real));
  }

  // ---------- helpers ----------
  function audit(actor, action, eventId, projectId, detail) {
    try {
      db.prepare('INSERT INTO voting_audit (ts, actor, action, event_id, project_id, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
        new Date().toISOString(), actor || 'anonymous', action, eventId || null, projectId || null, detail || null
      );
    } catch (e) {
      // logging must never break a request
    }
  }
  function actorOf(auth) { return auth ? (auth.email || auth.role) : 'anonymous'; }
  function ipHash(req) {
    return crypto.createHash('sha256').update(String(req.ip || '')).digest('hex').slice(0, 12);
  }

  function getConfig(eventId) {
    const row = db.prepare('SELECT * FROM voting_config WHERE event_id = ?').get(eventId);
    if (row) return row;
    return { event_id: eventId, enabled: 0, opens_at: null, closes_at: null, votes_per_voter: 3, eligibility: 'open', comments_enabled: 1, results_during: 0 };
  }

  function statusOf(cfg, now) {
    if (!cfg || !cfg.enabled) return 'disabled';
    if (cfg.opens_at && now < new Date(cfg.opens_at)) return 'upcoming';
    if (cfg.closes_at && now > new Date(cfg.closes_at)) return 'closed';
    return 'open';
  }

  // Results are hidden from everyone but admins until voting closes (unless an admin opted in to live totals).
  function resultsVisible(cfg, status, auth) {
    if (auth && auth.role === 'admin') return true;
    if (status === 'closed') return true;
    if (status === 'open' && cfg.results_during) return true;
    return false;
  }

  function voterEmail(auth) {
    return auth && auth.role === 'participant' && auth.email ? String(auth.email).toLowerCase() : null;
  }

  function eligibility(email, cfg, eventId) {
    if (!email) return { ok: false, reason: 'account' };
    if (cfg.eligibility === 'allowlist') {
      const row = db.prepare('SELECT 1 AS x FROM voting_allowlist WHERE event_id = ? AND email = ?').get(eventId, email);
      if (!row) return { ok: false, reason: 'not-listed' };
    }
    return { ok: true, reason: null };
  }

  function eventProjects(eventId) {
    return db.prepare(
      'SELECT p.id, p.title, p.summary, p.repo_url FROM projects p JOIN teams t ON t.id = p.team_id WHERE t.event_id = ? ORDER BY p.id'
    ).all(eventId);
  }

  function ownedProjectIds(eventId, email) {
    const set = {};
    if (!email) return set;
    db.prepare(
      'SELECT p.id FROM projects p JOIN teams t ON t.id = p.team_id JOIN team_members m ON m.team_id = p.team_id WHERE t.event_id = ? AND lower(m.email) = ?'
    ).all(eventId, email).forEach(function (r) { set[r.id] = true; });
    return set;
  }

  function tally(eventId) {
    const rows = db.prepare(
      'SELECT p.id, p.title, (SELECT COUNT(*) FROM votes v WHERE v.event_id = ? AND v.project_id = p.id) AS votes ' +
      'FROM projects p JOIN teams t ON t.id = p.team_id WHERE t.event_id = ?'
    ).all(eventId, eventId);
    rows.sort(function (a, b) {
      return (b.votes - a.votes) || String(a.title).localeCompare(String(b.title));
    });
    let prevVotes = null;
    let prevRank = 0;
    return rows.map(function (r, i) {
      const rank = (prevVotes !== null && r.votes === prevVotes) ? prevRank : i + 1;
      prevVotes = r.votes;
      prevRank = rank;
      return { id: r.id, title: r.title, votes: r.votes, rank: rank };
    });
  }

  // Per-voter deterministic shuffle: the same voter always sees the same order, different voters see different orders.
  function seededShuffle(list, seedStr) {
    let a = crypto.createHash('sha256').update(seedStr).digest().readUInt32BE(0);
    function rnd() {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function parseUtc(v) {
    const s = String(v || '').trim();
    if (!s) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return undefined;
    const d = new Date(s.length === 16 ? s + ':00Z' : s + 'Z');
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  function voterCtx(req, res) {
    const auth = getAuth(req);
    if (!auth) { res.redirect('/login'); return null; }
    if (!csrfOk(req)) { res.status(403).send(CSRF_MSG); return null; }
    const event = db.prepare('SELECT id, name FROM events WHERE id = ?').get(req.params.eventId);
    if (!event) { res.redirect('/vote'); return null; }
    const cfg = getConfig(event.id);
    return { auth: auth, event: event, cfg: cfg, status: statusOf(cfg, new Date()), email: voterEmail(auth) };
  }

  // ---------- voter pages ----------

  app.get('/vote', function (req, res) {
    const events = db.prepare('SELECT id, name FROM events').all().map(function (e) {
      const cfg = getConfig(e.id);
      return { id: e.id, name: e.name, status: statusOf(cfg, new Date()), closes_at: cfg.closes_at };
    }).filter(function (e) { return e.status !== 'disabled'; });
    res.render('vote-events', { auth: getAuth(req), events: events });
  });

  app.get('/vote/:eventId', function (req, res) {
    const auth = getAuth(req);
    if (!auth) return res.redirect('/login');
    const event = db.prepare('SELECT id, name FROM events WHERE id = ?').get(req.params.eventId);
    if (!event) return res.redirect('/vote');

    const cfg = getConfig(event.id);
    const status = statusOf(cfg, new Date());
    const email = voterEmail(auth);
    const elig = eligibility(email, cfg, event.id);
    const isAdmin = auth.role === 'admin';

    let projects = [];
    if (status !== 'disabled' || isAdmin) {
      const mine = {};
      let owned = {};
      if (email) {
        db.prepare('SELECT project_id FROM votes WHERE event_id = ? AND voter = ?').all(event.id, email).forEach(function (r) { mine[r.project_id] = true; });
        owned = ownedProjectIds(event.id, email);
      }
      projects = seededShuffle(eventProjects(event.id), (email || auth.role) + '|' + event.id).map(function (p) {
        return { id: p.id, title: p.title, summary: p.summary, repo_url: p.repo_url, voted: !!mine[p.id], own: !!owned[p.id] };
      });
    }
    const used = projects.filter(function (p) { return p.voted; }).length;

    res.render('vote-event', {
      auth: auth, event: event, cfg: cfg, status: status, elig: elig, projects: projects,
      votesLeft: Math.max(0, cfg.votes_per_voter - used),
      results: resultsVisible(cfg, status, auth) ? tally(event.id) : null,
      csrf: csrfToken(req),
      msgText: pick(MSG, req.query.msg), errorText: pick(ERR, req.query.error)
    });
  });

  function rejectVote(c, req, res, pid, code, action) {
    audit(c.email || actorOf(c.auth), action, c.event.id, pid, code);
    return res.redirect('/vote/' + enc(c.event.id) + '?error=' + code);
  }

  app.post('/vote/:eventId/projects/:projectId/vote', function (req, res) {
    const c = voterCtx(req, res);
    if (!c) return;
    const pid = req.params.projectId;
    const back = '/vote/' + enc(c.event.id);

    if (!c.email) return rejectVote(c, req, res, pid, 'not-a-voter', 'vote_rejected');
    if (!eligibility(c.email, c.cfg, c.event.id).ok) return rejectVote(c, req, res, pid, 'not-eligible', 'vote_rejected');
    if (c.status !== 'open') return rejectVote(c, req, res, pid, 'voting-' + c.status, 'vote_rejected');
    if (rateLimited(req, c.email)) {
      audit(c.email, 'rate_limited', c.event.id, pid, 'vote');
      return res.status(429).send('Too many requests. Wait a minute and try again.');
    }
    const project = db.prepare('SELECT p.id FROM projects p JOIN teams t ON t.id = p.team_id WHERE p.id = ? AND t.event_id = ?').get(pid, c.event.id);
    if (!project) return rejectVote(c, req, res, pid, 'no-such-project', 'vote_rejected');
    if (ownedProjectIds(c.event.id, c.email)[pid]) return rejectVote(c, req, res, pid, 'own-project', 'vote_rejected');

    const dup = db.prepare('SELECT 1 AS x FROM votes WHERE event_id = ? AND project_id = ? AND voter = ?').get(c.event.id, pid, c.email);
    if (dup) return rejectVote(c, req, res, pid, 'already-voted', 'duplicate_vote_rejected');

    const have = db.prepare('SELECT COUNT(*) AS c FROM votes WHERE event_id = ? AND voter = ?').get(c.event.id, c.email).c;
    if (have >= c.cfg.votes_per_voter) return rejectVote(c, req, res, pid, 'no-votes-left', 'vote_rejected');

    try {
      db.prepare('INSERT INTO votes (event_id, project_id, voter, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)').run(
        c.event.id, pid, c.email, new Date().toISOString(), ipHash(req)
      );
    } catch (e) {
      return rejectVote(c, req, res, pid, 'already-voted', 'duplicate_vote_rejected');
    }
    audit(c.email, 'vote_cast', c.event.id, pid, null);
    res.redirect(back + '?msg=vote-recorded');
  });

  app.post('/vote/:eventId/projects/:projectId/unvote', function (req, res) {
    const c = voterCtx(req, res);
    if (!c) return;
    const pid = req.params.projectId;

    if (!c.email) return rejectVote(c, req, res, pid, 'not-a-voter', 'unvote_rejected');
    if (c.status !== 'open') return rejectVote(c, req, res, pid, 'voting-' + c.status, 'unvote_rejected');
    if (rateLimited(req, c.email)) {
      audit(c.email, 'rate_limited', c.event.id, pid, 'unvote');
      return res.status(429).send('Too many requests. Wait a minute and try again.');
    }
    const r = db.prepare('DELETE FROM votes WHERE event_id = ? AND project_id = ? AND voter = ?').run(c.event.id, pid, c.email);
    if (!r.changes) return rejectVote(c, req, res, pid, 'no-such-vote', 'unvote_rejected');
    audit(c.email, 'vote_removed', c.event.id, pid, null);
    res.redirect('/vote/' + enc(c.event.id) + '?msg=vote-removed');
  });

  app.get('/vote/:eventId/projects/:projectId', function (req, res) {
    const auth = getAuth(req);
    if (!auth) return res.redirect('/login');
    const event = db.prepare('SELECT id, name FROM events WHERE id = ?').get(req.params.eventId);
    if (!event) return res.redirect('/vote');
    const project = db.prepare('SELECT p.id, p.title, p.summary, p.repo_url FROM projects p JOIN teams t ON t.id = p.team_id WHERE p.id = ? AND t.event_id = ?').get(req.params.projectId, event.id);
    if (!project) return res.redirect('/vote/' + enc(event.id));

    const cfg = getConfig(event.id);
    const status = statusOf(cfg, new Date());
    const email = voterEmail(auth);
    const elig = eligibility(email, cfg, event.id);
    const isAdmin = auth.role === 'admin';
    const showComments = cfg.comments_enabled && (status !== 'disabled' || isAdmin);
    const comments = showComments
      ? db.prepare('SELECT id, author, body, created_at FROM vote_comments WHERE event_id = ? AND project_id = ? AND deleted = 0 ORDER BY id').all(event.id, project.id)
      : [];
    const voted = email
      ? !!db.prepare('SELECT 1 AS x FROM votes WHERE event_id = ? AND project_id = ? AND voter = ?').get(event.id, project.id, email)
      : false;

    res.render('vote-project', {
      auth: auth, event: event, project: project, cfg: cfg, status: status, elig: elig,
      comments: comments, showComments: !!showComments, voted: voted, isAdmin: isAdmin,
      own: !!ownedProjectIds(event.id, email)[project.id],
      csrf: csrfToken(req),
      msgText: pick(MSG, req.query.msg), errorText: pick(ERR, req.query.error)
    });
  });

  app.post('/vote/:eventId/projects/:projectId/comments', function (req, res) {
    const c = voterCtx(req, res);
    if (!c) return;
    const pid = req.params.projectId;
    const back = '/vote/' + enc(c.event.id) + '/projects/' + enc(pid);
    function reject(code) {
      audit(c.email || actorOf(c.auth), 'comment_rejected', c.event.id, pid, code);
      return res.redirect(back + '?error=' + code);
    }

    if (!c.email) return reject('not-a-voter');
    if (!eligibility(c.email, c.cfg, c.event.id).ok) return reject('not-eligible');
    if (!c.cfg.comments_enabled) return reject('comments-off');
    if (c.status !== 'open') return reject('voting-' + c.status);
    const project = db.prepare('SELECT p.id FROM projects p JOIN teams t ON t.id = p.team_id WHERE p.id = ? AND t.event_id = ?').get(pid, c.event.id);
    if (!project) return reject('no-such-project');

    const body = String(req.body.body || '').trim();
    if (!body) return reject('comment-empty');
    if (body.length > COMMENT_MAX) return reject('comment-long');
    if (rateLimited(req, c.email)) {
      audit(c.email, 'rate_limited', c.event.id, pid, 'comment');
      return res.status(429).send('Too many requests. Wait a minute and try again.');
    }
    const dup = db.prepare('SELECT 1 AS x FROM vote_comments WHERE event_id = ? AND project_id = ? AND author = ? AND body = ? AND deleted = 0').get(c.event.id, pid, c.email, body);
    if (dup) return reject('comment-duplicate');

    db.prepare('INSERT INTO vote_comments (event_id, project_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
      c.event.id, pid, c.email, body, new Date().toISOString()
    );
    audit(c.email, 'comment_added', c.event.id, pid, 'length ' + body.length);
    res.redirect(back + '?msg=comment-posted');
  });

  app.post('/vote/comments/:id/delete', requirePageRole('admin'), function (req, res) {
    if (!csrfOk(req)) return res.status(403).send(CSRF_MSG);
    const row = db.prepare('SELECT * FROM vote_comments WHERE id = ?').get(req.params.id);
    if (!row) return res.redirect('/admin/voting');
    db.prepare('UPDATE vote_comments SET deleted = 1 WHERE id = ?').run(row.id);
    audit(actorOf(req.auth), 'comment_deleted', row.event_id, row.project_id, 'comment ' + row.id + ' by ' + row.author);
    res.redirect('/vote/' + enc(row.event_id) + '/projects/' + enc(row.project_id) + '?msg=comment-deleted');
  });

  // ---------- admin: configuration, voter list, results, audit ----------

  app.get('/admin/voting', requirePageRole('admin'), function (req, res) {
    const first = db.prepare('SELECT id FROM events ORDER BY rowid LIMIT 1').get();
    res.redirect(first ? '/admin/voting/' + enc(first.id) : '/admin');
  });

  app.get('/admin/voting/:eventId', requirePageRole('admin'), function (req, res) {
    const event = db.prepare('SELECT id, name FROM events WHERE id = ?').get(req.params.eventId);
    if (!event) return res.redirect('/admin/voting');
    const cfg = getConfig(event.id);
    const events = db.prepare('SELECT id, name FROM events').all().map(function (e) {
      return { id: e.id, name: e.name, status: statusOf(getConfig(e.id), new Date()) };
    });
    res.render('admin-voting', {
      event: event, events: events, cfg: cfg, status: statusOf(cfg, new Date()),
      allowlist: db.prepare('SELECT email FROM voting_allowlist WHERE event_id = ? ORDER BY email').all(event.id),
      tally: tally(event.id),
      advisory: db.prepare('SELECT ip_hash, COUNT(DISTINCT voter) AS voters, COUNT(*) AS votes FROM votes WHERE event_id = ? GROUP BY ip_hash HAVING COUNT(DISTINCT voter) >= 3').all(event.id),
      audit: db.prepare('SELECT * FROM voting_audit WHERE event_id = ? ORDER BY id DESC LIMIT 50').all(event.id),
      csrf: csrfToken(req),
      msgText: pick(MSG, req.query.msg), errorText: pick(ERR, req.query.error)
    });
  });

  app.post('/admin/voting/:eventId/config', requirePageRole('admin'), function (req, res) {
    if (!csrfOk(req)) return res.status(403).send(CSRF_MSG);
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.eventId);
    if (!event) return res.redirect('/admin/voting');
    const back = '/admin/voting/' + enc(event.id);

    const opens = parseUtc(req.body.opens_at);
    const closes = parseUtc(req.body.closes_at);
    if (opens === undefined || closes === undefined) return res.redirect(back + '?error=bad-date');
    if (opens && closes && new Date(closes) <= new Date(opens)) return res.redirect(back + '?error=bad-window');
    const n = Number(req.body.votes_per_voter);
    if (!Number.isInteger(n) || n < 1 || n > MAX_VOTES_CAP) return res.redirect(back + '?error=bad-votes');
    const eligibilityMode = String(req.body.eligibility || '');
    if (eligibilityMode !== 'open' && eligibilityMode !== 'allowlist') return res.redirect(back + '?error=bad-eligibility');

    const before = getConfig(event.id);
    const cfg = {
      event_id: event.id, enabled: req.body.enabled ? 1 : 0, opens_at: opens, closes_at: closes,
      votes_per_voter: n, eligibility: eligibilityMode,
      comments_enabled: req.body.comments_enabled ? 1 : 0, results_during: req.body.results_during ? 1 : 0
    };
    db.prepare('INSERT OR REPLACE INTO voting_config VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      cfg.event_id, cfg.enabled, cfg.opens_at, cfg.closes_at, cfg.votes_per_voter, cfg.eligibility, cfg.comments_enabled, cfg.results_during
    );
    audit(actorOf(req.auth), 'config_changed', event.id, null, 'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(cfg));
    res.redirect(back + '?msg=config-saved');
  });

  app.post('/admin/voting/:eventId/allowlist/add', requirePageRole('admin'), function (req, res) {
    if (!csrfOk(req)) return res.status(403).send(CSRF_MSG);
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.eventId);
    if (!event) return res.redirect('/admin/voting');
    const seen = {};
    const emails = String(req.body.emails || '').split(/[\s,;]+/).map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) {
      if (!s || s.length > 254 || s.indexOf('@') < 1 || seen[s]) return false;
      seen[s] = true;
      return true;
    });
    const ins = db.prepare('INSERT OR IGNORE INTO voting_allowlist VALUES (?, ?)');
    emails.forEach(function (e) { ins.run(event.id, e); });
    audit(actorOf(req.auth), 'allowlist_added', event.id, null, emails.length + ' address(es)');
    res.redirect('/admin/voting/' + enc(event.id) + '?msg=allowlist-updated');
  });

  app.post('/admin/voting/:eventId/allowlist/remove', requirePageRole('admin'), function (req, res) {
    if (!csrfOk(req)) return res.status(403).send(CSRF_MSG);
    const email = String(req.body.email || '').trim().toLowerCase();
    db.prepare('DELETE FROM voting_allowlist WHERE event_id = ? AND email = ?').run(req.params.eventId, email);
    audit(actorOf(req.auth), 'allowlist_removed', req.params.eventId, null, email);
    res.redirect('/admin/voting/' + enc(req.params.eventId) + '?msg=allowlist-updated');
  });

  app.get('/admin/voting/:eventId/results.csv', requirePageRole('admin'), function (req, res) {
    let csv = 'rank,project_id,project_title,votes\n';
    tally(req.params.eventId).forEach(function (r) {
      csv += r.rank + ',' + csvCell(r.id) + ',' + csvCell(r.title) + ',' + r.votes + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="voting-results.csv"');
    res.send(csv);
  });

  app.get('/admin/voting/:eventId/audit.csv', requirePageRole('admin'), function (req, res) {
    const rows = db.prepare('SELECT * FROM voting_audit WHERE event_id = ? ORDER BY id').all(req.params.eventId);
    let csv = 'id,ts,actor,action,project_id,detail\n';
    rows.forEach(function (r) {
      csv += r.id + ',' + csvCell(r.ts) + ',' + csvCell(r.actor) + ',' + csvCell(r.action) + ',' + csvCell(r.project_id) + ',' + csvCell(r.detail) + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="voting-audit.csv"');
    res.send(csv);
  });
};
