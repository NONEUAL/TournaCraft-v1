/**
 * js/bracket/groupsPlayoff.js
 *
 * Groups → Playoff transition layer.
 *
 * Responsibilities:
 *   1. Validate that all group stage matches are complete
 *   2. Collect advancement slots from each group's standings
 *   3. Apply a seeding strategy (cross-bracket, balanced, or straight)
 *      to fill the playoff bracket's first round
 *   4. Return the updated tournament ready for playoff play
 *
 * This module is the bridge between roundRobin.js (group stage) and
 * doubleElim.js / singleElim.js (playoff stage). mobileLegends.js
 * uses it internally; any future game with group→playoffs can too.
 *
 * Seeding strategies:
 *   'cross'    — A1vD2, B1vC2, C1vB2, D1vA2 (avoids same-group R1 rematch)
 *   'straight' — A1vA2, B1vB2, … (simpler, allows same-group rematch)
 *   'ranked'   — rank all advancing teams by record, pair 1v8, 2v7, etc.
 */

'use strict';

const GroupsPlayoff = (() => {

  // ================================================================
  // VALIDATION
  // ================================================================

  /**
   * Check whether all group stage matches are finished.
   * @param {Array} groups  — tournament.groups
   * @returns {{ complete: boolean, pending: number }}
   */
  function checkGroupsComplete(groups) {
    let pending = 0;
    for (const group of groups) {
      for (const match of group.matches || []) {
        if (match.status !== 'completed') pending++;
      }
    }
    return { complete: pending === 0, pending };
  }

  // ================================================================
  // ADVANCEMENT COLLECTION
  // ================================================================

  /**
   * Collect teams advancing to each bracket from group standings.
   *
   * Returns:
   * {
   *   winnersBracket: [ { team, group, rank } ],
   *   losersBracket:  [ { team, group, rank } ],
   *   eliminated:     [ { team, group, rank } ],
   * }
   *
   * @param {Array} groups   — tournament.groups (with standings)
   * @param {Array} teams    — tournament.teams (full list for lookups)
   * @param {Object} opts    — { advanceToWB: 2, advanceToLB: 1 }
   */
  function collectAdvancement(groups, teams, opts = {}) {
    const { advanceToWB = 2, advanceToLB = 1 } = opts;

    const result = { winnersBracket: [], losersBracket: [], eliminated: [] };

    groups.forEach(group => {
      const standings = group.standings || [];
      standings.forEach((standing, rank) => {
        const team = teams.find(t => t.id === standing.teamId);
        if (!team) return;

        const entry = { team, group: group.name, rank: rank + 1, standing };

        if (rank < advanceToWB) {
          result.winnersBracket.push(entry);
        } else if (rank < advanceToWB + advanceToLB) {
          result.losersBracket.push(entry);
        } else {
          result.eliminated.push(entry);
        }
      });
    });

    return result;
  }

  // ================================================================
  // SEEDING STRATEGIES
  // ================================================================

  /**
   * Cross-bracket seeding: avoids same-group R1 rematches.
   * Standard for 4-group, 8-team WB:
   *   Match 1: A1 vs D2
   *   Match 2: B1 vs C2
   *   Match 3: C1 vs B2
   *   Match 4: D1 vs A2
   *
   * @param {Object} advancement  — output of collectAdvancement()
   * @param {number} numGroups
   * @returns {Array} pairs — [[ team1, team2 ], ...]
   */
  function crossBracketSeed(advancement, numGroups) {
    // Group WB teams by their source group
    const byGroup = {};
    advancement.winnersBracket.forEach(({ team, group, rank }) => {
      if (!byGroup[group]) byGroup[group] = {};
      byGroup[group][rank] = team;
    });

    const groupNames = Object.keys(byGroup).sort();
    const n          = groupNames.length;
    const pairs      = [];

    // Cross-pair: group[i] rank1 vs group[n-1-i] rank2
    for (let i = 0; i < Math.floor(n / 2); i++) {
      const gA = groupNames[i];
      const gB = groupNames[n - 1 - i];
      pairs.push([ byGroup[gA]?.[1], byGroup[gB]?.[2] ]);  // A1 vs D2
      pairs.push([ byGroup[gB]?.[1], byGroup[gA]?.[2] ]);  // D1 vs A2
    }

    return pairs;
  }

  /**
   * Ranked seeding: rank all WB advancers by group record, then pair 1v8, 2v7…
   * Requires recalculating cross-group rankings.
   *
   * @param {Object} advancement
   * @returns {Array} pairs
   */
  function rankedSeed(advancement) {
    // Sort all WB teams by wins desc, then gameDiff desc
    const ranked = [...advancement.winnersBracket].sort((a, b) => {
      const wa = a.standing?.wins ?? 0;
      const wb = b.standing?.wins ?? 0;
      if (wb !== wa) return wb - wa;
      const da = a.standing?.gameDiff ?? 0;
      const db = b.standing?.gameDiff ?? 0;
      return db - da;
    });

    const pairs = [];
    const half  = Math.floor(ranked.length / 2);
    for (let i = 0; i < half; i++) {
      pairs.push([ ranked[i].team, ranked[ranked.length - 1 - i].team ]);
    }
    return pairs;
  }

  /**
   * Straight seeding: A1vA2, B1vB2, … (same-group rematches possible)
   *
   * @param {Object} advancement
   * @returns {Array} pairs
   */
  function straightSeed(advancement) {
    // Sort into groups, then pair rank 1 vs rank 2 within each group
    const byGroup = {};
    advancement.winnersBracket.forEach(({ team, group, rank }) => {
      if (!byGroup[group]) byGroup[group] = {};
      byGroup[group][rank] = team;
    });

    return Object.keys(byGroup).sort().map(g => [
      byGroup[g][1], byGroup[g][2]
    ]);
  }

  // ================================================================
  // PLAYOFF SEEDING (main entry point)
  // ================================================================

  /**
   * Seed a playoff bracket after all groups are complete.
   * Mutates tournament in-place (call after deepClone if needed).
   *
   * @param {Object} tournament       — full tournament object
   * @param {Object} opts
   * @param {string} opts.strategy    — 'cross' | 'ranked' | 'straight' (default: 'cross')
   * @param {number} opts.advanceToWB — teams per group into WB (default: 2)
   * @param {number} opts.advanceToLB — teams per group into LB (default: 1)
   * @returns {Object} updated tournament
   */
  function seedPlayoffBracket(tournament, opts = {}) {
    const {
      strategy   = 'cross',
      advanceToWB = 2,
      advanceToLB = 1,
    } = opts;

    // Validate groups are complete
    const { complete, pending } = checkGroupsComplete(tournament.groups);
    if (!complete) {
      throw new Error(
        `Cannot seed playoffs: ${pending} group match${pending !== 1 ? 'es' : ''} still pending.`
      );
    }

    // Collect who advances from each group
    const advancement = collectAdvancement(
      tournament.groups, tournament.teams, { advanceToWB, advanceToLB }
    );

    // Build WB seed pairs using chosen strategy
    let wbPairs;
    if (strategy === 'ranked') {
      wbPairs = rankedSeed(advancement);
    } else if (strategy === 'straight') {
      wbPairs = straightSeed(advancement);
    } else {
      wbPairs = crossBracketSeed(advancement, tournament.groups.length);
    }

    // Write team IDs into WB Round 1 matches
    const wbR1 = tournament.winnersBracket?.rounds?.find(r => r.round === 1);
    if (wbR1) {
      wbPairs.forEach(([ team1, team2 ], i) => {
        const match = wbR1.matches[i];
        if (!match) return;
        match.team1Id  = team1?.id ?? null;
        match.team2Id  = team2?.id ?? null;
        match.phaseKey = 'winnersBracket';
        match.status   = (team1 && team2) ? 'pending' : 'waiting';
      });
    }

    // Write LB R1 pairs (group 3rd places vs each other)
    const lbTeams = advancement.losersBracket;
    const lbR1    = tournament.losersBracket?.rounds?.find(r => r.round === 1);
    if (lbR1 && lbTeams.length >= 2) {
      // Pair them: LB[0] vs LB[1], LB[2] vs LB[3], …
      for (let i = 0; i < lbTeams.length; i += 2) {
        const match = lbR1.matches[i / 2];
        if (!match) continue;
        match.team1Id  = lbTeams[i]?.team?.id     ?? null;
        match.team2Id  = lbTeams[i + 1]?.team?.id ?? null;
        match.phaseKey = 'losersBracket';
        match.status   = 'pending';
      }
    }

    // Stamp phaseKey on all WB/LB matches (ensures routing works)
    tournament.winnersBracket?.rounds?.forEach(r =>
      r.matches.forEach(m => { m.phaseKey = 'winnersBracket'; })
    );
    tournament.losersBracket?.rounds?.forEach(r =>
      r.matches.forEach(m => { m.phaseKey = 'losersBracket'; })
    );

    tournament.phase     = 'playoffs';
    tournament.updatedAt = Date.now();

    return tournament;
  }

  // ================================================================
  // STATUS HELPERS
  // ================================================================

  /**
   * Get a summary of group stage progress for UI display.
   *
   * @param {Array} groups
   * @returns {{ totalMatches, completedMatches, percentComplete, groupSummaries }}
   */
  function getGroupProgress(groups) {
    let total = 0, completed = 0;
    const groupSummaries = groups.map(g => {
      const gTotal     = g.matches?.length || 0;
      const gCompleted = g.matches?.filter(m => m.status === 'completed').length || 0;
      total     += gTotal;
      completed += gCompleted;
      return {
        name:      g.name,
        total:     gTotal,
        completed: gCompleted,
        done:      gTotal > 0 && gCompleted === gTotal,
      };
    });
    return {
      totalMatches:     total,
      completedMatches: completed,
      percentComplete:  total > 0 ? Math.round((completed / total) * 100) : 0,
      groupSummaries,
    };
  }

  /**
   * Get the current leader of each group for live display.
   *
   * @param {Object} group  — single group object with standings
   * @param {Array}  teams  — tournament.teams
   * @returns {Array} sorted standings with team names attached
   */
  function getGroupLeaderboard(group, teams) {
    return (group.standings || []).map((s, i) => ({
      rank:     i + 1,
      team:     teams.find(t => t.id === s.teamId),
      standing: s,
    })).filter(e => e.team);
  }

  // ================================================================
  // PUBLIC API
  // ================================================================

  return {
    checkGroupsComplete,
    collectAdvancement,
    crossBracketSeed,
    rankedSeed,
    straightSeed,
    seedPlayoffBracket,
    getGroupProgress,
    getGroupLeaderboard,
  };

})();

window.GroupsPlayoff = GroupsPlayoff;
