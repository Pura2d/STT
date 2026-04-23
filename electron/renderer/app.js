(() => {
  const TARGET_RATE    = 16000;
  const STORAGE_KEY    = "stt-sessions-v2";
  const STORAGE_KEY_V1 = "stt-sessions-v1";

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const micToggle     = document.getElementById("micToggle");
  const welcomeMicToggle = document.getElementById("welcomeMicToggle");
  const iconIdle      = micToggle.querySelector(".icon-idle");
  const iconLive      = micToggle.querySelector(".icon-live");
  const statusText    = document.getElementById("statusText");
  const statusIdle    = document.getElementById("statusIdle");
  const waveStatus    = document.getElementById("waveStatus");
  const waveformCanvas= document.getElementById("waveformCanvas");
  const waveCtx       = waveformCanvas.getContext("2d");
  const messagesArea  = document.getElementById("messagesArea");
  const welcomeWrap   = document.getElementById("welcomeWrap");
  const recBadge         = document.getElementById("recBadge");
  const recordingBanner  = document.getElementById("recordingBanner");
  const toast         = document.getElementById("toast");
  const sessionListEl = document.getElementById("sessionList");
  const wordListEl    = document.getElementById("wordList");
  const vocabInput    = document.getElementById("vocabInput");
  const btnAddVocab   = document.getElementById("btnAddVocab");
  const sessionSearch = document.getElementById("sessionSearch");

  // ── Audio state ───────────────────────────────────────────────────────────
  let ws = null, audioCtx = null, mediaStream = null;
  let workletNode = null, sourceNode = null, analyser = null, animFrame = null;

  let isRecording = false;
  let isStarting  = false;

  // ── WS reconnect ──────────────────────────────────────────────────────────
  let wsRetryCount = 0;
  let wsRetryTimer = null;
  const WS_MAX_RETRIES = 5;

  // ── Partial bubble (single, reused) ───────────────────────────────────────
  let partialRow = null;

  // ── Session state ─────────────────────────────────────────────────────────
  /**
   * @typedef {{ id:string, text:string, html:string, corrections:any[], timestamp:number }} Msg
   * @typedef {{ id:string, title:string, messages:Msg[], createdAt:number, updatedAt:number }} Session
   */
  /** @type {Session[]} */
  let sessions        = [];
  let activeSessionId = null;

  function genId() {
    return `s_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
  function fmtTitle(ts) {
    const d = new Date(ts);
    return `새 대화 · ${d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  function saveSessions() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions, activeSessionId })); } catch (_) {}
  }

  function loadSessions() {
    // v2
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (Array.isArray(d.sessions) && d.sessions.length) return d;
      }
    } catch (_) {}
    // migrate v1 → v2
    try {
      const rawV1 = localStorage.getItem(STORAGE_KEY_V1);
      if (rawV1) {
        const d1 = JSON.parse(rawV1);
        if (Array.isArray(d1.sessions) && d1.sessions.length) {
          const migrated = d1.sessions.map(s => ({
            id: s.id, title: s.title,
            messages: s.finalText
              ? [{ id: genId(), text: s.finalText, html: _esc(s.finalText), corrections: [], timestamp: s.updatedAt || s.createdAt }]
              : [],
            createdAt: s.createdAt, updatedAt: s.updatedAt,
          }));
          return { sessions: migrated, activeSessionId: d1.activeSessionId };
        }
      }
    } catch (_) {}
    return null;
  }

  function getActive() { return sessions.find(x => x.id === activeSessionId) || null; }

  function autotitle(s) {
    if (!s || !s.title.startsWith("새 대화")) return;
    const msgs = s.messages || [];
    if (!msgs.length) return;
    const t = msgs[0].text.replace(/\s+/g, " ").trim();
    if (!t) return;
    s.title = t.length > 30 ? `${t.slice(0, 30)}…` : t;
  }

  function persistActive() {
    const s = getActive();
    if (!s) return;
    s.updatedAt = Date.now();
    autotitle(s);
    saveSessions();
  }

  // ── Welcome / messages area ───────────────────────────────────────────────
  function showWelcome(v) {
    welcomeWrap.style.display = v ? "flex" : "none";
  }

  function scrollBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  // ── Build bubble DOM ──────────────────────────────────────────────────────
  function makeBubble(msg) {
    const row = document.createElement("div");
    row.className = "msg-row";
    if (msg.id) row.dataset.msgId = msg.id;

    row.innerHTML = `
      <div class="msg-avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/>
          <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
          <line x1="12" y1="18" x2="12" y2="22"/>
        </svg>
      </div>
      <div class="msg-bubble">
        <div class="msg-text"></div>
        <div class="msg-footer">
          <span class="msg-time">${fmtTime(msg.timestamp)}</span>
          ${msg.corrections && msg.corrections.length
            ? `<span class="msg-badge" title="${msg.corrections.map(c => `${c.from}→${c.to}`).join(', ')}">교정 ${msg.corrections.length}</span>`
            : ""}
        </div>
      </div>`;

    // Set innerHTML via property to safely inject corrected HTML
    row.querySelector(".msg-text").innerHTML = msg.html || _esc(msg.text);
    return row;
  }

  function makePartialBubble() {
    const row = document.createElement("div");
    row.className = "msg-row msg-row--partial";
    row.id = "partialRow";
    row.innerHTML = `
      <div class="msg-avatar" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/>
          <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
          <line x1="12" y1="18" x2="12" y2="22"/>
        </svg>
      </div>
      <div class="msg-bubble">
        <div class="msg-text" id="partialMsgText"></div>
      </div>`;
    return row;
  }

  // ── Render session into messages area ──────────────────────────────────────
  function renderSession(s) {
    // Remove all message rows (keep welcomeWrap)
    messagesArea.querySelectorAll(".msg-row").forEach(el => el.remove());
    partialRow = null;

    if (!s || !s.messages || !s.messages.length) {
      showWelcome(true);
      return;
    }
    showWelcome(false);
    for (const msg of s.messages) {
      messagesArea.appendChild(makeBubble(msg));
    }
    scrollBottom();
  }

  // ── Partial text ──────────────────────────────────────────────────────────
  function setPartial(text) {
    if (!text) {
      if (partialRow) { partialRow.remove(); partialRow = null; }
      return;
    }
    showWelcome(false);
    if (!partialRow) {
      partialRow = makePartialBubble();
      messagesArea.appendChild(partialRow);
    }
    const el = document.getElementById("partialMsgText");
    if (el) el.textContent = text;
    scrollBottom();
  }

  // ── Append final message ──────────────────────────────────────────────────
  function appendFinal(text, corrections) {
    if (!text) return;
    const s = getActive();
    if (!s) return;

    // Remove partial bubble
    if (partialRow) { partialRow.remove(); partialRow = null; }
    showWelcome(false);

    const html = buildCorrectedHtml(text, corrections);
    const msg  = { id: genId(), text, html, corrections: corrections || [], timestamp: Date.now() };

    s.messages = s.messages || [];
    s.messages.push(msg);
    s.updatedAt = msg.timestamp;
    autotitle(s);
    saveSessions();
    renderSessionList();

    messagesArea.appendChild(makeBubble(msg));
    scrollBottom();
  }

  // ── Session list ──────────────────────────────────────────────────────────
  function renderSessionList() {
    sessionListEl.innerHTML = "";
    const query = (sessionSearch?.value || "").trim().toLowerCase();
    const ordered = [...sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter(s => {
        if (!query) return true;
        if (s.title.toLowerCase().includes(query)) return true;
        return (s.messages || []).some(m => m.text.toLowerCase().includes(query));
      });

    if (!ordered.length) {
      const li = document.createElement("li");
      li.className = "session-empty";
      li.textContent = query ? `"${query}" 검색 결과 없음` : "대화가 없습니다";
      sessionListEl.appendChild(li);
      return;
    }

    for (const s of ordered) {
      const li  = document.createElement("li");
      const btn = document.createElement("button");
      btn.type      = "button";
      btn.className = "session-item" + (s.id === activeSessionId ? " active" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", s.id === activeSessionId ? "true" : "false");

      const title = document.createElement("div");
      title.className   = "session-item-title";
      title.textContent = s.title || "대화";

      const msgs   = s.messages || [];
      const lastMsg = msgs[msgs.length - 1];
      const preview = document.createElement("div");
      preview.className = "session-item-preview";
      preview.textContent = lastMsg
        ? lastMsg.text.replace(/\s+/g, " ").slice(0, 32) + (lastMsg.text.length > 32 ? "…" : "")
        : new Date(s.updatedAt).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

      btn.append(title, preview);
      btn.addEventListener("click", () => selectSession(s.id));

      const delBtn = document.createElement("button");
      delBtn.type      = "button";
      delBtn.className = "btn-session-del";
      delBtn.textContent = "✕";
      delBtn.title = "대화 삭제";
      delBtn.addEventListener("click", e => { e.stopPropagation(); deleteSession(s.id); });

      li.append(btn, delBtn);
      sessionListEl.appendChild(li);
    }
  }

  function selectSession(id) {
    if (id === activeSessionId) return;
    if (isRecording || isStarting) {
      if (!confirm("녹음 중입니다. 중지하고 선택한 대화로 이동할까요?")) return;
      stopAll();
    }
    persistActive();
    activeSessionId = id;
    renderSession(getActive());
    saveSessions();
    renderSessionList();
  }

  function deleteSession(id) {
    if (sessions.length === 1) { showToast("마지막 대화는 삭제할 수 없습니다.", 2500); return; }
    const t = sessions.find(s => s.id === id);
    if (!confirm(`"${t?.title || "대화"}"를 삭제할까요?`)) return;
    if (id === activeSessionId && (isRecording || isStarting)) stopAll();
    sessions = sessions.filter(s => s.id !== id);
    if (id === activeSessionId) {
      activeSessionId = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
      renderSession(getActive());
    }
    saveSessions();
    renderSessionList();
    showToast("대화가 삭제되었습니다.");
  }

  function createNewSession() {
    if (isRecording || isStarting) {
      if (!confirm("녹음 중입니다. 새 대화를 만들면 녹음이 중지됩니다. 계속할까요?")) return;
      stopAll();
    }
    persistActive();
    const now = Date.now();
    const s = { id: genId(), title: fmtTitle(now), messages: [], createdAt: now, updatedAt: now };
    sessions.unshift(s);
    activeSessionId = s.id;
    if (sessionSearch) sessionSearch.value = "";
    saveSessions();
    renderSessionList();
    renderSession(s);
    showToast("새 대화가 만들어졌습니다.");
  }

  function initSessions() {
    const loaded = loadSessions();
    if (loaded && Array.isArray(loaded.sessions) && loaded.sessions.length) {
      sessions        = loaded.sessions;
      activeSessionId = loaded.activeSessionId;
      if (!sessions.some(x => x.id === activeSessionId)) activeSessionId = sessions[0].id;
    } else {
      const now = Date.now();
      const id  = genId();
      sessions  = [{ id, title: fmtTitle(now), messages: [], createdAt: now, updatedAt: now }];
      activeSessionId = id;
      saveSessions();
    }
    renderSession(getActive());
    renderSessionList();
  }

  // ── Vocabulary API ─────────────────────────────────────────────────────────
  const API_BASE = `${window.location.protocol}//${window.location.host}`;

  async function fetchVocab() {
    try { return (await (await fetch(`${API_BASE}/api/vocabulary`)).json()).words || []; }
    catch { return []; }
  }
  async function apiAddWord(w) {
    try {
      return (await (await fetch(`${API_BASE}/api/vocabulary`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ words: [w] }),
      })).json()).words || [];
    } catch { return null; }
  }
  async function apiDelWord(w) {
    try {
      return (await (await fetch(`${API_BASE}/api/vocabulary/${encodeURIComponent(w)}`, { method: "DELETE" })).json()).words || [];
    } catch { return null; }
  }

  function renderWordList(words) {
    wordListEl.innerHTML = "";
    if (!words || !words.length) {
      const li = document.createElement("li");
      li.className   = "word-item-empty";
      li.textContent = "단어를 추가하면\nSTT 교정에 활용됩니다";
      wordListEl.appendChild(li);
      return;
    }
    for (const w of words) {
      const li  = document.createElement("li"); li.className = "word-item";
      const dot = document.createElement("span"); dot.className = "word-item-dot";
      const txt = document.createElement("span"); txt.className = "word-item-text"; txt.textContent = w;
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn-word-del"; del.textContent = "✕"; del.title = "어휘에서 제거";
      del.addEventListener("click", async () => { const u = await apiDelWord(w); if (u !== null) renderWordList(u); });
      li.append(dot, txt, del);
      wordListEl.appendChild(li);
    }
  }

  async function addVocabWord() {
    const word = vocabInput.value.trim();
    if (!word) return;
    vocabInput.value = "";
    const updated = await apiAddWord(word);
    if (updated !== null) { renderWordList(updated); showToast(`"${word}" 추가됨`); }
    else showToast("어휘 추가 실패", 3000);
  }

  // ── Text helpers ───────────────────────────────────────────────────────────
  function _esc(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function buildCorrectedHtml(text, corrections) {
    if (!corrections || !corrections.length) return _esc(text);
    const map = {};
    for (const c of corrections) map[c.index] = c;
    return text.split(" ").map((tok, i) => {
      if (map[i]) {
        const sim = (map[i].similarity * 100).toFixed(0);
        return `<span class="corrected-word" title="원문: ${_esc(map[i].from)} (유사도 ${sim}%)">${_esc(tok)}</span>`;
      }
      return _esc(tok);
    }).join(" ");
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  function wsUrl() {
    const u = new URL(window.location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws/stt"; u.search = ""; u.hash = "";
    return u.toString();
  }

  function openWs() {
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    if (ws) { try { ws.onclose = null; ws.close(); } catch (_) {} ws = null; }

    ws = new WebSocket(wsUrl());
    ws.binaryType = "arraybuffer";
    ws.onopen  = () => { wsRetryCount = 0; };
    ws.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "partial") {
        setPartial(msg.partial || "");
      } else if (msg.type === "final" && msg.text) {
        appendFinal(msg.text, msg.corrections || []);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      ws = null;
      if (!isRecording) return;
      if (wsRetryCount < WS_MAX_RETRIES) {
        const delay = Math.min(1000 * (1 << wsRetryCount), 8000);
        wsRetryCount++;
        showToast(`연결 끊김 — ${(delay/1000).toFixed(0)}초 후 재연결 (${wsRetryCount}/${WS_MAX_RETRIES})`, delay + 600);
        statusText.textContent = "재연결 중...";
        wsRetryTimer = setTimeout(() => { if (isRecording) openWs(); }, delay);
      } else {
        showToast("재연결 실패. 마이크 버튼으로 다시 시작하세요.", 5000);
        stopAll();
      }
    };

    return new Promise((resolve, reject) => {
      const onOpen = () => { ws?.removeEventListener("error", onErr); resolve(); };
      const onErr  = () => { ws?.removeEventListener("open", onOpen); reject(new Error("WebSocket 연결 실패")); };
      ws.addEventListener("open",  onOpen, { once: true });
      ws.addEventListener("error", onErr,  { once: true });
    });
  }

  // ── Audio helpers ──────────────────────────────────────────────────────────
  // Float32→Int16 변환 및 downsample 은 AudioWorklet(audio-processor.js) 에서 처리

  // ── Waveform ───────────────────────────────────────────────────────────────
  function startWaveform() {
    waveformCanvas.classList.add("visible");
    statusIdle.classList.add("hidden");
    const dpr  = window.devicePixelRatio || 1;
    const rect = waveStatus.getBoundingClientRect();
    waveformCanvas.width  = rect.width  * dpr;
    waveformCanvas.height = rect.height * dpr;
    waveCtx.scale(dpr, dpr);
    const W = rect.width, H = rect.height;
    const da = new Uint8Array(analyser.fftSize);

    function draw() {
      animFrame = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(da);
      waveCtx.clearRect(0, 0, W, H);
      waveCtx.strokeStyle = "rgba(255,255,255,0.06)";
      waveCtx.lineWidth   = 1;
      waveCtx.beginPath(); waveCtx.moveTo(0, H / 2); waveCtx.lineTo(W, H / 2); waveCtx.stroke();
      waveCtx.strokeStyle = "#00c8ef"; waveCtx.lineWidth = 1.5;
      waveCtx.lineJoin = "round"; waveCtx.globalAlpha = 0.85;
      waveCtx.beginPath();
      const sw = W / da.length;
      for (let i = 0; i < da.length; i++) {
        const y = (da[i] / 255) * H;
        i === 0 ? waveCtx.moveTo(0, y) : waveCtx.lineTo(i * sw, y);
      }
      waveCtx.stroke();
      waveCtx.globalAlpha = 1;
    }
    draw();
  }

  function stopWaveform() {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    waveformCanvas.classList.remove("visible");
    statusIdle.classList.remove("hidden");
    waveCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  function showToast(msg, duration = 2400) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), duration);
  }

  function setMicUi(active) {
    micToggle.classList.toggle("live", active);
    if (welcomeMicToggle) welcomeMicToggle.classList.toggle("live", active);
    document.body.classList.toggle("recording", active);
    micToggle.setAttribute("aria-pressed", active ? "true" : "false");
    micToggle.setAttribute("aria-label", active ? "클릭하여 녹음 중지" : "음성 인식 시작");
    // OFF: 사선 마이크 / ON: ■ 정지 아이콘 (icon-stop은 CSS .live 에 의해 표시)
    iconIdle.style.display = active ? "none"  : "block";
    iconLive.style.display = "none";  // CSS가 icon-stop으로 대체
    statusText.textContent = active ? "● 인식 중  —  버튼을 눌러 중지" : "마이크를 눌러 시작";
    statusText.classList.toggle("live", active);
    recBadge.hidden = false;
    recBadge.classList.toggle("active", active);
    // 녹음 배너
    if (recordingBanner) recordingBanner.classList.toggle("hidden", !active);
  }

  // ── Stop / rerecord ────────────────────────────────────────────────────────
  function stopAll() {
    if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    wsRetryCount = 0;
    stopWaveform();
    if (workletNode) { try { workletNode.port.close(); workletNode.disconnect(); } catch (_) {} workletNode = null; }
    if (analyser)    { try { analyser.disconnect();   } catch (_) {} analyser   = null; }
    if (sourceNode)  { try { sourceNode.disconnect(); } catch (_) {} sourceNode = null; }
    if (audioCtx)    { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    if (ws)          { ws.onclose = null; ws.close(); ws = null; }
    setPartial("");
    isRecording = false;
    setMicUi(false);
    persistActive();
    // 종료 피드백 토스트
    const s = getActive();
    const count = s?.messages?.length || 0;
    if (count > 0) showToast(`녹음 완료 — ${count}개 발화 저장됨`, 2800);
    if (!s || !count) showWelcome(true);
  }

  function rerecord() {
    const s = getActive();
    const hasContent = s && s.messages && s.messages.length;
    if (hasContent || isRecording || isStarting) {
      if (!confirm("인식된 내용을 모두 지우고 처음부터 다시 녹음합니다. 계속할까요?")) return;
    }
    isStarting = false;
    stopAll();
    const sess = getActive();
    if (sess) { sess.messages = []; sess.updatedAt = Date.now(); sess.title = fmtTitle(Date.now()); }
    saveSessions();
    renderSessionList();
    renderSession(getActive());
    showToast("초기화했습니다. 마이크 버튼으로 다시 녹음하세요.");
  }

  // ── Save log ───────────────────────────────────────────────────────────────
  function buildLogText() {
    const s    = getActive();
    const msgs = s?.messages || [];
    const lines = [
      "=== Voice Finder 인식 로그 ===",
      s?.title ? `대화: ${s.title}` : "",
      `저장 시각: ${new Date().toLocaleString("ko-KR")}`,
      "", "[인식 내용]",
    ];
    if (msgs.length) {
      for (const m of msgs) lines.push(`[${fmtTime(m.timestamp)}] ${m.text}`);
    } else {
      lines.push("(없음)");
    }
    return lines.filter(Boolean).join("\n");
  }

  // ── Event wiring ───────────────────────────────────────────────────────────
  document.getElementById("btnNewSession").addEventListener("click", createNewSession);
  document.getElementById("btnRerecord").addEventListener("click", rerecord);
  sessionSearch?.addEventListener("input", () => renderSessionList());

  document.getElementById("btnSaveLog").addEventListener("click", async () => {
    const text = buildLogText();
    if (window.stt && typeof window.stt.saveChatLog === "function") {
      try {
        const r = await window.stt.saveChatLog(text);
        if (r?.ok) showToast("저장했습니다");
        else if (r?.canceled) return;
        else showToast(r?.error || "저장에 실패했습니다", 3200);
      } catch (e) { showToast(e.message || "저장 오류", 3200); }
      return;
    }
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `voicefinder-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast("파일로 받았습니다 (브라우저 모드)");
  });

  document.getElementById("btnQuit").addEventListener("click", () => {
    if (isRecording || isStarting) {
      if (!confirm("녹음·연결 중입니다. 그대로 종료할까요?")) return;
      stopAll();
    }
    persistActive();
    if (window.stt && typeof window.stt.quit === "function") { window.stt.quit(); return; }
    window.close();
  });

  async function toggleRecording() {
    if (isStarting) return;
    if (isRecording) { stopAll(); return; }

    isStarting = true;
    try {
      await openWs();

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount:     1,
          echoCancellation: true,   // 하울링/에코 제거 → Vosk 인식률 향상
          noiseSuppression: true,   // 배경 노이즈 억제 → Vosk 인식률 향상
          autoGainControl:  true,
          sampleRate:       { ideal: 16000 },
        },
      });

      // AudioContext 를 TARGET_RATE(16 kHz) 로 고정
      // → 브라우저 내장 고품질 리샘플러 사용, 수동 downsample 불필요
      audioCtx = new AudioContext({ sampleRate: TARGET_RATE });
      if (audioCtx.state === "suspended") await audioCtx.resume();
      sourceNode = audioCtx.createMediaStreamSource(mediaStream);

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      sourceNode.connect(analyser);

      // AudioWorklet: 전용 오디오 스레드 — 메인 스레드 GC 영향 없음
      // VAD + Float32→Int16 변환도 worklet 내부에서 처리 (main thread 부하 최소화)
      await audioCtx.audioWorklet.addModule('./audio-processor.js');
      workletNode = new AudioWorkletNode(audioCtx, 'stt-processor', {
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        processorOptions: {
          vadThreshold: 0.002, // RMS 임계값 (0.003 → 0.002: 더 민감)
          holdFrames:   38,    // 침묵 후 유지 (~300 ms @ 16 kHz/128)
          chunkFrames:  8,     // 전송 단위: 8×128=1024 samples ≈ 64 ms
        },
      });
      // worklet 이 Int16Array 를 zero-copy 전송 → 바로 WebSocket 송신
      workletNode.port.onmessage = e => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(e.data.buffer);
      };
      sourceNode.connect(workletNode);
      // workletNode → destination 연결 불필요 (오디오 출력 없음)

      startWaveform();
      isRecording = true;
      setMicUi(true);
      showWelcome(false);
    } catch (err) {
      showToast(err.message || String(err), 3200);
      stopAll();
    } finally {
      isStarting = false;
    }
  }

  // ── Mic toggle ─────────────────────────────────────────────────────────────
  micToggle.addEventListener("click", toggleRecording);
  welcomeMicToggle?.addEventListener("click", toggleRecording);

  // ── Vocabulary events ──────────────────────────────────────────────────────
  btnAddVocab.addEventListener("click", addVocabWord);
  vocabInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addVocabWord(); } });

  // ── Responsive sidebar ─────────────────────────────────────────────────────
  const sidebarL  = document.querySelector(".sidebar-left");
  const sidebarR  = document.querySelector(".sidebar-right");
  const overlay   = document.getElementById("sidebarOverlay");
  const closeAll  = () => { sidebarL.classList.remove("open"); sidebarR.classList.remove("open"); overlay.classList.remove("visible"); };

  document.getElementById("btnToggleLeft")?.addEventListener("click", () => {
    const opening = !sidebarL.classList.contains("open"); closeAll();
    if (opening) { sidebarL.classList.add("open"); overlay.classList.add("visible"); }
  });
  document.getElementById("btnToggleRight")?.addEventListener("click", () => {
    const opening = !sidebarR.classList.contains("open"); closeAll();
    if (opening) { sidebarR.classList.add("open"); overlay.classList.add("visible"); }
  });
  overlay?.addEventListener("click", closeAll);

  // ── Init ───────────────────────────────────────────────────────────────────
  initSessions();
  setMicUi(false);
  (async () => renderWordList(await fetchVocab()))();

  window._vfToast = showToast;
})();
