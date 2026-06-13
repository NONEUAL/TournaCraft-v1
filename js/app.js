/**
 * app.js — Province Games Tournament Maker
 * Application controller: views, form flow, score modal, share.
 * Rendering is fully delegated to js/ui/bracketRenderer.js.
 * Bracket logic lives in js/bracket/*.js
 * Game rules live in js/games/*.js
 *
 * Depends on (load order matters):
 *   storage.js → singleElim.js → doubleElim.js → roundRobin.js
 *   → groupsPlayoff.js → mobileLegends.js → bracketRenderer.js
 *   → websocket.js → app.js
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
  initInstallPrompt();
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
    } else if (d.format === 'single_elimination') {
      tournament = SingleElimBracket.createTournament(d, teams);
    } else {
      // Swiss and other future formats — fall back to single elimination
      tournament = SingleElimBracket.createTournament(d, teams);
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

    // Subscribe to live updates for this tournament
    if (window.RealtimeSync) {
      RealtimeSync.subscribe(tournament.id);
      // When a live update arrives, refresh the bracket view
      RealtimeSync.onUpdate = (updated) => {
        if (updated.id === appState.activeTournamentId) {
          appState.activeTournament = updated;
          renderCurrentPhase();
        }
      };
    }

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
  // Delegate to BracketRenderer — single source of truth for phase definitions
  if (window.BracketRenderer) return BracketRenderer.getPhaseList(tournament);
  // Minimal fallback if renderer not loaded yet
  if (tournament.format === 'groups_double_elim') {
    return [
      { key: 'groups',         label: 'Group Stage'     },
      { key: 'winnersBracket', label: 'Winners Bracket' },
      { key: 'losersBracket',  label: 'Losers Bracket'  },
      { key: 'grandFinals',    label: 'Grand Finals'    },
    ];
  }
  if (tournament.format === 'double_elimination') {
    return [
      { key: 'winnersBracket', label: 'Winners Bracket' },
      { key: 'losersBracket',  label: 'Losers Bracket'  },
      { key: 'grandFinals',    label: 'Grand Finals'    },
    ];
  }
  if (tournament.format === 'round_robin') return [{ key: 'roundRobin', label: 'Round Robin' }];
  return [{ key: 'singleElim', label: 'Bracket' }];
}

function renderCurrentPhase() {
  const tournament = appState.activeTournament;
  const phases     = getPhaseList(tournament);
  const phase      = phases[appState.activePhaseIndex];
  renderTournamentPhase(tournament, appState.activePhaseIndex, DOM.bracketContent, false);
}

/**
 * Render a tournament phase into `container`.
 * Delegates to BracketRenderer (js/ui/bracketRenderer.js) if loaded,
 * with the score-modal click handler wired in for admin mode.
 * Also exposed as window.renderTournamentPhase so view.html can call it.
 */
window.renderTournamentPhase = function(tournament, phaseIndex, container, readOnly) {
  if (window.BracketRenderer) {
    // Use extracted renderer; pass click handler only in admin (non-readOnly) mode
    const clickHandler = readOnly ? null : (matchRef) => {
      openScoreModal(matchRef, appState.activeTournament);
    };
    BracketRenderer.renderTournamentPhase(
      tournament, phaseIndex, container, readOnly, clickHandler
    );
  } else {
    // Inline fallback (should not happen if scripts load correctly)
    container.innerHTML = '<p class="loading-overlay">Bracket renderer not loaded. Refresh the page.</p>';
  }
};

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

  // Score increment/decrement buttons — use closest() to find sibling input,
  // avoiding fragile global index assumptions.
  DOM.scoreModal.querySelectorAll('.score-inc').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = btn.closest('.score-controls').querySelector('.score-input');
      if (inp) inp.value = Math.min(99, parseInt(inp.value, 10) + 1);
    });
  });
  DOM.scoreModal.querySelectorAll('.score-dec').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = btn.closest('.score-controls').querySelector('.score-input');
      if (inp) inp.value = Math.max(0, parseInt(inp.value, 10) - 1);
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

  const ref        = appState.pendingMatchEdit;
  const match      = ref.match;
  const tournament = appState.activeTournament;
  const bestOf     = match.bestOf || GAME_CONFIGS[tournament.game]?.defaultBO || 3;

  // FIX #9: validate BO rules before saving
  // Use game-specific validator if available, otherwise use generic check
  let validation = { valid: true, message: '' };
  if (tournament.game === 'mobile_legends' && typeof MLTournament !== 'undefined') {
    validation = MLTournament.validateScore(s1, s2, bestOf);
  } else {
    if (s1 === s2)  validation = { valid: false, message: 'Scores must differ — there must be a winner.' };
    else if (s1 < 0 || s2 < 0) validation = { valid: false, message: 'Scores cannot be negative.' };
  }
  if (!validation.valid) { showToast(validation.message, 'error'); return; }

  const winnerId = s1 > s2 ? match.team1Id : match.team2Id;

  try {
    let updatedTournament;

    // Route to the correct update function based on phase and format
    if (ref.phaseKey === 'groups') {
      // Group stage match — always goes through ML (or generic) group handler
      if (typeof MLTournament !== 'undefined' && tournament.format === 'groups_double_elim') {
        updatedTournament = MLTournament.updateGroupMatch(
          tournament, ref.groupId, ref.matchId, s1, s2, winnerId
        );
      } else {
        updatedTournament = RoundRobinBracket.updateMatch(tournament, ref.matchId, s1, s2, winnerId);
      }
    } else if (ref.phaseKey === 'roundRobin') {
      updatedTournament = RoundRobinBracket.updateMatch(tournament, ref.matchId, s1, s2, winnerId);
    } else if (tournament.format === 'single_elimination') {
      updatedTournament = SingleElimBracket.updateMatch(tournament, ref.matchId, s1, s2, winnerId);
    } else {
      // winnersBracket, losersBracket, grandFinals — double elimination engine
      updatedTournament = DoubleElimBracket.updateMatch(tournament, ref.matchId, s1, s2, winnerId);
    }

    await Storage.saveTournament(updatedTournament);
    appState.activeTournament = updatedTournament;

    // Broadcast to live viewers if WebSocket is connected
    if (window.RealtimeSync?.isConnected()) {
      RealtimeSync.broadcast(updatedTournament);
    }

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

// ================================================================
// BRACKET CONNECTOR LINES (Bug #8 fix)
// ================================================================

/**
 * Build an SVG connector column between two bracket rounds.
 * Draws horizontal + vertical lines linking each pair of matches
 * in the previous round to their combined match in the next round.
 *
 * @param {number} prevCount  — number of matches in the left round
 * @param {number} nextCount  — number of matches in the right round
 * @returns {HTMLElement} a div containing an SVG
 */
function buildRoundConnector(prevCount, nextCount) {
  const wrap = document.createElement('div');
  wrap.className = 'bracket-connector-col';
  wrap.style.cssText = 'display:flex;align-items:stretch;width:28px;flex-shrink:0;';

  const MATCH_H   = 88;   // approximate px height of one match card + gap
  const HALF_PREV = MATCH_H / 2;
  const totalH    = Math.max(prevCount, nextCount) * MATCH_H;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', String(totalH));
  svg.setAttribute('viewBox', `0 0 28 ${totalH}`);
  svg.style.overflow = 'visible';

  const ratio = prevCount / nextCount;   // usually 2:1

  for (let ni = 0; ni < nextCount; ni++) {
    // Two prev matches feed into one next match
    const pi1 = ni * ratio;
    const pi2 = pi1 + ratio - 1;

    const y1 = (pi1 + 0.5) * MATCH_H;  // centre of first prev match
    const y2 = (pi2 + 0.5) * MATCH_H;  // centre of second prev match
    const yMid = (y1 + y2) / 2;         // centre of next match

    // Horizontal stub from left edge to midpoint
    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line1.setAttribute('d', `M0,${y1} H14 V${yMid} H28`);
    line1.setAttribute('stroke', '#403F4C');
    line1.setAttribute('stroke-width', '1.5');
    line1.setAttribute('fill', 'none');

    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line2.setAttribute('d', `M0,${y2} H14`);
    line2.setAttribute('stroke', '#403F4C');
    line2.setAttribute('stroke-width', '1.5');
    line2.setAttribute('fill', 'none');

    svg.appendChild(line1);
    svg.appendChild(line2);
  }

  wrap.appendChild(svg);
  return wrap;
}

// ================================================================
// PWA INSTALL PROMPT (Bug #10 fix)
// ================================================================

let _deferredInstallPrompt = null;

function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', e => {
    // Prevent Chrome's mini-infobar on mobile
    e.preventDefault();
    _deferredInstallPrompt = e;

    // Show a non-intrusive install banner after a short delay
    // only if the user hasn't dismissed it before
    if (!localStorage.getItem('pg_install_dismissed')) {
      setTimeout(showInstallBanner, 3000);
    }
  });

  window.addEventListener('appinstalled', () => {
    _deferredInstallPrompt = null;
    hideInstallBanner();
    showToast('Province Games installed on your home screen! 🏆', 'success');
  });
}

function showInstallBanner() {
  if (document.getElementById('install-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'install-banner';
  banner.style.cssText = [
    'position:fixed', 'bottom:max(80px,calc(env(safe-area-inset-bottom)+80px))',
    'left:50%', 'transform:translateX(-50%)',
    'background:#1B2432', 'border:1.5px solid #6994B8',
    'border-radius:12px', 'padding:12px 16px',
    'display:flex', 'align-items:center', 'gap:12px',
    'z-index:800', 'box-shadow:0 4px 24px rgba(0,0,0,0.5)',
    'max-width:340px', 'width:calc(100% - 32px)',
    'animation:toast-in 0.25s ease'
  ].join(';');
  banner.innerHTML = `
    <span style="font-size:24px">📲</span>
    <div style="flex:1">
      <div style="font-weight:700;font-size:14px;color:#fff">Add to Home Screen</div>
      <div style="font-size:12px;color:#B0B0B0;margin-top:2px">Works fully offline on iPad</div>
    </div>
    <button id="btn-install-now" style="
      background:#6994B8;color:#fff;border:none;border-radius:8px;
      padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer;
      min-height:44px;min-width:64px;font-family:inherit">Install</button>
    <button id="btn-install-dismiss" style="
      background:none;border:none;color:#B0B0B0;cursor:pointer;
      padding:8px;min-height:44px;min-width:44px;font-size:18px" 
      aria-label="Dismiss">✕</button>`;
  document.body.appendChild(banner);

  document.getElementById('btn-install-now').addEventListener('click', async () => {
    if (!_deferredInstallPrompt) return;
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      _deferredInstallPrompt = null;
    }
    hideInstallBanner();
  });

  document.getElementById('btn-install-dismiss').addEventListener('click', () => {
    localStorage.setItem('pg_install_dismissed', '1');
    hideInstallBanner();
  });
}

function hideInstallBanner() {
  document.getElementById('install-banner')?.remove();
}

// Make sanitize available to other modules
window.sanitize = sanitize;
window.showToast = showToast;
