#!/usr/bin/env python3
"""
Province Games — LB Routing Fix Script
Run from your project root:
  cd /mnt/c/Users/Gab/Documents/province-games-tournament-system
  python3 fix_lb_routing.py
"""
import os, sys

BASE = os.getcwd()
print(f'Working in: {BASE}')

# ================================================================
# FIX 1: dropToLosers — replace broken 2*(R-1) formula with
# explicit lookup for the next drop-in (odd) LB round
# ================================================================
path = os.path.join(BASE, 'js/bracket/doubleElim.js')
with open(path, 'r') as f:
    content = f.read()

old = '''function dropToLosers(tournament, completedMatch) {
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
      const lbMatch    = lbR1.matches[lbMatchIdx];
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
  }'''

new = '''function dropToLosers(tournament, completedMatch) {
    const { round, matchNum } = completedMatch;
    const lbRounds = tournament.losersBracket.rounds;

    if (round === 1) {
      // WB R1 losers → LB R1 as team2 (group 3rds are team1)
      // Pair: WB matches (1,2)→LB match 1, (3,4)→LB match 2
      // Cross-slot to keep seeds separated longer
      const lbR1 = lbRounds.find(r => r.round === 1);
      if (!lbR1) return;
      const lbMatchIdx = Math.floor((matchNum - 1) / 2);
      const slot       = (matchNum - 1) % 2 === 0 ? 'team2Id' : 'team1Id';
      const lbMatch    = lbR1.matches[lbMatchIdx];
      if (lbMatch) lbMatch[slot] = completedMatch.loserId;

    } else {
      // WB Round R (R≥2) losers drop into the next ODD (drop-in) LB round
      // at or after position 2*(R-1).
      // This handles ML's 6-round LB where 2*(R-1) can land on a survivor
      // round — we skip ahead to the next drop-in round instead.
      //
      // ML mapping (3-round WB, 6-round LB):
      //   WB R2 (4 matches) → 2*(2-1)=2 → LB R3 (first odd ≥ 2) ← team2
      //   WB R3 (2 matches) → 2*(3-1)=4 → LB R5 (first odd ≥ 4) ← team2
      const targetRoundNum = 2 * (round - 1);
      const lbRound = lbRounds.find(r => r.round >= targetRoundNum && r.round % 2 === 1)
                   || lbRounds.find(r => r.round >= targetRoundNum);
      if (!lbRound) return;

      const lbMatchIdx = matchNum - 1;
      const lbMatch    = lbRound.matches[lbMatchIdx];
      if (lbMatch) lbMatch.team2Id = completedMatch.loserId;
    }
  }'''

if old in content:
    content = content.replace(old, new, 1)
    with open(path, 'w') as f:
        f.write(content)
    print('OK: Fix 1 — dropToLosers updated in doubleElim.js')
else:
    print('ERROR: Fix 1 — dropToLosers pattern not found')
    print('       Check doubleElim.js manually')


# ================================================================
# FIX 2: advanceInLosers — remove broken sameCount logic
# that caused Team Epsilon to appear in every LB round
# ================================================================
with open(path, 'r') as f:
    content = f.read()

old = '''  function advanceInLosers(tournament, completedMatch) {
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

    // Round parity:
    //   Odd  rounds = drop-in  (receive WB losers as team2, LB survivors wait as team1)
    //   Even rounds = survivor (two LB survivors play each other)
    const isCurrentDropIn = round % 2 === 1;
    const isNextDropIn    = (round + 1) % 2 === 1;

    if (isCurrentDropIn) {
      // Drop-in round winner → next survivor round, same match index, team1Id
      // (they are the "waiting" survivor; the other team comes from WB)
      const nextMatch = nextRoundObj.matches[matchNum - 1];
      if (nextMatch) nextMatch.team1Id = completedMatch.winnerId;

    } else {
      // Survivor round: two LB players played each other.
      // Winner advances to next round.
      if (isNextDropIn) {
        // Next round is drop-in: winner waits as team1Id (WB loser fills team2Id)
        // Match count may halve — use floor pairing only if next round has fewer slots
        const nextMatchIdx = nextRoundObj.matches.length < nextRoundObj.matches.length * 2
          ? Math.floor((matchNum - 1) / 2)
          : matchNum - 1;
        // Simpler: direct 1:1 if same count, halve if fewer
        const sameCount = nextRoundObj.matches.length === lbRounds.find(r => r.round === round).matches.length;
        const idx = sameCount ? matchNum - 1 : Math.floor((matchNum - 1) / 2);
        const nextMatch = nextRoundObj.matches[idx];
        if (nextMatch) nextMatch.team1Id = completedMatch.winnerId;
      } else {
        // Next round is also survivor: pair up with floor division, alternate slots
        const nextMatchIdx = Math.floor((matchNum - 1) / 2);
        const slot         = (matchNum - 1) % 2 === 0 ? 'team1Id' : 'team2Id';
        const nextMatch    = nextRoundObj.matches[nextMatchIdx];
        if (nextMatch) nextMatch[slot] = completedMatch.winnerId;
      }
    }
  }'''

new = '''  function advanceInLosers(tournament, completedMatch) {
    const { round, matchNum } = completedMatch;
    const lbRounds        = tournament.losersBracket.rounds;
    const lastRound       = lbRounds[lbRounds.length - 1].round;

    // LB Final winner → Grand Finals slot 2
    if (round === lastRound) {
      tournament.grandFinals.series1.team2Id = completedMatch.winnerId;
      return;
    }

    const currentRoundObj   = lbRounds.find(r => r.round === round);
    const nextRoundObj      = lbRounds.find(r => r.round === round + 1);
    if (!nextRoundObj) return;

    const currentMatchCount = currentRoundObj?.matches.length || 1;
    const nextMatchCount    = nextRoundObj.matches.length;

    // Odd rounds  = drop-in  (WB loser arrives as team2, LB survivor waited as team1)
    // Even rounds = survivor (two LB survivors played each other)
    const isCurrentDropIn = round % 2 === 1;

    if (isCurrentDropIn) {
      // Drop-in winner advances to next (survivor) round at same index as team1
      // They wait there; the next drop-in round's WB loser will fill team2
      const nextMatch = nextRoundObj.matches[matchNum - 1];
      if (nextMatch) nextMatch.team1Id = completedMatch.winnerId;

    } else {
      // Survivor winner advances to next (drop-in) round as team1
      // If next round has fewer matches than current, use floor pairing
      // Otherwise direct 1:1
      const idx = nextMatchCount < currentMatchCount
        ? Math.floor((matchNum - 1) / 2)
        : matchNum - 1;
      const nextMatch = nextRoundObj.matches[idx];
      if (nextMatch) nextMatch.team1Id = completedMatch.winnerId;
    }
  }'''

if old in content:
    content = content.replace(old, new, 1)
    with open(path, 'w') as f:
        f.write(content)
    print('OK: Fix 2 — advanceInLosers simplified in doubleElim.js')
else:
    print('ERROR: Fix 2 — advanceInLosers pattern not found')
    print('       The function may have already been partially patched')


# ================================================================
# FIX 3: Update stale comment in mobileLegends.js
# ================================================================
ml_path = os.path.join(BASE, 'js/games/mobileLegends.js')
with open(ml_path, 'r') as f:
    ml = f.read()

old_c = '''   *   LB Round 1 (Drop-in): 2 matches — 4 teams from groups play 4 WB R1 losers
   *   LB Round 2: 2 matches (survivors)
   *   LB Round 3: 1 match (SF)
   *   LB Round 4: LB Final BO3'''

new_c = '''   *   LB R1 (drop-in):  2 — group 3rds vs each other
   *   LB R2 (drop-in):  2 — R1 winners vs WB QF losers
   *   LB R3 (drop-in):  2 — R2 winners vs WB SF losers
   *   LB R4 (survivor): 1 — 2 R3 survivors
   *   LB R5 (drop-in):  1 — R4 winner vs WB Final loser
   *   LB R6 (LB Final): 1 — BO3'''

if old_c in ml:
    ml = ml.replace(old_c, new_c, 1)
    with open(ml_path, 'w') as f:
        f.write(ml)
    print('OK: Fix 3 — stale comment updated in mobileLegends.js')
else:
    print('SKIP: Fix 3 — comment already updated (non-critical)')

print('')
print('=== All fixes applied ===')
print('Next steps:')
print('  1. Hard reload browser: Ctrl+Shift+R')
print('  2. Clear IndexedDB: DevTools > Application > IndexedDB > Clear')
print('  3. Create a new tournament and test LB routing')
