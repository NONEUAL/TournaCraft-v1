/**
 * js/bracket/singleElim.js
 *
 * Single Elimination bracket engine.
 *
 * Features:
 *   - Standard seeded bracket (1v16, 8v9, 5v12, 4v13, …)
 *   - Automatic bye padding to next power of 2
 *   - Bye propagation: BYE wins advance immediately on generation
 *   - Winner propagation: completing a match fills the next round slot
 *   - Third-place match (optional)
 *   - Configurable bestOf per round or flat for all rounds
 *
 * Expansion pattern:
 *   Implements the same public API shape as doubleElim.js so app.js
 *   can call createTournament / updateMatch without knowing the format.
 */

'use strict';

const SingleElimBracket = (() => {

  let _seq = 0;
  function newMatchId(prefix = 'SE') {
    return `${prefix}-${Date.now()}-${++_seq}`;
  }

  function generateId() {
    return `T-SE-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  }

  function generateShareCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  function nextPow2(n) {
    let p = 1; while (p < n) p <<= 1; return p;
  }

  // ================================================================
  // TOURNAMENT FACTORY
  // ================================================================

  /**
   * Create a single-elimination tournament.
   *
   * @param {Object} formData  — { name, game, format, date, venue }
   * @param {Array}  teams     — [{ id, name, seed }]
   * @param {Object} opts      — { bestOf: 3, thirdPlace: false }
   * @returns {Object} tournament
   */
  function createTournament(formData, teams, opts = {}) {
    if (!teams || teams.length < 2) throw new Error('Need at least 2 teams.');
    if (teams.length > 64) throw new Error('Maximum 64 teams supported.');

    const { bestOf = 3, thirdPlace = false } = opts;
    const seeded  = [...teams].sort((a, b) => (a.seed || 0) - (b.seed || 0));
    const padded  = padWithByes(seeded);
    const bracket = buildBracket(padded, bestOf);

    let thirdPlaceMatch = null;
    if (thirdPlace) {
      thirdPlaceMatch = {
        id:       newMatchId('TP'),
        phaseKey: 'thirdPlace',
        team1Id:  null,
        team2Id:  null,
        score1:   null,
        score2:   null,
        winnerId: null,
        games:    [],
        bestOf,
        status:   'pending',
        label:    '3rd Place Match',
      };
    }

    return {
      id:            generateId(),
      shareCode:     generateShareCode(),
      name:          formData.name,
      game:          formData.game,
      format:        'single_elimination',
      date:          formData.date || '',
      venue:         formData.venue || '',
      status:        'active',
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
      teams:         seeded,
      // For compatibility with app.js renderEliminationBracket,
      // single elim stores its rounds under winnersBracket
      winnersBracket: bracket,
      losersBracket:  null,
      grandFinals:    null,
      thirdPlaceMatch,
    };
  }

  // ================================================================
  // BRACKET BUILDER
  // ================================================================

  /**
   * Build bracket rounds from padded seeded team list.
   * Returns { rounds: [...] } — same shape as DoubleElim winnersBracket.
   */
  function buildBracket(teams, bestOf) {
    const n         = teams.length;     // power of 2
    const numRounds = Math.log2(n);
    const rounds    = [];

    // Round 1: seeded matchups
    const pairs     = generateSeededPairs(teams);
    const r1Matches = pairs.map(([ t1, t2 ], i) => {
      const match = {
        id:       newMatchId('SE'),
        phaseKey: 'winnersBracket',
        round:    1,
        matchNum: i + 1,
        team1Id:  t1.id,
        team2Id:  t2.id,
        score1:   null,
        score2:   null,
        winnerId: null,
        games:    [],
        bestOf,
        status:   t2.isBye ? 'bye' : 'pending',
      };
      if (t2.isBye) {
        match.winnerId = t1.id;
        match.score1   = 1;
        match.score2   = 0;
        match.status   = 'completed';
        match.isBye    = true;
      }
      return match;
    });
    rounds.push({ round: 1, label: 'Round 1', bestOf, matches: r1Matches });

    // Remaining rounds: empty placeholder matches
    for (let r = 2; r <= numRounds; r++) {
      const matchCount = n / Math.pow(2, r);
      const label      = r === numRounds
        ? 'Final'
        : r === numRounds - 1 ? 'Semi-Final'
        : r === numRounds - 2 ? 'Quarter-Final'
        : `Round ${r}`;

      const matches = Array.from({ length: matchCount }, (_, i) => ({
        id:       newMatchId('SE'),
        phaseKey: 'winnersBracket',
        round:    r,
        matchNum: i + 1,
        team1Id:  null,
        team2Id:  null,
        score1:   null,
        score2:   null,
        winnerId: null,
        games:    [],
        bestOf,
        status:   'pending',
      }));
      rounds.push({ round: r, label, bestOf, matches });
    }

    // Propagate any bye winners from Round 1
    propagateByes(rounds);

    return { rounds };
  }

  // ── Seeding ────────────────────────────────────────────────────

  function generateSeededPairs(teams) {
    const order = buildBracketOrder(teams.length);
    const pairs = [];
    for (let i = 0; i < order.length; i += 2) {
      pairs.push([ teams[order[i] - 1], teams[order[i + 1] - 1] ]);
    }
    return pairs;
  }

  function buildBracketOrder(n) {
    if (n === 2) return [1, 2];
    const prev = buildBracketOrder(n / 2);
    return prev.reduce((acc, pos) => { acc.push(pos, n + 1 - pos); return acc; }, []);
  }

  function padWithByes(teams) {
    const n   = nextPow2(teams.length);
    const out = [...teams];
    for (let i = 0; i < n - teams.length; i++) {
      out.push({ id: `BYE-${i}`, name: 'BYE', seed: 9999 + i, isBye: true });
    }
    return out;
  }

  function propagateByes(rounds) {
    for (let ri = 0; ri < rounds.length - 1; ri++) {
      rounds[ri].matches.forEach((match, mi) => {
        if (match.status === 'completed' && match.isBye) {
          const nextMatch = rounds[ri + 1].matches[Math.floor(mi / 2)];
          if (nextMatch) nextMatch[mi % 2 === 0 ? 'team1Id' : 'team2Id'] = match.winnerId;
        }
      });
    }
  }

  // ================================================================
  // MATCH UPDATE ENGINE
  // ================================================================

  /**
   * Record a match result and advance the winner.
   * Losers are eliminated — no LB in single elimination.
   *
   * @param {Object} tournament
   * @param {string} matchId
   * @param {number} score1
   * @param {number} score2
   * @param {string} winnerId
   * @returns {Object} updated tournament
   */
  function updateMatch(tournament, matchId, score1, score2, winnerId) {
    const t = JSON.parse(JSON.stringify(tournament));

    // Check third-place match first
    if (t.thirdPlaceMatch?.id === matchId) {
      t.thirdPlaceMatch.score1   = score1;
      t.thirdPlaceMatch.score2   = score2;
      t.thirdPlaceMatch.winnerId = winnerId;
      t.thirdPlaceMatch.status   = 'completed';
      t.updatedAt = Date.now();
      checkComplete(t);
      return t;
    }

    // Find in main bracket
    let foundMatch = null;
    let foundRound = null;
    let foundRoundIdx = -1;

    for (let ri = 0; ri < t.winnersBracket.rounds.length; ri++) {
      const round = t.winnersBracket.rounds[ri];
      const m     = round.matches.find(m => m.id === matchId);
      if (m) { foundMatch = m; foundRound = round; foundRoundIdx = ri; break; }
    }

    if (!foundMatch) throw new Error(`Match ${matchId} not found.`);

    const loserId = foundMatch.team1Id === winnerId ? foundMatch.team2Id : foundMatch.team1Id;
    foundMatch.score1   = score1;
    foundMatch.score2   = score2;
    foundMatch.winnerId = winnerId;
    foundMatch.loserId  = loserId;
    foundMatch.status   = 'completed';
    t.updatedAt         = Date.now();

    // Advance winner to next round
    const rounds    = t.winnersBracket.rounds;
    const lastRound = rounds[rounds.length - 1].round;

    if (foundRound.round === lastRound) {
      // Final match — tournament champion
      t.championId = winnerId;
      // Feed losers into third-place match if configured
      if (t.thirdPlaceMatch) {
        const slot = t.thirdPlaceMatch.team1Id === null ? 'team1Id' : 'team2Id';
        t.thirdPlaceMatch[slot] = loserId;
      }
    } else {
      // Advance winner to next round
      const nextRound    = rounds[foundRoundIdx + 1];
      const nextMatchIdx = Math.floor((foundMatch.matchNum - 1) / 2);
      const slot         = (foundMatch.matchNum - 1) % 2 === 0 ? 'team1Id' : 'team2Id';
      if (nextRound?.matches[nextMatchIdx]) {
        nextRound.matches[nextMatchIdx][slot] = winnerId;
      }

      // If semi-final and third-place is enabled, collect loser
      const isSemiFinal = foundRound.round === lastRound - 1;
      if (isSemiFinal && t.thirdPlaceMatch) {
        const slot = t.thirdPlaceMatch.team1Id === null ? 'team1Id' : 'team2Id';
        t.thirdPlaceMatch[slot] = loserId;
      }
    }

    checkComplete(t);
    return t;
  }

  function checkComplete(t) {
    if (t.championId) {
      // If third-place is configured, wait until it's done too
      if (!t.thirdPlaceMatch || t.thirdPlaceMatch.status === 'completed') {
        t.status = 'done';
      }
    }
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
  };

})();

window.SingleElimBracket = SingleElimBracket;
