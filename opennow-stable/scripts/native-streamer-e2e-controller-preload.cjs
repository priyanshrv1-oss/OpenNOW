const { ipcRenderer } = require("electron");

ipcRenderer.on("gfn:native-streamer-event", (_event, payload) => {
  ipcRenderer.send("e2e:native-event", payload);
});
