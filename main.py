"""
Vosk 한국어 STT WebSocket 서버.

파이프라인
----------
클라이언트(PCM 16-bit LE 16kHz)
  → Vosk 스트리밍 인식 (partial 실시간 전송)
  → 발화 확정 시: SemanticCorrector(자모 TF-IDF 코사인 유사도) 교정
  → 클라이언트 전송 { type, text, original, corrections }
"""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Protocol

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import vosk

# Vosk 내부 로그 완전 억제 — stderr 오염 없이 Python 로그만 사용
vosk.SetLogLevel(-1)

logger = logging.getLogger(__name__)

_BASE = os.path.dirname(os.path.abspath(__file__))

# ── 모델 경로 ─────────────────────────────────────────────────────────────────

def _default_model_path() -> str:
    candidates = [
        os.path.join(_BASE, "model"),
        os.path.join(_BASE, "vosk-model-small-ko-0.22", "vosk-model-small-ko-0.22"),
        os.path.join(_BASE, "vosk-model-ko-0.22", "vosk-model-ko-0.22"),
    ]
    for p in candidates:
        if os.path.isfile(os.path.join(p, "conf", "mfcc.conf")):
            return p
    return candidates[0]


_raw = os.environ.get("VOSK_MODEL_PATH")
if _raw:
    _p = os.path.expandvars(os.path.expanduser(_raw))
    MODEL_PATH = _p if os.path.isabs(_p) else os.path.abspath(os.path.join(_BASE, _p))
else:
    MODEL_PATH = _default_model_path()

SAMPLE_RATE = int(os.environ.get("VOSK_SAMPLE_RATE", "16000"))
CORRECT_THRESHOLD = float(os.environ.get("STT_CORRECT_THRESHOLD", "0.86"))
CORRECT_NGRAM = int(os.environ.get("STT_CORRECT_NGRAM", "2"))
# 일반 대화 기본값: 어휘 grammar 제약을 끄고 자유 인식을 우선합니다.
USE_VOCAB_GRAMMAR = os.environ.get("VOSK_USE_VOCAB_GRAMMAR", "0").lower() in {
    "1",
    "true",
    "yes",
    "y",
}
MAX_GRAMMAR_WORDS = int(os.environ.get("VOSK_GRAMMAR_MAX_WORDS", "1500"))
ENABLE_CORRECTOR = os.environ.get("STT_ENABLE_CORRECTOR", "1").lower() in {
    "1",
    "true",
    "yes",
    "y",
}
# 교정 백엔드: local(기본) | cloud
CORRECTOR_BACKEND = os.environ.get("STT_CORRECTOR_BACKEND", "local").strip().lower()
# 교정기 구현체를 런타임에 교체할 수 있도록 클래스 경로를 노출합니다.
# STT_CORRECTOR_CLASS를 지정하지 않으면 backend 값으로 기본 클래스를 자동 선택합니다.
CORRECTOR_CLASS = os.environ.get("STT_CORRECTOR_CLASS", "").strip()
# 실시간 우선 모드: 확정 결과를 즉시 보내고(기본), 교정은 선택적으로만 적용.
APPLY_CORRECTION_ON_FINAL = os.environ.get("STT_APPLY_CORRECTION_ON_FINAL", "1").lower() in {
    "1",
    "true",
    "yes",
    "y",
}

# ── 어휘 경로 ─────────────────────────────────────────────────────────────────

_vocab_path: str = os.environ.get(
    "VOCAB_PATH",
    os.path.join(_BASE, "vocabulary.json"),
)


def _load_vocab_file() -> list[str]:
    if os.path.isfile(_vocab_path):
        try:
            with open(_vocab_path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                return [str(w) for w in data if str(w).strip()]
        except Exception as e:
            logger.warning("어휘 파일 로드 실패: %s", e)
    return []


def _save_vocab_file(words: list[str]) -> None:
    try:
        os.makedirs(os.path.dirname(_vocab_path) or ".", exist_ok=True)
        with open(_vocab_path, "w", encoding="utf-8") as f:
            json.dump(words, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.warning("어휘 파일 저장 실패: %s", e)


def _build_vosk_grammar(words: list[str]) -> str | None:
    """어휘 기반 Vosk grammar(JSON 배열 문자열)를 만듭니다.

    [unk]를 추가해 사전에 없는 단어도 인식 가능하게 둡니다.
    """
    cleaned: list[str] = []
    seen = set()
    for w in words:
        t = str(w).strip()
        if not t or t in seen:
            continue
        seen.add(t)
        cleaned.append(t)
        if len(cleaned) >= MAX_GRAMMAR_WORDS:
            break
    if not cleaned:
        return None
    cleaned.append("[unk]")
    return json.dumps(cleaned, ensure_ascii=False)


# ── 전역 상태 ─────────────────────────────────────────────────────────────────

_model:     vosk.Model | None        = None


class CorrectorResult(Protocol):
    text: str
    raw: str
    corrections: list[Any]


class CorrectorEngine(Protocol):
    @property
    def vocabulary(self) -> list[str]:
        ...

    def load_vocabulary(self, words: list[str]) -> None:
        ...

    def add_words(self, words: list[str]) -> None:
        ...

    def remove_word(self, word: str) -> None:
        ...

    def process(self, raw_text: str) -> CorrectorResult:
        ...


class _PassthroughResult:
    def __init__(self, text: str) -> None:
        self.text = text
        self.raw = text
        self.corrections: list[Any] = []


class PassthroughCorrector:
    """교정기를 끄거나 로드 실패 시 사용하는 no-op 교정기."""

    def __init__(self, vocabulary: list[str] | None = None, **_: Any) -> None:
        self._vocab: list[str] = []
        if vocabulary:
            self.load_vocabulary(vocabulary)

    @property
    def vocabulary(self) -> list[str]:
        return self._vocab

    def load_vocabulary(self, words: list[str]) -> None:
        seen: set[str] = set()
        clean: list[str] = []
        for word in words:
            token = str(word).strip()
            if token and token not in seen:
                seen.add(token)
                clean.append(token)
        self._vocab = clean

    def add_words(self, words: list[str]) -> None:
        self.load_vocabulary(self._vocab + list(words))

    def remove_word(self, word: str) -> None:
        target = word.strip()
        self.load_vocabulary([w for w in self._vocab if w != target])

    def process(self, raw_text: str) -> _PassthroughResult:
        return _PassthroughResult(raw_text)


class LegacyCorrectorAdapter:
    """기존 SemanticCorrector 인터페이스(_vocab 기반)를 표준화합니다."""

    def __init__(self, engine: Any) -> None:
        self._engine = engine

    @property
    def vocabulary(self) -> list[str]:
        return list(getattr(self._engine, "_vocab", []))

    def load_vocabulary(self, words: list[str]) -> None:
        self._engine.load_vocabulary(words)

    def add_words(self, words: list[str]) -> None:
        self._engine.add_words(words)

    def remove_word(self, word: str) -> None:
        self._engine.remove_word(word)

    def process(self, raw_text: str) -> CorrectorResult:
        return self._engine.process(raw_text)


def _load_corrector_class(path: str):
    module_name, _, class_name = path.rpartition(".")
    if not module_name or not class_name:
        raise ValueError(f"잘못된 STT_CORRECTOR_CLASS 값: {path!r}")
    module = importlib.import_module(module_name)
    cls = getattr(module, class_name, None)
    if cls is None:
        raise AttributeError(f"{module_name!r}에 {class_name!r} 클래스가 없습니다.")
    return cls


def _create_corrector(vocab: list[str]) -> CorrectorEngine:
    if not ENABLE_CORRECTOR:
        logger.info("교정기 비활성화(STT_ENABLE_CORRECTOR=0) — PassthroughCorrector 사용")
        return PassthroughCorrector(vocabulary=vocab)

    try:
        class_path = CORRECTOR_CLASS
        if not class_path:
            if CORRECTOR_BACKEND == "cloud":
                class_path = "cloud_corrector.CloudLlmCorrector"
            else:
                class_path = "stt_corrector.SemanticCorrector"

        corrector_cls = _load_corrector_class(class_path)
        engine = corrector_cls(
            vocabulary=vocab, threshold=CORRECT_THRESHOLD, ngram=CORRECT_NGRAM
        )
        logger.info(
            "교정기 초기화 완료 — backend=%s, class=%s, 어휘 %d개, threshold=%.2f, ngram=%d",
            CORRECTOR_BACKEND,
            class_path,
            len(vocab),
            CORRECT_THRESHOLD,
            CORRECT_NGRAM,
        )
        if hasattr(engine, "vocabulary"):
            return engine
        return LegacyCorrectorAdapter(engine)
    except Exception as e:
        logger.warning(
            "교정기 로드 실패(backend=%s, class=%s): %s — PassthroughCorrector로 폴백합니다.",
            CORRECTOR_BACKEND,
            CORRECTOR_CLASS or "(auto)",
            e,
        )
        return PassthroughCorrector(vocabulary=vocab)


_corrector: CorrectorEngine | None = None


# ── 앱 수명 주기 ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _corrector

    if not os.path.isdir(MODEL_PATH):
        raise RuntimeError(
            f"Vosk 모델 디렉터리를 찾을 수 없습니다: {MODEL_PATH!r}. "
            "https://alphacephei.com/vosk/models 에서 한국어 모델을 받아 압축을 풀고 "
            "VOSK_MODEL_PATH를 해당 폴더로 설정하세요."
        )
    logger.info("Vosk 모델 로드 중: %s", MODEL_PATH)
    _model = vosk.Model(MODEL_PATH)

    vocab = _load_vocab_file()
    _corrector = _create_corrector(vocab)

    yield

    _model     = None
    _corrector = None


app = FastAPI(title="Vosk KO STT", lifespan=lifespan)

_UI_DIR = os.environ.get("UI_DIR") or os.path.join(_BASE, "electron", "renderer")
if os.path.isdir(_UI_DIR):
    app.mount("/ui", StaticFiles(directory=_UI_DIR, html=True), name="ui")


# ── 기본 엔드포인트 ───────────────────────────────────────────────────────────

@app.get("/")
def root():
    if os.path.isdir(_UI_DIR):
        return RedirectResponse(url="/ui/")
    return {"message": "Open /ui or use /health."}


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status":       "ok",
        "model_loaded": _model is not None,
        "corrector_backend": CORRECTOR_BACKEND,
        "vocab_size":   len(_corrector.vocabulary) if _corrector else 0,
    }


# ── 어휘 관리 API ─────────────────────────────────────────────────────────────

@app.get("/api/vocabulary")
def get_vocabulary():
    return {"words": _corrector.vocabulary if _corrector else []}


@app.post("/api/vocabulary")
async def add_vocabulary(request: Request):
    body = await request.json()
    words = body.get("words", [])
    if not isinstance(words, list):
        return JSONResponse({"error": "words 필드는 배열이어야 합니다."}, status_code=400)
    if _corrector:
        _corrector.add_words(words)
        _save_vocab_file(_corrector.vocabulary)
        logger.info("어휘 추가: %s (총 %d개)", words, len(_corrector.vocabulary))
    return {"words": _corrector.vocabulary if _corrector else []}


@app.delete("/api/vocabulary/{word:path}")
def delete_vocabulary(word: str):
    if _corrector:
        _corrector.remove_word(word)
        _save_vocab_file(_corrector.vocabulary)
        logger.info("어휘 제거: %r (총 %d개)", word, len(_corrector.vocabulary))
    return {"words": _corrector.vocabulary if _corrector else []}


@app.delete("/api/vocabulary")
def clear_vocabulary():
    if _corrector:
        _corrector.load_vocabulary([])
        _save_vocab_file([])
    return {"words": []}


# ── 유틸 ──────────────────────────────────────────────────────────────────────

def _parse_vosk_json(raw: str) -> dict[str, Any]:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {}


def _build_final_payload(raw_text: str) -> dict[str, Any]:
    """Vosk 원시 텍스트에 SemanticCorrector 파이프라인을 적용합니다."""
    if not raw_text:
        return {"type": "final", "text": "", "original": "", "corrections": []}

    if _corrector and APPLY_CORRECTION_ON_FINAL:
        result = _corrector.process(raw_text)
        return {
            "type":        "final",
            "text":        result.text,
            "original":    result.raw,
            "corrections": [
                {
                    "index":      c.index,
                    "from":       c.original,
                    "to":         c.corrected,
                    "similarity": c.similarity,
                }
                for c in result.corrections
            ],
        }
    # 실시간 기본 경로: 원문을 바로 송신(지연 최소화)
    return {"type": "final", "text": raw_text, "original": raw_text, "corrections": []}


# ── STT WebSocket ─────────────────────────────────────────────────────────────

@app.websocket("/ws/stt")
async def stt_websocket(websocket: WebSocket) -> None:
    if _model is None:
        await websocket.close(code=1011)
        return

    await websocket.accept()

    # ── VOSK 인식기 초기화 ──────────────────────────────────────────────────────
    grammar = None
    if USE_VOCAB_GRAMMAR and _corrector and _corrector.vocabulary:
        grammar = _build_vosk_grammar(_corrector.vocabulary)
    if grammar:
        rec = vosk.KaldiRecognizer(_model, SAMPLE_RATE, grammar)
    else:
        rec = vosk.KaldiRecognizer(_model, SAMPLE_RATE)

    # 단어별 타임스탬프 불필요 — JSON 크기 절감 및 파싱 속도 향상
    rec.SetWords(False)

    last_partial = ""  # 동일 partial 반복 전송 차단

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            data = message.get("bytes")
            if not data:
                continue

            # AcceptWaveform: VOSK 내부 버퍼에 PCM 누적
            # → 침묵 구간(클라이언트 침묵 패딩 포함) 감지 시 True 반환
            if rec.AcceptWaveform(data):
                last_partial = ""
                payload  = _parse_vosk_json(rec.Result())
                raw_text = (payload.get("text") or "").strip()
                if raw_text:
                    msg = _build_final_payload(raw_text)
                    if msg.get("text"):
                        await websocket.send_json(msg)
            else:
                payload = _parse_vosk_json(rec.PartialResult())
                partial = (payload.get("partial") or "").strip()
                if partial and partial != last_partial:
                    last_partial = partial
                    await websocket.send_json(
                        {"type": "partial", "partial": partial}
                    )

    except WebSocketDisconnect:
        pass
    finally:
        # 연결 종료 시 미확정 발화 강제 확정
        try:
            tail     = _parse_vosk_json(rec.FinalResult())
            raw_tail = (tail.get("text") or "").strip()
            if raw_tail:
                msg = _build_final_payload(raw_tail)
                if msg.get("text"):
                    await websocket.send_json(msg)
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(
        app,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        reload=False,
    )
