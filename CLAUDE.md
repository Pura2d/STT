# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development (no build required)
```bash
# Python 서버만 실행 (개발)
python -m uvicorn main:app --host 127.0.0.1 --port 18765

# Electron 앱 실행 (Python 서버가 먼저 떠 있어야 함)
npm run electron:dev
```

### Full build → installer
```bash
# 1단계: Python 서버 PyInstaller 번들 생성
npm run build:py          # → dist/stt-server/stt-server.exe

# 2단계: Electron 설치 파일 생성
npm run electron:build    # → release/

# 한 번에
npm run dist
```

### Python deps
```bash
pip install -r requirements.txt
```

## Architecture

### Process model
Electron main process (`electron/main.cjs`) spawns a Python child process and waits for `/health` to return 200 before opening a `BrowserWindow`. The window loads `http://127.0.0.1:18765/` — served by FastAPI, not Electron's file protocol — so the renderer is a normal web page with no node access.

**개발 모드**: `python -m uvicorn main:app` 직접 실행  
**패키지 모드**: `dist/stt-server/stt-server.exe` (PyInstaller onedir) 실행

### Python server (`main.py` + `stt_corrector.py`)
- **FastAPI** + **uvicorn** WebSocket server on port 18765
- `GET /` → redirects to `/ui/` (StaticFiles serving `electron/renderer/`)
- `GET /health` — Electron health-check
- `WS /ws/stt` — accepts raw PCM binary (16-bit LE, 16 kHz mono), streams through Vosk, returns `{type:"partial", partial}` or `{type:"final", text, original, corrections[]}`
- `GET|POST|DELETE /api/vocabulary` — runtime vocabulary management; persisted to `userData/vocabulary.json`

**STT pipeline**: PCM → `vosk.KaldiRecognizer` → on final result → corrector(`local` or `cloud`) `process()` (only when `STT_APPLY_CORRECTION_ON_FINAL=1`)

**`stt_corrector.py`**: zero-dependency pure-Python module. Pipeline: normalize (filler removal) → jamo decomposition → char n-gram TF-IDF vectorization → cosine similarity match against vocabulary → `CorrectionResult`.

### Electron (`electron/`)
| File | Role |
|---|---|
| `main.cjs` | 프로세스 관리, 권한, IPC 핸들러, 창 생성 |
| `preload.cjs` | `window.stt.saveChatLog()`, `window.stt.quit()` 노출 |
| `renderer/` | FastAPI가 `/ui/`로 서빙하는 정적 웹 UI |

`contextIsolation: true`, `nodeIntegration: false`. 렌더러→메인 통신은 `ipcRenderer.invoke/send`만 사용.

마이크 권한은 `127.0.0.1` HTTP 출처에 한해 `setPermissionRequestHandler`로 허용 (Chromium 기본 차단 우회).

### Frontend (`electron/renderer/app.js`)
Single IIFE. Key flows:
- **Recording**: `getUserMedia` → `AudioContext` (2048 buffer) → downsample to 16 kHz → VAD (RMS threshold 0.003, hold 14 frames) → `Int16Array` binary → WebSocket `/ws/stt`
- **Session storage**: `localStorage` key `stt-sessions-v2`; structure `{sessions[], activeSessionId}`. Includes v1→v2 migration.
- **Partial/final bubbles**: single reused `#partialRow` for partials; permanent `.msg-row` appended on final.

### Build packaging (`stt-server.spec`)
PyInstaller **onedir** (not onefile) for faster startup. Vosk language model is **not** bundled — passed via `VOSK_MODEL_PATH` env var.

electron-builder `extraResources`:
| Source | `resources/` path |
|---|---|
| `electron/renderer/` | `renderer/` |
| `dist/stt-server/` | `stt-server/` |
| `vosk-model-small-ko-0.22/vosk-model-small-ko-0.22/` | `vosk-model-small-ko-0.22/` |

Packaged binary resolves paths via `resolveResource()` which checks both `process.resourcesPath` and `dirname(process.execPath)/resources` (portable exe fallback).

## Key env vars (Electron → Python)
| Var | Default | Purpose |
|---|---|---|
| `VOSK_MODEL_PATH` | auto-detected | Vosk 모델 디렉터리 |
| `UI_DIR` | `electron/renderer` | 정적 파일 루트 |
| `HOST` / `PORT` | `127.0.0.1:18765` | 서버 바인딩 |
| `VOCAB_PATH` | `userData/vocabulary.json` | 어휘 파일 경로 |
| `STT_ENABLE_CORRECTOR` | `1` | 교정기 활성화 (0이면 passthrough) |
| `STT_CORRECTOR_BACKEND` | `local` | `local` 또는 `cloud` 선택 |
| `STT_CORRECTOR_CLASS` | auto | 교정기 클래스 경로 직접 지정 (없으면 backend 기본값 사용) |
| `STT_APPLY_CORRECTION_ON_FINAL` | `1` | 교정 적용 (0=지연최소, 1=교정우선) |
| `CORRECT_THRESHOLD` | `0.86` | local 교정기의 코사인 유사도 임계값 |
| `STT_CLOUD_PROVIDER` | `openai` | cloud 제공자 (`openai`, `anthropic`, `gemini`) |
| `STT_CLOUD_API_KEY` | - | cloud API 키 |
| `STT_CLOUD_MODEL` | provider default | cloud 모델명 |
| `STT_CLOUD_TIMEOUT_SEC` | `8` | cloud 요청 타임아웃(초) |
