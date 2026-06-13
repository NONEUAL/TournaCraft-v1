/**
 * js/games/mobileLegends.js
 *
 * Mobile Legends: Bang Bang — Tournament Module
 *
 * Implements the full MLBB Provincial Cup structure:
 *   Group Stage (4 groups of 4, round robin, 3 matches per team)
 *     → Top 2 per group → Winners Bracket (8 teams)
 *     → 3rd per group   → Losers Bracket Round 1 (4 teams)
 *     → 4th per group   → Eliminated
 *   Winners Bracket: Best of 3
 *   Losers Bracket:  Best of 1 (BO3 for LB Final)
 *   Grand Finals:    Best of 5, with bracket-reset possibility
 *
 * Expansion pattern: New games follow this same module shape.
 * Add a new file at js/games/[gameName].js, implement the same
 * exported object shape, and register in GAME_CONFIGS in app.js.
 */

'use strict';

const MLTournament = (() => {

  // ── Config for Mobile Legends ──────────────────────────────────
  const ML_CONFIG = {
    label:        'Mobile Legends: Bang Bang',
    teamSize:     5,
    groupSize:    4,       // Teams per group
    maxGroups:    4,       // Groups A–D
    advanceToWB:  2,       // Top 2 → Winners Bracket
    advanceToLB:  1,       // 3rd   → Losers Bracket
    eliminated:   1,       // 4th   → Eliminated
    bestOfGroup:  3,       // BO3 in groups
    bestOfWB:     3,       // BO3 in Winners Bracket
    bestOfLB:     1,       // BO1 in LB (except LB Final)
    bestOfLBFinal:3,       // BO3 for LB Final
    bestOfGF:     5,       // BO5 Grand Finals
    scoreUnit:    'Games', // UI label
    groupNames:   ['A', 'B', 'C', 'D'],
  };

  // ── Share code generator ──────────────────────────────────────
  function generateShareCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  function generateId() {
    return `ML-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }

  // ================================================================
  // TOURNAMENT FACTORY — Groups → Double Elimination
  // ================================================================

  /**
   * Build the complete MLBB Provincial Cup tournament object.
   *
   * Structure:
   * {
   *   id, shareCode, name, game, format, date, venue, status,
   *   teams: [...16 teams...],
   *   groups: [
   *     { name: 'A', teamIds: [...], matches: [...], standings: [...] },
   *     ...
   *   ],
   *   winnersBracket: { rounds: [...] },   // 8-team DE WB
   *   losersBracket:  { rounds: [...] },   // 4+4 team DE LB
   *   grandFinals:    { ... }
   * }
   *
   * @param {Object} formData — { name, game, format, date, venue }
   * @param {Array}  teams    — seeded team list (8 or 16 teams)
   * @returns {Object} tournament
   */
  function createMLGroupsDoubleElim(formData, teams) {
    if (teams.length !== 16 && teams.length !== 8) {
      throw new Error('ML Groups format requires exactly 8 or 16 teams.');
    }

    const seeded   = [...teams].sort((a, b) => (a.seed || 0) - (b.seed || 0));
    const numGroups = teams.length === 16 ? 4 : 2;
    const groupSize = teams.length / numGroups;

    // Split teams into groups: seeds 1-4 → Group A, 5-8 → Group B, etc.
    // Standard allocation: snake-seed for balanced groups
    //   Group A: seeds 1, 8, 9, 16
    //   Group B: seeds 2, 7, 10, 15
    //   Group C: seeds 3, 6, 11, 14
    //   Group D: seeds 4, 5, 12, 13
    const groupAssignments = allocateGroupsSnakeSeed(seeded, numGroups);

    const groups = groupAssignments.map((groupTeams, gi) => {
      const groupName = ML_CONFIG.groupNames[gi];
      const matches   = RoundRobinBracket.generateGroupMatches(
        groupTeams, groupName, `G${groupName}`
      );
      const standings = RoundRobinBracket.initGroupStandings(groupTeams);

      // Annotate teams with their group
      groupTeams.forEach(t => { t.group = groupName; });

      return {
        name:     groupName,
        teamIds:  groupTeams.map(t => t.id),
        matches,
        standings,
        completed: false,
      };
    });

    // Annotate teams on main team list with group assignment
    groups.forEach(g => {
      g.teamIds.forEach(tid => {
        const team = seeded.find(t => t.id === tid);
        if (team) team.group = g.name;
      });
    });

    // Build 8-team Winners Bracket (empty — filled after group stage)
    const winnersBracket = buildEmptyWinnersBracket(8, ML_CONFIG.bestOfWB);
    const losersBracket  = buildEmptyLosersBracket(4, ML_CONFIG.bestOfLB, ML_CONFIG.bestOfLBFinal);
    const grandFinals    = buildGrandFinals(ML_CONFIG.bestOfGF);

    return {
      id:            generateId(),
      shareCode:     generateShareCode(),
      name:          formData.name,
      game:          'mobile_legends',
      format:        'groups_double_elim',
      date:          formData.date || '',
      venue:         formData.venue || '',
      status:        'active',
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
      teams:         seeded,
      groups,
      winnersBracket,
      losersBracket,
      grandFinals,
      phase:         'groups', // 'groups' | 'playoffs'
    };
  }

  // ================================================================
  // GROUP SEEDING — Snake allocation
  // ================================================================

  /**
   * Allocate teams to groups using snake seeding for balance.
   * For 16 teams into 4 groups:
   *   Round 1 (seeds 1-4):  1→A, 2→B, 3→C, 4→D
   *   Round 2 (seeds 5-8):  5→D, 6→C, 7→B, 8→A   (reversed)
   *   Round 3 (seeds 9-12): 9→A, 10→B, 11→C, 12→D
   *   Round 4 (seeds 13-16):13→D, 14→C, 15→B, 16→A
   *
   * @param {Array} seededTeams — sorted by seed ascending
   * @param {number} numGroups
   * @returns {Array[]} array of arrays, one per group
   */
  function allocateGroupsSnakeSeed(seededTeams, numGroups) {
    const groups = Array.from({ length: numGroups }, () => []);
    let forward = true;

    for (let i = 0; i < seededTeams.length; i++) {
      const roundIndex = Math.floor(i / numGroups);
      const posInRound = i % numGroups;

      let groupIndex;
      if (roundIndex % 2 === 0) {
        // Forward pass
        groupIndex = posInRound;
      } else {
        // Reverse pass (snake back)
        groupIndex = numGroups - 1 - posInRound;
      }
      groups[groupIndex].push(seededTeams[i]);
    }
    return groups;
  }

  // ================================================================
  // EMPTY BRACKET BUILDERS
  // ================================================================

  /**
   * Build an 8-team Winners Bracket shell (all TBD).
   * Rounds: QF, SF, WB Final.
   */
  function buildEmptyWinnersBracket(teamCount, bestOf) {
    const numRounds = Math.log2(teamCount);
    const rounds    = [];
    let seq = 0;

    for (let r = 1; r <= numRounds; r++) {
      const matchCount = teamCount / Math.pow(2, r);
      const label = r === numRounds     ? 'Winners Final'
                  : r === numRounds - 1 ? 'Winners Semi-Final'
                  : 'Winners Quarter-Final';
      const matches = Array.from({ length: matchCount }, (_, i) => ({
        id:       `WB-${r}-${++seq}`,
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
        bestOf:   r === numRounds ? 3 : bestOf,
        status:   'pending',
      }));
      rounds.push({ round: r, label, bestOf, matches });
    }
    return { rounds };
  }

  /**
   * Build Losers Bracket for 4 drop-in teams (from group stage 3rd places).
   * Structure:
   *   LB Round 1 (Drop-in): 2 matches — 4 teams from groups play 4 WB R1 losers
   *   LB Round 2: 2 matches (survivors)
   *   LB Round 3: 1 match (SF)
   *   LB Round 4: LB Final BO3
   */
  function buildEmptyLosersBracket(dropInCount, bestOf, bestOfFinal) {
    // LB for 8 teams in WB + 4 group 3rd places:
    // Actual LB structure after group stage feeds in:
    const rounds = [];
    let seq = 0;

    // 6 LB rounds for 8-team double elimination
    const roundDefs = [
      { round: 1, label: 'LB Round 1', matchCount: 2, bestOf: 1 },
      { round: 2, label: 'LB Round 2', matchCount: 2, bestOf: 1 },
      { round: 3, label: 'LB Round 3', matchCount: 1, bestOf: 1 },
      { round: 4, label: 'LB Round 4', matchCount: 2, bestOf: 1 },
      { round: 5, label: 'LB Semi-Final', matchCount: 1, bestOf: 1 },
      { round: 6, label: 'LB Final',   matchCount: 1, bestOf: bestOfFinal },
    ];

    roundDefs.forEach(def => {
      const matches = Array.from({ length: def.matchCount }, (_, i) => ({
        id:       `LB-${def.round}-${++seq}`,
        phaseKey: 'losersBracket',
        round:    def.round,
        matchNum: i + 1,
        team1Id:  null,
        team2Id:  null,
        score1:   null,
        score2:   null,
        winnerId: null,
        loserId:  null,
        games:    [],
        bestOf:   def.bestOf,
        status:   'pending',
      }));
      rounds.push({ round: def.round, label: def.label, bestOf: def.bestOf, matches });
    });

    return { rounds };
  }

  function buildGrandFinals(bestOf) {
    return {
      bestOf,
      bracketReset: false,
      series1: {
        id:       'GF-1',
        phaseKey: 'grandFinals',
        team1Id:  null,  // WB champion
        team2Id:  null,  // LB champion
        score1:   null,
        score2:   null,
        winnerId: null,
        games:    [],
        bestOf,
        status:   'pending',
      },
      series2: null,
    };
  }

  // ================================================================
  // GROUP MATCH UPDATE
  // ================================================================

  /**
   * Record a group match result, recompute standings, and
   * propagate to the playoffs bracket if all group matches are done.
   *
   * @param {Object} tournament
   * @param {string} groupId      — 'A' | 'B' | 'C' | 'D'
   * @param {string} matchId
   * @param {number} score1
   * @param {number} score2
   * @param {string} winnerId
   * @returns {Object} updated tournament
   */
  function updateGroupMatch(tournament, groupId, matchId, score1, score2, winnerId) {
    const t = JSON.parse(JSON.stringify(tournament));

    const group = t.groups.find(g => g.name === groupId);
    if (!group) throw new Error(`Group ${groupId} not found.`);

    const match = group.matches.find(m => m.id === matchId);
    if (!match) throw new Error(`Match ${matchId} not found in Group ${groupId}.`);

    // Record result
    match.score1   = score1;
    match.score2   = score2;
    match.winnerId = winnerId;
    match.status   = 'completed';
    t.updatedAt    = Date.now();

    // Recompute standings for this group
    const groupTeams = t.teams.filter(tm => tm.group === groupId);
    group.standings = RoundRobinBracket.recalculateGroupStandings(
      group.matches, groupTeams,
      { advanceToWB: ML_CONFIG.advanceToWB, advanceToLB: ML_CONFIG.advanceToLB }
    );

    // Check if all matches in this group are done
    const groupDone = group.matches.every(m => m.status === 'completed');
    if (groupDone) group.completed = true;

    // If ALL groups are complete, seed the playoffs
    const allGroupsDone = t.groups.every(g => g.completed);
    if (allGroupsDone) {
      seedPlayoffs(t);
    }

    return t;
  }

  // ================================================================
  // PLAYOFF SEEDING
  // ================================================================

  /**
   * After all group stage matches are complete, seed teams into:
   *   - Winners Bracket: top 2 from each group (8 teams)
   *   - Losers Bracket:  3rd from each group (4 teams)
   *
   * WB seeding (standard cross-bracket to avoid same-group rematches):
   *   WB Match 1: A1 vs D2
   *   WB Match 2: B1 vs C2
   *   WB Match 3: C1 vs B2
   *   WB Match 4: D1 vs A2
   *
   * LB seeding (group 3rd places):
   *   LB R1 Match 1: A3 vs B3
   *   LB R1 Match 2: C3 vs D3
   * Then LB R1 losers from WB feed into LB R2.
   *
   * @param {Object} t — tournament (mutated in place after deep clone)
   */
  function seedPlayoffs(t) {
    // Collect advancement results per group
    // advancedByGroup[groupName] = { wb: [team1st, team2nd], lb: [team3rd] }
    const advancedByGroup = {};
    t.groups.forEach(group => {
      const wbTeams = group.standings
        .filter(s => s.advanceTo === 'winnersBracket')
        .map(s => t.teams.find(tm => tm.id === s.teamId))
        .filter(Boolean);
      const lbTeams = group.standings
        .filter(s => s.advanceTo === 'losersBracket')
        .map(s => t.teams.find(tm => tm.id === s.teamId))
        .filter(Boolean);
      advancedByGroup[group.name] = { wb: wbTeams, lb: lbTeams };
    });

    // FIX #3: look up rounds by .round property, not by hardcoded IDs.
    // The matches array within each round is what we write team IDs into.
    // We locate the round by its round number — this survives any ID scheme.
    const wbR1 = t.winnersBracket.rounds.find(r => r.round === 1);
    if (wbR1) {
      // Cross-bracket seeding to avoid same-group rematches immediately:
      //   Match 1: A1 vs D2,  Match 2: B1 vs C2
      //   Match 3: C1 vs B2,  Match 4: D1 vs A2
      const wbPairs = [
        [ advancedByGroup['A']?.wb[0], advancedByGroup['D']?.wb[1] ],
        [ advancedByGroup['B']?.wb[0], advancedByGroup['C']?.wb[1] ],
        [ advancedByGroup['C']?.wb[0], advancedByGroup['B']?.wb[1] ],
        [ advancedByGroup['D']?.wb[0], advancedByGroup['A']?.wb[1] ],
      ];
      wbPairs.forEach(([ team1, team2 ], i) => {
        const match = wbR1.matches[i];
        if (!match) return;
        match.team1Id  = team1?.id  ?? null;
        match.team2Id  = team2?.id  ?? null;
        match.phaseKey = 'winnersBracket';   // ensure routing key is set
        // Mark ready only when both slots are filled
        match.status   = (team1 && team2) ? 'pending' : 'waiting';
      });
    }

    // LB Round 1: group 3rd places play each other.
    // LB Round 2 drop-in slots will receive WB R1 losers automatically
    // when the first WB matches are completed (via DoubleElimBracket.updateMatch).
    const lbR1 = t.losersBracket.rounds.find(r => r.round === 1);
    if (lbR1) {
      const lbPairs = [
        [ advancedByGroup['A']?.lb[0], advancedByGroup['B']?.lb[0] ],
        [ advancedByGroup['C']?.lb[0], advancedByGroup['D']?.lb[0] ],
      ];
      lbPairs.forEach(([ team1, team2 ], i) => {
        const match = lbR1.matches[i];
        if (!match) return;
        match.team1Id  = team1?.id ?? null;
        match.team2Id  = team2?.id ?? null;
        match.phaseKey = 'losersBracket';
        match.status   = (team1 && team2) ? 'pending' : 'waiting';
      });
    }

    // Ensure all WB/LB matches have the correct phaseKey stamped for routing
    t.winnersBracket.rounds.forEach(r =>
      r.matches.forEach(m => { m.phaseKey = 'winnersBracket'; })
    );
    t.losersBracket.rounds.forEach(r =>
      r.matches.forEach(m => { m.phaseKey = 'losersBracket'; })
    );

    t.phase = 'playoffs';
  }

  // ================================================================
  // PLAYOFF MATCH UPDATE
  // ================================================================

  /**
   * Delegate WB/LB/GF match updates to the DoubleElimBracket engine.
   * This wrapper ensures ML-specific bracket reset logic is applied.
   *
   * @param {Object} tournament
   * @param {string} matchId
   * @param {number} score1
   * @param {number} score2
   * @param {string} winnerId
   * @returns {Object} updated tournament
   */
  function updatePlayoffMatch(tournament, matchId, score1, score2, winnerId) {
    return DoubleElimBracket.updateMatch(tournament, matchId, score1, score2, winnerId);
  }

  // ================================================================
  // DEMO TOURNAMENT BUILDER
  // ================================================================

  /**
   * Create the MLBB Provincial Cup 2024 demo tournament
   * with all 16 teams pre-seeded into groups.
   * Group stage matches are generated but results are empty (pending).
   *
   * @returns {Object} ready-to-use demo tournament
   */
  function buildDemoTournament() {
    const formData = {
      name:   'MLBB Provincial Cup 2024',
      game:   'mobile_legends',
      format: 'groups_double_elim',
      date:   '2024-11-15',
      venue:  'City Sports Complex',
    };

    const teams = [
      { id: 1,  name: 'Team Alpha',   seed: 1  },
      { id: 2,  name: 'Team Beta',    seed: 2  },
      { id: 3,  name: 'Team Gamma',   seed: 3  },
      { id: 4,  name: 'Team Delta',   seed: 4  },
      { id: 5,  name: 'Team Epsilon', seed: 5  },
      { id: 6,  name: 'Team Zeta',    seed: 6  },
      { id: 7,  name: 'Team Eta',     seed: 7  },
      { id: 8,  name: 'Team Theta',   seed: 8  },
      { id: 9,  name: 'Team Iota',    seed: 9  },
      { id: 10, name: 'Team Kappa',   seed: 10 },
      { id: 11, name: 'Team Lambda',  seed: 11 },
      { id: 12, name: 'Team Mu',      seed: 12 },
      { id: 13, name: 'Team Nu',      seed: 13 },
      { id: 14, name: 'Team Xi',      seed: 14 },
      { id: 15, name: 'Team Omicron', seed: 15 },
      { id: 16, name: 'Team Pi',      seed: 16 },
    ];

    return createMLGroupsDoubleElim(formData, teams);
  }

  // ================================================================
  // SCORE VALIDATION FOR ML (BO3 / BO5)
  // ================================================================

  /**
   * Validate a proposed match score for ML rules.
   * @param {number} s1 — team 1 games won
   * @param {number} s2 — team 2 games won
   * @param {number} bestOf — 1, 3, or 5
   * @returns {{ valid: boolean, message: string }}
   */
  function validateScore(s1, s2, bestOf) {
    const required = Math.ceil(bestOf / 2); // 1 for BO1, 2 for BO3, 3 for BO5
    if (s1 === s2) return { valid: false, message: 'A winner must be declared — scores cannot be equal.' };
    if (s1 > required || s2 > required) return { valid: false, message: `Maximum ${required} wins for BO${bestOf}.` };
    if (s1 < 0 || s2 < 0) return { valid: false, message: 'Scores cannot be negative.' };
    const winner = s1 > s2 ? 1 : 2;
    const winnerScore = Math.max(s1, s2);
    const loserScore  = Math.min(s1, s2);
    if (winnerScore !== required) return { valid: false, message: `Winner needs exactly ${required} wins. Got ${winnerScore}.` };
    if (loserScore >= required)   return { valid: false, message: `Loser cannot have ${required}+ wins in BO${bestOf}.` };
    return { valid: true, message: '' };
  }

  // ================================================================
  // SCORE INPUT UI CONFIG (expansion pattern — game-specific UI)
  // ================================================================

  /**
   * Returns UI config for the ML score input screen.
   * Other game modules implement this same interface.
   *
   * @param {Object} match — the match being scored
   * @returns {Object} uiConfig
   */
  function getScoreInputConfig(match) {
    const bestOf = match.bestOf || 3;
    return {
      scoreType:   'games',          // 'games' | 'points' | 'sets'
      maxScore:    Math.ceil(bestOf / 2),
      minScore:    0,
      unit:        'Games',
      showPerGame: bestOf > 1,       // Show per-game series tracker
      bestOf,
      winCondition: `First to ${Math.ceil(bestOf / 2)} wins`,
      validationFn: (s1, s2) => validateScore(s1, s2, bestOf),
    };
  }

  // ================================================================
  // PUBLIC API
  // ================================================================

  return {
    config:                    ML_CONFIG,
    createMLGroupsDoubleElim,
    updateGroupMatch,
    updatePlayoffMatch,
    buildDemoTournament,
    validateScore,
    getScoreInputConfig,
    seedPlayoffs,
  };

})();

window.MLTournament = MLTournament;
