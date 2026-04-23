// Squirrel(Windows 설치/업데이트/제거) 이벤트를 처리하고 즉시 종료합니다.
// electron-forge maker-squirrel 사용 시 필수 — 없으면 설치 후 첫 실행 crash.
if (require("electron-squirrel-startup")) process.exit(0);

/**
 * Electron 메인 프로세스.
 *
 * 개발:  python -m uvicorn main:app 을 직접 실행
 * 패키지: PyInstaller 번들(dist/stt-server/stt-server.exe)을 실행
 *
 * 마이크: 로컬(127.0.0.1/localhost) HTTP 출처에 대해 Chromium 미디어 권한 허용.
 */
const {
  app,
  BrowserWindow,
  dialog,
  session,
  systemPreferences,
  Menu,
  ipcMain,
} = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { existsSync, createWriteStream } = require("fs");
const { spawn } = require("child_process");
const http = require("http");

// ── 로그 ──────────────────────────────────────────────────────────────────────
let _logStream = null;

function initLogStream() {
  try {
    const logDir  = app.getPath("logs");
    const logFile = path.join(logDir, "stt-server.log");
    _logStream = createWriteStream(logFile, { flags: "a" });
    _logStream.write(`\n=== 로컬 STT 엔진 시작 ${new Date().toISOString()} ===\n`);
  } catch (_) {}
}

function writeLog(data) {
  if (_logStream) _logStream.write(data);
}

const STT_PORT = process.env.STT_PORT || "18765";

if (process.platform === "win32") {
  app.setAppUserModelId("com.voicefinder.desktop");
}

let mainWindow = null;
let pyChild = null;
/** 패키지 모드: stt-server stderr 끝부분(헬스 실패 시 안내용) */
let lastPyStderr = "";
const LAST_PY_STDERR_MAX = 12000;

// ── 권한 ──────────────────────────────────────────────────────────────────────

function isLocalSttUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "http:" &&
      (u.hostname === "127.0.0.1" || u.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

function configureSessionMediaPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === "media" && isLocalSttUrl(details.requestingUrl || "")) {
      callback(true);
    } else {
      callback(false);
    }
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (permission !== "media") return undefined;
    const url = (details && details.requestingUrl) || "";
    return isLocalSttUrl(url) || isLocalSttUrl(origin) || undefined;
  });
}

async function ensureMacMicrophoneAccess() {
  if (process.platform !== "darwin") return;
  try {
    if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return;
    const granted = await systemPreferences.askForMediaAccess("microphone");
    if (!granted) {
      await dialog.showMessageBox({
        type: "warning",
        title: "마이크 권한",
        message: "마이크 접근이 거부되었습니다.",
        detail:
          "시스템 설정 › 개인 정보 보호 및 보안 › 마이크에서 이 앱을 허용한 뒤 다시 실행하세요.",
      });
    }
  } catch (e) {
    dialog.showErrorBox("마이크 권한", e.message || String(e));
  }
}

// ── Ollama 가용성 확인 (비차단) ───────────────────────────────────────────────

function checkOllamaAsync() {
  const ollamaBase = process.env.OLLAMA_BASE || "http://localhost:11434";
  http.get(`${ollamaBase}/api/tags`, (res) => {
    res.resume();
    if (res.statusCode === 200) {
      writeLog("[info] Ollama 서버 감지됨\n");
    } else {
      writeLog(`[warn] Ollama 응답 이상: ${res.statusCode}\n`);
    }
  }).on("error", () => {
    writeLog("[warn] Ollama 서버를 찾을 수 없습니다 (localhost:11434). LLM 보정 비활성화.\n");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        `typeof window._vfToast === 'function' && window._vfToast('Ollama 미연결 — 기본 보정 모드로 동작합니다', 4000)`
      ).catch(() => {});
    }
  });
}

// ── 경로 ──────────────────────────────────────────────────────────────────────

/**
 * 패키지 모드에서 resourcesPath 외에 exe 옆 resources/ 도 후보로 확인합니다.
 * electron-builder portable 은 추출 위치에 따라 resourcesPath 가
 * process.execPath 기준과 다를 수 있어 fallback 탐색이 필요합니다.
 */
function resolveResource(relPath) {
  const candidates = [
    path.join(process.resourcesPath, relPath),
    path.join(path.dirname(process.execPath), "resources", relPath),
  ];
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch (_) {}
  }
  return candidates[0]; // 없더라도 첫 번째 경로를 반환 (에러 메시지용)
}

function modelDir() {
  if (app.isPackaged) return resolveResource("vosk-model-small-ko-0.22");
  return path.join(__dirname, "..", "vosk-model-small-ko-0.22", "vosk-model-small-ko-0.22");
}

/** renderer HTML/JS 위치 — Python 정적 파일 서버로 서빙됨 */
function uiDir() {
  if (app.isPackaged) return resolveResource("renderer");
  return path.join(__dirname, "renderer");
}

function pythonExecutable() {
  if (process.env.PYTHON_EXE) return process.env.PYTHON_EXE;
  return process.platform === "win32" ? "python" : "python3";
}

// ── 헬스 체크 ─────────────────────────────────────────────────────────────────

function waitForHealth(port, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  const logFile = path.join(app.getPath("logs"), "stt-server.log");
  return new Promise((resolve, reject) => {
    const once = () => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else if (Date.now() > deadline) {
          reject(new Error(`/health 응답 이상: ${res.statusCode}`));
        } else {
          setTimeout(once, 300);
        }
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          const tail = (lastPyStderr || "").trim().slice(-2500);
          const hint =
            `로컬 STT 엔진이 ${timeoutMs / 1000}초 안에 준비되지 않았습니다.\n` +
            `(http://127.0.0.1:${port}/health)\n\n` +
            `로그 파일:\n${logFile}\n\n` +
            `자주 있는 원인:\n` +
            `· 설치 파일을 만들 때 npm run build:py 를 먼저 실행하지 않아 stt-server.exe가 비어 있음\n` +
            `· Vosk 모델 폴더가 설치본 resources에 포함되지 않음\n` +
            `· 백신/보안 프로그램이 stt-server.exe 실행을 차단\n` +
            `· Visual C++ 재배포 가능 패키지 미설치\n\n` +
            (tail ? `엔진 출력(일부):\n${tail}` : "");
          reject(new Error(hint));
        } else {
          setTimeout(once, 300);
        }
      });
    };
    once();
  });
}

// ── 패키지 모드 사전 검사 (설치본에서 바로 원인 안내) ─────────────────────────

function preflightPackagedStt() {
  if (!app.isPackaged) return;
  const exeName = "stt-server" + (process.platform === "win32" ? ".exe" : "");
  const serverDir = resolveResource("stt-server");
  const exe = path.join(serverDir, exeName);
  if (!existsSync(exe)) {
    throw new Error(
      `STT 엔진 실행 파일이 설치본에 없습니다.\n\n` +
        `기대 경로:\n${exe}\n\n` +
        `개발 PC에서 npm run build:py 로 dist/stt-server 를 만든 뒤\n` +
        `npm run electron:build 또는 npm run dist 로 설치 파일을 다시 만드세요.`
    );
  }
  const m = modelDir();
  const mfcc = path.join(m, "conf", "mfcc.conf");
  if (!existsSync(mfcc)) {
    throw new Error(
      `Vosk 모델이 설치본에 없거나 경로가 잘못되었습니다.\n\n` +
        `기대: …/resources/vosk-model-small-ko-0.22/conf/mfcc.conf\n` +
        `실제 모델 루트:\n${m}\n\n` +
        `electron-builder extraResources에 모델 폴더가 포함됐는지 확인 후 다시 빌드하세요.`
    );
  }
  const u = uiDir();
  if (!existsSync(u)) {
    throw new Error(
      `UI(renderer) 폴더가 설치본에 없습니다.\n\n기대 경로:\n${u}\n\nelectron/renderer 가 extraResources에 포함됐는지 확인하세요.`
    );
  }
  if (!existsSync(path.join(u, "index.html"))) {
    throw new Error(
      `UI 폴더에 index.html 이 없습니다.\n\n경로:\n${u}\n\nelectron/renderer 내용이 빌드에 포함됐는지 확인하세요.`
    );
  }
}

// ── Python 서버 시작 ──────────────────────────────────────────────────────────

function startPythonServer() {
  const env = {
    ...process.env,
    VOSK_MODEL_PATH: modelDir(),
    UI_DIR: uiDir(),
    HOST: "127.0.0.1",
    PORT: STT_PORT,
    // 어휘 파일을 userData 에 저장해 업데이트 후에도 유지됩니다.
    VOCAB_PATH: path.join(app.getPath("userData"), "vocabulary.json"),
  };

  let exe, args, cwd;

  lastPyStderr = "";

  if (app.isPackaged) {
    const exeName = "stt-server" + (process.platform === "win32" ? ".exe" : "");
    const serverDir = resolveResource("stt-server");
    exe  = path.join(serverDir, exeName);
    args = [];
    cwd  = serverDir;
  } else {
    exe  = pythonExecutable();
    args = ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", STT_PORT];
    cwd  = path.join(__dirname, "..");
  }

  pyChild = spawn(exe, args, { cwd, env, windowsHide: true });

  pyChild.stderr?.on("data", (d) => {
    if (!app.isPackaged) process.stderr.write(d);
    writeLog(d);
    const s = d.toString();
    lastPyStderr += s;
    if (lastPyStderr.length > LAST_PY_STDERR_MAX) {
      lastPyStderr = lastPyStderr.slice(-LAST_PY_STDERR_MAX);
    }
  });
  pyChild.stdout?.on("data", (d) => {
    if (!app.isPackaged) process.stdout.write(d);
    writeLog(d);
  });

  pyChild.on("error", (err) => {
    const hint = app.isPackaged
      ? `stt-server.exe 를 찾을 수 없습니다.\n경로: ${exe}\n'npm run dist'로 다시 빌드하세요.`
      : "PATH에 Python이 있는지, pip install -r requirements.txt 했는지 확인하세요.";
    writeLog(`[error] ${err.message}\n`);
    dialog.showErrorBox("Python 실행 실패", `${hint}\n\n${err.message}`);
  });

  pyChild.on("exit", (code) => {
    writeLog(`[exit] stt-server 프로세스 종료 code=${code}\n`);
    if (code && code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        "STT 엔진 종료",
        `프로세스가 비정상 종료되었습니다 (code=${code}).\n\n로그: ${path.join(app.getPath("logs"), "stt-server.log")}`
      );
    }
    pyChild = null;
  });
}

// ── IPC ───────────────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  ipcMain.handle("stt-save-chat-log", async (event, text) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "텍스트 저장",
      defaultPath: `stt-${stamp}.txt`,
      filters: [
        { name: "텍스트", extensions: ["txt"] },
        { name: "Markdown", extensions: ["md"] },
      ],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      await fs.writeFile(filePath, typeof text === "string" ? text : "", "utf8");
      return { ok: true, filePath };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.on("stt-quit", () => app.quit());
}

// ── 창 ────────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 520,
    minHeight: 480,
    title: "Voice Finder",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://127.0.0.1:${STT_PORT}/`);
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── 앱 수명 주기 ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  initLogStream();
  try {
    Menu.setApplicationMenu(null);
    registerIpcHandlers();
    configureSessionMediaPermissions();
    await ensureMacMicrophoneAccess();
    preflightPackagedStt();
    startPythonServer();
    await waitForHealth(STT_PORT);
    createWindow();
    // Ollama 가용성 확인 — 창이 뜬 뒤 3초 후 비차단 확인
    setTimeout(checkOllamaAsync, 3000);
  } catch (e) {
    dialog.showErrorBox("STT 시작 실패", e.message || String(e));
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function killPython() {
  if (pyChild && !pyChild.killed) {
    pyChild.kill();
    pyChild = null;
  }
}

app.on("window-all-closed", () => {
  killPython();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", killPython);
