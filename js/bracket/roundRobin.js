/**
 * js/bracket/roundRobin.js
 *
 * Round Robin bracket engine.
 * Implements the circle (polygon) rotation algorithm for scheduling:
 * - Fix one team, rotate the rest to generate balanced match pairings
 * - Every team plays every other team exactly once
 * - Supports odd and even team counts (bye handling for odd counts)
 * - Produces standings with win/loss/game-differential tiebreakers
 *
 * Used by: app.js, mobileLegends.js (group stage)
 */

'use strict';

const RoundRobinBracket = (() => {

  let _seq = 0;
  function newMatchId(prefix = 'RR') {
    return `${prefix}-${Date.now()}-${++_seq}`;
  }

  function generateId() {
    return `T-RR-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  }

  function generateShareCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  // ================================================================
  // TOURNAMENT FACTORY
  // ================================================================

  /**
   * Create a full round-robin tournament.
   * @param {Object} formData — name, game, format, date, venue
   * @param {Array}  teams    — [{ id, name, seed }]
   * @returns {Object} tournament
   */
  function createTournament(formData, teams) {
    if (!teams || teams.length < 2) throw new Error('Need at least 2 teams for round robin.');

    const matches   = generateSchedule(teams);
    const standings = initStandings(teams);

    return {
      id:         generateId(),
      shareCode:  generateShareCode(),
      name:       formData.name,
      game:       formData.game,
      format:     'round_robin',
      date:       formData.date || '',
      venue:      formData.venue || '',
      status:     'active',
      createdAt:  Date.now(),
      updatedAt:  Date.now(),
      teams,
      roundRobin: {
        matches,
        standings,
        totalRounds: Math.ceil(matches.length / Math.floor(teams.length / 2)),
      }
    };
  }

  // ================================================================
  // CIRCLE ROTATION ALGORITHM
  // ================================================================

  /**
   * Generate a complete round-robin schedule using the circle method.
   *
   * Algorithm:
   * 1. If odd number of teams, add a virtual BYE team.
   * 2. Fix team at position 0; rotate all others clockwise each round.
   * 3. In each round, pair position 0 with position N/2, then
   *    position 1 with N-1, position 2 with N-2, etc.
   * 4. For N teams: N-1 rounds (or N rounds if odd).
   *
   * @param {Array} teams
   * @returns {Array} matches
   */
  function generateSchedule(teams) {
    const list = [...teams];
    const hasOddCount = list.length % 2 !== 0;

    // Add BYE for odd team count so rotation works cleanly
    if (hasOddCount) {
      list.push({ id: 'BYE', name: 'BYE', seed: 9999, isBye: true });
    }

    const n       = list.length;        // Must be even
    const numRounds = n - 1;
    const matchesPerRound = n / 2;
    const matches = [];

    // Working rotation array: position 0 is fixed, rest rotate
    const rotation = list.map((_, i) => i);

    for (let round = 1; round <= numRounds; round++) {
      for (let slot = 0; slot < matchesPerRound; slot++) {
        const idxA = slot === 0 ? rotation[0] : rotation[slot];
        const idxB = rotation[n - 1 - (slot === 0 ? 0 : slot - 1) - (slot === 0 ? 0 : 0)];

        // Corrected pairing: pair slot i with slot n-1-i (except slot 0 fixed)
        let posA, posB;
        if (slot === 0) {
          posA = rotation[0];
          posB = rotation[n - 1];
        } else {
          posA = rotation[slot];
          posB = rotation[n - 1 - slot];
        }

        const teamA = list[posA];
        const teamB = list[posB];

        // Skip if either is BYE
        if (teamA?.isBye || teamB?.isBye) continue;

        matches.push({
          id:      newMatchId('RR'),
          phaseKey:'roundRobin',
          round,
          matchNum: matches.length + 1,
          team1Id:  teamA.id,
          team2Id:  teamB.id,
          score1:   null,
          score2:   null,
          winnerId: null,
          games:    [],
          bestOf:   3,
          status:   'pending',
        });
      }

      // Rotate: keep position 0 fixed, shift positions 1..n-1 clockwise
      rotateSlice(rotation, 1);
    }

    return matches;
  }

  /**
   * Rotate array slice [startIndex..end] by one position clockwise.
   * e.g. [0, 1, 2, 3, 4] → rotate from index 1 → [0, 4, 1, 2, 3]
   */
  function rotateSlice(arr, startIndex) {
    const last = arr[arr.length - 1];
    for (let i = arr.length - 1; i > startIndex; i--) {
      arr[i] = arr[i - 1];
    }
    arr[startIndex] = last;
  }

  // ================================================================
  // STANDINGS
  // ================================================================

  /**
   * Initialise zeroed standings for all teams.
   */
  function initStandings(teams) {
    return teams.map(team => ({
      teamId:   team.id,
      wins:     0,
      losses:   0,
      gamesWon: 0,
      gamesLost:0,
      gameDiff: 0,
      points:   0,   // 2pts per win, 0 per loss
      played:   0,
      advanced: false,
    }));
  }

  /**
   * Recompute standings from scratch based on all completed matches.
   * Tiebreaker order: Points → Win % → Game diff → Head-to-head.
   *
   * @param {Array} standings   — current standings array
   * @param {Array} matches     — all matches (completed + pending)
   * @param {Array} teams       — team list
   * @returns {Array} sorted standings
   */
  function recalculateStandings(standings, matches, teams) {
    // Reset
    const map = {};
    teams.forEach(t => {
      map[t.id] = {
        teamId:    t.id,
        wins:      0, losses:    0,
        gamesWon:  0, gamesLost: 0,
        gameDiff:  0, points:    0,
        played:    0, advanced:  false,
      };
    });

    // Accumulate from completed matches
    matches.filter(m => m.status === 'completed').forEach(m => {
      const a = map[m.team1Id];
      const b = map[m.team2Id];
      if (!a || !b) return;

      a.played++;
      b.played++;
      a.gamesWon  += m.score1 ?? 0;
      a.gamesLost += m.score2 ?? 0;
      b.gamesWon  += m.score2 ?? 0;
      b.gamesLost += m.score1 ?? 0;

      if (m.winnerId === m.team1Id) {
        a.wins++;   a.points += 2;
        b.losses++;
      } else {
        b.wins++;   b.points += 2;
        a.losses++;
      }
    });

    // Compute game diff
    Object.values(map).forEach(s => {
      s.gameDiff = s.gamesWon - s.gamesLost;
    });

    // Sort: points desc → gameDiff desc → gamesWon desc
    const sorted = Object.values(map).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.gameDiff !== a.gameDiff) return b.gameDiff - a.gameDiff;
      return b.gamesWon - a.gamesWon;
    });

    return sorted;
  }

  // ================================================================
  // MATCH UPDATE
  // ================================================================

  /**
   * Record a match result and recompute standings.
   * @param {Object} tournament
   * @param {string} matchId
   * @param {number} score1
   * @param {number} score2
   * @param {string} winnerId
   * @returns {Object} updated tournament
   */
  function updateMatch(tournament, matchId, score1, score2, winnerId) {
    const t = JSON.parse(JSON.stringify(tournament)); // deep clone

    const match = t.roundRobin.matches.find(m => m.id === matchId);
    if (!match) throw new Error(`Match ${matchId} not found in round robin.`);

    match.score1   = score1;
    match.score2   = score2;
    match.winnerId = winnerId;
    match.status   = 'completed';
    t.updatedAt    = Date.now();

    // Recompute standings
    t.roundRobin.standings = recalculateStandings(
      t.roundRobin.standings,
      t.roundRobin.matches,
      t.teams
    );

    // Check if all matches are done
    const allDone = t.roundRobin.matches.every(m => m.status === 'completed');
    if (allDone) t.status = 'done';

    return t;
  }

  // ================================================================
  // GROUP STAGE HELPER (used by mobileLegends.js)
  // ================================================================

  /**
   * Generate round-robin matches for a single group.
   * Returns matches array with groupId stamped on each match.
   *
   * @param {Array}  teams    — group teams [{ id, name, seed }]
   * @param {string} groupId  — e.g. 'A'
   * @param {string} matchPrefix — e.g. 'GA' for Group A
   * @returns {Array} matches
   */
  function generateGroupMatches(teams, groupId, matchPrefix = 'G') {
    const matches = generateSchedule(teams);
    return matches.map(m => ({
      ...m,
      id:      newMatchId(matchPrefix),
      groupId,
      phaseKey:'groups',
    }));
  }

  /**
   * Initial standings for a group.
   * Same shape as full RR standings.
   */
  function initGroupStandings(teams) {
    return teams.map(team => ({
      teamId:    team.id,
      wins:      0,
      losses:    0,
      gamesWon:  0,
      gamesLost: 0,
      gameDiff:  0,
      points:    0,
      played:    0,
      advanced:  false,
      advanceTo: null, // 'winnersBracket' | 'losersBracket' | null
    }));
  }

  /**
   * Recompute standings for a single group.
   * Returns standings sorted by: Wins → Game diff → Games won.
   * Also marks advancement slots (top 2 → WB, 3rd → LB, 4th → eliminated).
   *
   * @param {Array} matches  — group matches
   * @param {Array} teams    — group teams
   * @param {Object} opts    — { advanceToWB: 2, advanceToLB: 1 }
   * @returns {Array} sorted standings with advanceTo field set
   */
  function recalculateGroupStandings(matches, teams, opts = {}) {
    const { advanceToWB = 2, advanceToLB = 1 } = opts;

    const map = {};
    teams.forEach(t => {
      map[t.id] = {
        teamId: t.id, wins: 0, losses: 0,
        gamesWon: 0, gamesLost: 0, gameDiff: 0,
        points: 0, played: 0, advanced: false, advanceTo: null,
      };
    });

    matches.filter(m => m.status === 'completed').forEach(m => {
      const a = map[m.team1Id];
      const b = map[m.team2Id];
      if (!a || !b) return;

      a.played++;  b.played++;
      a.gamesWon  += m.score1 ?? 0;
      a.gamesLost += m.score2 ?? 0;
      b.gamesWon  += m.score2 ?? 0;
      b.gamesLost += m.score1 ?? 0;

      if (m.winnerId === m.team1Id) {
        a.wins++; a.points += 2; b.losses++;
      } else {
        b.wins++; b.points += 2; a.losses++;
      }
    });

    Object.values(map).forEach(s => { s.gameDiff = s.gamesWon - s.gamesLost; });

    const sorted = Object.values(map).sort((a, b) => {
      if (b.wins    !== a.wins)     return b.wins - a.wins;
      if (b.gameDiff!== a.gameDiff) return b.gameDiff - a.gameDiff;
      return b.gamesWon - a.gamesWon;
    });

    // Assign advancement slots
    sorted.forEach((s, i) => {
      if (i < advanceToWB) {
        s.advanced  = true;
        s.advanceTo = 'winnersBracket';
      } else if (i < advanceToWB + advanceToLB) {
        s.advanced  = true;
        s.advanceTo = 'losersBracket';
      } else {
        s.advanced  = false;
        s.advanceTo = null;
      }
    });

    return sorted;
  }

  // ================================================================
  // PUBLIC API
  // ================================================================

  return {
    createTournament,
    updateMatch,
    generateSchedule,
    generateGroupMatches,
    initGroupStandings,
    recalculateGroupStandings,
    recalculateStandings,
    initStandings,
  };

})();

window.RoundRobinBracket = RoundRobinBracket;
