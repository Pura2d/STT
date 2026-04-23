const { contextBridge, ipcRenderer } = require("electron");

/**
 * 렌더러에서 사용할 최소 API (nodeIntegration 없이 IPC만)
 */
contextBridge.exposeInMainWorld("stt", {
  saveChatLog: (text) => ipcRenderer.invoke("stt-save-chat-log", text),
  quit: () => ipcRenderer.send("stt-quit"),
});
  