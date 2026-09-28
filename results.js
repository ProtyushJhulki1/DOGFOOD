module.exports = function mountResults(app, db, requirePageRole, csvCell, judgeAssignments, judgeSubmittedMap) {
  const MIN_SCORES = 3;

  function totalOf(criteriaJson) {
    try {
      const obj = JSON.parse(criteriaJson);
      const vals = Object.values(obj).filter(function (v) { return typeof v === 'number'; });
      if (!vals.length) return null;
      return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    } catch (e) {
      return null;
    }
  }

  function mean(arr) {
    return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
  }

  function sd(arr, m) {
    if (arr.length < 2) return 0;
    const ss = arr.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0);
    return Math.sqrt(ss / (arr.length - 1));
  }

  function num(v, digits) {
    return typeof v === 'number' && isFinite(v) ? v.toFixed(digits) : '';
  }

  function assignRanks(list, key, rankKey) {
    const sorted = list.slice().sort(function (a, b) { return b[key] - a[key]; });
    let prevRank = 0;
    let prevVal = null;
    sorted.forEach(function (p, i) {
      if (prevVal !== null && Math.abs(p[key] - prevVal) < 1e-9) {
        p[rankKey] = prevRank;
      } else {
        p[rankKey] = i + 1;
        prevRank = i + 1;
        prevVal = p[key];
      }
    });
  }

  // Recomputed from the raw scores table on every call. Raw scores are never modified.
  function compute() {
    const rows = db.prepare(
      'SELECT scores.judge_id, scores.project_id, scores.criteria, projects.title, events.name AS event_name ' +
      'FROM scores ' +
      'JOIN projects ON projects.id = scores.project_id ' +
      'LEFT JOIN teams ON teams.id = projects.team_id ' +
      'LEFT JOIN events ON events.id = teams.event_id'
    ).all();

    const scored = [];
    rows.forEach(function (r) {
      const t = totalOf(r.criteria);
      if (t !== null) {
        scored.push({
          judge: r.judge_id, project: r.project_id, title: r.title,
          event: r.event_name || '-', total: t
        });
      }
    });

    if (!scored.length) {
      return { scoreCount: 0, gMean: null, gSd: null, judges: [], projects: [], detail: [] };
    }

    const gMean = mean(scored.map(function (s) { return s.total; }));
    const gSd = sd(scored.map(function (s) { return s.total; }), gMean);

    const byJudge = {};
    scored.forEach(function (s) {
      if (!byJudge[s.judge]) byJudge[s.judge] = [];
      byJudge[s.judge].push(s.total);
    });
    const judgeStats = {};
    Object.keys(byJudge).forEach(function (j) {
      const arr = byJudge[j];
      const m = mean(arr);
      const s = sd(arr, m);
      const usable = arr.length >= MIN_SCORES && s > 0;
      judgeStats[j] = { id: j, n: arr.length, mean: m, sd: s, method: usable ? 'judge' : 'pooled' };
    });

    scored.forEach(function (s) {
      const st = judgeStats[s.judge];
      const m = st.method === 'judge' ? st.mean : gMean;
      const d = st.method === 'judge' ? st.sd : gSd;
      s.z = d > 0 ? (s.total - m) / d : 0;
      s.method = st.method;
      s.jn = st.n;
      s.jmean = st.mean;
      s.jsd = st.sd;
    });

    const byProject = {};
    scored.forEach(function (s) {
      if (!byProject[s.project]) {
        byProject[s.project] = { id: s.project, title: s.title, event: s.event, totals: [], zs: [], fallback: 0 };
      }
      const p = byProject[s.project];
      p.totals.push(s.total);
      p.zs.push(s.z);
      if (s.method === 'pooled') p.fallback += 1;
    });

    const projects = Object.keys(byProject).map(function (id) {
      const p = byProject[id];
      const zMean = mean(p.zs);
      return {
        id: p.id, title: p.title, event: p.event, judges: p.totals.length, fallback: p.fallback,
        raw: mean(p.totals), z: zMean, adjusted: gMean + zMean * gSd
      };
    });

    assignRanks(projects, 'raw', 'rawRank');
    assignRanks(projects, 'z', 'normRank');
    projects.forEach(function (p) { p.change = p.rawRank - p.normRank; });
    projects.sort(function (a, b) {
      if (a.normRank !== b.normRank) return a.normRank - b.normRank;
      return String(a.title).localeCompare(String(b.title));
    });

    const judges = Object.keys(judgeStats).sort().map(function (j) { return judgeStats[j]; });

    return { scoreCount: scored.length, gMean: gMean, gSd: gSd, judges: judges, projects: projects, detail: scored };
  }

  app.get('/organizer/results', requirePageRole('organizer'), function (req, res) {
    res.render('results', { data: compute(), minScores: MIN_SCORES });
  });

  app.get('/organizer/results.csv', requirePageRole('organizer'), function (req, res) {
    const data = compute();
    let csv = 'norm_rank,raw_rank,project_id,project_title,event,judges,raw_mean,adjusted_mean,z_mean,pooled_fallback_scores\n';
    data.projects.forEach(function (p) {
      csv += p.normRank + ',' + p.rawRank + ',' + csvCell(p.id) + ',' + csvCell(p.title) + ',' + csvCell(p.event) + ',' +
        p.judges + ',' + num(p.raw, 3) + ',' + num(p.adjusted, 3) + ',' + num(p.z, 3) + ',' + p.fallback + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
    res.send(csv);
  });

  app.get('/organizer/results/scores.csv', requirePageRole('organizer'), function (req, res) {
    const data = compute();
    let csv = 'judge_id,project_id,project_title,raw_total,judge_score_count,judge_mean,judge_sd,method,z_score\n';
    data.detail.forEach(function (s) {
      csv += csvCell(s.judge) + ',' + csvCell(s.project) + ',' + csvCell(s.title) + ',' + num(s.total, 3) + ',' +
        s.jn + ',' + num(s.jmean, 3) + ',' + num(s.jsd, 3) + ',' + s.method + ',' + num(s.z, 3) + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="normalization-detail.csv"');
    res.send(csv);
  });

  // A judge exports only their own assignments and scores (identity comes from the session/token).
  app.get('/judge/export.csv', requirePageRole('judge'), function (req, res) {
    const judgeId = req.auth.judgeId;
    const assigned = judgeAssignments(judgeId);
    const submitted = judgeSubmittedMap(judgeId);
    let csv = 'project_id,project_title,event,status,functionality,quality,innovation,total,comment\n';
    assigned.forEach(function (a) {
      const s = submitted[a.project_id];
      let c = {};
      let total = null;
      if (s) {
        try { c = JSON.parse(s.criteria); } catch (e) { c = {}; }
        total = totalOf(s.criteria);
      }
      csv += csvCell(a.project_id) + ',' + csvCell(a.title) + ',' + csvCell(a.event_name) + ',' +
        (s ? 'submitted' : 'pending') + ',' +
        num(c.functionality, 0) + ',' + num(c.quality, 0) + ',' + num(c.innovation, 0) + ',' +
        num(total, 2) + ',' + csvCell(s ? s.comment : '') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="my-scores.csv"');
    res.send(csv);
  });
};