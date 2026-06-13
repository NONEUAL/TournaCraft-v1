/**
 * js/ui/bracketRenderer.js
 *
 * Bracket Renderer — standalone UI module.
 *
 * Extracted from app.js so view.html can use the same rendering logic
 * without loading the full admin app. All functions are pure: they take
 * a tournament object + a container element and write HTML into it.
 * No global appState is touched; no Storage calls are made.
 *
 * Responsibilities:
 *   - renderTournamentPhase()   exported as window.renderTournamentPhase
 *   - renderGroupStage()
 *   - renderEliminationBracket()
 *   - renderGrandFinals()
 *   - renderRoundRobinPhase()
 *   - buildMatchCard()
 *   - buildRoundConnector()      SVG connector lines
 *   - renderChampionBanner()     shown when tournament.championId is set
 *
 * Click handling:
 *   When readOnly=false, match cards and group rows call the provided
 *   onMatchClick(matchRef) callback. The admin app provides this callback;
 *   view.html passes null / omits it.
 *
 * Dependencies: sanitize() (window.sanitize from app.js or defined below)
 */

'use strict';

const BracketRenderer = (() => {

  // Fallback sanitize if app.js hasn't loaded yet (view.html standalone use)
  function _sanitize(str) {
    if (window.sanitize) return window.sanitize(str);
    if (typeof str !== 'string') return String(str ?? '');
    return str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  // ── Phase list helper ──────────────────────────────────────────

  function getPhaseList(tournament) {
    switch (tournament.format) {
      case 'groups_double_elim':
        return [
          { key: 'groups',         label: 'Group Stage'      },
          { key: 'winnersBracket', label: 'Winners Bracket'  },
          { key: 'losersBracket',  label: 'Losers Bracket'   },
          { key: 'grandFinals',    label: 'Grand Finals'     },
        ];
      case 'double_elimination':
        return [
          { key: 'winnersBracket', label: 'Winners Bracket'  },
          { key: 'losersBracket',  label: 'Losers Bracket'   },
          { key: 'grandFinals',    label: 'Grand Finals'     },
        ];
      case 'round_robin':
        return [{ key: 'roundRobin', label: 'Round Robin' }];
      case 'single_elimination':
      default:
        return [{ key: 'singleElim', label: 'Bracket' }];
    }
  }

  // ================================================================
  // MAIN ENTRY POINT
  // ================================================================

  /**
   * Render a tournament phase into a container element.
   *
   * @param {Object}   tournament
   * @param {number}   phaseIndex    — index into getPhaseList()
   * @param {Element}  container     — DOM element to write into
   * @param {boolean}  readOnly      — true = viewer mode, no click handlers
   * @param {Function} onMatchClick  — called with matchRef when a match is clicked
   */
  function renderTournamentPhase(tournament, phaseIndex, container, readOnly, onMatchClick) {
    const phases = getPhaseList(tournament);
    const phase  = phases[phaseIndex];
    if (!phase) { container.innerHTML = ''; return; }

    // Show champion banner if tournament is complete
    if (tournament.championId) {
      const champion = tournament.teams?.find(t => t.id === tournament.championId);
      if (champion) {
        const existing = container.parentElement?.querySelector('.champion-banner');
        if (!existing) renderChampionBanner(champion, container);
      }
    }

    switch (phase.key) {
      case 'groups':
        renderGroupStage(tournament, container, readOnly, onMatchClick);
        break;
      case 'winnersBracket':
        renderEliminationBracket(
          tournament.winnersBracket, 'Winners', container, readOnly, tournament, onMatchClick
        );
        break;
      case 'losersBracket':
        renderEliminationBracket(
          tournament.losersBracket, 'Losers', container, readOnly, tournament, onMatchClick
        );
        break;
      case 'grandFinals':
        renderGrandFinals(tournament, container, readOnly, onMatchClick);
        break;
      case 'roundRobin':
        renderRoundRobinPhase(tournament, container, readOnly, onMatchClick);
        break;
      case 'singleElim':
      default:
        renderEliminationBracket(
          tournament.winnersBracket || tournament.bracket,
          'Bracket', container, readOnly, tournament, onMatchClick
        );
        // Third-place match
        if (tournament.thirdPlaceMatch) {
          renderThirdPlaceMatch(tournament, container, readOnly, onMatchClick);
        }
        break;
    }
  }

  // ================================================================
  // GROUP STAGE
  // ================================================================

  function renderGroupStage(tournament, container, readOnly, onMatchClick) {
    if (!tournament.groups?.length) {
      container.innerHTML = '<p class="loading-overlay">No group data available.</p>';
      return;
    }

    container.innerHTML = '<div class="groups-layout"></div>';
    const layout = container.querySelector('.groups-layout');

    tournament.groups.forEach(group => {
      const block = document.createElement('div');
      block.className = 'group-block';

      const advanced = (group.standings || []).filter(s => s.advanced).length;
      block.innerHTML = `
        <div class="group-block-header">
          <span class="group-name">Group ${_sanitize(group.name)}</span>
          <span class="group-subtitle">${advanced} advance</span>
        </div>
        ${renderGroupStandingsTable(group, tournament.teams)}
        <div class="group-matches" data-group="${_sanitize(group.name)}">
          ${(group.matches || []).map(m =>
            renderGroupMatchRow(m, tournament.teams, readOnly)
          ).join('')}
        </div>`;
      layout.appendChild(block);
    });

    // Attach click handlers via delegation on the whole container
    if (!readOnly && typeof onMatchClick === 'function') {
      container.addEventListener('click', function onGroupClick(e) {
        const row = e.target.closest('.group-match-row');
        if (!row || row.classList.contains('completed')) return;
        const matchId = row.dataset.matchId;
        const groupId = row.dataset.groupId;
        if (matchId && groupId) {
          onMatchClick({ matchId, groupId, phaseKey: 'groups' });
        }
      });
    }
  }

  function renderGroupStandingsTable(group, teams) {
    const standings = group.standings || [];
    if (!standings.length) {
      // No standings yet — show team list placeholder
      const groupTeams = teams.filter(t => group.teamIds?.includes(t.id));
      return `<table class="group-standings">
        <thead><tr><th>Team</th><th>W</th><th>L</th><th>Diff</th><th></th></tr></thead>
        <tbody>${groupTeams.map((t, i) => `<tr>
          <td><span class="team-rank-indicator">${i + 1}</span>${_sanitize(t.name)}</td>
          <td style="text-align:center">0</td><td style="text-align:center">0</td>
          <td style="text-align:center">0</td><td></td></tr>`).join('')}
        </tbody></table>`;
    }

    const rows = standings.map((s, i) => {
      const team        = teams.find(t => t.id === s.teamId);
      const advBadge    = i < 2 ? '→ WB' : i === 2 ? '→ LB' : '✗';
      const advColor    = i < 2 ? 'var(--c-accent)' : i === 2 ? '#c8a840' : 'var(--c-text-muted)';
      return `<tr class="rank-${i + 1}">
        <td><span class="team-rank-indicator">${i + 1}</span>${_sanitize(team?.name || 'TBD')}</td>
        <td style="text-align:center">${s.wins ?? 0}</td>
        <td style="text-align:center">${s.losses ?? 0}</td>
        <td style="text-align:center">${s.gameDiff ?? 0}</td>
        <td style="text-align:right;font-size:11px;font-weight:700;color:${advColor}">${advBadge}</td>
      </tr>`;
    }).join('');

    return `<table class="group-standings">
      <thead><tr><th>Team</th><th>W</th><th>L</th><th>Diff</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function renderGroupMatchRow(match, teams, readOnly) {
    const t1   = teams.find(t => t.id === match.team1Id);
    const t2   = teams.find(t => t.id === match.team2Id);
    const done = match.status === 'completed';
    const scoreHtml = done
      ? `<span class="match-score-inline">${match.score1}–${match.score2}</span>`
      : `<span class="match-score-inline pending">vs</span>`;

    return `<div class="group-match-row${done ? ' completed' : ''}"
      data-match-id="${_sanitize(match.id)}"
      data-group-id="${_sanitize(match.groupId)}"
      ${!readOnly && !done ? 'role="button" tabindex="0"' : ''}>
      <div class="match-teams-inline">
        <span class="match-team-inline">${_sanitize(t1?.name || 'TBD')}</span>
        <span class="match-vs">vs</span>
        <span class="match-team-inline">${_sanitize(t2?.name || 'TBD')}</span>
      </div>
      ${scoreHtml}
      <span style="font-size:11px;color:var(--c-text-muted);margin-left:4px">R${match.round}</span>
    </div>`;
  }

  // ================================================================
  // ELIMINATION BRACKET
  // ================================================================

  function renderEliminationBracket(bracket, label, container, readOnly, tournament, onMatchClick) {
    container.innerHTML = '';

    if (!bracket?.rounds?.length) {
      container.innerHTML = `<div class="loading-overlay" style="width:100%">
        <p>${label} bracket starts after group stage is complete.</p></div>`;
      return;
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:inline-flex;gap:0;min-width:100%;align-items:flex-start;padding-bottom:16px';
    container.appendChild(wrap);

    bracket.rounds.forEach((round, ri) => {
      // SVG connector column before each round (except first)
      if (ri > 0) {
        wrap.appendChild(buildRoundConnector(
          bracket.rounds[ri - 1].matches.length,
          round.matches.length
        ));
      }

      const col = document.createElement('div');
      col.className = 'bracket-round-col';
      col.innerHTML = `<div class="round-header">
        ${_sanitize(round.label || `Round ${ri + 1}`)}
        <br><span style="font-size:10px;font-weight:400">BO${round.bestOf || 3}</span>
      </div>`;

      const matchesWrap = document.createElement('div');
      matchesWrap.className = 'round-matches';

      round.matches.forEach(match => {
        const card = buildMatchCard(match, tournament?.teams || [], readOnly, onMatchClick);
        matchesWrap.appendChild(card);
      });

      col.appendChild(matchesWrap);
      wrap.appendChild(col);
    });
  }

  // ── Match card ─────────────────────────────────────────────────

  function buildMatchCard(match, teams, readOnly, onMatchClick) {
    const t1          = match.team1Id ? teams.find(t => t.id === match.team1Id) : null;
    const t2          = match.team2Id ? teams.find(t => t.id === match.team2Id) : null;
    const isBye       = match.isBye;
    const isCompleted = match.status === 'completed';
    const isWaiting   = match.status === 'waiting';

    const card = document.createElement('div');
    card.className = `match-card${isBye ? ' bye' : ''}${isWaiting ? ' tbd' : ''}`;
    card.dataset.matchId = match.id;

    const p1Class = isCompleted ? (match.winnerId === match.team1Id ? 'winner' : 'loser') : '';
    const p2Class = isCompleted ? (match.winnerId === match.team2Id ? 'winner' : 'loser') : '';

    const score1 = isCompleted ? `<span class="participant-score">${match.score1 ?? ''}</span>` : '';
    const score2 = isCompleted ? `<span class="participant-score">${match.score2 ?? ''}</span>` : '';

    card.innerHTML = `
      <div class="match-participant ${p1Class}${!t1 ? ' empty' : ''}">
        <span class="participant-seed">${t1?.seed ?? ''}</span>
        <span class="participant-name">${_sanitize(t1?.name || (isBye ? 'BYE' : 'TBD'))}</span>
        ${score1}
      </div>
      <div class="match-participant ${p2Class}${!t2 ? ' empty' : ''}">
        <span class="participant-seed">${t2?.seed ?? ''}</span>
        <span class="participant-name">${_sanitize(t2?.name || (isBye ? '—' : 'TBD'))}</span>
        ${score2}
      </div>`;

    if (!readOnly && t1 && t2 && !isBye && typeof onMatchClick === 'function') {
      card.addEventListener('click', () => {
        onMatchClick({ matchId: match.id, phaseKey: match.phaseKey || 'bracket' });
      });
    }
    return card;
  }

  // ── SVG connector ──────────────────────────────────────────────

  function buildRoundConnector(prevCount, nextCount) {
    const wrap = document.createElement('div');
    wrap.className = 'bracket-connector-col';
    wrap.style.cssText = 'display:flex;align-items:stretch;width:28px;flex-shrink:0;';

    const MATCH_H = 88;
    const totalH  = Math.max(prevCount, nextCount) * MATCH_H;
    const ratio   = prevCount / Math.max(nextCount, 1);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', String(totalH));
    svg.setAttribute('viewBox', `0 0 28 ${totalH}`);
    svg.style.overflow = 'visible';

    for (let ni = 0; ni < nextCount; ni++) {
      const pi1 = ni * ratio;
      const pi2 = pi1 + ratio - 1;
      const y1  = (pi1 + 0.5) * MATCH_H;
      const y2  = (pi2 + 0.5) * MATCH_H;
      const yM  = (y1 + y2) / 2;

      // Line from top prev match to midpoint then to next match
      const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path1.setAttribute('d', `M0,${y1} H14 V${yM} H28`);
      path1.setAttribute('stroke', '#403F4C');
      path1.setAttribute('stroke-width', '1.5');
      path1.setAttribute('fill', 'none');

      // Line from bottom prev match to same midpoint
      const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path2.setAttribute('d', `M0,${y2} H14`);
      path2.setAttribute('stroke', '#403F4C');
      path2.setAttribute('stroke-width', '1.5');
      path2.setAttribute('fill', 'none');

      svg.appendChild(path1);
      svg.appendChild(path2);
    }

    wrap.appendChild(svg);
    return wrap;
  }

  // ================================================================
  // GRAND FINALS
  // ================================================================

  function renderGrandFinals(tournament, container, readOnly, onMatchClick) {
    container.innerHTML = '';
    const gf = tournament.grandFinals;

    if (!gf) {
      container.innerHTML = `<div class="loading-overlay" style="width:100%">
        <p>Grand Finals starts after the bracket stages are complete.</p></div>`;
      return;
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px;width:100%';
    container.appendChild(wrap);

    // Header
    const hdr = document.createElement('div');
    hdr.innerHTML = `<h2 style="text-align:center;margin-bottom:4px">🏆 Grand Finals</h2>
      <p style="text-align:center;font-size:13px">
        Best of ${gf.bestOf}
        ${gf.bracketReset
          ? ' · <span style="color:var(--c-accent);font-weight:700">⚡ Bracket Reset</span>'
          : ''}
      </p>`;
    wrap.appendChild(hdr);

    // Series 1
    if (gf.series1) {
      const s1Label = document.createElement('div');
      s1Label.className = 'bracket-section-label';
      s1Label.style.cssText = 'text-align:center;min-width:260px;margin-bottom:8px';
      s1Label.textContent = 'Series 1 — WB Champion vs LB Champion';
      wrap.appendChild(s1Label);

      const s1Card = buildMatchCard(gf.series1, tournament.teams, readOnly, onMatchClick);
      s1Card.classList.add('grand-finals');
      s1Card.style.width = '260px';
      const lbl = document.createElement('div');
      lbl.className = 'match-label';
      lbl.textContent = 'GF S1';
      s1Card.appendChild(lbl);
      wrap.appendChild(s1Card);
    }

    // Bracket reset series 2
    if (gf.bracketReset && gf.series2) {
      const divider = document.createElement('div');
      divider.className = 'bracket-divider';
      divider.textContent = '⚡ Bracket Reset — Series 2';
      wrap.appendChild(divider);

      const s2Card = buildMatchCard(gf.series2, tournament.teams, readOnly, onMatchClick);
      s2Card.classList.add('grand-finals');
      s2Card.style.width = '260px';
      const lbl2 = document.createElement('div');
      lbl2.className = 'match-label';
      lbl2.style.background = '#d4af37';
      lbl2.textContent = 'GF S2';
      s2Card.appendChild(lbl2);
      wrap.appendChild(s2Card);
    }
  }

  // ================================================================
  // ROUND ROBIN
  // ================================================================

  function renderRoundRobinPhase(tournament, container, readOnly, onMatchClick) {
    container.innerHTML = '';
    const rr = tournament.roundRobin;

    if (!rr) {
      container.innerHTML = '<div class="loading-overlay"><p>No round robin data.</p></div>';
      return;
    }

    const layout = document.createElement('div');
    layout.className = 'groups-layout';
    container.appendChild(layout);

    const block = document.createElement('div');
    block.className = 'group-block';
    block.innerHTML = `
      <div class="group-block-header">
        <span class="group-name">Round Robin Standings</span>
        <span class="group-subtitle">${(rr.standings || []).length} teams</span>
      </div>
      ${renderGroupStandingsTable({ standings: rr.standings, teamIds: tournament.teams.map(t => t.id) }, tournament.teams)}
      <div class="group-matches" data-group="rr">
        ${(rr.matches || []).map(m => renderGroupMatchRow(m, tournament.teams, readOnly)).join('')}
      </div>`;
    layout.appendChild(block);

    if (!readOnly && typeof onMatchClick === 'function') {
      container.addEventListener('click', e => {
        const row = e.target.closest('.group-match-row');
        if (!row || row.classList.contains('completed')) return;
        const matchId = row.dataset.matchId;
        if (matchId) onMatchClick({ matchId, phaseKey: 'roundRobin' });
      });
    }
  }

  // ================================================================
  // THIRD PLACE MATCH
  // ================================================================

  function renderThirdPlaceMatch(tournament, container, readOnly, onMatchClick) {
    const match = tournament.thirdPlaceMatch;
    if (!match) return;

    const divider = document.createElement('div');
    divider.className = 'bracket-divider';
    divider.textContent = '3rd Place Match';
    container.appendChild(divider);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;justify-content:center;padding:0 24px 24px';
    const card = buildMatchCard(match, tournament.teams, readOnly, onMatchClick);
    card.style.width = '220px';
    wrap.appendChild(card);
    container.appendChild(wrap);
  }

  // ================================================================
  // CHAMPION BANNER
  // ================================================================

  function renderChampionBanner(champion, container) {
    const banner = document.createElement('div');
    banner.className = 'champion-banner';
    banner.style.cssText = [
      'text-align:center', 'padding:20px 16px', 'margin-bottom:16px',
      'background:linear-gradient(135deg,rgba(105,148,184,0.15),rgba(105,148,184,0.05))',
      'border:1.5px solid var(--c-accent)', 'border-radius:12px',
      'animation:toast-in 0.4s ease'
    ].join(';');
    banner.innerHTML = `
      <div style="font-size:36px;margin-bottom:8px">🏆</div>
      <div style="font-size:18px;font-weight:700;color:var(--c-text)">Tournament Champion</div>
      <div style="font-size:22px;font-weight:800;color:var(--c-accent);margin-top:4px">
        ${_sanitize(champion.name)}
      </div>`;
    container.insertAdjacentElement('beforebegin', banner);
  }

  // ================================================================
  // PUBLIC API
  // ================================================================

  return {
    renderTournamentPhase,
    renderGroupStage,
    renderEliminationBracket,
    renderGrandFinals,
    renderRoundRobinPhase,
    renderThirdPlaceMatch,
    buildMatchCard,
    buildRoundConnector,
    renderChampionBanner,
    getPhaseList,
  };

})();

// Expose globally so app.js and view.html can both call it
window.BracketRenderer = BracketRenderer;

// Override the global renderTournamentPhase that view.html uses
window.renderTournamentPhase = function(tournament, phaseIndex, container, readOnly, onMatchClick) {
  BracketRenderer.renderTournamentPhase(tournament, phaseIndex, container, readOnly, onMatchClick);
};
