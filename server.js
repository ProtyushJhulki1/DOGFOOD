const express = require('express');
const path = require('path');
const session = require('express-session');
const { initDb } = require('./db/init');

const app = express();
const PORT = 8080;

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

function getAuth(req) {
  const headerToken = req.headers['x-auth-token'];
  if (headerToken && authTokens[headerToken]) return authTokens[headerToken];

  const sessionToken = req.session && req.session.authToken;
  if (sessionToken && authTokens[sessionToken]) return authTokens[sessionToken];

  return null;
}

function requireRole(role) {
  return (req, res, next) => {
    const auth = getAuth(req);
    if (!auth || auth.role !== role) {
      return res.status(403).json({ error: 'forbidden' });
    }
    req.auth = auth;
    next();
  };
}

function requirePageRole(role) {
  return (req, res, next) => {
    const auth = getAuth(req);
    if (!auth || auth.role !== role) {
      return res.redirect('/login');
    }
    req.auth = auth;
    next();
  };
}

function buildLoginOptions() {
  return Object.entries(authTokens).map(([token, info]) => ({
    token,
    label: info.role === 'judge'
      ? `Judge (${info.judgeId})`
      : info.role.charAt(0).toUpperCase() + info.role.slice(1)
  }));
}

app.get('/login', (req, res) => {
  res.render('login', { options: buildLoginOptions(), error: null });
});

app.post('/login', (req, res) => {
  const token = req.body.token;
  if (!token || !authTokens[token]) {
    return res.render('login', {
      options: buildLoginOptions(),
      error: 'Invalid selection, please try again.'
    });
  }
  req.session.authToken = token;
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/dashboard', (req, res) => {
  const auth = getAuth(req);
  if (!auth) return res.redirect('/login');

  if (auth.role === 'organizer') return res.redirect('/organizer');
  if (auth.role === 'judge') return res.redirect('/judge');
  if (auth.role === 'participant') return res.redirect('/participant');
  res.redirect('/login');
});

app.get('/projects', (req, res) => {
  const projects = db.prepare('SELECT * FROM projects').all();
  const auth = getAuth(req);
  res.render('gallery', { projects, auth });
});

app.post('/projects/new', (req, res) => {
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

app.get('/api/judge/scores', requireRole('judge'), (req, res) => {
  const rows = db.prepare('SELECT * FROM scores WHERE judge_id = ?').all(req.auth.judgeId);
  res.json(rows);
});

app.get('/api/judge/scores/peer', (req, res) => {
  const auth = getAuth(req);
  const requestedJudgeId = req.query.judge;
  if (!auth || auth.role !== 'judge' || auth.judgeId !== requestedJudgeId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const rows = db.prepare('SELECT * FROM scores WHERE judge_id = ?').all(requestedJudgeId);
  res.json(rows);
});

app.get('/organizer', requirePageRole('organizer'), (req, res) => {
  const projectCount = db.prepare('SELECT COUNT(*) as c FROM projects').get().c;
  const scoreCount = db.prepare('SELECT COUNT(*) as c FROM scores').get().c;
  const judgeCount = db.prepare('SELECT COUNT(*) as c FROM judges').get().c;
  res.render('organizer', { projectCount, scoreCount, judgeCount });
});

app.get('/judge', requirePageRole('judge'), (req, res) => {
  const rows = db.prepare(`
    SELECT scores.*, projects.title FROM scores
    JOIN projects ON projects.id = scores.project_id
    WHERE judge_id = ?
  `).all(req.auth.judgeId);
  res.render('judge', { scores: rows, judgeId: req.auth.judgeId });
});

app.get('/participant', requirePageRole('participant'), (req, res) => {
  res.render('participant', {
    eventClose,
    email: req.auth.email,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

app.get('/api/export.csv', requireRole('organizer'), (req, res) => {
  const rows = db.prepare('SELECT * FROM scores').all();
  let csv = 'judge_id,project_id,criteria,comment\n';
  rows.forEach(r => {
    csv += `${r.judge_id},${r.project_id},"${r.criteria.replace(/"/g, '""')}","${(r.comment||'').replace(/"/g, '""')}"\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('\n=== AUTH TOKENS (paste into .dogfood.toml) ===');
  Object.entries(authTokens).forEach(([token, info]) => {
    console.log(`${info.role}${info.judgeId ? ' ('+info.judgeId+')' : ''}: X-Auth-Token: ${token}`);
  });
  console.log('===============================================\n');
});