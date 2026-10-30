'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_EVENTS = new Set(['win:maximized', 'win:context-menu', 'app:update-state']);

contextBridge.exposeInMainWorld('sam', {
  env: {
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  },
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    print: (opts) => ipcRenderer.invoke('win:print', opts || {}),
    savePdf: (opts) => ipcRenderer.invoke('win:savePdf', opts || {})
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openPath: (p) => ipcRenderer.invoke('app:openPath', p),
    saveFile: (opts) => ipcRenderer.invoke('app:saveFile', opts || {}),
    relaunch: () => ipcRenderer.invoke('app:relaunch')
  },
  nav: {
    toMain: () => ipcRenderer.invoke('nav:toMain'),
    toLogin: () => ipcRenderer.invoke('nav:toLogin')
  },
  db: {
    invoke: (name, ...args) => ipcRenderer.invoke('db:invoke', name, ...args)
  },
  auth: {
    login: (username, password) => ipcRenderer.invoke('auth:login', username, password),
    logout: () => ipcRenderer.invoke('auth:logout'),
    current: () => ipcRenderer.invoke('auth:current'),
    changePassword: (oldPw, newPw) => ipcRenderer.invoke('auth:changePassword', oldPw, newPw),
    meta: () => ipcRenderer.invoke('app:meta')
  },
  users: {
    list: () => ipcRenderer.invoke('users:list'),
    save: (payload) => ipcRenderer.invoke('users:save', payload),
    remove: (id) => ipcRenderer.invoke('users:remove', id)
  },
  backup: {
    now: () => ipcRenderer.invoke('backup:now'),
    saveAs: () => ipcRenderer.invoke('backup:saveAs'),
    list: () => ipcRenderer.invoke('backup:list')
  },
  sync: {
    info: () => ipcRenderer.invoke('sync:info'),
    setConfig: (cfg) => ipcRenderer.invoke('sync:setConfig', cfg),
    pickFolder: () => ipcRenderer.invoke('sync:pickFolder'),
    now: () => ipcRenderer.invoke('sync:now')
  },
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    simulate: () => ipcRenderer.invoke('update:simulate'),
    feed: () => ipcRenderer.invoke('update:feed')
  },
  on(channel, handler) {
    if (!ALLOWED_EVENTS.has(channel)) return () => {};
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});
