"""
STT 텍스트 후처리 — 정규화 · 자모 TF-IDF 벡터화 · 의미 교정 파이프라인.

외부 라이브러리 없이 순수 Python 표준 라이브러리만 사용합니다.

파이프라인 개요
--------------
1. 정규화 (Normalizer)
   - 연속 공백 → 단일 공백
   - 단독 필러 단어 제거 (어, 음, 그, 뭐 …)

2. 벡터화 (JamoTfidfVectorizer)
   - 한글 음절 → 자모(초·중·종성) 분해
   - 자모 시퀀스를 문자 n-gram 집합으로 변환
   - 어휘 전체로 IDF 가중치 계산 후 단어별 TF-IDF 벡터 생성
   - 음운상 유사한 단어가 고차원 공간에서 가까운 거리를 갖도록 설계

3. 의미 교정 (SemanticCorrector)
   - 입력 토큰 각각을 어휘 벡터와 코사인 유사도 비교
   - 유사도가 threshold 이상이고 원본과 다른 경우 교정 적용
   - 교정 내역을 CorrectionRecord 리스트로 반환
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# ── 한글 자모 분해 ────────────────────────────────────────────────────────────

_HANGUL_BASE  = 0xAC00
_HANGUL_END   = 0xD7A3
_CHO_LIST  = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"   # 19개
_JUNG_LIST = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"  # 21개
_JONG_LIST = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"  # 28개 (0=없음)


def _decompose(ch: str) -> str:
    """한글 음절 → 초성+중성+종성 문자열. 비한글은 그대로."""
    code = ord(ch) - _HANGUL_BASE
    if not (0 <= code <= 11171):
        return ch
    cho  = code // (21 * 28)
    jung = (code % (21 * 28)) // 28
    jong = code % 28
    result = _CHO_LIST[cho] + _JUNG_LIST[jung]
    if jong:
        result += _JONG_LIST[jong]
    return result


def to_jamo(text: str) -> str:
    """텍스트 전체를 자모 시퀀스로 변환합니다."""
    return "".join(
        _decompose(ch) if _HANGUL_BASE <= ord(ch) <= _HANGUL_END else ch
        for ch in text
    )


# ── 문자 n-gram ───────────────────────────────────────────────────────────────

def _ngram_freq(text: str, n: int) -> Dict[str, float]:
    """문자 n-gram 빈도 딕셔너리. 빈 텍스트면 빈 딕셔너리."""
    freq: Dict[str, float] = {}
    for i in range(max(0, len(text) - n + 1)):
        g = text[i : i + n]
        freq[g] = freq.get(g, 0.0) + 1.0
    return freq


def _cosine(va: Dict[str, float], vb: Dict[str, float]) -> float:
    """두 빈도 벡터의 코사인 유사도 (0 ~ 1)."""
    if not va or not vb:
        return 0.0
    dot   = sum(va.get(k, 0.0) * v for k, v in vb.items())
    mag_a = math.sqrt(sum(v * v for v in va.values()))
    mag_b = math.sqrt(sum(v * v for v in vb.values()))
    return dot / (mag_a * mag_b) if mag_a and mag_b else 0.0


# ── TF-IDF 벡터라이저 ─────────────────────────────────────────────────────────

class JamoTfidfVectorizer:
    """자모 n-gram 기반 TF-IDF 벡터라이저.

    어휘 코퍼스 전체로 IDF를 사전 계산한 뒤,
    임의 단어를 TF-IDF 가중 n-gram 벡터로 변환합니다.
    """

    def __init__(self, ngram: int = 2) -> None:
        self.ngram = ngram
        self._idf: Dict[str, float] = {}
        self._fitted = False

    def fit(self, docs: List[str]) -> "JamoTfidfVectorizer":
        """어휘 코퍼스로 IDF 가중치를 계산합니다."""
        n_docs = len(docs)
        if n_docs == 0:
            return self
        df: Dict[str, int] = {}
        for doc in docs:
            for gram in set(_ngram_freq(to_jamo(doc), self.ngram)):
                df[gram] = df.get(gram, 0) + 1
        # 라플라스 스무딩 적용 IDF
        self._idf = {g: math.log((n_docs + 1) / (cnt + 1)) + 1.0 for g, cnt in df.items()}
        self._fitted = True
        return self

    def vectorize(self, word: str) -> Dict[str, float]:
        """단어를 TF-IDF 벡터로 변환합니다."""
        tf = _ngram_freq(to_jamo(word), self.ngram)
        if not self._fitted:
            return tf
        return {k: v * self._idf.get(k, 1.0) for k, v in tf.items()}

    def similarity(self, a: str, b: str) -> float:
        """두 단어의 TF-IDF 벡터 코사인 유사도."""
        return _cosine(self.vectorize(a), self.vectorize(b))


# ── 정규화 ────────────────────────────────────────────────────────────────────

_FILLERS  = frozenset({"어", "음", "그", "뭐", "아", "이제", "그냥", "막", "좀"})
_SPACE_RE = re.compile(r"\s+")


def normalize(text: str) -> str:
    """STT 출력 텍스트를 정규화합니다.

    - 연속 공백 → 단일 공백
    - 단독 필러 단어 제거
    """
    tokens = _SPACE_RE.sub(" ", text).strip().split()
    return " ".join(t for t in tokens if t not in _FILLERS)


# ── 교정 결과 ─────────────────────────────────────────────────────────────────

@dataclass
class CorrectionRecord:
    """단어 하나의 교정 기록."""
    index:    int    # 토큰 인덱스
    original: str   # Vosk 원본 단어
    corrected: str  # 교정된 단어
    similarity: float  # 매칭 유사도


@dataclass
class CorrectionResult:
    """SemanticCorrector.process() 반환값."""
    text:        str                      # 교정 완료 텍스트
    original:    str                      # 정규화 직후 텍스트 (교정 전)
    raw:         str                      # Vosk 원시 텍스트
    corrections: List[CorrectionRecord] = field(default_factory=list)

    @property
    def was_corrected(self) -> bool:
        return bool(self.corrections)


# ── 의미 교정기 ───────────────────────────────────────────────────────────────

class SemanticCorrector:
    """자모 TF-IDF 코사인 유사도 기반 STT 텍스트 교정기.

    사용 예::

        corrector = SemanticCorrector(threshold=0.82)
        corrector.load_vocabulary(["무릎", "인대", "반월상연골"])
        result = corrector.process("무르 인다 손상")
        # result.text  → "무릎 인대 손상"
        # result.corrections[0]  → CorrectionRecord(0, "무르", "무릎", 0.91)
    """

    def __init__(
        self,
        vocabulary: Optional[List[str]] = None,
        threshold: float = 0.82,
        ngram: int = 2,
    ) -> None:
        self.threshold = threshold
        self._vectorizer = JamoTfidfVectorizer(ngram=ngram)
        self._vocab: List[str] = []
        # 캐시: (단어 → TF-IDF 벡터)
        self._vocab_cache: List[Tuple[str, Dict[str, float]]] = []

        if vocabulary:
            self.load_vocabulary(vocabulary)

    # ── 어휘 관리 ─────────────────────────────────────────────────────────────

    def load_vocabulary(self, words: List[str]) -> None:
        """어휘 목록을 교체하고 TF-IDF를 재계산합니다."""
        # 중복 제거, 공백 제거
        seen: set = set()
        clean = []
        for w in words:
            w = w.strip()
            if w and w not in seen:
                seen.add(w)
                clean.append(w)
        self._vocab = clean
        if not clean:
            self._vocab_cache = []
            return
        self._vectorizer.fit(clean)
        self._vocab_cache = [(w, self._vectorizer.vectorize(w)) for w in clean]

    def add_words(self, words: List[str]) -> None:
        """어휘를 추가하고 재fit합니다."""
        self.load_vocabulary(self._vocab + list(words))

    def remove_word(self, word: str) -> None:
        """특정 단어를 어휘에서 제거합니다."""
        self.load_vocabulary([w for w in self._vocab if w != word.strip()])

    # ── 핵심 교정 ─────────────────────────────────────────────────────────────

    def _best_match(self, token: str) -> Tuple[str, float]:
        """토큰과 코사인 유사도가 가장 높은 어휘 단어를 반환합니다."""
        if not self._vocab_cache:
            return token, 0.0
        vec = self._vectorizer.vectorize(token)
        best_word, best_sim = token, 0.0
        for vocab_word, vocab_vec in self._vocab_cache:
            # 음절 수 차이가 3 이상이면 스킵 (계산 비용 절감)
            if abs(len(vocab_word) - len(token)) > 3:
                continue
            sim = _cosine(vec, vocab_vec)
            if sim > best_sim:
                best_sim, best_word = sim, vocab_word
        return best_word, best_sim

    def _is_korean(self, token: str) -> bool:
        return any(_HANGUL_BASE <= ord(c) <= _HANGUL_END for c in token)

    def correct(self, normalized: str) -> CorrectionResult:
        """정규화된 텍스트에 어휘 교정을 적용합니다."""
        tokens = normalized.split()
        corrected_tokens: List[str] = []
        records: List[CorrectionRecord] = []

        for idx, token in enumerate(tokens):
            # 한글이 없거나 너무 짧은 토큰은 교정 생략
            if len(token) < 2 or not self._is_korean(token):
                corrected_tokens.append(token)
                continue

            best, sim = self._best_match(token)
            if sim >= self.threshold and best != token:
                corrected_tokens.append(best)
                records.append(CorrectionRecord(idx, token, best, round(sim, 4)))
            else:
                corrected_tokens.append(token)

        return CorrectionResult(
            text=" ".join(corrected_tokens),
            original=normalized,
            raw=normalized,
            corrections=records,
        )

    def process(self, raw_text: str) -> CorrectionResult:
        """전체 파이프라인 실행: 정규화 → 벡터화 → 의미 교정."""
        normalized = normalize(raw_text)
        result = self.correct(normalized)
        result.raw = raw_text  # 정규화 전 원시 텍스트 보존
        return result
