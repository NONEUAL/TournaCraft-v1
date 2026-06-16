/**
 * backend/api/matches.js
 *
 * Match score update endpoint.
 * Accepts a score update and applies it server-side using the same
 * bracket logic the frontend uses — no score can be written directly
 * into the JSONB without going through the bracket engine.
 *
 * Routes:
 *   POST /api/matches/:tournamentId/score
 *     Body: { matchId, score1, score2, winnerId, phaseKey, groupId? }
 *
 *   GET  /api/matches/:tournamentId/pending
 *     Returns all matches with status 'pending' that are ready to play
 *     (both teams filled in). Useful for scorekeepers.
 */

'use strict';

const router = require('express').Router();
const { query, transaction } = require('../database/db');
const { broadcast } = require('../realtime/index');
const { validateTournamentId } = require('./validate');

// ── POST /api/matches/:tournamentId/score ─────────────────────
router.post('/:tournamentId/score', async (req, res, next) => {
  try {
    const { tournamentId } = req.params;
    if (!validateTournamentId(tournamentId)) {
      return res.status(400).json({ error: 'Invalid tournament ID.' });
    }

    const { matchId, score1, score2, winnerId, phaseKey, groupId } = req.body;

    // Basic input validation
    if (!matchId || typeof matchId !== 'string') {
      return res.status(400).json({ error: 'matchId is required.' });
    }
    const s1 = parseInt(score1, 10);
    const s2 = parseInt(score2, 10);
    if (isNaN(s1) || isNaN(s2) || s1 < 0 || s2 < 0) {
      return res.status(400).json({ error: 'Scores must be non-negative integers.' });
    }
    if (s1 === s2) {
      return res.status(400).json({ error: 'A match must have a winner — scores cannot be equal.' });
    }
    if (!winnerId) {
      return res.status(400).json({ error: 'winnerId is required.' });
    }

    const updatedTournament = await transaction(async (client) => {
      // Fetch current tournament with a row lock to prevent concurrent updates
      const { rows } = await client.query(
        'SELECT data FROM tournaments WHERE id = $1 AND deleted = FALSE FOR UPDATE',
        [tournamentId]
      );
      if (!rows.length) throw Object.assign(new Error('Tournament not found.'), { status: 404 });

      const tournament = rows[0].data;

      // Apply score update using the same logic as the frontend.
      // The server re-runs the bracket engine on the stored tournament data
      // so the bracket state is always authoritative.
      let updated;
      if (phaseKey === 'groups' && groupId) {
        updated = applyGroupScore(tournament, groupId, matchId, s1, s2, winnerId);
      } else {
        updated = applyBracketScore(tournament, matchId, s1, s2, winnerId);
      }

      updated.updatedAt = Date.now();

      // Write back
      await client.query(
        `UPDATE tournaments
         SET data = $2, updated_at = $3, status = $4
         WHERE id = $1`,
        [tournamentId, JSON.stringify(updated), updated.updatedAt, updated.status || 'active']
      );

      // Audit log
      await client.query(
        `INSERT INTO sync_log (tournament_id, operation, client_id, payload_diff)
         VALUES ($1, 'update', $2, $3)`,
        [
          tournamentId,
          req.headers['x-client-id'] || null,
          JSON.stringify({ matchId, score1: s1, score2: s2, winnerId }),
        ]
      );

      return updated;
    });

    // Broadcast to viewers immediately
    broadcast(tournamentId, { type: 'update', tournament: updatedTournament });

    res.json({ data: updatedTournament });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── GET /api/matches/:tournamentId/pending ────────────────────
router.get('/:tournamentId/pending', async (req, res, next) => {
  try {
    const { tournamentId } = req.params;
    if (!validateTournamentId(tournamentId)) {
      return res.status(400).json({ error: 'Invalid tournament ID.' });
    }

    const { rows } = await query(
      'SELECT data FROM tournaments WHERE id = $1 AND deleted = FALSE LIMIT 1',
      [tournamentId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Tournament not found.' });
    }

    const tournament = rows[0].data;
    const pending    = collectPendingMatches(tournament);

    res.json({ data: pending });
  } catch (err) {
    next(err);
  }
});

// ── Bracket engine wrappers ───────────────────────────────────
// The server does NOT import the frontend JS files (they're browser modules).
// Instead it implements minimal versions of the update logic that operate
// purely on the data model. For full correctness, consider extracting the
// bracket engines into a shared npm package in a future refactor.

function applyGroupScore(tournament, groupId, matchId, s1, s2, winnerId) {
  const t     = JSON.parse(JSON.stringify(tournament));
  const group = t.groups?.find(g => g.name === groupId);
  if (!group) throw Object.assign(new Error(`Group ${groupId} not found.`), { status: 422 });

  const match = group.matches?.find(m => m.id === matchId);
  if (!match) throw Object.assign(new Error(`Match ${matchId} not found in Group ${groupId}.`), { status: 422 });

  // Validate winner is one of the two teams
  if (winnerId !== match.team1Id && winnerId !== match.team2Id) {
    throw Object.assign(new Error('winnerId must be one of the two competing teams.'), { status: 422 });
  }

  match.score1   = s1;
  match.score2   = s2;
  match.winnerId = winnerId;
  match.status   = 'completed';

  // Recompute group standings (simple wins/losses, no full engine needed server-side)
  group.standings = recalculateGroupStandings(group, t.teams);

  // Mark group complete if all matches done
  if (group.matches.every(m => m.status === 'completed')) {
    group.completed = true;
  }

  // Seed playoffs if all groups done
  if (t.groups.every(g => g.completed)) {
    seedPlayoffsServer(t);
  }

  return t;
}

function applyBracketScore(tournament, matchId, s1, s2, winnerId) {
  const t = JSON.parse(JSON.stringify(tournament));

  // Find match across WB, LB, GF
  let match = null, phase = null;
  for (const round of t.winnersBracket?.rounds || []) {
    const m = round.matches.find(m => m.id === matchId);
    if (m) { match = m; phase = 'winnersBracket'; break; }
  }
  if (!match) {
    for (const round of t.losersBracket?.rounds || []) {
      const m = round.matches.find(m => m.id === matchId);
      if (m) { match = m; phase = 'losersBracket'; break; }
    }
  }
  if (!match && t.grandFinals?.series1?.id === matchId) {
    match = t.grandFinals.series1; phase = 'grandFinals';
  }
  if (!match && t.grandFinals?.series2?.id === matchId) {
    match = t.grandFinals.series2; phase = 'grandFinals';
  }
  if (!match) throw Object.assign(new Error(`Match ${matchId} not found.`), { status: 422 });

  if (winnerId !== match.team1Id && winnerId !== match.team2Id) {
    throw Object.assign(new Error('winnerId must be one of the two competing teams.'), { status: 422 });
  }

  const loserId  = match.team1Id === winnerId ? match.team2Id : match.team1Id;
  match.score1   = s1;
  match.score2   = s2;
  match.winnerId = winnerId;
  match.loserId  = loserId;
  match.status   = 'completed';

  // Advance winner / drop loser using the same algorithms as the frontend
  if (phase === 'winnersBracket') {
    serverAdvanceWB(t, match);
    serverDropToLB(t, match);
  } else if (phase === 'losersBracket') {
    serverAdvanceLB(t, match);
  } else if (phase === 'grandFinals') {
    serverResolveGF(t, match);
  }

  if (t.championId) t.status = 'done';
  return t;
}

// ── Minimal server-side bracket advance functions ─────────────
// Mirror of the fixed doubleElim.js logic — kept in sync manually.
// A future refactor should extract these into a shared `@province-games/bracket` package.

function serverAdvanceWB(t, match) {
  const { round, matchNum } = match;
  const rounds    = t.winnersBracket.rounds;
  const lastRound = rounds[rounds.length - 1].round;
  if (round === lastRound) {
    t.grandFinals.series1.team1Id = match.winnerId;
    return;
  }
  const nextRound = rounds.find(r => r.round === round + 1);
  if (!nextRound) return;
  const idx  = Math.floor((matchNum - 1) / 2);
  const slot = (matchNum - 1) % 2 === 0 ? 'team1Id' : 'team2Id';
  if (nextRound.matches[idx]) nextRound.matches[idx][slot] = match.winnerId;
}

function serverDropToLB(t, match) {
  const { round, matchNum } = match;
  const lbRounds = t.losersBracket.rounds;
  if (round === 1) {
    const lbR1 = lbRounds.find(r => r.round === 1);
    if (!lbR1) return;
    const idx  = Math.floor((matchNum - 1) / 2);
    const slot = (matchNum - 1) % 2 === 0 ? 'team2Id' : 'team1Id';
    if (lbR1.matches[idx]) lbR1.matches[idx][slot] = match.loserId;
  } else {
    const lbRound = lbRounds.find(r => r.round === 2 * (round - 1));
    if (!lbRound) return;
    const lbMatch = lbRound.matches[matchNum - 1];
    if (lbMatch) lbMatch.team2Id = match.loserId;
  }
}

function serverAdvanceLB(t, match) {
  const { round, matchNum } = match;
  const lbRounds  = t.losersBracket.rounds;
  const lastRound = lbRounds[lbRounds.length - 1].round;

  if (round === lastRound) {
    t.grandFinals.series1.team2Id = match.winnerId;
    return;
  }

  const nextRound = lbRounds.find(r => r.round === round + 1);
  if (!nextRound) return;

  const isCurrentDropIn = round % 2 === 1;
  const isNextDropIn    = (round + 1) % 2 === 1;
  const currentRound    = lbRounds.find(r => r.round === round);

  if (isCurrentDropIn) {
    // Drop-in winner waits as team1Id for WB loser (team2Id)
    const nextMatch = nextRound.matches[matchNum - 1];
    if (nextMatch) nextMatch.team1Id = match.winnerId;
  } else {
    if (isNextDropIn) {
      // Survivor into drop-in: use floor if next round has fewer matches
      const sameCount = nextRound.matches.length === (currentRound?.matches.length || 0);
      const idx = sameCount ? matchNum - 1 : Math.floor((matchNum - 1) / 2);
      const nextMatch = nextRound.matches[idx];
      if (nextMatch) nextMatch.team1Id = match.winnerId;
    } else {
      // Survivor into survivor: pair up
      const idx  = Math.floor((matchNum - 1) / 2);
      const slot = (matchNum - 1) % 2 === 0 ? 'team1Id' : 'team2Id';
      if (nextRound.matches[idx]) nextRound.matches[idx][slot] = match.winnerId;
    }
  }
}

function serverResolveGF(t, match) {
  const gf = t.grandFinals;
  if (match.id === gf.series1.id) {
    if (match.winnerId !== gf.series1.team1Id) {
      gf.bracketReset = true;
      gf.series2 = {
        id:       `GF2-${Date.now()}`,
        phaseKey: 'grandFinals',
        team1Id:  gf.series1.team2Id,
        team2Id:  gf.series1.team1Id,
        score1: null, score2: null, winnerId: null,
        games: [], bestOf: 5, status: 'pending',
      };
    } else {
      t.championId = match.winnerId;
    }
  } else if (gf.series2 && match.id === gf.series2.id) {
    t.championId = match.winnerId;
  }
}

function recalculateGroupStandings(group, teams) {
  const map = {};
  (group.teamIds || []).forEach(id => {
    map[id] = { teamId: id, wins: 0, losses: 0, gamesWon: 0, gamesLost: 0, gameDiff: 0, points: 0, played: 0, advanced: false, advanceTo: null };
  });
  (group.matches || []).filter(m => m.status === 'completed').forEach(m => {
    const a = map[m.team1Id], b = map[m.team2Id];
    if (!a || !b) return;
    a.played++; b.played++;
    a.gamesWon += m.score1 ?? 0; a.gamesLost += m.score2 ?? 0;
    b.gamesWon += m.score2 ?? 0; b.gamesLost += m.score1 ?? 0;
    if (m.winnerId === m.team1Id) { a.wins++; a.points += 2; b.losses++; }
    else { b.wins++; b.points += 2; a.losses++; }
  });
  Object.values(map).forEach(s => { s.gameDiff = s.gamesWon - s.gamesLost; });
  const sorted = Object.values(map).sort((a, b) =>
    b.wins !== a.wins ? b.wins - a.wins : b.gameDiff - a.gameDiff
  );
  sorted.forEach((s, i) => {
    if (i < 2) { s.advanced = true; s.advanceTo = 'winnersBracket'; }
    else if (i === 2) { s.advanced = true; s.advanceTo = 'losersBracket'; }
  });
  return sorted;
}

function seedPlayoffsServer(t) {
  const advByGroup = {};
  t.groups.forEach(g => {
    const wb = g.standings.filter(s => s.advanceTo === 'winnersBracket').map(s => t.teams.find(tm => tm.id === s.teamId)).filter(Boolean);
    const lb = g.standings.filter(s => s.advanceTo === 'losersBracket').map(s => t.teams.find(tm => tm.id === s.teamId)).filter(Boolean);
    advByGroup[g.name] = { wb, lb };
  });
  const wbR1 = t.winnersBracket?.rounds?.find(r => r.round === 1);
  if (wbR1) {
    const pairs = [
      [advByGroup['A']?.wb[0], advByGroup['D']?.wb[1]],
      [advByGroup['B']?.wb[0], advByGroup['C']?.wb[1]],
      [advByGroup['C']?.wb[0], advByGroup['B']?.wb[1]],
      [advByGroup['D']?.wb[0], advByGroup['A']?.wb[1]],
    ];
    pairs.forEach(([t1, t2], i) => {
      const m = wbR1.matches[i];
      if (m) { m.team1Id = t1?.id ?? null; m.team2Id = t2?.id ?? null; m.phaseKey = 'winnersBracket'; m.status = t1 && t2 ? 'pending' : 'waiting'; }
    });
  }
  const lbR1 = t.losersBracket?.rounds?.find(r => r.round === 1);
  if (lbR1) {
    const pairs = [[advByGroup['A']?.lb[0], advByGroup['B']?.lb[0]], [advByGroup['C']?.lb[0], advByGroup['D']?.lb[0]]];
    pairs.forEach(([t1, t2], i) => {
      const m = lbR1.matches[i];
      if (m) { m.team1Id = t1?.id ?? null; m.team2Id = t2?.id ?? null; m.phaseKey = 'losersBracket'; m.status = 'pending'; }
    });
  }
  t.winnersBracket?.rounds?.forEach(r => r.matches.forEach(m => { m.phaseKey = 'winnersBracket'; }));
  t.losersBracket?.rounds?.forEach(r => r.matches.forEach(m => { m.phaseKey = 'losersBracket'; }));
  t.phase = 'playoffs';
}

function collectPendingMatches(tournament) {
  const pending = [];
  const push = (match, phase) => {
    if (match.status === 'pending' && match.team1Id && match.team2Id) {
      const t1 = tournament.teams?.find(t => t.id === match.team1Id);
      const t2 = tournament.teams?.find(t => t.id === match.team2Id);
      pending.push({ ...match, phase, team1Name: t1?.name, team2Name: t2?.name });
    }
  };
  tournament.groups?.forEach(g => g.matches?.forEach(m => push(m, `Group ${g.name}`)));
  tournament.winnersBracket?.rounds?.forEach(r => r.matches.forEach(m => push(m, r.label)));
  tournament.losersBracket?.rounds?.forEach(r => r.matches.forEach(m => push(m, r.label)));
  if (tournament.grandFinals?.series1) push(tournament.grandFinals.series1, 'Grand Finals');
  if (tournament.grandFinals?.series2) push(tournament.grandFinals.series2, 'Grand Finals Reset');
  return pending;
}

module.exports = router;
