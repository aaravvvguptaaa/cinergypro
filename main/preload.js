'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(ch, ...args) {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r || !r.ok) throw new Error(r ? r.error : 'IPC failure: ' + ch);
  return r.value;
}

const listeners = new Map();
function on(ch, fn) {
  const wrapped = (_e, ...a) => fn(...a);
  ipcRenderer.on(ch, wrapped);
  return () => ipcRenderer.removeListener(ch, wrapped);
}

contextBridge.exposeInMainWorld('native', {
  call,
  on,
  post: (msg) => ipcRenderer.send('popout:post', msg),
  toMain: (msg) => ipcRenderer.send('popout:to-main', msg),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return file.path || ''; } },
  mediaUrl: (p) => 'media://local/' + encodeURIComponent(p).replace(/%2F/g, '/'),
  platform: process.platform,
});
