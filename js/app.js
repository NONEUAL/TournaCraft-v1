/**
 * app.js — Province Games Tournament Maker
 * Main application controller. Manages views, form flow,
 * bracket rendering, and match score updates.
 *
 * Depends on: storage.js, bracket/doubleElim.js,
 *             bracket/roundRobin.js, games/mobileLegends.js
 */

'use strict';

// ================================================================
// CONSTANTS & GAME CONFIGS
// ================================================================

/** Display label and config for each supported game type */
const GAME_CONFIGS = {
  mobile_legends: {
    label:       'Mobile Legends',
    teamSize:    5,
    scoreUnit:   'Games',
    defaultBO:   3,
    formats:     ['groups_double_elim', 'double_elimination', 'single_elimination'],
    scoreMin:    0,
    scoreMax:    3,
  },
  cod_mobile: {
    label:       'COD Mobile',
    teamSize:    5,
    scoreUnit:   'Games',
    defaultBO:   3,
    formats:     ['double_elimination', 'single_elimination'],
    scoreMin:    0,
    scoreMax:    3,
  },
  volleyball: {
    label:       'Volleyball',
    teamSize:    6,
    scoreUnit:   'Sets',
    defaultBO:   3,
    formats:     ['single_elimination', 'round_robin', 'groups_double_elim'],
    scoreMin:    0,
    scoreMax:    3,
  },
  basketball: {
    label:       'Basketball',
    teamSize:    5,
    scoreUnit:   'Points',
    defaultBO:   1,
    formats:     ['single_elimination', 'round_robin'],
    scoreMin:    0,
    scoreMax:    200,
  },
  tekken: {
    label:       'Tekken',
    teamSize:    1,
    scoreUnit:   'Rounds',
    defaultBO:   3,
    formats:     ['double_elimination', 'single_elimination'],
    scoreMin:    0,
    scoreMax:    3,
  }
};

const FORMAT_LABELS = {
  groups_double_elim: 'Groups → Double Elim',
  double_elimination: 'Double Elimination',
  single_elimination: 'Single Elimination',
  round_robin:        'Round Robin',
  swiss:              'Swiss Stage',
};

/** Demo tournament matching spec requirements */
const DEMO_TOURNAMENT_DATA = {
  name:   'MLBB Provincial Cup 2024',
  game:   'mobile_legends',
  format: 'groups_double_elim',
  date:   '2024-11-15',
  venue:  'City Sports Complex',
  teams: [
    'Team Alpha', 'Team Beta', 'Team Gamma', 'Team Delta',
    'Team Epsilon', 'Team Zeta', 'Team Eta', 'Team Theta',
    'Team Iota', 'Team Kappa', 'Team Lambda', 'Team Mu',
    'Team Nu', 'Team Xi', 'Team Omicron', 'Team Pi',
  ]
};

// ================================================================
// APPLICATION STATE
// ================================================================

let appState = {
  currentView:        'dashboard',
  activeTournamentId: null,
  activeTournament:   null,
  activePhaseIndex:   0,
  pendingMatchEdit:   null,   // { matchId, phaseKey, groupId? }
  formStep:           1,
  formData:           {},
  teams:              [],
};

// ================================================================
// DOM REFERENCES
// ================================================================

const $ = id => document.getElementById(id);

const DOM = {
  views: {
    dashboard: $('view-dashboard'),
    create:    $('view-create'),
    bracket:   $('view-bracket'),
  },
  // Dashboard
  tournamentList: $('tournament-list'),
  emptyState:     $('empty-state'),
  btnOpenCreate:  $('btn-open-create'),
  btnEmptyCreate: $('btn-empty-create'),
  // Create form
  tournamentForm: $('tournament-form'),
  steps:          [null, $('step-1'), $('step-2'), $('step-3')],
  tName:          $('t-name'),
  tGame:          $('t-game'),
  tFormat:        $('t-format'),
  tDate:          $('t-date'),
  tVenue:         $('t-venue'),
  teamsGrid:      $('teams-grid'),
  teamCountLabel: $('team-count-label'),
  reviewSummary:  $('review-summary'),
  // Bracket
  bracketName:    $('bracket-tournament-name'),
  bracketStatus:  $('bracket-status-badge'),
  phaseTabs:      $('phase-tabs'),
  bracketContent: $('bracket-content'),
  btnShare:       $('btn-share'),
  // Modals
  scoreModal:     $('modal-score'),
  shareModal:     $('modal-share'),
  // Score modal fields
  modalTeam1:     $('modal-team1-name'),
  modalTeam2:     $('modal-team2-name'),
  modalScore1:    $('modal-score1'),
  modalScore2:    $('modal-score2'),
  modalBestOf:    $('modal-best-of'),
  gameSeriesTracker: $('game-series-tracker'),
  // Share modal
  shareCodeValue:  $('share-code-value'),
  shareUrlDisplay: $('share-url-display'),
  // Connection
  connectionBadge: $('connection-status'),
};

// ================================================================
// INITIALISATION
// ================================================================

document.addEventListener('DOMContentLoaded', async () => {
  initConnectionMonitor();
  bindNavigationEvents();
  bindCreateFormEvents();
  bindBracketEvents();
  bindModalEvents();
  await loadDashboard();
});

// ================================================================
// CONNECTION MONITOR
// ================================================================

function initConnectionMonitor() {
  const badge = DOM.connectionBadge;
  function update() {
    const online = navigator.onLine;
    badge.className = `connection-badge ${online ? 'online' : 'offline'}`;
    badge.querySelector('.status-text').textContent = online ? 'Online' : 'Offline';
    if (online) syncPendingChanges();
  }
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
}

async function syncPendingChanges() {
  try {
    await Storage.syncPendingChanges();
  } catch (err) {
    console.warn('[Sync] Could not sync:', err);
  }
}

// ================================================================
// VIEW NAVIGATION
// ================================================================

function showView(viewName) {
  Object.values(DOM.views).forEach(v => v?.classList.remove('active'));
  DOM.views[viewName]?.classList.add('active');
  appState.currentView = viewName;

  // Keep nav buttons in sync
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
}

function bindNavigationEvents() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === 'create') openCreateView();
      else if (view === 'dashboard') showView('dashboard');
    });
  });

  DOM.btnOpenCreate?.addEventListener('click', openCreateView);
  DOM.btnEmptyCreate?.addEventListener('click', openCreateView);

  $('btn-back-dashboard')?.addEventListener('click', () => showView('dashboard'));
  $('btn-back-from-bracket')?.addEventListener('click', async () => {
    await loadDashboard();
    showView('dashboard');
  });
}

// ================================================================
// DASHBOARD
// ================================================================

async function loadDashboard() {
  try {
    const tournaments = await Storage.getAllTournaments();
    renderDashboard(tournaments);
  } catch (err) {
    showToast('Unable to load your tournaments. Refresh to try again.', 'error');
    console.error('[Dashboard] Load error:', err);
  }
}

function renderDashboard(tournaments) {
  if (!tournaments || tournaments.length === 0) {
    DOM.tournamentList.innerHTML = '';
    DOM.emptyState.classList.remove('hidden');
    return;
  }
  DOM.emptyState.classList.add('hidden');

  DOM.tournamentList.innerHTML = tournaments.map(t => {
    const gameCfg = GAME_CONFIGS[t.game] || { label: t.game };
    const fmtLabel = FORMAT_LABELS[t.format] || t.format;
    const teamCount = t.teams?.length || 0;
    const dateStr = t.date ? new Date(t.date).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '';

    return `
    <div class="tournament-card" data-id="${sanitize(t.id)}" role="button" tabindex="0"
         aria-label="Open ${sanitize(t.name)} tournament">
      <div class="tournament-card-header">
        <div class="tournament-card-title">${sanitize(t.name)}</div>
        <span class="status-badge ${t.status === 'active' ? 'status-active' : t.status === 'done' ? 'status-done' : 'status-pending'}">
          ${t.status === 'active' ? '● Active' : t.status === 'done' ? 'Finished' : 'Draft'}
        </span>
      </div>
      <div class="tournament-card-meta">
        <span class="tag tag-game">${sanitize(gameCfg.label)}</span>
        <span class="tag tag-format">${sanitize(fmtLabel)}</span>
        <span class="tag">${teamCount} teams</span>
        ${dateStr ? `<span class="tag">${sanitize(dateStr)}</span>` : ''}
      </div>
      <div class="tournament-card-actions">
        <button class="btn btn-primary btn-sm btn-open-bracket" data-id="${sanitize(t.id)}">
          Open Bracket
        </button>
        <button class="btn btn-secondary btn-sm btn-delete-tournament" data-id="${sanitize(t.id)}"
          aria-label="Delete ${sanitize(t.name)}">Delete</button>
      </div>
    </div>`;
  }).join('');

  // Bind card actions
  DOM.tournamentList.querySelectorAll('.btn-open-bracket').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openBracket(btn.dataset.id);
    });
  });
  DOM.tournamentList.querySelectorAll('.btn-delete-tournament').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (confirm('Delete this tournament? This cannot be undone.')) {
        try {
          await Storage.deleteTournament(btn.dataset.id);
          await loadDashboard();
          showToast('Tournament deleted.', 'success');
        } catch (err) {
          showToast('Unable to delete tournament. Try again.', 'error');
        }
      }
    });
  });
  DOM.tournamentList.querySelectorAll('.tournament-card').forEach(card => {
    card.addEventListener('click', () => openBracket(card.dataset.id));
    card.addEventListener('keydown', e => { if (e.key === 'Enter') openBracket(card.dataset.id); });
  });
}

// ================================================================
// CREATE TOURNAMENT FORM
// ================================================================

function openCreateView() {
  appState.formStep = 1;
  appState.formData = {};
  appState.teams = [];
  DOM.tName.value = '';
  DOM.tDate.value = new Date().toISOString().split('T')[0];
  DOM.tVenue.value = '';
  renderTeamsGrid(8); // Default 8 team slots
  goToStep(1);
  showView('create');
}

function goToStep(n) {
  DOM.steps.forEach((s, i) => { if (s) s.classList.toggle('active', i === n); });
  appState.formStep = n;
  if (n === 3) renderReviewSummary();
}

function bindCreateFormEvents() {
  $('btn-step1-next')?.addEventListener('click', () => {
    if (validateStep1()) goToStep(2);
  });
  $('btn-step2-back')?.addEventListener('click', () => goToStep(1));
  $('btn-step2-next')?.addEventListener('click', () => {
    if (validateStep2()) goToStep(3);
  });
  $('btn-step3-back')?.addEventListener('click', () => goToStep(2));
  $('btn-add-team')?.addEventListener('click', () => addTeamSlot());
  $('btn-load-demo')?.addEventListener('click', loadDemoData);
  $('btn-clear-teams')?.addEventListener('click', clearTeams);

  DOM.tournamentForm?.addEventListener('submit', async e => {
    e.preventDefault();
    await generateTournament();
  });
}

function validateStep1() {
  const name = DOM.tName.value.trim();
  const errEl = DOM.steps[1].querySelector('.field-error');
  if (!name) {
    errEl.textContent = 'Please enter a tournament name.';
    DOM.tName.focus();
    return false;
  }
  if (name.length > 80) {
    errEl.textContent = 'Name must be 80 characters or fewer.';
    return false;
  }
  errEl.textContent = '';
  appState.formData = {
    name:   sanitize(name),
    game:   DOM.tGame.value,
    format: DOM.tFormat.value,
    date:   DOM.tDate.value,
    venue:  sanitize(DOM.tVenue.value.trim()),
  };
  return true;
}

function validateStep2() {
  const teams = getTeamsFromGrid();
  if (teams.length < 2) {
    showToast('Please add at least 2 teams.', 'error');
    return false;
  }
  // Validate group-based formats need multiples of 4 (up to 16 for MVP)
  if (appState.formData.format === 'groups_double_elim') {
    if (teams.length !== 16 && teams.length !== 8) {
      showToast('Group stage requires exactly 8 or 16 teams.', 'error');
      return false;
    }
  }
  // Check for duplicate names
  const names = teams.map(t => t.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    showToast('Team names must be unique.', 'error');
    return false;
  }
  appState.teams = teams;
  return true;
}

/** Render the grid of team name inputs */
function renderTeamsGrid(count) {
  DOM.teamsGrid.innerHTML = Array.from({ length: count }, (_, i) =>
    `<div class="team-input-wrap" data-slot="${i}">
      <span class="team-seed-num">${i + 1}</span>
      <input type="text" class="team-name-input" placeholder="Team ${i + 1}"
        maxlength="40" autocomplete="off" data-index="${i}"
        aria-label="Team ${i + 1} name" />
      <button type="button" class="btn btn-remove-team" aria-label="Remove team ${i + 1}"
        onclick="removeTeamSlot(${i})">
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24">
          <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>`
  ).join('');
  updateTeamCount();
  // Update count label on input
  DOM.teamsGrid.querySelectorAll('.team-name-input').forEach(inp =>
    inp.addEventListener('input', updateTeamCount)
  );
}

function addTeamSlot() {
  const current = DOM.teamsGrid.children.length;
  if (current >= 32) { showToast('Maximum 32 teams supported.', 'error'); return; }
  const i = current;
  const wrap = document.createElement('div');
  wrap.className = 'team-input-wrap';
  wrap.dataset.slot = i;
  wrap.innerHTML = `
    <span class="team-seed-num">${i + 1}</span>
    <input type="text" class="team-name-input" placeholder="Team ${i + 1}"
      maxlength="40" autocomplete="off" data-index="${i}"
      aria-label="Team ${i + 1} name" />
    <button type="button" class="btn btn-remove-team" aria-label="Remove team"
      onclick="removeTeamSlot(${i})">
      <svg width="14" height="14" fill="none" viewBox="0 0 24 24">
        <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </button>`;
  wrap.querySelector('.team-name-input').addEventListener('input', updateTeamCount);
  DOM.teamsGrid.appendChild(wrap);
  wrap.querySelector('input').focus();
  updateTeamCount();
}

function removeTeamSlot(index) {
  const slots = DOM.teamsGrid.querySelectorAll('.team-input-wrap');
  if (slots.length <= 2) { showToast('Need at least 2 teams.', 'error'); return; }
  slots[index]?.remove();
  // Re-number remaining slots
  DOM.teamsGrid.querySelectorAll('.team-input-wrap').forEach((wrap, i) => {
    wrap.dataset.slot = i;
    const seedEl = wrap.querySelector('.team-seed-num');
    if (seedEl) seedEl.textContent = i + 1;
    const inp = wrap.querySelector('input');
    if (inp) { inp.dataset.index = i; inp.setAttribute('aria-label', `Team ${i + 1} name`); }
  });
  updateTeamCount();
}

function getTeamsFromGrid() {
  const inputs = DOM.teamsGrid.querySelectorAll('.team-name-input');
  const teams = [];
  inputs.forEach((inp, i) => {
    const name = inp.value.trim();
    if (name) {
      teams.push({ id: i + 1, name: sanitize(name), seed: i + 1 });
    }
  });
  return teams;
}

function updateTeamCount() {
  const filled = getTeamsFromGrid().length;
  DOM.teamCountLabel.textContent = `${filled} team${filled !== 1 ? 's' : ''} added`;
}

function clearTeams() {
  DOM.teamsGrid.querySelectorAll('.team-name-input').forEach(inp => { inp.value = ''; });
  updateTeamCount();
}

function loadDemoData() {
  const names = DEMO_TOURNAMENT_DATA.teams;
  const slots = DOM.teamsGrid.querySelectorAll('.team-name-input');
  // Expand grid if needed
  while (DOM.teamsGrid.children.length < names.length) addTeamSlot();
  DOM.teamsGrid.querySelectorAll('.team-name-input').forEach((inp, i) => {
    inp.value = names[i] || '';
  });
  // Also pre-fill step 1 fields
  DOM.tName.value  = DEMO_TOURNAMENT_DATA.name;
  DOM.tGame.value  = DEMO_TOURNAMENT_DATA.game;
  DOM.tFormat.value = DEMO_TOURNAMENT_DATA.format;
  DOM.tDate.value  = DEMO_TOURNAMENT_DATA.date;
  DOM.tVenue.value = DEMO_TOURNAMENT_DATA.venue;
  updateTeamCount();
  showToast('Demo data loaded! ✓', 'success');
}

function renderReviewSummary() {
  const d = appState.formData;
  const teams = getTeamsFromGrid();
  const gameCfg = GAME_CONFIGS[d.game] || { label: d.game };
  const fmtLabel = FORMAT_LABELS[d.format] || d.format;
  DOM.reviewSummary.innerHTML = `
    <div class="review-row"><span class="review-label">Name</span><span class="review-value">${sanitize(d.name)}</span></div>
    <hr class="review-divider"/>
    <div class="review-row"><span class="review-label">Game</span><span class="review-value">${sanitize(gameCfg.label)}</span></div>
    <div class="review-row"><span class="review-label">Format</span><span class="review-value">${sanitize(fmtLabel)}</span></div>
    <div class="review-row"><span class="review-label">Teams</span><span class="review-value">${teams.length}</span></div>
    ${d.date ? `<div class="review-row"><span class="review-label">Date</span><span class="review-value">${sanitize(d.date)}</span></div>` : ''}
    ${d.venue ? `<div class="review-row"><span class="review-label">Venue</span><span class="review-value">${sanitize(d.venue)}</span></div>` : ''}
    <hr class="review-divider"/>
    <div class="form-group">
      <label class="review-label">Team Lineup</label>
      <div class="review-teams-preview">
        ${teams.map(t => `<span class="review-team-chip">${sanitize(t.name)}</span>`).join('')}
      </div>
    </div>`;
}

async function generateTournament() {
  const btn = $('btn-generate');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const teams = getTeamsFromGrid();
    const d = appState.formData;

    // Build full tournament object using ML game config as default
    let tournament;
    if (d.game === 'mobile_legends' && d.format === 'groups_double_elim') {
      tournament = MLTournament.createMLGroupsDoubleElim(d, teams);
    } else if (d.format === 'double_elimination' || d.format === 'groups_double_elim') {
      tournament = DoubleElimBracket.createTournament(d, teams);
    } else if (d.format === 'round_robin') {
      tournament = RoundRobinBracket.createTournament(d, teams);
    } else {
      // Single elimination / swiss — use double elim as base for now
      tournament = DoubleElimBracket.createTournament(d, teams);
    }

    await Storage.saveTournament(tournament);
    showToast('Tournament created! 🏆', 'success');
    await openBracket(tournament.id);
  } catch (err) {
    showToast('Could not create tournament. Please try again.', 'error');
    console.error('[Generate] Error:', err);
  } finally {
    btn.disabled = false;
    btn.textContent = '🏆 Generate Bracket';
  }
}

// ================================================================
// BRACKET VIEW
// ================================================================

async function openBracket(id) {
  try {
    const tournament = await Storage.getTournament(id);
    if (!tournament) { showToast('Tournament not found.', 'error'); return; }
    appState.activeTournament   = tournament;
    appState.activeTournamentId = id;
    appState.activePhaseIndex   = 0;

    DOM.bracketName.textContent   = tournament.name;
    DOM.bracketStatus.className   = `status-badge ${tournament.status === 'active' ? 'status-active' : 'status-done'}`;
    DOM.bracketStatus.textContent = tournament.status === 'active' ? '● Active' : 'Finished';

    // Store for print
    document.querySelector('.bracket-topbar')?.setAttribute('data-tournament-name', tournament.name);

    buildPhaseTabs(tournament);
    renderCurrentPhase();
    showView('bracket');
  } catch (err) {
    showToast('Unable to open bracket. Please try again.', 'error');
    console.error('[Bracket] Open error:', err);
  }
}

function buildPhaseTabs(tournament) {
  const phases = getPhaseList(tournament);
  DOM.phaseTabs.innerHTML = phases.map((phase, i) =>
    `<button class="phase-tab${i === 0 ? ' active' : ''}" role="tab" data-index="${i}">${phase.label}</button>`
  ).join('');
  DOM.phaseTabs.querySelectorAll('.phase-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      DOM.phaseTabs.querySelectorAll('.phase-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      appState.activePhaseIndex = parseInt(tab.dataset.index, 10);
      renderCurrentPhase();
    });
  });
}

function getPhaseList(tournament) {
  switch (tournament.format) {
    case 'groups_double_elim':
      return [
        { key: 'groups',        label: 'Group Stage' },
        { key: 'winnersBracket', label: 'Winners Bracket' },
        { key: 'losersBracket',  label: 'Losers Bracket' },
        { key: 'grandFinals',    label: 'Grand Finals' },
      ];
    case 'double_elimination':
      return [
        { key: 'winnersBracket', label: 'Winners Bracket' },
        { key: 'losersBracket',  label: 'Losers Bracket' },
        { key: 'grandFinals',    label: 'Grand Finals' },
      ];
    case 'round_robin':
      return [{ key: 'roundRobin', label: 'Round Robin' }];
    default:
      return [{ key: 'singleElim', label: 'Bracket' }];
  }
}

function renderCurrentPhase() {
  const tournament = appState.activeTournament;
  const phases     = getPhaseList(tournament);
  const phase      = phases[appState.activePhaseIndex];
  renderTournamentPhase(tournament, appState.activePhaseIndex, DOM.bracketContent, false);
}

/**
 * Render a tournament phase into `container`.
 * Exposed as global so view.html can call it too.
 * @param {Object}  tournament
 * @param {number}  phaseIndex
 * @param {Element} container
 * @param {boolean} readOnly   — disables match-click when true
 */
window.renderTournamentPhase = function(tournament, phaseIndex, container, readOnly) {
  const phases = getPhaseList(tournament);
  const phase  = phases[phaseIndex];
  if (!phase) { container.innerHTML = ''; return; }

  switch (phase.key) {
    case 'groups':
      renderGroupStage(tournament, container, readOnly);
      break;
    case 'winnersBracket':
      renderEliminationBracket(tournament.winnersBracket, 'Winners', container, readOnly, tournament);
      break;
    case 'losersBracket':
      renderEliminationBracket(tournament.losersBracket, 'Losers', container, readOnly, tournament);
      break;
    case 'grandFinals':
      renderGrandFinals(tournament, container, readOnly);
      break;
    case 'roundRobin':
      renderRoundRobinPhase(tournament, container, readOnly);
      break;
    default:
      renderEliminationBracket(tournament.winnersBracket || tournament.bracket,
        'Bracket', container, readOnly, tournament);
  }
};

// ── Group Stage Rendering ────────────────────────────────────────

function renderGroupStage(tournament, container, readOnly) {
  if (!tournament.groups) { container.innerHTML = '<p class="loading-overlay">No group data.</p>'; return; }
  container.innerHTML = `<div class="groups-layout" id="groups-layout"></div>`;
  const layout = container.querySelector('.groups-layout');

  tournament.groups.forEach(group => {
    const block = document.createElement('div');
    block.className = 'group-block';
    block.innerHTML = `
      <div class="group-block-header">
        <span class="group-name">Group ${sanitize(group.name)}</span>
        <span class="group-subtitle">${group.standings?.filter(s => s.advanced).length || 0} advance</span>
      </div>
      ${renderGroupStandingsTable(group, tournament.teams)}
      <div class="group-matches">
        ${(group.matches || []).map(m => renderGroupMatchRow(m, tournament.teams, readOnly)).join('')}
      </div>`;
    layout.appendChild(block);
  });

  if (!readOnly) {
    container.querySelectorAll('.group-match-row:not(.completed)').forEach(row => {
      row.addEventListener('click', () => {
        const matchId = row.dataset.matchId;
        const groupId = row.dataset.groupId;
        openScoreModal({ matchId, groupId, phaseKey: 'groups' }, tournament);
      });
    });
  }
}

function renderGroupStandingsTable(group, teams) {
  const standings = group.standings || [];
  const rows = standings.map((s, i) => {
    const team = teams.find(t => t.id === s.teamId);
    const rankClass = `rank-${i + 1}`;
    const advanceBadge = i < 2 ? '→ WB' : i === 2 ? '→ LB' : '✗';
    const advanceColor = i < 2 ? 'var(--c-accent)' : i === 2 ? '#c8a840' : 'var(--c-text-muted)';
    return `<tr class="${rankClass}">
      <td><span class="team-rank-indicator">${i + 1}</span>${sanitize(team?.name || 'TBD')}</td>
      <td style="text-align:center">${s.wins ?? 0}</td>
      <td style="text-align:center">${s.losses ?? 0}</td>
      <td style="text-align:center">${s.gameDiff ?? 0}</td>
      <td style="text-align:right;font-size:11px;font-weight:700;color:${advanceColor}">${advanceBadge}</td>
    </tr>`;
  }).join('');
  return `<table class="group-standings">
    <thead><tr>
      <th>Team</th><th>W</th><th>L</th><th>Diff</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderGroupMatchRow(match, teams, readOnly) {
  const t1 = teams.find(t => t.id === match.team1Id);
  const t2 = teams.find(t => t.id === match.team2Id);
  const done = match.status === 'completed';
  const scoreHtml = done
    ? `<span class="match-score-inline">${match.score1}–${match.score2}</span>`
    : `<span class="match-score-inline pending">vs</span>`;
  return `<div class="group-match-row${done ? ' completed' : ''}"
    data-match-id="${sanitize(match.id)}"
    data-group-id="${sanitize(match.groupId)}"
    ${readOnly ? '' : 'role="button" tabindex="0"'}>
    <div class="match-teams-inline">
      <span class="match-team-inline">${sanitize(t1?.name || 'TBD')}</span>
      <span class="match-vs">vs</span>
      <span class="match-team-inline">${sanitize(t2?.name || 'TBD')}</span>
    </div>
    ${scoreHtml}
    <span style="font-size:11px;color:var(--c-text-muted);margin-left:4px">R${match.round}</span>
  </div>`;
}

// ── Elimination Bracket Rendering ────────────────────────────────

function renderEliminationBracket(bracket, label, container, readOnly, tournament) {
  if (!bracket || !bracket.rounds || bracket.rounds.length === 0) {
    container.innerHTML = `<p class="loading-overlay text-muted" style="padding:60px 24px;width:100%">
      ${label} bracket hasn't started yet.<br>Complete the group stage first.</p>`;
    return;
  }

  const wrap = document.createElement('div');
  wrap.style.display = 'inline-flex';
  wrap.style.gap = '4px';
  wrap.style.minWidth = '100%';
  container.innerHTML = '';
  container.appendChild(wrap);

  bracket.rounds.forEach((round, ri) => {
    const col = document.createElement('div');
    col.className = 'bracket-round-col';
    col.innerHTML = `<div class="round-header">
      ${round.label || (ri === bracket.rounds.length - 1 ? label + ' Final' : `Round ${ri + 1}`)}
      <br><span style="font-size:10px;font-weight:400">BO${round.bestOf || 3}</span>
    </div>`;

    const matchesWrap = document.createElement('div');
    matchesWrap.className = 'round-matches';
    round.matches.forEach(match => {
      const card = buildMatchCard(match, tournament?.teams || [], readOnly);
      matchesWrap.appendChild(card);
    });
    col.appendChild(matchesWrap);
    wrap.appendChild(col);
  });
}

function renderGrandFinals(tournament, container, readOnly) {
  container.innerHTML = '';
  const gf = tournament.grandFinals;
  if (!gf) {
    container.innerHTML = `<p class="loading-overlay text-muted" style="padding:60px 24px">Grand Finals hasn't started yet.</p>`;
    return;
  }

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px;width:100%';
  container.appendChild(wrap);

  const info = document.createElement('div');
  info.innerHTML = `<h2 style="text-align:center;margin-bottom:4px">🏆 Grand Finals</h2>
    <p style="text-align:center;font-size:13px">
      Best of ${gf.bestOf} · 
      ${gf.bracketReset ? '<span style="color:var(--c-accent)">Bracket Reset Required</span>' : 'Single series'}
    </p>`;
  wrap.appendChild(info);

  // Series 1
  if (gf.series1) {
    const s1Wrap = document.createElement('div');
    s1Wrap.innerHTML = '<div class="bracket-section-label" style="text-align:center;margin-bottom:12px">Series 1</div>';
    const card = buildMatchCard({ ...gf.series1, isFinals: true }, tournament.teams, readOnly);
    card.classList.add('grand-finals');
    const lbl = document.createElement('div');
    lbl.className = 'match-label';
    lbl.textContent = 'Finals';
    card.appendChild(lbl);
    card.style.width = '260px';
    s1Wrap.appendChild(card);
    wrap.appendChild(s1Wrap);
  }

  // Bracket reset (Series 2) if applicable
  if (gf.bracketReset && gf.series2) {
    const divider = document.createElement('div');
    divider.className = 'bracket-divider';
    divider.textContent = '⚡ Bracket Reset — Series 2';
    wrap.appendChild(divider);

    const s2Wrap = document.createElement('div');
    const card2 = buildMatchCard({ ...gf.series2, isFinals: true }, tournament.teams, readOnly);
    card2.classList.add('grand-finals');
    card2.style.width = '260px';
    s2Wrap.appendChild(card2);
    wrap.appendChild(s2Wrap);
  }
}

function renderRoundRobinPhase(tournament, container, readOnly) {
  container.innerHTML = '';
  const rr = tournament.roundRobin;
  if (!rr) { container.innerHTML = '<p class="loading-overlay">No round robin data.</p>'; return; }

  const layout = document.createElement('div');
  layout.className = 'groups-layout';
  layout.style.cssText = 'width:100%;grid-template-columns:1fr';

  // Standings
  const block = document.createElement('div');
  block.className = 'group-block';
  block.innerHTML = `
    <div class="group-block-header">
      <span class="group-name">Round Robin Standings</span>
    </div>
    ${renderGroupStandingsTable({ standings: rr.standings }, tournament.teams)}
    <div class="group-matches">
      ${(rr.matches || []).map(m => renderGroupMatchRow(m, tournament.teams, readOnly)).join('')}
    </div>`;
  layout.appendChild(block);
  container.appendChild(layout);

  if (!readOnly) {
    container.querySelectorAll('.group-match-row:not(.completed)').forEach(row => {
      row.addEventListener('click', () =>
        openScoreModal({ matchId: row.dataset.matchId, phaseKey: 'roundRobin' }, tournament));
    });
  }
}

/** Build an individual match card DOM element */
function buildMatchCard(match, teams, readOnly) {
  const t1 = match.team1Id ? teams.find(t => t.id === match.team1Id) : null;
  const t2 = match.team2Id ? teams.find(t => t.id === match.team2Id) : null;

  const isBye = match.isBye;
  const isTBD = !t1 && !t2;
  const isCompleted = match.status === 'completed';

  const card = document.createElement('div');
  card.className = `match-card${isBye ? ' bye' : ''}${isTBD ? ' tbd' : ''}`;
  card.dataset.matchId = match.id;

  const p1Class = isCompleted && match.winnerId === match.team1Id ? 'winner' : isCompleted ? 'loser' : '';
  const p2Class = isCompleted && match.winnerId === match.team2Id ? 'winner' : isCompleted ? 'loser' : '';

  const score1 = isCompleted ? `<span class="participant-score">${match.score1 ?? ''}</span>` : '';
  const score2 = isCompleted ? `<span class="participant-score">${match.score2 ?? ''}</span>` : '';

  card.innerHTML = `
    <div class="match-participant ${p1Class}${!t1 ? ' empty' : ''}">
      <span class="participant-seed">${t1?.seed ?? ''}</span>
      <span class="participant-name">${sanitize(t1?.name || (isBye ? 'BYE' : 'TBD'))}</span>
      ${score1}
    </div>
    <div class="match-participant ${p2Class}${!t2 ? ' empty' : ''}">
      <span class="participant-seed">${t2?.seed ?? ''}</span>
      <span class="participant-name">${sanitize(t2?.name || (isBye ? '—' : 'TBD'))}</span>
      ${score2}
    </div>`;

  if (!readOnly && t1 && t2 && !isBye) {
    card.addEventListener('click', () =>
      openScoreModal({ matchId: match.id, phaseKey: match.phaseKey || 'bracket' },
        appState.activeTournament));
  }
  return card;
}

// ================================================================
// SCORE MODAL
// ================================================================

function bindBracketEvents() {
  DOM.btnShare?.addEventListener('click', openShareModal);
}

function openScoreModal(matchRef, tournament) {
  // Find the match in the tournament data
  const match = findMatch(tournament, matchRef.matchId);
  if (!match) { showToast('Match not found.', 'error'); return; }

  const t1 = tournament.teams.find(t => t.id === match.team1Id);
  const t2 = tournament.teams.find(t => t.id === match.team2Id);
  if (!t1 || !t2) { showToast('Teams not yet determined. Finish earlier rounds first.', 'error'); return; }

  appState.pendingMatchEdit = { ...matchRef, match };

  DOM.modalTeam1.textContent = t1.name;
  DOM.modalTeam2.textContent = t2.name;
  DOM.modalScore1.value = match.score1 ?? 0;
  DOM.modalScore2.value = match.score2 ?? 0;

  const bestOf = match.bestOf || GAME_CONFIGS[tournament.game]?.defaultBO || 3;
  DOM.modalBestOf.textContent = `Best of ${bestOf}`;

  buildGameSeriesTracker(match, bestOf, t1, t2);

  // Highlight teams if result already in
  $('entry-team1').classList.toggle('selected', match.winnerId === match.team1Id);
  $('entry-team2').classList.toggle('selected', match.winnerId === match.team2Id);

  DOM.scoreModal.hidden = false;
  document.body.style.overflow = 'hidden';
  DOM.modalScore1.focus();
}

function buildGameSeriesTracker(match, bestOf, t1, t2) {
  // Build per-game circles for BO3/BO5 tracking
  const games = match.games || [];
  DOM.gameSeriesTracker.innerHTML = '';

  for (let i = 0; i < bestOf; i++) {
    const dot = document.createElement('div');
    dot.className = 'game-dot';
    const g = games[i];
    if (g?.winner === match.team1Id) dot.classList.add('team1-win');
    else if (g?.winner === match.team2Id) dot.classList.add('team2-win');
    dot.textContent = `G${i + 1}`;
    dot.title = `Game ${i + 1}`;
    dot.dataset.gameIndex = i;
    dot.addEventListener('click', () => toggleGameDot(dot, i, match, t1, t2));
    DOM.gameSeriesTracker.appendChild(dot);
  }
}

function toggleGameDot(dot, gameIndex, match, t1, t2) {
  // Cycle: blank → team1 wins → team2 wins → blank
  if (dot.classList.contains('team1-win')) {
    dot.classList.remove('team1-win');
    dot.classList.add('team2-win');
  } else if (dot.classList.contains('team2-win')) {
    dot.classList.remove('team2-win');
  } else {
    dot.classList.add('team1-win');
  }
  // Tally scores from dots
  const dots = DOM.gameSeriesTracker.querySelectorAll('.game-dot');
  let s1 = 0, s2 = 0;
  dots.forEach(d => {
    if (d.classList.contains('team1-win')) s1++;
    else if (d.classList.contains('team2-win')) s2++;
  });
  DOM.modalScore1.value = s1;
  DOM.modalScore2.value = s2;
}

function bindModalEvents() {
  // Score modal controls
  $('modal-close')?.addEventListener('click', closeScoreModal);
  $('modal-cancel')?.addEventListener('click', closeScoreModal);
  DOM.scoreModal?.querySelector('.modal-backdrop')?.addEventListener('click', closeScoreModal);

  // Score increment buttons
  document.querySelectorAll('.score-inc').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      const inp = i === 0 ? DOM.modalScore1 : DOM.modalScore2;
      inp.value = Math.min(99, parseInt(inp.value, 10) + 1);
    });
  });
  document.querySelectorAll('.score-dec').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      const inp = i === 0 ? DOM.modalScore1 : DOM.modalScore2;
      inp.value = Math.max(0, parseInt(inp.value, 10) - 1);
    });
  });

  $('modal-confirm')?.addEventListener('click', confirmMatchResult);

  // Share modal
  $('btn-share')?.addEventListener('click', openShareModal);
  $('share-modal-close')?.addEventListener('click', () => { DOM.shareModal.hidden = true; document.body.style.overflow = ''; });
  DOM.shareModal?.querySelector('.modal-backdrop')?.addEventListener('click', () => { DOM.shareModal.hidden = true; document.body.style.overflow = ''; });
  $('btn-copy-code')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(DOM.shareCodeValue.textContent)
      .then(() => showToast('Code copied!', 'success'))
      .catch(() => showToast('Select the code manually to copy.', 'error'));
  });
  $('btn-copy-url')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(DOM.shareUrlDisplay.value)
      .then(() => showToast('Link copied!', 'success'))
      .catch(() => showToast('Select the URL manually to copy.', 'error'));
  });
}

function closeScoreModal() {
  DOM.scoreModal.hidden = true;
  document.body.style.overflow = '';
  appState.pendingMatchEdit = null;
}

async function confirmMatchResult() {
  const s1 = parseInt(DOM.modalScore1.value, 10) || 0;
  const s2 = parseInt(DOM.modalScore2.value, 10) || 0;
  if (s1 === s2) { showToast('Scores must differ — there must be a winner.', 'error'); return; }

  const ref   = appState.pendingMatchEdit;
  const match = ref.match;
  const tournament = appState.activeTournament;

  const winnerId = s1 > s2 ? match.team1Id : match.team2Id;

  try {
    let updatedTournament;
    if (tournament.format === 'groups_double_elim' && ref.phaseKey === 'groups') {
      updatedTournament = MLTournament.updateGroupMatch(tournament, ref.groupId, ref.matchId, s1, s2, winnerId);
    } else if (tournament.format === 'double_elimination' || ref.phaseKey === 'winnersBracket' || ref.phaseKey === 'losersBracket') {
      updatedTournament = DoubleElimBracket.updateMatch(tournament, ref.matchId, s1, s2, winnerId);
    } else if (tournament.format === 'round_robin') {
      updatedTournament = RoundRobinBracket.updateMatch(tournament, ref.matchId, s1, s2, winnerId);
    } else {
      updatedTournament = DoubleElimBracket.updateMatch(tournament, ref.matchId, s1, s2, winnerId);
    }

    await Storage.saveTournament(updatedTournament);
    appState.activeTournament = updatedTournament;
    closeScoreModal();
    renderCurrentPhase();
    showToast('Result saved! ✓', 'success');
  } catch (err) {
    showToast('Could not save result. Please try again.', 'error');
    console.error('[Score] Update error:', err);
  }
}

/** Recursively search all bracket phases for a match by ID */
function findMatch(tournament, matchId) {
  // Search groups
  if (tournament.groups) {
    for (const group of tournament.groups) {
      const m = group.matches?.find(m => m.id === matchId);
      if (m) return m;
    }
  }
  // Search winners bracket
  if (tournament.winnersBracket?.rounds) {
    for (const round of tournament.winnersBracket.rounds) {
      const m = round.matches?.find(m => m.id === matchId);
      if (m) return m;
    }
  }
  // Search losers bracket
  if (tournament.losersBracket?.rounds) {
    for (const round of tournament.losersBracket.rounds) {
      const m = round.matches?.find(m => m.id === matchId);
      if (m) return m;
    }
  }
  // Grand finals
  if (tournament.grandFinals?.series1?.id === matchId) return tournament.grandFinals.series1;
  if (tournament.grandFinals?.series2?.id === matchId) return tournament.grandFinals.series2;
  // Round robin
  if (tournament.roundRobin?.matches) {
    const m = tournament.roundRobin.matches.find(m => m.id === matchId);
    if (m) return m;
  }
  return null;
}

// ================================================================
// SHARE MODAL
// ================================================================

function openShareModal() {
  const tournament = appState.activeTournament;
  if (!tournament) return;

  const code = tournament.shareCode || '------';
  const viewerUrl = `${location.origin}${location.pathname.replace('index.html', '')}view.html?code=${code}`;

  DOM.shareCodeValue.textContent  = code;
  DOM.shareUrlDisplay.value       = viewerUrl;
  DOM.shareModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

// ================================================================
// TOAST NOTIFICATIONS
// ================================================================

function showToast(message, type = '') {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast${type ? ' ' + type : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toast-out 0.3s ease forwards';
    toast.addEventListener('animationend', () => toast.remove());
  }, 3200);
}

// ================================================================
// SECURITY HELPERS
// ================================================================

/** Sanitize strings before inserting into the DOM (prevent XSS) */
function sanitize(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#x27;');
}

// Make sanitize available to other modules
window.sanitize = sanitize;
window.showToast = showToast;
