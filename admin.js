module.exports = function mountAdmin(app, db, getAuth, requirePageRole, csvCell) {
  const ROLES = ['participant', 'organizer', 'admin'];

  db.exec('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, role TEXT, method TEXT, route TEXT, status INTEGER)');

  app.use(function (req, res, next) {
    res.on('finish', function () {
      try {
        if (req.method !== 'POST') return;
        const auth = getAuth(req);
        const actor = auth ? (auth.email || auth.judgeId || auth.role) : 'anonymous';
        const role = auth ? auth.role : null;
        const route = req.route && req.route.path ? req.route.path : req.path;
        db.prepare('INSERT INTO audit_log (ts, actor, role, method, route, status) VALUES (?, ?, ?, ?, ?, ?)').run(
          new Date().toISOString(), actor, role, req.method, route, res.statusCode
        );
        db.prepare('DELETE FROM audit_log WHERE id <= (SELECT MAX(id) FROM audit_log) - 2000').run();
      } catch (e) {
        // logging must never break a request
      }
    });
    next();
  });

  app.get('/admin', requirePageRole('admin'), function (req, res) {
    function count(table) {
      return db.prepare('SELECT COUNT(*) AS c FROM ' + table).get().c;
    }
    const counts = {
      users: count('users'), events: count('events'), teams: count('teams'),
      projects: count('projects'), judges: count('judges'), scores: count('scores')
    };
    const users = db.prepare('SELECT id, email, role FROM users ORDER BY email').all();
    const events = db.prepare(
      'SELECT events.id, events.name, (SELECT COUNT(*) FROM projects JOIN teams ON teams.id = projects.team_id WHERE teams.event_id = events.id) AS project_count FROM events'
    ).all();
    const audit = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 50').all();
    res.render('admin', {
      counts: counts, users: users, events: events, audit: audit, roles: ROLES,
      me: req.auth.email || null, msg: req.query.msg || null, error: req.query.error || null
    });
  });

  app.post('/admin/users/:id/role', requirePageRole('admin'), function (req, res) {
    const role = String(req.body.role || '');
    if (ROLES.indexOf(role) === -1) return res.redirect('/admin?error=invalid-role');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.redirect('/admin?error=no-such-user');
    if (req.auth.email && user.email === req.auth.email) return res.redirect('/admin?error=cannot-change-self');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
    res.redirect('/admin?msg=role-updated');
  });

  app.post('/admin/users/:id/delete', requirePageRole('admin'), function (req, res) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.redirect('/admin?error=no-such-user');
    if (req.auth.email && user.email === req.auth.email) return res.redirect('/admin?error=cannot-change-self');
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM team_members WHERE email = ?').run(user.email);
    db.prepare('DELETE FROM team_invites WHERE invited_email = ?').run(user.email);
    res.redirect('/admin?msg=user-deleted');
  });

  app.get('/admin/export/users.csv', requirePageRole('admin'), function (req, res) {
    const rows = db.prepare('SELECT id, email, role FROM users ORDER BY email').all();
    let csv = 'id,email,role\n';
    rows.forEach(function (r) {
      csv += csvCell(r.id) + ',' + csvCell(r.email) + ',' + csvCell(r.role) + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.send(csv);
  });

  app.get('/admin/export/audit.csv', requirePageRole('admin'), function (req, res) {
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
    let csv = 'id,ts,actor,role,method,route,status\n';
    rows.forEach(function (r) {
      csv += r.id + ',' + csvCell(r.ts) + ',' + csvCell(r.actor) + ',' + csvCell(r.role) + ',' +
        csvCell(r.method) + ',' + csvCell(r.route) + ',' + r.status + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
    res.send(csv);
  });
};