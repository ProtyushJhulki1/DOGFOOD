const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { initDb } = require('./db/init');

const app = express();
const PORT = 8080;
const TEAM_SIZE_LIMIT = 4;
const CRITERIA = ['functionality', 'quality', 'innovation'];

const { db, authTokens, eventClose } = initDb();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'dogfood-hackathon-secret',
  resave: false,
  saveUninitialized: false
}));

require('./results')(app, db, requirePageRole, csvCell, judgeAssignments, judgeSubmittedMap);

require('./admin')(app, db, getAuth, requirePageRole, csvCell);

function tokenInfo(token) {
  if (!token) return null;
  return Object.prototype.hasOwnProperty.call(authTokens, token) ? authTokens[token] : null;
}

function getAuth(req) {
  const headerInfo = tokenInfo(req.headers['x-auth-token']);
  if (headerInfo) return headerInfo;

  const sessionInfo = tokenInfo(req.session && req.session.authToken);
  if (sessionInfo) return sessionInfo;

  const userId = req.session && req.session.userId;
  if (userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (user) return { role: user.role, email: user.email };
  }
  return null;
}

function requireRole(role) {
  return function (req, res, next) {
    const auth = getAuth(req);
    if (!auth || auth.role !== role) {
      return res.status(403).json({ error: 'forbidden' });
    }
    req.auth = auth;
    next();
  };
}

function requirePageRole(role) {
  return function (req, res, next) {
    const auth = getAuth(req);
    const allowed = auth && (auth.role === role || (role === 'organizer' && auth.role === 'admin'));
    if (!allowed) {
      return res.redirect('/login');
    }
    req.auth = auth;
    next();
  };
}
function buildLoginOptions() {
  return Object.entries(authTokens).map(function (entry) {
    const token = entry[0];
    const info = entry[1];
    const label = info.role === 'judge'
      ? 'Judge (' + info.judgeId + ')'
      : info.role.charAt(0).toUpperCase() + info.role.slice(1);
    return { token: token, label: label };
  });
}

function csvCell(value) {
  let s = String(value === null || value === undefined ? '' : value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// ---------- Auth ----------

app.get('/login', function (req, res) {
  res.render('login', { options: buildLoginOptions(), error: null });
});

app.post('/login', function (req, res) {
  const token = req.body.token;
  if (!tokenInfo(token)) {
    return res.render('login', { options: buildLoginOptions(), error: 'Invalid selection, please try again.' });
  }
  req.session.authToken = token;
  res.redirect('/dashboard');
});

app.post('/login/email', async function (req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.render('login', { options: buildLoginOptions(), error: 'Invalid email or password.' });
  }
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

app.get('/signup', function (req, res) {
  res.render('signup', { error: null });
});

app.post('/signup', async function (req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || password.length < 6) {
    return res.render('signup', { error: 'Email required, password must be at least 6 characters.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.render('signup', { error: 'An account with that email already exists.' });
  }
  const id = 'usr_' + crypto.randomBytes(6).toString('hex');
  const hash = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)').run(id, email, hash, 'participant');
  req.session.userId = id;
  res.redirect('/participant');
});

app.get('/logout', function (req, res) {
  req.session.destroy(function () { res.redirect('/login'); });
});

app.get('/dashboard', function (req, res) {
  const auth = getAuth(req);
  if (!auth) return res.redirect('/login');
  if (auth.role === 'admin') return res.redirect('/admin');
  if (auth.role === 'organizer') return res.redirect('/organizer');
  if (auth.role === 'judge') return res.redirect('/judge');
  if (auth.role === 'participant') return res.redirect('/participant');
  res.redirect('/login');
});

// ---------- Public pages ----------

app.get('/', function (req, res) {
  const auth = getAuth(req);
  const projectCount = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
  const judgeCount = db.prepare('SELECT COUNT(*) as c FROM judges').get().c;
  const scoreCount = db.prepare('SELECT COUNT(*) as c FROM scores').get().c;
  const event = db.prepare('SELECT * FROM events').get();
  const tickerRows = db.prepare(
    "SELECT scores.comment, projects.title FROM scores JOIN projects ON projects.id = scores.project_id WHERE scores.comment != '' LIMIT 12"
  ).all();
  res.render('home', { auth: auth, projectCount: projectCount, judgeCount: judgeCount, scoreCount: scoreCount, event: event, tickerRows: tickerRows });
});

app.get('/events', function (req, res) {
  const auth = getAuth(req);
  const events = db.prepare(
    'SELECT events.*, (SELECT COUNT(*) FROM projects JOIN teams ON teams.id = projects.team_id WHERE teams.event_id = events.id) AS project_count FROM events'
  ).all();
  res.render('events', { auth: auth, events: events });
});

app.get('/projects', function (req, res) {
  const base = 'SELECT projects.*, tracks.name AS track_name, teams.name AS team_name FROM projects LEFT JOIN tracks ON tracks.id = projects.track_id LEFT JOIN teams ON teams.id = projects.team_id';
  let projects;
  if (req.query.event) {
    projects = db.prepare(base + ' WHERE teams.event_id = ?').all(String(req.query.event));
  } else {
    projects = db.prepare(base).all();
  }
  res.render('gallery', { projects: projects, auth: getAuth(req) });
});

// Checker-critical route. Behavior unchanged. Do not modify.
app.post('/projects/new', function (req, res) {
  const auth = getAuth(req);
  const wantsHtml = req.headers.accept && req.headers.accept.includes('html');

  if (!auth || auth.role !== 'participant') {
    if (wantsHtml) return res.redirect('/participant?error=forbidden');
    return res.status(403).json({ error: 'forbidden' });
  }
  const closeDate = new Date(eventClose);
  if (new Date() > closeDate) {
    if (wantsHtml) return res.redirect('/participant?error=closed');
    return res.status(403).json({ error: 'submissions are closed' });
  }
  if (wantsHtml) return res.redirect('/participant?success=1');
  res.status(201).json({ ok: true });
});

// ---------- Checker-critical judge API. Behavior unchanged. Do not modify. ----------

app.get('/api/judge/scores', requireRole('judge'), function (req, res) {
  const rows = db.prepare('SELECT * FROM scores WHERE judge_id = ?').all(req.auth.judgeId);
  res.json(rows);
});

app.get('/api/judge/scores/peer', function (req, res) {
  const auth = getAuth(req);
  const requestedJudgeId = req.query.judge;
  if (!auth || auth.role !== 'judge' || auth.judgeId !== requestedJudgeId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const rows = db.prepare('SELECT * FROM scores WHERE judge_id = ?').all(requestedJudgeId);
  res.json(rows);
});

app.get('/api/export.csv', requireRole('organizer'), function (req, res) {
  const rows = db.prepare('SELECT * FROM scores').all();
  let csv = 'judge_id,project_id,criteria,comment\n';
  rows.forEach(function (r) {
    csv += r.judge_id + ',' + r.project_id + ',' + csvCell(r.criteria) + ',' + csvCell(r.comment) + '\n';
  });
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});

// ---------- Organizer ----------

app.get('/organizer', requirePageRole('organizer'), function (req, res) {
  const projectCount = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
  const scoreCount = db.prepare('SELECT COUNT(*) as c FROM scores').get().c;
  const judgeCount = db.prepare('SELECT COUNT(*) as c FROM judges').get().c;
  const events = db.prepare(
    'SELECT events.*, (SELECT COUNT(*) FROM projects JOIN teams ON teams.id = projects.team_id WHERE teams.event_id = events.id) AS project_count FROM events'
  ).all();
  res.render('organizer', { projectCount: projectCount, scoreCount: scoreCount, judgeCount: judgeCount, events: events });
});

app.get('/organizer/events/new', requirePageRole('organizer'), function (req, res) {
  res.render('event-form', { mode: 'create', event: {} });
});

app.post('/organizer/events/new', requirePageRole('organizer'), function (req, res) {
  const id = 'evt_' + Date.now();
  db.prepare(
    'INSERT INTO events (id, name, submissions_close, start_date, end_date, registration_open, registration_close, prizes, rules) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id, req.body.name, req.body.submissions_close, req.body.start_date, req.body.end_date,
    req.body.registration_open, req.body.registration_close, req.body.prizes, req.body.rules
  );
  res.redirect('/organizer');
});

app.get('/organizer/events/:id/edit', requirePageRole('organizer'), function (req, res) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.redirect('/organizer');
  res.render('event-form', { mode: 'edit', event: event });
});

app.post('/organizer/events/:id/edit', requirePageRole('organizer'), function (req, res) {
  db.prepare(
    'UPDATE events SET name = ?, submissions_close = ?, start_date = ?, end_date = ?, registration_open = ?, registration_close = ?, prizes = ?, rules = ? WHERE id = ?'
  ).run(
    req.body.name, req.body.submissions_close, req.body.start_date, req.body.end_date,
    req.body.registration_open, req.body.registration_close, req.body.prizes, req.body.rules,
    req.params.id
  );
  res.redirect('/organizer');
});

app.get('/organizer/events/:id', requirePageRole('organizer'), function (req, res) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.redirect('/organizer');
  const now = new Date();
  let status = 'Upcoming';
  if (event.submissions_close && now > new Date(event.submissions_close)) status = 'Submissions Closed';
  else if (event.start_date && now > new Date(event.start_date)) status = 'Live';
  const projectCount = db.prepare(
    'SELECT COUNT(*) as c FROM projects JOIN teams ON teams.id = projects.team_id WHERE teams.event_id = ?'
  ).get(req.params.id).c;
  res.render('event-detail', { event: event, status: status, projectCount: projectCount });
});

app.post('/organizer/events/:id/delete', requirePageRole('organizer'), function (req, res) {
  if (req.params.id === 'evt_01') {
    return res.redirect('/organizer?error=cannot-delete-graded-event');
  }
  db.prepare('DELETE FROM projects WHERE team_id IN (SELECT id FROM teams WHERE event_id = ?)').run(req.params.id);
  db.prepare('DELETE FROM teams WHERE event_id = ?').run(req.params.id);
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.redirect('/organizer');
});

// ---------- Judge ----------

function judgeAssignments(judgeId) {
  return db.prepare(
    'SELECT a.project_id, p.title, p.summary, p.repo_url, e.id AS event_id, e.name AS event_name ' +
    'FROM judge_assignments a ' +
    'JOIN projects p ON p.id = a.project_id ' +
    'JOIN teams t ON t.id = p.team_id ' +
    'JOIN events e ON e.id = t.event_id ' +
    'LEFT JOIN judge_invites i ON i.judge_id = a.judge_id AND i.event_id = e.id ' +
    "WHERE a.judge_id = ? AND (i.id IS NULL OR i.status = 'accepted')"
  ).all(judgeId);
}

function getAssignedProject(judgeId, projectId) {
  return judgeAssignments(judgeId).find(function (a) { return a.project_id === projectId; });
}

function judgeSubmittedMap(judgeId) {
  const rows = db.prepare('SELECT project_id, criteria, comment FROM scores WHERE judge_id = ?').all(judgeId);
  const map = {};
  rows.forEach(function (r) { map[r.project_id] = r; });
  return map;
}

function parseScores(body) {
  const out = {};
  for (let i = 0; i < CRITERIA.length; i++) {
    const key = CRITERIA[i];
    const raw = body[key];
    if (raw === undefined || raw === '') {
      out[key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { error: true };
    out[key] = n;
  }
  return { scores: out };
}

app.get('/judge', requirePageRole('judge'), function (req, res) {
  const judgeId = req.auth.judgeId;
  const submitted = judgeSubmittedMap(judgeId);
  const drafts = {};
  db.prepare('SELECT project_id FROM score_drafts WHERE judge_id = ?').all(judgeId).forEach(function (d) {
    drafts[d.project_id] = true;
  });

  const projects = judgeAssignments(judgeId).map(function (a) {
    let status = 'pending';
    if (submitted[a.project_id]) status = 'submitted';
    else if (drafts[a.project_id]) status = 'draft';
    return Object.assign({}, a, { status: status });
  });

  const total = projects.length;
  const done = projects.filter(function (p) { return p.status === 'submitted'; }).length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const invites = db.prepare(
    "SELECT judge_invites.id, judge_invites.event_id, events.name AS event_name FROM judge_invites JOIN events ON events.id = judge_invites.event_id WHERE judge_invites.judge_id = ? AND judge_invites.status = 'pending'"
  ).all(judgeId);

  const eventMap = {};
  projects.forEach(function (p) { eventMap[p.event_id] = p.event_name; });
  db.prepare(
    "SELECT judge_invites.event_id AS id, events.name AS name FROM judge_invites JOIN events ON events.id = judge_invites.event_id WHERE judge_invites.judge_id = ? AND judge_invites.status = 'accepted'"
  ).all(judgeId).forEach(function (e) { eventMap[e.id] = e.name; });
  const events = Object.keys(eventMap).map(function (id) { return { id: id, name: eventMap[id] }; });

  res.render('judge', {
    judgeId: judgeId, projects: projects, invites: invites, events: events,
    total: total, done: done, pct: pct, msg: req.query.msg || null
  });
});

app.post('/judge/invites/:id/:action', requirePageRole('judge'), function (req, res) {
  const action = req.params.action;
  if (action !== 'accept' && action !== 'reject') return res.redirect('/judge');
  const invite = db.prepare('SELECT * FROM judge_invites WHERE id = ?').get(req.params.id);
  if (!invite || invite.judge_id !== req.auth.judgeId || invite.status !== 'pending') {
    return res.redirect('/judge');
  }
  db.prepare('UPDATE judge_invites SET status = ? WHERE id = ?').run(action === 'accept' ? 'accepted' : 'rejected', invite.id);
  res.redirect('/judge?msg=' + (action === 'accept' ? 'invite-accepted' : 'invite-declined'));
});

app.get('/judge/records', requirePageRole('judge'), function (req, res) {
  const judgeId = req.auth.judgeId;
  const judge = db.prepare('SELECT * FROM judges WHERE id = ?').get(judgeId);
  const submitted = judgeSubmittedMap(judgeId);
  const byEvent = {};
  judgeAssignments(judgeId).forEach(function (p) {
    if (!byEvent[p.event_id]) byEvent[p.event_id] = { event_name: p.event_name, assigned: 0, submitted: 0 };
    byEvent[p.event_id].assigned += 1;
    if (submitted[p.project_id]) byEvent[p.event_id].submitted += 1;
  });
  const records = Object.keys(byEvent).map(function (id) {
    return Object.assign({ event_id: id }, byEvent[id]);
  });
  res.render('judge-records', {
    judgeId: judgeId, judgeName: judge ? judge.name : judgeId,
    records: records, generatedAt: new Date().toISOString()
  });
});

app.get('/judge/projects/:projectId', requirePageRole('judge'), function (req, res) {
  const judgeId = req.auth.judgeId;
  const project = getAssignedProject(judgeId, req.params.projectId);
  if (!project) return res.status(403).send('You are not assigned to this project.');

  const submitted = judgeSubmittedMap(judgeId)[project.project_id] || null;
  const draft = db.prepare('SELECT criteria, comment FROM score_drafts WHERE judge_id = ? AND project_id = ?').get(judgeId, project.project_id) || null;

  let values = {};
  let comment = '';
  if (submitted) {
    values = JSON.parse(submitted.criteria);
    comment = submitted.comment || '';
  } else if (draft) {
    values = JSON.parse(draft.criteria);
    comment = draft.comment || '';
  }

  res.render('judge-project', {
    project: project, criteria: CRITERIA, values: values, comment: comment,
    locked: !!submitted, msg: req.query.msg || null, error: req.query.error || null
  });
});

app.post('/judge/projects/:projectId/draft', requirePageRole('judge'), function (req, res) {
  const judgeId = req.auth.judgeId;
  const project = getAssignedProject(judgeId, req.params.projectId);
  if (!project) return res.status(403).send('You are not assigned to this project.');
  const back = '/judge/projects/' + encodeURIComponent(project.project_id);

  if (judgeSubmittedMap(judgeId)[project.project_id]) {
    return res.redirect(back + '?error=already-submitted');
  }
  const parsed = parseScores(req.body);
  if (parsed.error) return res.redirect(back + '?error=invalid-score');
  const comment = String(req.body.comment || '').slice(0, 1000);

  db.prepare('INSERT OR REPLACE INTO score_drafts VALUES (?, ?, ?, ?, ?)').run(
    judgeId, project.project_id, JSON.stringify(parsed.scores), comment, new Date().toISOString()
  );
  res.redirect(back + '?msg=draft-saved');
});

app.post('/judge/projects/:projectId/submit', requirePageRole('judge'), function (req, res) {
  const judgeId = req.auth.judgeId;
  const project = getAssignedProject(judgeId, req.params.projectId);
  if (!project) return res.status(403).send('You are not assigned to this project.');
  const back = '/judge/projects/' + encodeURIComponent(project.project_id);

  if (judgeSubmittedMap(judgeId)[project.project_id]) {
    return res.redirect(back + '?error=already-submitted');
  }
  const parsed = parseScores(req.body);
  if (parsed.error) return res.redirect(back + '?error=invalid-score');
  const missing = CRITERIA.some(function (c) { return parsed.scores[c] === null; });
  if (missing) return res.redirect(back + '?error=all-scores-required');
  const comment = String(req.body.comment || '').slice(0, 1000);

  db.prepare('INSERT INTO scores VALUES (?, ?, ?, ?)').run(judgeId, project.project_id, JSON.stringify(parsed.scores), comment);
  db.prepare('DELETE FROM score_drafts WHERE judge_id = ? AND project_id = ?').run(judgeId, project.project_id);
  res.redirect('/judge?msg=score-submitted');
});

// ---------- Participant: events and teams ----------

app.get('/participant', requirePageRole('participant'), function (req, res) {
  const email = req.auth.email;
  const events = db.prepare('SELECT * FROM events').all();
  const myTeams = db.prepare(
    'SELECT teams.event_id, teams.id FROM team_members JOIN teams ON teams.id = team_members.team_id WHERE team_members.email = ?'
  ).all(email);
  const teamByEvent = {};
  myTeams.forEach(function (t) { teamByEvent[t.event_id] = t.id; });

  const pendingInvites = db.prepare(
    "SELECT team_invites.*, teams.name AS team_name, teams.event_id FROM team_invites JOIN teams ON teams.id = team_invites.team_id WHERE team_invites.invited_email = ? AND team_invites.status = 'pending'"
  ).all(email);

  res.render('participant-home', {
    email: email, events: events, teamByEvent: teamByEvent, pendingInvites: pendingInvites,
    error: req.query.error || null, success: req.query.success || null
  });
});

app.get('/participant/events/:eventId', requirePageRole('participant'), function (req, res) {
  const email = req.auth.email;
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.eventId);
  if (!event) return res.redirect('/participant');

  const myTeam = db.prepare(
    'SELECT teams.* FROM team_members JOIN teams ON teams.id = team_members.team_id WHERE team_members.email = ? AND teams.event_id = ?'
  ).get(email, req.params.eventId);

  if (!myTeam) {
    return res.render('team-join', { event: event, error: req.query.error || null });
  }

  const members = db.prepare('SELECT email FROM team_members WHERE team_id = ?').all(myTeam.id);
  const invites = db.prepare('SELECT * FROM team_invites WHERE team_id = ?').all(myTeam.id);

  res.render('team-manage', {
    event: event, team: myTeam, members: members, invites: invites, teamSizeLimit: TEAM_SIZE_LIMIT,
    error: req.query.error || null, success: req.query.success || null
  });
});

app.post('/participant/events/:eventId/team', requirePageRole('participant'), function (req, res) {
  const email = req.auth.email;
  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.eventId);
  if (!event) return res.redirect('/participant');

  const existing = db.prepare(
    'SELECT teams.id FROM team_members JOIN teams ON teams.id = team_members.team_id WHERE team_members.email = ? AND teams.event_id = ?'
  ).get(email, req.params.eventId);
  if (existing) return res.redirect('/participant/events/' + req.params.eventId);

  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.redirect('/participant/events/' + req.params.eventId);

  const teamId = 'team_' + crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO teams VALUES (?, ?, ?)').run(teamId, name, req.params.eventId);
  db.prepare('INSERT INTO team_members VALUES (?, ?)').run(teamId, email);
  res.redirect('/participant/events/' + req.params.eventId);
});

app.post('/participant/teams/:teamId/invite', requirePageRole('participant'), function (req, res) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) return res.redirect('/participant');

  const isMember = db.prepare('SELECT 1 AS ok FROM team_members WHERE team_id = ? AND email = ?').get(team.id, req.auth.email);
  if (!isMember) return res.status(403).send('Only team members can invite.');

  const invitedEmail = String(req.body.email || '').trim().toLowerCase();
  const back = '/participant/events/' + team.event_id;
  if (!invitedEmail) return res.redirect(back);

  const memberCount = db.prepare('SELECT COUNT(*) as c FROM team_members WHERE team_id = ?').get(team.id).c;
  const pendingCount = db.prepare("SELECT COUNT(*) as c FROM team_invites WHERE team_id = ? AND status = 'pending'").get(team.id).c;
  if (memberCount + pendingCount >= TEAM_SIZE_LIMIT) {
    return res.redirect(back + '?error=team-full');
  }

  const alreadyMember = db.prepare('SELECT 1 AS ok FROM team_members WHERE team_id = ? AND email = ?').get(team.id, invitedEmail);
  if (alreadyMember) return res.redirect(back + '?error=already-member');

  const id = 'inv_' + crypto.randomBytes(6).toString('hex');
  const token = crypto.randomBytes(12).toString('hex');
  db.prepare('INSERT INTO team_invites VALUES (?, ?, ?, ?, ?)').run(id, team.id, token, invitedEmail, 'pending');
  res.redirect(back + '?success=invite-sent');
});

app.get('/invite/:token', function (req, res) {
  const invite = db.prepare(
    'SELECT team_invites.*, teams.name AS team_name, teams.event_id, events.name AS event_name FROM team_invites JOIN teams ON teams.id = team_invites.team_id JOIN events ON events.id = teams.event_id WHERE team_invites.token = ?'
  ).get(req.params.token);
  res.render('invite-response', { invite: invite || null, auth: getAuth(req) });
});

app.post('/invite/:token/accept', requirePageRole('participant'), function (req, res) {
  const invite = db.prepare('SELECT * FROM team_invites WHERE token = ?').get(req.params.token);
  if (!invite || invite.status !== 'pending') return res.redirect('/participant');

  if (invite.invited_email !== req.auth.email) {
    return res.redirect('/invite/' + req.params.token);
  }

  const memberCount = db.prepare('SELECT COUNT(*) as c FROM team_members WHERE team_id = ?').get(invite.team_id).c;
  if (memberCount >= TEAM_SIZE_LIMIT) {
    db.prepare("UPDATE team_invites SET status = 'expired' WHERE token = ?").run(req.params.token);
    return res.redirect('/participant?error=team-full');
  }

  db.prepare('INSERT INTO team_members VALUES (?, ?)').run(invite.team_id, req.auth.email);
  db.prepare("UPDATE team_invites SET status = 'accepted' WHERE token = ?").run(req.params.token);

  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(invite.team_id);
  res.redirect('/participant/events/' + team.event_id);
});

app.post('/invite/:token/reject', requirePageRole('participant'), function (req, res) {
  const invite = db.prepare('SELECT * FROM team_invites WHERE token = ?').get(req.params.token);
  if (invite && invite.status === 'pending' && invite.invited_email === req.auth.email) {
    db.prepare("UPDATE team_invites SET status = 'rejected' WHERE token = ?").run(req.params.token);
  }
  res.redirect('/participant?success=invite-declined');
});

app.listen(PORT, function () {
  console.log('Server running at http://localhost:' + PORT);
  console.log('\n=== AUTH TOKENS (paste into .dogfood.toml) ===');
  Object.entries(authTokens).forEach(function (entry) {
    const info = entry[1];
    console.log(info.role + (info.judgeId ? ' (' + info.judgeId + ')' : '') + ': X-Auth-Token: ' + entry[0]);
  });
  console.log('===============================================\n');
});