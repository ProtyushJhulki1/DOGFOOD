const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function initDb() {
  const db = new DatabaseSync(':memory:');

  db.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT, submissions_close TEXT);
    CREATE TABLE tracks (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE judges (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT, event_id TEXT);
    CREATE TABLE team_members (team_id TEXT, email TEXT);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, team_id TEXT, track_id TEXT,
      title TEXT, summary TEXT, repo_url TEXT, submitted_at TEXT
    );
    CREATE TABLE scores (
      judge_id TEXT, project_id TEXT, criteria TEXT, comment TEXT
    );
  `);

  const raw = fs.readFileSync(path.join(__dirname, '..', 'fixtures.json'), 'utf8');
  const data = JSON.parse(raw);

  db.prepare('INSERT INTO events VALUES (?, ?, ?)').run(
    data.event.id, data.event.name, data.event.submissions_close
  );

  const insertTrack = db.prepare('INSERT INTO tracks VALUES (?, ?)');
  data.tracks.forEach(t => insertTrack.run(t.id, t.name));

  const insertJudge = db.prepare('INSERT INTO judges VALUES (?, ?, ?)');
  data.judges.forEach(j => insertJudge.run(j.id, j.name, j.email));

  const insertTeam = db.prepare('INSERT INTO teams VALUES (?, ?, ?)');
  const insertMember = db.prepare('INSERT INTO team_members VALUES (?, ?)');
  data.teams.forEach(t => {
    insertTeam.run(t.id, t.name, data.event.id);
    (t.members || []).forEach(email => insertMember.run(t.id, email));
  });

  const insertProject = db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?)');
  data.projects.forEach(p => insertProject.run(
    p.id, p.team, p.track, p.title, p.summary, p.repo_url, p.submitted_at
  ));

  const insertScore = db.prepare('INSERT INTO scores VALUES (?, ?, ?, ?)');
  data.scores.forEach(s => insertScore.run(
    s.judge, s.project, JSON.stringify(s.criteria), s.comment || ''
  ));

  // Demo events — clearly labeled, separate from the real graded event above.
  const demoEvents = [
    { id: 'evt_demo_1', name: '[Demo] Spring Sprint 2026', close: '2099-01-01T00:00:00Z' },
    { id: 'evt_demo_2', name: '[Demo] Autumn Build Week', close: '2099-01-01T00:00:00Z' }
  ];
  const insertEvent = db.prepare('INSERT INTO events VALUES (?, ?, ?)');
  demoEvents.forEach(e => insertEvent.run(e.id, e.name, e.close));

  demoEvents.forEach(e => {
    for (let i = 1; i <= 2; i++) {
      const teamId = `${e.id}_team_${i}`;
      insertTeam.run(teamId, `${e.name} Team ${i}`, e.id);
      insertProject.run(
        `${e.id}_prj_${i}`, teamId, data.tracks[0]?.id || null,
        `${e.name} Sample Project ${i}`,
        'A placeholder project for this demo event.',
        'https://github.com/example/demo',
        new Date().toISOString()
      );
    }
  });

  const judgeIds = data.judges.map(j => j.id);
  const firstMemberEmail = data.teams[0]?.members?.[0];

  const authTokens = {
    'org_fixed_token': { role: 'organizer' },
    'jdga_fixed_token': { role: 'judge', judgeId: judgeIds[0] },
    'jdgb_fixed_token': { role: 'judge', judgeId: judgeIds[1] },
    'prt_fixed_token': { role: 'participant', email: firstMemberEmail }
  };

  return { db, authTokens, eventClose: data.event.submissions_close };
}

module.exports = { initDb };