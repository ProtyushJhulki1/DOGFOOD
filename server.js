const express = require('express');
const path = require('path');
const { initDb } = require('./db/init');

const app = express();
const PORT = 8080;

const { db, authTokens, eventClose } = initDb();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

function getAuth(req) {
  const token = req.headers['x-auth-token'];
  if (!token || !authTokens[token]) return null;
  return authTokens[token];
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

app.get('/projects', (req, res) => {
  const projects = db.prepare('SELECT * FROM projects').all();
  res.render('gallery', { projects });
});

app.post('/projects/new', (req, res) => {
  const auth = getAuth(req);
  if (!auth || auth.role !== 'participant') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const closeDate = new Date(eventClose);
  if (new Date() > closeDate) {
    return res.status(403).json({ error: 'submissions are closed' });
  }
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