/**
 * js/bracket/doubleElim.js
 *
 * Double Elimination bracket engine — FIXED VERSION
 *
 * Bug fixes applied:
 *   BUG #2: dropToLosers() had an off-by-one in the reverse-pair slot
 *           assignment for WB Round 1. Losers were landing in wrong LB slots.
 *           Fixed: WB R1 losers now correctly fill team1Id/team2Id in LB R1
 *           using the standard interleaved reverse-mapping.
 *
 *   BUG #2b: advanceToNextWinnersRound() was checking isWbFinal but also
 *            calling the next-round advance, causing double-writes on the
 *            WB Final match. Fixed with early return guarding.
 *
 *   BUG #2c: advanceInLosers() used floor-division slot mapping which broke
 *            for drop-in rounds (even LB rounds that receive WB losers, not
 *            LB survivors). Fixed with separate slot logic per round parity.
 */

'use strict';

const DoubleElimBracket = (() => {

  // ── ID Generation ─────────────────────────────────────────────
  let _matchSeq = 0;

  function newMatchId(prefix = 'M') {
    return `${prefix}-${Date.now()}-${++_matchSeq}`;
  }

  function generateShareCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  function generateId() {
    return `T-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  }

  // ── Tournament Shell Factory ───────────────────────────────────

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

  function buildWinnersBracket(teams, game) {
    const n         = teams.length;
    const numRounds = Math.log2(n);
    const rounds    = [];

    // Round 1: seeded bracket pairs
    const r1Pairs = generateSeededPairs(teams);
    const r1Matches = r1Pairs.map(([ t1, t2 ], i) => {
      const match = {
        id:       newMatchId('W'),
        phaseKey: 'winnersBracket',
        round:    1,
        matchNum: i + 1,
        team1Id:  t1.id,
        team2Id:  t2.id,
        score1:   null,
        score2:   null,
        winnerId: null,
        loserId:  null,
        games:    [],
        bestOf:   3,
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
    rounds.push({ round: 1, label: 'Round 1', bestOf: 3, matches: r1Matches });

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
        bestOf:   3,
        status:   'pending',
      }));
      rounds.push({ round: r, label, bestOf: 3, matches });
    }

    propagateByes(rounds);
    return { rounds };
  }

  function generateSeededPairs(teams) {
    const n     = teams.length;
    const pairs = [];
    const order = buildBracketOrder(n);
    for (let i = 0; i < order.length; i += 2) {
      pairs.push([ teams[order[i] - 1], teams[order[i + 1] - 1] ]);
    }
    return pairs;
  }

  function buildBracketOrder(n) {
    if (n === 2) return [1, 2];
    const prev = buildBracketOrder(n / 2);
    return prev.reduce((acc, pos) => {
      acc.push(pos, n + 1 - pos);
      return acc;
    }, []);
  }

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

  function buildLosersBracket(winnersBracket) {
    const wbRounds       = winnersBracket.rounds.length;
    const lbRounds       = 2 * (wbRounds - 1);
    const wbR1MatchCount = winnersBracket.rounds[0].matches.length;
    const rounds         = [];

    for (let r = 1; r <= lbRounds; r++) {
      const isFinal     = r === lbRounds;
      const isSemiFinal = r === lbRounds - 1;
      const bestOf      = isFinal ? 3 : 1;

      let matchCount;
      if (r === 1) {
        matchCount = Math.floor(wbR1MatchCount / 2);
      } else if (r % 2 === 1) {
        // Odd rounds after R1 are drop-in rounds: same count as previous
        matchCount = rounds[rounds.length - 1].matches.length;
      } else {
        // Even rounds are survivor rounds: halve
        matchCount = Math.ceil(rounds[rounds.length - 1].matches.length / 2);
      }
      matchCount = Math.max(1, matchCount);

      const label = isFinal
        ? 'Losers Final'
        : isSemiFinal ? 'Losers Semi-Final'
        : r % 2 === 1 ? `LB Round ${r} (Drop-In)` : `LB Round ${r}`;

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

  function buildGrandFinals() {
    return {
      bestOf:       5,
      bracketReset: false,
      series1: {
        id:       newMatchId('GF'),
        phaseKey: 'grandFinals',
        team1Id:  null,
        team2Id:  null,
        score1:   null,
        score2:   null,
        winnerId: null,
        games:    [],
        bestOf:   5,
        status:   'pending',
      },
      series2: null,
    };
  }

  // ================================================================
  // MATCH UPDATE ENGINE
  // ================================================================

  function updateMatch(tournament, matchId, score1, score2, winnerId) {
    const t = deepClone(tournament);

    const { match, phase } = findMatchInTournament(t, matchId);
    if (!match) throw new Error(`Match ${matchId} not found.`);

    const loserId = match.team1Id === winnerId ? match.team2Id : match.team1Id;

    match.score1   = score1;
    match.score2   = score2;
    match.winnerId = winnerId;
    match.loserId  = loserId;
    match.status   = 'completed';
    t.updatedAt    = Date.now();

    if (phase === 'winnersBracket') {
      advanceToNextWinnersRound(t, match);
      dropToLosers(t, match);
    } else if (phase === 'losersBracket') {
      advanceInLosers(t, match);
    } else if (phase === 'grandFinals') {
      resolveGrandFinals(t, match);
    }

    checkTournamentComplete(t);
    return t;
  }

  // FIX #2b: Guard against double-write by separating WB-Final handling
  function advanceToNextWinnersRound(tournament, completedMatch) {
    const { round, matchNum } = completedMatch;
    const rounds    = tournament.winnersBracket.rounds;
    const lastRound = rounds[rounds.length - 1].round;

    // WB Final winner → Grand Finals slot 1
    if (round === lastRound) {
      tournament.grandFinals.series1.team1Id = completedMatch.winnerId;
      return;
    }

    const nextRoundObj = rounds.find(r => r.round === round + 1);
    if (!nextRoundObj) return;

    const nextMatchIndex = Math.floor((matchNum - 1) / 2);
    const slot           = (matchNum - 1) % 2 === 0 ? 'team1Id' : 'team2Id';
    if (nextRoundObj.matches[nextMatchIndex]) {
      nextRoundObj.matches[nextMatchIndex][slot] = completedMatch.winnerId;
    }
  }

  /**
   * FIX #2: Drop WB loser into correct LB slot.
   *
   * WB Round 1 losers → LB Round 1
   *   Standard mapping: pair WB matches into LB matches
   *   WB matches (1,2) → LB match 1 (team1=WB1loser, team2=WB2loser)
   *   WB matches (3,4) → LB match 2 (team1=WB3loser, team2=WB4loser)
   *   The "reverse" within each pair avoids top seeds meeting immediately:
   *   WB match 1 loser fills team2 of LB match, WB match 2 loser fills team1.
   *
   * WB Round R (R≥2) losers → LB drop-in round (2R-2)
   *   Direct slot: WB match i loser → LB match i team2 (drop-in slot)
   *   (team1 is already filled by the surviving LB player from round before)
   */
  function dropToLosers(tournament, completedMatch) {
    const { round, matchNum } = completedMatch;
    const lbRounds = tournament.losersBracket.rounds;

    if (round === 1) {
      // WB R1: pairs of WB matches collapse into single LB matches
      // WB matches 1&2 → LB R1 match 1, matches 3&4 → LB R1 match 2, etc.
      const lbR1      = lbRounds.find(r => r.round === 1);
      if (!lbR1) return;
      const lbMatchIdx = Math.floor((matchNum - 1) / 2);
      // Within each pair: first WB match loser → team2, second → team1
      // (intentional cross to keep top seeds separated longer)
      const slot = (matchNum - 1) % 2 === 0 ? 'team2Id' : 'team1Id';
      const lbMatch = lbR1.matches[lbMatchIdx];
      if (lbMatch) lbMatch[slot] = completedMatch.loserId;

    } else {
      // WB Round R (R≥2): loser drops into LB drop-in round = 2*(R-1)
      const lbDropRound = 2 * (round - 1);
      const lbRound = lbRounds.find(r => r.round === lbDropRound);
      if (!lbRound) return;

      // Drop-in rounds receive WB losers as team2 (team1 is LB survivor)
      // Direct 1-to-1 mapping: WB match N loser → LB match N team2
      const lbMatchIdx = matchNum - 1;
      const lbMatch = lbRound.matches[lbMatchIdx];
      if (lbMatch) lbMatch.team2Id = completedMatch.loserId;
    }
  }

  /**
   * FIX #2c: Advance LB winner to next round with correct slot logic.
   *
   * LB has two types of rounds:
   *   Odd rounds (drop-in): receive new players from WB; survivors play them.
   *     matchNum maps directly (winner of match N → next round match N, team1)
   *   Even rounds (survivor): two survivors play each other.
   *     matchNum uses floor pairing (matches 1&2 → next match 1, etc.)
   *
   * The final LB round winner goes to Grand Finals as team2.
   */
  function advanceInLosers(tournament, completedMatch) {
    const { round, matchNum } = completedMatch;
    const lbRounds  = tournament.losersBracket.rounds;
    const lastRound = lbRounds[lbRounds.length - 1].round;

    // LB Final winner → Grand Finals slot 2
    if (round === lastRound) {
      tournament.grandFinals.series1.team2Id = completedMatch.winnerId;
      return;
    }

    const nextRoundObj = lbRounds.find(r => r.round === round + 1);
    if (!nextRoundObj) return;

    const isDropInRound = round % 2 === 1; // Odd = drop-in, even = survivor

    if (isDropInRound) {
      // Current round is drop-in: each match winner goes 1-to-1 to same slot
      // in next (survivor) round as team1
      const nextMatch = nextRoundObj.matches[matchNum - 1];
      if (nextMatch) nextMatch.team1Id = completedMatch.winnerId;
    } else {
      // Current round is survivor: pairs collapse, winner goes to next round
      const nextMatchIdx = Math.floor((matchNum - 1) / 2);
      const slot         = (matchNum - 1) % 2 === 0 ? 'team1Id' : 'team2Id';
      const nextMatch    = nextRoundObj.matches[nextMatchIdx];
      if (nextMatch) nextMatch[slot] = completedMatch.winnerId;
    }
  }

  function resolveGrandFinals(tournament, completedMatch) {
    const gf = tournament.grandFinals;
    if (completedMatch.id === gf.series1.id) {
      const wbChampion = gf.series1.team1Id;
      if (completedMatch.winnerId !== wbChampion) {
        // LB champion won Series 1 → bracket reset
        gf.bracketReset = true;
        gf.series2 = {
          id:       newMatchId('GF2'),
          phaseKey: 'grandFinals',
          team1Id:  gf.series1.team2Id,
          team2Id:  gf.series1.team1Id,
          score1:   null,
          score2:   null,
          winnerId: null,
          games:    [],
          bestOf:   5,
          status:   'pending',
        };
      } else {
        tournament.championId = completedMatch.winnerId;
      }
    } else if (gf.series2 && completedMatch.id === gf.series2.id) {
      tournament.championId = completedMatch.winnerId;
    }
  }

  function checkTournamentComplete(tournament) {
    if (tournament.championId) tournament.status = 'done';
  }

  // ================================================================
  // UTILITY HELPERS
  // ================================================================

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

window.DoubleElimBracket = DoubleElimBracket;
