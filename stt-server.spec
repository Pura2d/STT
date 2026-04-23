# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller onedir spec for the Vosk STT FastAPI/uvicorn server.

Build:
    pyinstaller stt-server.spec

Output:
    dist/stt-server/stt-server.exe  (+ all DLLs/PYDs in same folder)

Notes:
  - onedir is used instead of onefile for faster startup (no extraction step).
  - UPX is disabled to avoid antivirus false-positives.
  - The Vosk *language model* is NOT embedded here; it lives in
    extraResources/vosk-model and is pointed to via the VOSK_MODEL_PATH env var.
"""
import sys
from PyInstaller.utils.hooks import collect_all

block_cipher = None

# ── collect binary + data + hidden-imports from runtime packages ──────────────
_pkgs = [
    "vosk",
    "uvicorn",
    "fastapi",
    "starlette",
    "anyio",
    "h11",
    "httptools",
    "websockets",
    "wsproto",
    "numpy",          # FFT 스펙트럼 디노이즈
]

binaries_all, datas_all, hidden_all = [], [], []
for pkg in _pkgs:
    try:
        d, b, h = collect_all(pkg)
        datas_all   += d
        binaries_all += b
        hidden_all   += h
    except Exception as exc:
        print(f"[spec] collect_all({pkg!r}) skipped: {exc}")

extra_hidden = [
    # uvicorn dynamic imports (selected by string at runtime)
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.http.httptools_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    # stdlib
    "asyncio",
    "logging.config",
    "email.mime.text",
    "email.mime.multipart",
    "multiprocessing",
]

a = Analysis(
    ["main.py"],
    pathex=["."],  # stt_corrector.py 탐색 경로
    binaries=binaries_all,
    datas=datas_all,
    hiddenimports=hidden_all + extra_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # strip unused heavy packages from the bundle
    excludes=["tkinter", "matplotlib", "pandas", "PIL", "cv2", "scipy"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="stt-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,          # Electron's windowsHide:true keeps the console hidden
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="stt-server",
)
