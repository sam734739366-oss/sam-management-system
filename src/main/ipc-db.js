'use strict';

/**
 * src/main/ipc-db.js — whitelisted database bridge.
 * One IPC channel, an explicit allow-list of operations, a permission check
 * for every write/delete, and a uniform { ok, data | error } envelope.
 */

const d = require('./db');
const session = require('./session');

const API = {
  summary: () => d.summary(),

  listWarehouses: () => d.listWarehouses(),
  getWarehouse: (id) => d.getWarehouse(id),
  getMainWarehouse: () => d.getMainWarehouse(),
  addWarehouse: (w) => d.addWarehouse(w),
  updateWarehouse: (id, w) => d.updateWarehouse(id, w),
  warehouseImpact: (id) => d.warehouseImpact(id),
  deleteWarehouse: (id) => d.deleteWarehouse(id),

  listItems: (search) => d.listItems(search),
  getItem: (id) => d.getItem(id),
  itemStock: (id) => d.itemStock(id),
  openingBalances: (id) => d.openingBalances(id),
  addItem: (item, balances) => d.addItem(item, balances),
  updateItem: (id, item, balances) => d.updateItem(id, item, balances),
  deleteItemImpact: (id) => d.deleteItemImpact(id),
  deleteItem: (id) => d.deleteItem(id),

  PARTY_TYPES: () => d.PARTY_TYPES,
  listParties: (search, type) => d.listParties(search, type),
  getParty: (id) => d.getParty(id),
  addParty: (p) => d.addParty(p),
  updateParty: (id, p) => d.updateParty(id, p),
  partyImpact: (id) => d.partyImpact(id),
  deleteParty: (id) => d.deleteParty(id),

  listRecentMoves: (limit) => d.listRecentMoves(limit),
  getMove: (id) => d.moveDetail(id),
  deleteMove: (id) => d.deleteMove(id),

  DOC_KINDS: () => d.DOC_KINDS,
  nextDocNo: (kind) => d.nextDocNo(kind),
  availablePieces: (itemId, bucket, ignoreDocId) => d.availablePieces(itemId, bucket, ignoreDocId),
  availableInLocation: (itemId, whId, bucket, ignoreDocId) => d.availableInLocation(itemId, whId, bucket, ignoreDocId),
  availableByLocation: (itemId, bucket, ignoreDocId) => d.availableByLocation(itemId, bucket, ignoreDocId),
  saveDocument: (payload) => d.saveDocument(payload),
  getDocument: (id) => d.getDocument(id),
  listDocuments: (filter) => d.listDocuments(filter || {}),
  listProdReceipts: (limit) => d.listProdReceipts(limit),
  listProdIssues: (limit) => d.listProdIssues(limit),
  documentKindCounts: () => d.documentKindCounts(),
  documentImpact: (id) => d.documentImpact(id),
  deleteDocument: (id) => d.deleteDocument(id),

  getDistinctValues: (field) => d.distinctValues(field),
  prodRouting: () => d.prodRouting(),
  setProdRouting: (part) => d.setProdRouting(part),
  listIssues: (limit) => d.listIssues(limit),
  listOpenIssues: () => d.listOpenIssues(),
  saveIssue: (payload) => d.saveIssue(payload),
  issueImpact: (id) => d.issueImpact(id),
  deleteIssue: (id) => d.deleteIssue(id),
  listReceipts: (limit) => d.listReceipts(limit),
  getReceipt: (id) => d.getReceipt(id),
  saveReceipt: (payload) => d.saveReceipt(payload),
  receiptImpact: (id) => d.receiptImpact(id),
  deleteReceipt: (id) => d.deleteReceipt(id),
  productionGap: (filters) => d.productionGapReport(filters || {}),

  listTolling: (limit) => d.listTolling(limit),
  getTolling: (id) => d.getTolling(id),
  getTollingBatch: (id) => d.getTollingBatch(id),
  tollingProgress: (id) => d.tollingProgress(id),
  saveTolling: (payload) => d.saveTolling(payload),
  tollingImpact: (id) => d.tollingImpact(id),
  deleteTolling: (id) => d.deleteTolling(id),
  listScrap: (filters) => d.listScrap(filters || {}),
  deleteScrap: (id) => d.deleteScrap(id),

  listArchive: (limit) => d.listArchive(limit),
  getArchive: (id) => d.getArchive(id),
  saveArchive: (payload) => d.saveArchive(payload),
  deleteArchive: (id) => d.deleteArchive(id),

  reportQuery: (filters) => d.reportQuery(filters || {}),
  reportFacets: () => d.reportFacets(),
  dailyReport: (filters) => d.dailyReport(filters || {}),

  /* V4 — the ready-made report catalogue and the dispatcher behind it */
  REPORTS: () => d.REPORTS,
  runReport: (filters) => d.runReport(filters || {})
};

/** [screen, action] required per operation; a function gets the call arguments */
const PERMS = {
  listWarehouses: ['warehouses', 'view'],
  getWarehouse: ['warehouses', 'view'],
  warehouseImpact: ['warehouses', 'view'],
  addWarehouse: ['warehouses', 'add'],
  updateWarehouse: ['warehouses', 'edit'],
  deleteWarehouse: ['warehouses', 'delete'],

  listItems: ['items', 'view'],
  getItem: ['items', 'view'],
  itemStock: ['items', 'view'],
  openingBalances: ['items', 'view'],
  addItem: ['items', 'add'],
  updateItem: ['items', 'edit'],
  deleteItemImpact: ['items', 'delete'],
  deleteItem: ['items', 'delete'],

  listParties: ['parties', 'view'],
  getParty: ['parties', 'view'],
  addParty: ['parties', 'add'],
  updateParty: ['parties', 'edit'],
  partyImpact: ['parties', 'delete'],
  deleteParty: ['parties', 'delete'],

  listRecentMoves: null,
  getMove: ['transactions', 'view'],
  deleteMove: ['transactions', 'delete'],

  getDocument: ['transactions', 'view'],
  listDocuments: ['transactions', 'view'],
  listProdReceipts: ['production', 'view'],
  listProdIssues: ['production', 'view'],
  documentKindCounts: ['transactions', 'view'],
  productionGap: ['production', 'view'],
  documentImpact: ['transactions', 'delete'],
  saveDocument: (a) => ['transactions', a[0] && a[0].id ? 'edit' : 'add'],
  deleteDocument: ['transactions', 'delete'],

  prodRouting: ['production', 'view'],
  listIssues: ['production', 'view'],
  listOpenIssues: ['production', 'view'],
  getReceipt: ['production', 'view'],
  listReceipts: ['production', 'view'],
  issueImpact: ['production', 'delete'],
  receiptImpact: ['production', 'delete'],
  productionGap: ['production', 'view'],
  setProdRouting: ['production', 'edit'],
  saveIssue: (a) => ['production', a[0] && a[0].id ? 'edit' : 'add'],
  saveReceipt: (a) => ['production', a[0] && a[0].id ? 'edit' : 'add'],
  deleteIssue: ['production', 'delete'],
  deleteReceipt: ['production', 'delete'],

  listTolling: ['production', 'view'],
  getTolling: ['production', 'view'],
  getTollingBatch: ['production', 'view'],
  tollingProgress: ['production', 'view'],
  tollingImpact: ['production', 'delete'],
  saveTolling: (a) => ['production', a[0] && a[0].id ? 'edit' : 'add'],
  deleteTolling: ['production', 'delete'],
  listScrap: ['production', 'view'],
  deleteScrap: ['production', 'delete'],

  listArchive: ['production', 'view'],
  getArchive: ['production', 'view'],
  saveArchive: (a) => ['production', a[0] && a[0].id ? 'edit' : 'add'],
  deleteArchive: ['production', 'delete'],

  reportQuery: ['reports', 'view'],
  reportFacets: ['reports', 'view'],
  dailyReport: ['reports', 'view'],
  REPORTS: ['reports', 'view'],
  runReport: ['reports', 'view']
};

module.exports = function registerDbIpc() {
  require('electron').ipcMain.handle('db:invoke', (_event, name, ...args) => {
    const fn = API[name];
    if (typeof fn !== 'function') {
      return { ok: false, error: `عملية غير معروفة: ${name}` };
    }
    try {
      const rule = PERMS[name];
      const need = typeof rule === 'function' ? rule(args) : rule;
      if (need && !session.can(need[0], need[1])) {
        return {
          ok: false,
          denied: true,
          error: `لا تملك صلاحية «${session.PERM_LABELS[need[1]] || need[1]}» في «${session.SCREEN_LABELS[need[0]] || need[0]}»`
        };
      }
      return { ok: true, data: fn(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
  return API;
};
