const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("e2e", {
  send(channel, payload) {
    ipcRenderer.send(channel, payload);
  },
  on(channel, listener) {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
