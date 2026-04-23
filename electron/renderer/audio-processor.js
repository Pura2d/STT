/**
 * STT AudioWorklet Processor
 *
 * 전용 오디오 스레드에서 실행 — 메인 스레드 GC/레이아웃과 완전히 격리.
 *
 * 동작:
 *  - process() 호출당 128 samples (AudioWorklet 고정)
 *  - 16 kHz 기준: 128 samples = 8 ms/프레임
 *  - RMS VAD: 에너지 초과 시 hold 카운터 리셋
 *  - voice 프레임을 accumulation 버퍼에 누적
 *  - chunkSize 도달 시 Int16 PCM 변환 후 zero-copy 전송
 *  - VAD hold 만료(침묵 경계) 시:
 *      1) 누적된 나머지 음성 전송
 *      2) 명시적 침묵 패딩 전송 → VOSK 발화 확정(final) 즉시 유도
 */

// VAD hold 만료 후 VOSK에 전송하는 침묵 샘플 수
// 16 kHz 기준: 3200 samples = 200 ms
// VOSK 한국어 소형 모델이 발화 경계를 확정하기에 충분한 침묵 길이
const SILENCE_PAD_SAMPLES = 3200;

class STTProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this._threshold  = o.vadThreshold ?? 0.002; // RMS 에너지 임계값
    this._holdFrames = o.holdFrames   ?? 38;    // 침묵 후 유지 프레임 (~300 ms @ 16 kHz/128)
    this._chunkSize  = (o.chunkFrames ?? 8) * 128; // 전송 단위 (8×128=1024 samples ≈ 64 ms)
    this._hold     = 0;
    this._buf      = new Float32Array(this._chunkSize);
    this._pos      = 0;
    this._padSent  = false; // 침묵 패딩 중복 전송 방지
  }

  /**
   * Float32 samples → Int16 PCM 변환 후 main thread 로 zero-copy 전송
   * @param {number} count - this._buf 에서 유효한 샘플 수
   */
  _flush(count) {
    const int16 = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const s = Math.max(-1, Math.min(1, this._buf[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    this.port.postMessage(int16, [int16.buffer]);
    this._pos = 0;
  }

  /**
   * 침묵 패딩 전송 — VOSK 의 발화 경계 감지(AcceptWaveform → true)를 즉시 유도
   * VAD hold 만료 직후 한 번만 실행
   */
  _sendSilencePad() {
    if (this._padSent) return;
    this._padSent = true;
    const silence = new Int16Array(SILENCE_PAD_SAMPLES); // 0으로 채워짐
    this.port.postMessage(silence, [silence.buffer]);
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    // ── RMS VAD ──────────────────────────────────────────────
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const isVoice = Math.sqrt(sum / ch.length) > this._threshold;

    if (isVoice) {
      this._hold    = this._holdFrames;
      this._padSent = false; // 새 발화 시작 → 패딩 플래그 초기화
    }

    if (this._hold > 0) {
      this._hold--;
      // voice 프레임 누적
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._pos++] = ch[i];
        if (this._pos >= this._chunkSize) {
          this._flush(this._chunkSize);
        }
      }
    } else {
      // 침묵 경계 도달
      if (this._pos > 0) {
        // 1) 누적된 나머지 음성 전송
        this._flush(this._pos);
      }
      // 2) 명시적 침묵 패딩 → VOSK 발화 확정 유도
      this._sendSilencePad();
    }

    return true;
  }
}

registerProcessor('stt-processor', STTProcessor);
