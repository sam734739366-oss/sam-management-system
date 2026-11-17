'use strict';

/**
 * src/main/notice.js — one sentence the customer must read.
 *
 * Sometimes the program has to tell the customer something that happened
 * before the window appeared — the data folder was read-only and the file
 * had to be repaired, or the data was copied to a folder that accepts
 * writes. The note is kept here so the main process can set it and the
 * window can read it the moment it opens.
 *
 * The note is never silent: it is shown in Arabic, as a toast, and it stays
 * until the customer reads it.
 */

let message = '';
let kind = 'info';

function set(text, k) {
  message = String(text || '').trim();
  kind = k || 'info';
}

function take() {
  const m = message;
  message = '';
  return m ? { message: m, kind } : null;
}

function peek() {
  return message ? { message, kind } : null;
}

module.exports = { set, take, peek };
