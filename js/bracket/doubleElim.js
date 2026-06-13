/**
 * js/bracket/doubleElim.js
 *
 * Double Elimination bracket engine.
 * Handles:
 *  - Bracket generation from a list of seeded teams
 *  - Advancing winners through the Winners Bracket
 *  - Dropping losers into the correct Losers Bracket slot
 *  - Grand Finals with optional bracket-reset series
 *
 * Used by: app.js, mobileLegends.js
 */

'use strict';

// ================================================================
// DOUBLE ELIMINATION BRACKET
// ================================================================

const DoubleElimBracket = (() => {

  // ── ID Generation ─────────────────────────────────────────────

  let _matchSeq = 0;

  function newMatchId(prefix = 'M') {
    return `${prefix}-${Date.now()}-${++_matchSeq}`;
  }

  function generateShareCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // remove confusable chars
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function generateId() {
    return `T-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  }

  // ── Tournament Shell Factory ───────────────────────────────────

  /**
   * Create a full tournament object with a seeded double-elimination bracket.
   * @param {Object} formData  — name, game, format, date, venue
   * @param {Array}  teams     — [{ id, name, seed }]
   * @returns {Object} tournament
   */
  function createTournament(formData, teams) {
    if (!teams || teams.length < 2) throw new Error('Need at least 2 teams.');
    if (teams.length > 64) throw new Error('Maximum 64 teams supported.');

    const seeded = [...teams].sort((a, b) => (a.seed || 0) - (b.seed || 0));
    const padded = padWithByes(seeded);

    const winnersBracket = buildWinnersBracket(padded, formData.game);
    const losersBracket  = buildLosersBracket(winnersBracket, formData.game);
    const grandFinals    = buildGrandFinals(formData.game);

    return {
      id:            generateId(),
      shareCode:     generateShareCode(),
      name:          formData.name,
      game:          formData.game,
      format:        formData.format || 'double_elimination',
      date:          formData.date || '',
      venue:         formData.venue || '',
      status:        'active',
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
      teams:         seeded,
      winnersBracket,
      losersBracket,
      grandFinals,
    };
  }

  // ── Bye Padding ────────────────────────────────────────────────

  /**
   * Pad team list to next power of 2 with bye slots.
   * Byes are assigned to the lowest seeds (highest seed number) first.
   */
  function padWithByes(teams) {
    const n = nextPow2(teams.length);
    const byeCount = n - teams.length;
    const padded = [...teams];
    for (let i = 0; i < byeCount; i++) {
      padded.push({ id: `BYE-${i}`, name: 'BYE', seed: 9999 + i, isBye: true });
    }
    return padded;
  }

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  // ── Winners Bracket Construction ──────────────────────────────

  /**
   * Standard seeding pairs: 1v16, 8v9, 5v12, 4v13, … (snake draft)
   * This mirrors the standard double-elimination bracket used in most esports.
   */
  function buildWinnersBracket(teams, game) {
    const n         = teams.length;          // Must be power of 2
    const numRounds = Math.log2(n);
    const rounds    = [];

    // Determine bestOf per round (use ML defaults: BO3 throughout WB)
    function getBestOf(roundIndex) {
      return 3; // Override per game via game config if needed
    }

    // Round 1: seeded bracket pairs
    const r1Pairs = generateSeededPairs(teams);
    const r1Matches = r1Pairs.map(([t1, t2], i) => {
      const match = {
        id:        newMatchId('W'),
        phaseKey:  'winnersBracket',
        round:     1,
        matchNum:  i + 1,
        team1Id:   t1.id,
        team2Id:   t2.id,
        score1:    null,
        score2:    null,
        winnerId:  null,
        loserId:   null,
        games:     [],
        bestOf:    getBestOf(0),
        status:    t2.isBye ? 'bye' : 'pending',
      };
      // Auto-advance bye matches immediately
      if (t2.isBye) {
        match.winnerId = t1.id;
        match.score1   = 1;
        match.score2   = 0;
        match.status   = 'completed';
        match.isBye    = true;
      }
      return match;
    });
    rounds.push({ round: 1, label: 'Round 1', bestOf: getBestOf(0), matches: r1Matches });

    // Subsequent rounds: TBD placeholders
    for (let r = 2; r <= numRounds; r++) {
      const matchCount = n / Math.pow(2, r);
      const label = r === numRounds
        ? 'Winners Final'
        : r === numRounds - 1 ? 'Winners Semi-Final' : `Round ${r}`;
      const matches = Array.from({ length: matchCount }, (_, i) => ({
        id:       newMatchId('W'),
        phaseKey: 'winnersBracket',
        round:    r,
        matchNum: i + 1,
        team1Id:  null,
        team2Id:  null,
        score1:   null,
        score2:   null,
        winnerId: null,
        loserId:  null,
        games:    [],
        bestOf:   getBestOf(r - 1),
        status:   'pending',
      }));
      rounds.push({ round: r, label, bestOf: getBestOf(r - 1), matches });
    }

    // Propagate any bye-won matches from Round 1 into Round 2
    propagateByes(rounds);

    return { rounds };
  }

  /**
   * Standard bracket seeding pairs for N teams.
   * For 8: (1v8, 4v5, 2v7, 3v6) — typical bracket order.
   * Adapted from standard double-elimination seeding.
   */
  function generateSeededPairs(teams) {
    const n     = teams.length;
    const pairs = [];
    const order = buildBracketOrder(n);
    for (let i = 0; i < order.length; i += 2) {
      const t1 = teams[order[i] - 1];
      const t2 = teams[order[i + 1] - 1];
      pairs.push([t1, t2]);
    }
    return pairs;
  }

  /**
   * Recursive bracket position generation.
   * Returns seed positions in bracket order [1, 8, 5, 4, 3, 6, 7, 2] for N=8.
   */
  function buildBracketOrder(n) {
    if (n === 2) return [1, 2];
    const prev = buildBracketOrder(n / 2);
    return prev.reduce((acc, pos) => {
      acc.push(pos, n + 1 - pos);
      return acc;
    }, []);
  }

  /** Auto-advance bye winners into next round */
  function propagateByes(rounds) {
    for (let ri = 0; ri < rounds.length - 1; ri++) {
      const currentRound = rounds[ri];
      const nextRound    = rounds[ri + 1];
      currentRound.matches.forEach((match, mi) => {
        if (match.status === 'completed' && match.isBye) {
          const nextMatchIndex = Math.floor(mi / 2);
          const nextMatch      = nextRound.matches[nextMatchIndex];
          if (nextMatch) {
            const slot = mi % 2 === 0 ? 'team1Id' : 'team2Id';
            nextMatch[slot] = match.winnerId;
          }
        }
      });
    }
  }

  // ── Losers Bracket Construction ───────────────────────────────

  /**
   * Double-elimination losers bracket.
   * Round count for N-team winners bracket: 2*(log2(N)-1) rounds in LB.
   * Standard structure:
   *   LB Round 1:  WB Round 1 losers (N/2 teams)
   *   LB Round 2:  LB R1 winners vs WB Round 2 losers
   *   LB Round 3:  LB R2 winners (survivor matches only)
   *   … alternating drop-in rounds and survivor rounds
   *   LB Final:    Last 2 teams from LB
   */
  function buildLosersBracket(winnersBracket, game) {
    const wbRounds   = winnersBracket.rounds.length;
    const lbRounds   = 2 * (wbRounds - 1);
    const rounds     = [];

    // LB round 1 match count = WB round 1 match count / 2
    // (the WB R1 losers form LB R1)
    const wbR1MatchCount = winnersBracket.rounds[0].matches.length;

    for (let r = 1; r <= lbRounds; r++) {
      const isDropIn    = r % 2 === 1; // Odd rounds receive WB dropdowns
      const isFinal     = r === lbRounds;
      const isSemiFinal = r === lbRounds - 1;
      const bestOf      = isFinal ? 3 : 1; // BO1 until LB Final

      let matchCount;
      if (r === 1) {
        // LB R1: half of WB R1 non-bye losers
        matchCount = Math.floor(wbR1MatchCount / 2);
      } else if (isDropIn) {
        // Drop-in round: same count as previous survivor round
        matchCount = rounds[rounds.length - 1].matches.length;
      } else {
        // Survivor round: half of previous drop-in round
        matchCount = Math.ceil(rounds[rounds.length - 1].matches.length / 2);
      }
      matchCount = Math.max(1, matchCount);

      const label = isFinal
        ? 'Losers Final'
        : isSemiFinal ? 'Losers Semi-Final'
        : isDropIn    ? `LB Round ${r} (Drop-In)`
        : `LB Round ${r}`;

      const matches = Array.from({ length: matchCount }, (_, i) => ({
        id:       newMatchId('L'),
        phaseKey: 'losersBracket',
        round:    r,
        matchNum: i + 1,
        team1Id:  null,
        team2Id:  null,
        score1:   null,
        score2:   null,
        winnerId: null,
        loserId:  null,
        games:    [],
        bestOf,
        status:   'pending',
      }));
      rounds.push({ round: r, label, bestOf, matches });
    }
    return { rounds };
  }

  // ── Grand Finals Factory ───────────────────────────────────────

  function buildGrandFinals(game) {
    return {
      bestOf: 5,
      bracketReset: false,
      series1: {
        id:       newMatchId('GF'),
        phaseKey: 'grandFinals',
        team1Id:  null,  // WB champion
        team2Id:  null,  // LB champion
        score1:   null,
        score2:   null,
        winnerId: null,
        games:    [],
        bestOf:   5,
        status:   'pending',
      },
      series2: null,  // Created only if WB champion loses Series 1
    };
  }

  // ================================================================
  // MATCH UPDATE ENGINE
  // ================================================================

  /**
   * Apply a match result to a tournament and propagate winners/losers.
   * @param {Object} tournament
   * @param {string} matchId
   * @param {number} score1
   * @param {number} score2
   * @param {string} winnerId
   * @returns {Object} updated tournament (new object — no mutation)
   */
  function updateMatch(tournament, matchId, score1, score2, winnerId) {
    // Deep clone to avoid mutating React-style state
    const t = deepClone(tournament);

    // Locate and update the match
    const { match, phase } = findMatchInTournament(t, matchId);
    if (!match) throw new Error(`Match ${matchId} not found.`);

    const loserId = match.team1Id === winnerId ? match.team2Id : match.team1Id;

    match.score1   = score1;
    match.score2   = score2;
    match.winnerId = winnerId;
    match.loserId  = loserId;
    match.status   = 'completed';
    t.updatedAt    = Date.now();

    // Route winner & loser
    if (phase === 'winnersBracket') {
      advanceToNextWinnersRound(t, match);
      dropToLosers(t, match);
    } else if (phase === 'losersBracket') {
      advanceInLosers(t, match);
      // Loser is eliminated — no further action
    } else if (phase === 'grandFinals') {
      resolveGrandFinals(t, match);
    }

    // Check overall tournament completion
    checkTournamentComplete(t);

    return t;
  }

  /** Advance the winner of a WB match into the next WB round */
  function advanceToNextWinnersRound(tournament, completedMatch) {
    const { round, matchNum } = completedMatch;
    const rounds = tournament.winnersBracket.rounds;
    const nextRoundIndex = rounds.findIndex(r => r.round === round + 1);
    if (nextRoundIndex === -1) return; // WB Final: winner goes to Grand Finals

    const nextRound     = rounds[nextRoundIndex];
    const nextMatchIndex = Math.floor((matchNum - 1) / 2);
    const slot          = (matchNum - 1) % 2 === 0 ? 'team1Id' : 'team2Id';

    if (nextRound.matches[nextMatchIndex]) {
      nextRound.matches[nextMatchIndex][slot] = completedMatch.winnerId;
    }
    // If this is the WB Final (last WB round), put winner into Grand Finals slot 1
    const isWbFinal = round === rounds[rounds.length - 1].round;
    if (isWbFinal) {
      tournament.grandFinals.series1.team1Id = completedMatch.winnerId;
    }
  }

  /**
   * Drop the loser of a WB match into the corresponding LB slot.
   *
   * Mapping rule (standard double-elimination):
   * - WB Round R losers enter LB Round (2R - 1) for R > 1
   * - WB Round 1 losers enter LB Round 1
   * - Within a round, the standard mapping reverses pairing order
   *   to avoid rematches as long as possible.
   */
  function dropToLosers(tournament, completedMatch) {
    const { round, matchNum } = completedMatch;
    const lbRounds = tournament.losersBracket.rounds;

    // WB Round 1 losers → LB Round 1
    // WB Round R losers → LB Round (2R - 2 + 1) = LB Round (2R-1) for R>=2
    let lbRound;
    let lbMatchIndex;

    if (round === 1) {
      // WB R1 loser enters LB R1
      lbRound = lbRounds.find(r => r.round === 1);
      // Reverse-pair: match 1 loser → LB R1 match 1 team2, etc.
      lbMatchIndex = Math.floor((matchNum - 1) / 2);
      const slot   = (matchNum - 1) % 2 === 0 ? 'team2Id' : 'team1Id'; // reversed
      if (lbRound?.matches[lbMatchIndex]) {
        lbRound.matches[lbMatchIndex][slot] = completedMatch.loserId;
      }
    } else {
      // WB Round R (R≥2) losers → LB drop-in round (2R-2)
      const lbDropRound = 2 * round - 2;
      lbRound = lbRounds.find(r => r.round === lbDropRound);
      if (!lbRound) return;
      // Direct mapping: WB match N loser → LB slot N
      lbMatchIndex = matchNum - 1;
      if (lbRound.matches[lbMatchIndex]) {
        lbRound.matches[lbMatchIndex].team1Id = completedMatch.loserId;
      }
    }
  }

  /** Advance winner within the Losers Bracket */
  function advanceInLosers(tournament, completedMatch) {
    const { round, matchNum } = completedMatch;
    const lbRounds = tournament.losersBracket.rounds;
    const nextRoundIdx = lbRounds.findIndex(r => r.round === round + 1);

    if (nextRoundIdx === -1) {
      // LB Final: winner goes to Grand Finals Series 1 slot 2
      tournament.grandFinals.series1.team2Id = completedMatch.winnerId;
      return;
    }
    const nextRound     = lbRounds[nextRoundIdx];
    const nextMatchIdx  = Math.floor((matchNum - 1) / 2);
    const slot          = (matchNum - 1) % 2 === 0 ? 'team1Id' : 'team2Id';
    if (nextRound.matches[nextMatchIdx]) {
      nextRound.matches[nextMatchIdx][slot] = completedMatch.winnerId;
    }
  }

  /**
   * Handle Grand Finals result.
   * If the WB champion (team1) loses Series 1 → bracket reset, play Series 2.
   * If the LB champion (team1) wins Series 1 → they ARE champion.
   * Series 2 winner (if played) is the overall champion.
   */
  function resolveGrandFinals(tournament, completedMatch) {
    const gf = tournament.grandFinals;
    if (completedMatch.id === gf.series1.id) {
      // Series 1 complete
      const wbChampion = gf.series1.team1Id;
      if (completedMatch.winnerId !== wbChampion) {
        // LB champion won → bracket reset; play Series 2
        gf.bracketReset = true;
        gf.series2 = {
          id:       newMatchId('GF2'),
          phaseKey: 'grandFinals',
          // Both teams switch sides for series 2 (convention)
          team1Id:  gf.series1.team2Id, // LB champion
          team2Id:  gf.series1.team1Id, // WB champion
          score1:   null,
          score2:   null,
          winnerId: null,
          games:    [],
          bestOf:   5,
          status:   'pending',
        };
      } else {
        // WB champion won Series 1 — they are champion
        tournament.championId = completedMatch.winnerId;
      }
    } else if (gf.series2 && completedMatch.id === gf.series2.id) {
      // Bracket reset complete
      tournament.championId = completedMatch.winnerId;
    }
  }

  /** Mark tournament as done once a champion is determined */
  function checkTournamentComplete(tournament) {
    if (tournament.championId) tournament.status = 'done';
  }

  // ================================================================
  // UTILITY HELPERS
  // ================================================================

  /**
   * Locate a match by ID across all phases.
   * Returns { match, phase } or { match: null, phase: null }.
   */
  function findMatchInTournament(tournament, matchId) {
    for (const round of tournament.winnersBracket?.rounds || []) {
      const match = round.matches.find(m => m.id === matchId);
      if (match) return { match, phase: 'winnersBracket' };
    }
    for (const round of tournament.losersBracket?.rounds || []) {
      const match = round.matches.find(m => m.id === matchId);
      if (match) return { match, phase: 'losersBracket' };
    }
    const gf = tournament.grandFinals;
    if (gf?.series1?.id === matchId) return { match: gf.series1, phase: 'grandFinals' };
    if (gf?.series2?.id === matchId) return { match: gf.series2, phase: 'grandFinals' };
    return { match: null, phase: null };
  }

  /** Structured deep clone (avoids issues with functions/dates) */
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // ================================================================
  // PUBLIC API
  // ================================================================

  return {
    createTournament,
    updateMatch,
    generateId,
    generateShareCode,
    nextPow2,
    padWithByes,
    buildWinnersBracket,
    buildLosersBracket,
    buildGrandFinals,
    deepClone,
  };

})();

// Expose globally for app.js and view.html
window.DoubleElimBracket = DoubleElimBracket;
