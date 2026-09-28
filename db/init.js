const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function initDb() {
  const db = new DatabaseSync(':memory:');

  const schema = [
    'CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, submissions_close TEXT, start_date TEXT, end_date TEXT, registration_open TEXT, registration_close TEXT, prizes TEXT, rules TEXT)',
    'CREATE TABLE tracks (id TEXT PRIMARY KEY, name TEXT)',
    'CREATE TABLE judges (id TEXT PRIMARY KEY, name TEXT, email TEXT)',
    'CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT, event_id TEXT)',
    'CREATE TABLE team_members (team_id TEXT, email TEXT)',
    'CREATE TABLE team_invites (id TEXT PRIMARY KEY, team_id TEXT, token TEXT, invited_email TEXT, status TEXT)',
    'CREATE TABLE projects (id TEXT PRIMARY KEY, team_id TEXT, track_id TEXT, title TEXT, summary TEXT, repo_url TEXT, submitted_at TEXT)',
    'CREATE TABLE scores (judge_id TEXT, project_id TEXT, criteria TEXT, comment TEXT)',
    'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, role TEXT)',
    'CREATE TABLE judge_invites (id TEXT PRIMARY KEY, judge_id TEXT, event_id TEXT, status TEXT)',
    'CREATE TABLE judge_assignments (judge_id TEXT, project_id TEXT, PRIMARY KEY (judge_id, project_id))',
    'CREATE TABLE score_drafts (judge_id TEXT, project_id TEXT, criteria TEXT, comment TEXT, updated_at TEXT, PRIMARY KEY (judge_id, project_id))'
  ];
  schema.forEach(function (sql) { db.exec(sql); });

  const raw = fs.readFileSync(path.join(__dirname, '..', 'fixtures.json'), 'utf8');
  const data = JSON.parse(raw);

  const insertEvent = db.prepare('INSERT INTO events (id, name, submissions_close, start_date, end_date, registration_open, registration_close, prizes, rules) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertEvent.run(data.event.id, data.event.name, data.event.submissions_close, null, null, null, null, null, null);

  const insertTrack = db.prepare('INSERT INTO tracks VALUES (?, ?)');
  data.tracks.forEach(function (t) { insertTrack.run(t.id, t.name); });

  const insertJudge = db.prepare('INSERT INTO judges VALUES (?, ?, ?)');
  data.judges.forEach(function (j) { insertJudge.run(j.id, j.name, j.email); });

  const insertTeam = db.prepare('INSERT INTO teams VALUES (?, ?, ?)');
  const insertMember = db.prepare('INSERT INTO team_members VALUES (?, ?)');
  data.teams.forEach(function (t) {
    insertTeam.run(t.id, t.name, data.event.id);
    (t.members || []).forEach(function (email) { insertMember.run(t.id, email); });
  });

  const insertProject = db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)');
  data.projects.forEach(function (p) {
    insertProject.run(p.id, p.team, p.track, p.title, p.summary, p.repo_url, p.submitted_at);
  });

  const insertScore = db.prepare('INSERT INTO scores VALUES (?, ?, ?, ?)');
  data.scores.forEach(function (s) {
    insertScore.run(s.judge, s.project, JSON.stringify(s.criteria), s.comment || '');
  });

  const demoEvents = [
    { id: 'evt_demo_1', name: '[Demo] Spring Sprint 2026', close: '2099-01-01T00:00:00Z' },
    { id: 'evt_demo_2', name: '[Demo] Autumn Build Week', close: '2099-01-01T00:00:00Z' }
  ];

  demoEvents.forEach(function (e) {
    insertEvent.run(e.id, e.name, e.close, null, null, null, null, null, null);
  });

  demoEvents.forEach(function (e) {
    for (let i = 1; i <= 2; i++) {
      const teamId = e.id + '_team_' + i;
      insertTeam.run(teamId, e.name + ' Team ' + i, e.id);
      insertProject.run(
        e.id + '_prj_' + i,
        teamId,
        data.tracks[0] ? data.tracks[0].id : null,
        e.name + ' Sample Project ' + i,
        'A placeholder project for this demo event.',
        'https://github.com/example/demo',
        new Date().toISOString()
      );
    }
  });

  // Judge assignments: everything a judge already scored in the fixtures counts as assigned.
  const insertAssignment = db.prepare('INSERT OR IGNORE INTO judge_assignments VALUES (?, ?)');
  const scoredBy = {};
  data.scores.forEach(function (s) {
    insertAssignment.run(s.judge, s.project);
    if (!scoredBy[s.judge]) scoredBy[s.judge] = {};
    scoredBy[s.judge][s.project] = true;
  });

  // The two demo judges also get a few unscored projects, so the scoring flow can be demoed.
  const demoJudgeIds = [data.judges[0].id, data.judges[1].id];
  demoJudgeIds.forEach(function (jid, idx) {
    const candidates = data.projects.filter(function (p) {
      return !(scoredBy[jid] && scoredBy[jid][p.id]);
    });
    candidates.slice(idx * 3, idx * 3 + 3).forEach(function (p) {
      insertAssignment.run(jid, p.id);
    });
  });

  // Demo judges get a pending invite to the first demo event, with two projects waiting behind it.
  const insertJudgeInvite = db.prepare('INSERT INTO judge_invites VALUES (?, ?, ?, ?)');
  demoJudgeIds.forEach(function (jid) {
    insertJudgeInvite.run('jinv_' + jid + '_demo1', jid, 'evt_demo_1', 'pending');
    insertAssignment.run(jid, 'evt_demo_1_prj_1');
    insertAssignment.run(jid, 'evt_demo_1_prj_2');
  });

  const judgeIds = data.judges.map(function (j) { return j.id; });
  const firstMemberEmail = data.teams[0] && data.teams[0].members ? data.teams[0].members[0] : null;

  const authTokens = {
    'org_fixed_token': { role: 'organizer' },
    'adm_fixed_token': { role: 'admin' },
    'jdga_fixed_token': { role: 'judge', judgeId: judgeIds[0] },
    'jdgb_fixed_token': { role: 'judge', judgeId: judgeIds[1] },
    'prt_fixed_token': { role: 'participant', email: firstMemberEmail }
  };

  return { db: db, authTokens: authTokens, eventClose: data.event.submissions_close };
}

module.exports = { initDb };