const crypto = require('crypto');

// Bradley-Terry strength estimation via the MM algorithm (Hunter, 2004), with a
// fixed-strength virtual opponent (one virtual win + one virtual loss per item)
// so isolated items and disconnected comparison graphs still converge to a
// finite, well-defined result instead of diverging or dividing by zero.
function bradleyTerry(ids, matches, iterations) {
  const theta = {};
  ids.forEach(function (id) { theta[id] = 1; });
  if (!ids.length) return theta;

  const wins = {};
  const n = {};
  ids.forEach(function (i) {
    wins[i] = 1; // virtual win vs the anchor
    n[i] = {};
  });
  matches.forEach(function (m) {
    const a = m.a, b = m.b, w = m.w; // w: 1 = a won, 0 = b won, 0.5 = tie
    wins[a] = (wins[a] || 0) + w;
    wins[b] = (wins[b] || 0) + (1 - w);
    n[a][b] = (n[a][b] || 0) + 1;
    n[b][a] = (n[b][a] || 0) + 1;
  });

  for (let it = 0; it < iterations; it++) {
    const next = {};
    ids.forEach(function (i) {
      let denom = 2 / (theta[i] + 1); // virtual match vs anchor (theta = 1), 2 games
      Object.keys(n[i]).forEach(function (j) {
        denom += n[i][j] / (theta[i] + theta[j]);
      });
      next[i] = denom > 0 ? wins[i] / denom : theta[i];
      if (!isFinite(next[i]) || next[i] <= 0) next[i] = 1e-6;
    });
    // normalize so the geometric mean stays at 1 (keeps the scale from drifting)
    const logSum = ids.reduce(function (s, i) { return s + Math.log(next[i]); }, 0);
    const shift = Math.exp(logSum / ids.length);
    ids.forEach(function (i) { theta[i] = next[i] / shift; });
  }
  return theta;
}

module.exports = function mountPairwise(app, db, getAuth, requirePageRole, csvCell, judgeAssignments) {
  const ITERATIONS = 200;

  db.exec('CREATE TABLE IF NOT EXISTS pairwise_config (event_id TEXT PRIMARY KEY, enabled INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS pairwise_comparisons (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, judge_id TEXT, project_a TEXT, project_b TEXT, winner TEXT, created_at TEXT)');

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

  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  function judgeEvents(judgeId) {
    const seen = {};
    const out = [];
    judgeAssignments(judgeId).forEach(function (a) {
      if (!seen[a.event_id]) { seen[a.event_id] = true; out.push({ id: a.event_id, name: a.event_name }); }
    });
    return out;
  }

  function isEnabled(eventId) {
    const row = db.prepare('SELECT enabled FROM pairwise_config WHERE event_id = ?').get(eventId);
    return !!(row && row.enabled);
  }

  function eventProjects(eventId) {
    return db.prepare('SELECT p.id, p.title FROM projects p JOIN teams t ON t.id = p.team_id WHERE t.event_id = ? ORDER BY p.id').all(eventId);
  }

  function pickPair(eventId, judgeId) {
    const projects = eventProjects(eventId);
    if (projects.length < 2) return null;
    const done = {};
    db.prepare('SELECT project_a, project_b FROM pairwise_comparisons WHERE event_id = ? AND judge_id = ?').all(eventId, judgeId).forEach(function (r) {
      done[pairKey(r.project_a, r.project_b)] = true;
    });
    const remaining = [];
    for (let i = 0; i < projects.length; i++) {
      for (let j = i + 1; j < projects.length; j++) {
        const k = pairKey(projects[i].id, projects[j].id);
        if (!done[k]) remaining.push([projects[i], projects[j]]);
      }
    }
    if (!remaining.length) return { exhausted: true };
    const pick = remaining[Math.floor(Math.random() * remaining.length)];
    return { a: pick[0], b: pick[1] };
  }

  function computeRanking(eventId) {
    const projects = eventProjects(eventId);
    const ids = projects.map(function (p) { return p.id; });
    const titleOf = {};
    projects.forEach(function (p) { titleOf[p.id] = p.title; });

    const rows = db.prepare('SELECT project_a, project_b, winner FROM pairwise_comparisons WHERE event_id = ?').all(eventId);
    const matches = rows.map(function (r) {
      const w = r.winner === r.project_a ? 1 : (r.winner === r.project_b ? 0 : 0.5);
      return { a: r.project_a, b: r.project_b, w: w };
    });

    const compared = {};
    matches.forEach(function (m) { compared[m.a] = true; compared[m.b] = true; });

    const theta = bradleyTerry(ids, matches, ITERATIONS);
    const list = ids.map(function (id) {
      return { id: id, title: titleOf[id], strength: theta[id], comparisons: 0 };
    });
    ids.forEach(function (id) {
      list.find(function (x) { return x.id === id; }).comparisons =
        matches.filter(function (m) { return m.a === id || m.b === id; }).length;
    });
    list.sort(function (a, b) { return b.strength - a.strength; });
    list.forEach(function (x, i) { x.rank = i + 1; x.noData = !compared[x.id]; });

    return { list: list, totalComparisons: matches.length };
  }

  // ---------- judge pages ----------

  app.get('/judge/pairwise', requirePageRole('judge'), function (req, res) {
    const events = judgeEvents(req.auth.judgeId).filter(function (e) { return isEnabled(e.id); });
    res.render('pairwise-events', { events: events });
  });

  app.get('/judge/pairwise/:eventId', requirePageRole('judge'), function (req, res) {
    const judgeId = req.auth.judgeId;
    const allowed = judgeEvents(judgeId).some(function (e) { return e.id === req.params.eventId; });
    if (!allowed || !isEnabled(req.params.eventId)) return res.status(403).send('Pairwise comparisons are not open for you on this event.');

    const event = db.prepare('SELECT id, name FROM events WHERE id = ?').get(req.params.eventId);
    const pair = pickPair(event.id, judgeId);
    const doneCount = db.prepare('SELECT COUNT(*) AS c FROM pairwise_comparisons WHERE event_id = ? AND judge_id = ?').get(event.id, judgeId).c;

    res.render('pairwise-judge', {
      event: event, pair: pair, doneCount: doneCount, csrf: csrfToken(req),
      msgText: req.query.msg === 'recorded' ? 'Comparison recorded.' : null
    });
  });

  app.post('/judge/pairwise/:eventId/compare', requirePageRole('judge'), function (req, res) {
    const judgeId = req.auth.judgeId;
    const back = '/judge/pairwise/' + encodeURIComponent(req.params.eventId);
    if (!csrfOk(req)) return res.status(403).send('Invalid or missing form token. Reload the page and try again.');

    const allowed = judgeEvents(judgeId).some(function (e) { return e.id === req.params.eventId; });
    if (!allowed || !isEnabled(req.params.eventId)) return res.status(403).send('Pairwise comparisons are not open for you on this event.');

    const a = String(req.body.a || '');
    const b = String(req.body.b || '');
    const winner = String(req.body.winner || '');
    const valid = db.prepare('SELECT p.id FROM projects p JOIN teams t ON t.id = p.team_id WHERE t.event_id = ? AND p.id IN (?, ?)').all(req.params.eventId, a, b);
    if (valid.length !== 2 || (winner !== a && winner !== b && winner !== 'tie')) {
      return res.redirect(back);
    }
    const already = db.prepare(
      'SELECT 1 AS x FROM pairwise_comparisons WHERE event_id = ? AND judge_id = ? AND ((project_a = ? AND project_b = ?) OR (project_a = ? AND project_b = ?))'
    ).get(req.params.eventId, judgeId, a, b, b, a);
    if (already) return res.redirect(back);

    db.prepare('INSERT INTO pairwise_comparisons (event_id, judge_id, project_a, project_b, winner, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      req.params.eventId, judgeId, a, b, winner === 'tie' ? 'tie' : winner, new Date().toISOString()
    );
    res.redirect(back + '?msg=recorded');
  });

  // ---------- admin ----------

  app.get('/admin/pairwise', requirePageRole('admin'), function (req, res) {
    const first = db.prepare('SELECT id FROM events ORDER BY rowid LIMIT 1').get();
    res.redirect(first ? '/admin/pairwise/' + encodeURIComponent(first.id) : '/admin');
  });

  app.get('/admin/pairwise/:eventId', requirePageRole('admin'), function (req, res) {
    const event = db.prepare('SELECT id, name FROM events WHERE id = ?').get(req.params.eventId);
    if (!event) return res.redirect('/admin/pairwise');
    const events = db.prepare('SELECT id, name FROM events').all().map(function (e) {
      return { id: e.id, name: e.name, enabled: isEnabled(e.id) };
    });
    res.render('admin-pairwise', {
      event: event, events: events, enabled: isEnabled(event.id),
      result: computeRanking(event.id), csrf: csrfToken(req),
      msgText: req.query.msg === 'saved' ? 'Setting saved.' : null
    });
  });

  app.post('/admin/pairwise/:eventId/config', requirePageRole('admin'), function (req, res) {
    if (!csrfOk(req)) return res.status(403).send('Invalid or missing form token. Reload the page and try again.');
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.eventId);
    if (!event) return res.redirect('/admin/pairwise');
    db.prepare('INSERT OR REPLACE INTO pairwise_config VALUES (?, ?)').run(event.id, req.body.enabled ? 1 : 0);
    res.redirect('/admin/pairwise/' + encodeURIComponent(event.id) + '?msg=saved');
  });

  app.get('/admin/pairwise/:eventId/ranking.csv', requirePageRole('admin'), function (req, res) {
    const result = computeRanking(req.params.eventId);
    let csv = 'rank,project_id,project_title,strength,comparisons,no_data\n';
    result.list.forEach(function (r) {
      csv += r.rank + ',' + csvCell(r.id) + ',' + csvCell(r.title) + ',' + r.strength.toFixed(4) + ',' + r.comparisons + ',' + (r.noData ? 'yes' : 'no') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="pairwise-ranking.csv"');
    res.send(csv);
  });
};
