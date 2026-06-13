/**
 * backend/api/validate.js
 *
 * Shared input validation helpers for all API routes.
 * All functions are pure (no side effects) and return booleans
 * or { valid, message } objects.
 */

'use strict';

/**
 * Sanitise a string for safe storage.
 * Trims whitespace, strips null bytes and control characters.
 * Does NOT HTML-encode — that's the frontend's job.
 *
 * @param {*}      input
 * @param {number} maxLen  default 200
 * @returns {string}
 */
function sanitiseInput(input, maxLen = 200) {
  if (typeof input !== 'string') return '';
  return input
    .trim()
    .replace(/\0/g, '')                    // null bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')  // control chars
    .slice(0, maxLen);
}

/**
 * Validate a tournament ID.
 * Must be a non-empty string of alphanumeric chars, hyphens, underscores.
 * Max 80 chars.
 *
 * @param {*} id
 * @returns {boolean}
 */
function validateTournamentId(id) {
  if (typeof id !== 'string') return false;
  if (id.length < 1 || id.length > 80) return false;
  return /^[A-Za-z0-9\-_]+$/.test(id);
}

/**
 * Validate a share code.
 * 4–8 uppercase alphanumeric characters.
 *
 * @param {*} code
 * @returns {boolean}
 */
function validateShareCode(code) {
  if (typeof code !== 'string') return false;
  return /^[A-Z0-9]{4,8}$/.test(code);
}

/**
 * Validate a score value.
 * Must be a non-negative integer no greater than maxScore.
 *
 * @param {*}      val
 * @param {number} maxScore  default 99
 * @returns {boolean}
 */
function validateScore(val, maxScore = 99) {
  const n = parseInt(val, 10);
  return !isNaN(n) && n >= 0 && n <= maxScore;
}

/**
 * Validate a game type string.
 *
 * @param {*} game
 * @returns {boolean}
 */
function validateGame(game) {
  const VALID = [
    'mobile_legends', 'cod_mobile', 'volleyball',
    'basketball', 'tekken',
  ];
  return VALID.includes(game);
}

/**
 * Validate a tournament format string.
 *
 * @param {*} format
 * @returns {boolean}
 */
function validateFormat(format) {
  const VALID = [
    'single_elimination', 'double_elimination',
    'groups_double_elim', 'round_robin', 'swiss',
  ];
  return VALID.includes(format);
}

module.exports = {
  sanitiseInput,
  validateTournamentId,
  validateShareCode,
  validateScore,
  validateGame,
  validateFormat,
};
