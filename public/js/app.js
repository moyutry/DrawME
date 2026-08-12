(() => {
  "use strict";

  const DRAW_COLORS = [
    "#1e1e1e", "#ffffff", "#9b9b9b", "#e74c3c", "#e67e22", "#f1c40f",
    "#2ecc71", "#00892e", "#1abc9c", "#3498db", "#1e3fae", "#9b59b6",
    "#e84393", "#8b572a", "#ffb8d9", "#c9c9c9",
  ];

  // ---------- מצב מקומי ----------
  const el = (id) => document.getElementById(id);
  const socket = io();

  let myId = null;
  let lastState = null;
  let lastPhaseForForm = null;
  let formTouched = false;
  let lastTurnKey = null;
  let chatInitialized = false;
  let wordChoicesPayload = null;

  // ---------- זהות קבועה (לחיבור מחדש) ----------
  // טוקן אקראי ששמור במכשיר, נפרד מהפרופיל הקוסמטי (שם/דמות) - מאפשר לשרת
  // לזהות "זה/ו אותו/ה שחקן/ית שחזר/ה" אחרי ניתוק קצר (רקע/נעילת מסך/רשת).
  function getOrCreateToken() {
    let token = localStorage.getItem("tvn-token");
    if (!token) {
      token = (crypto.randomUUID && crypto.randomUUID())
        || `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem("tvn-token", token);
    }
    return token;
  }
  const myToken = getOrCreateToken();
  let myRoomCode = localStorage.getItem("tvn-room") || null;

  // ---------- מצב "לא יודע/ת לקרוא": תמונה במקום מילה ----------
  // המיפוי מילה -> תמונה נוצר מראש (npm run fetch-word-images) ונטען פעם אחת;
  // מילים בלי תמונה (כולל כל מילה מותאמת-אישית) פשוט חוזרות undefined - הקוד
  // שמשתמש בזה תמיד נופל חזרה לטקסט הרגיל במקרה כזה.
  let wordImages = {};
  fetch("data/word-images.json")
    .then((r) => (r.ok ? r.json() : {}))
    .then((map) => { wordImages = map || {}; })
    .catch(() => {});
  function imageForWord(word) {
    return wordImages[word];
  }

  // תמונות רבות שקופות/בהירות (למשל שום) נבלעות על רקע לבן - דוגמים את
  // התמונה בקנבס זמני ובודקים בהירות ממוצעת (מתעלמים מפיקסלים שקופים) כדי
  // להחליט אם להציג אותה על רקע לבן או שחור.
  function applyAdaptiveBackground(img) {
    img.addEventListener("load", () => {
      try {
        const c = document.createElement("canvas");
        const w = (c.width = 24), h = (c.height = 24);
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        let total = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 20) continue;
          total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          count++;
        }
        img.classList.toggle("dark-bg", count > 0 && total / count > 210);
      } catch { /* לא קריטי - נשאר על רקע לבן ברירת המחדל */ }
    });
  }

  const canvas = new DrawingCanvas(el("draw-canvas"), {
    onPoint: (data) => socket.emit("draw-point", data),
    onEnd: () => socket.emit("draw-end"),
  });

  // ---------- ניהול מסכים ----------

  function setScreen(name) {
    ["screen-join", "screen-main"].forEach((id) =>
      el(id).classList.toggle("hidden", id !== `screen-${name}`)
    );
  }

  // ---------- מסך כניסה + עורך דמות ----------

  const savedProfile = safeParse(localStorage.getItem("tvn-profile"));
  const avatarConfig = {
    color: (savedProfile && savedProfile.avatar && Avatar.COLORS.includes(savedProfile.avatar.color))
      ? savedProfile.avatar.color
      : Avatar.COLORS[Math.floor(Math.random() * Avatar.COLORS.length)],
    eyes: savedProfile && savedProfile.avatar ? Avatar.clampIndex(savedProfile.avatar.eyes, Avatar.EYES_COUNT) : 0,
    mouth: savedProfile && savedProfile.avatar ? Avatar.clampIndex(savedProfile.avatar.mouth, Avatar.MOUTH_COUNT) : 0,
  };

  function renderAvatarPreview() {
    Avatar.renderAvatar(el("avatar-preview"), avatarConfig, 140);
  }

  function buildColorPicker(containerId, onPick, initial) {
    const container = el(containerId);
    container.innerHTML = "";
    Avatar.COLORS.forEach((c) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "color-swatch" + (c === initial ? " selected" : "");
      btn.style.background = c;
      btn.addEventListener("click", () => {
        [...container.children].forEach((ch) => ch.classList.remove("selected"));
        btn.classList.add("selected");
        onPick(c);
      });
      container.appendChild(btn);
    });
  }

  buildColorPicker("color-picker", (c) => { avatarConfig.color = c; renderAvatarPreview(); }, avatarConfig.color);
  renderAvatarPreview();

  el("eyes-prev").addEventListener("click", () => {
    avatarConfig.eyes = Avatar.clampIndex(avatarConfig.eyes - 1, Avatar.EYES_COUNT);
    renderAvatarPreview();
  });
  el("eyes-next").addEventListener("click", () => {
    avatarConfig.eyes = Avatar.clampIndex(avatarConfig.eyes + 1, Avatar.EYES_COUNT);
    renderAvatarPreview();
  });
  el("mouth-prev").addEventListener("click", () => {
    avatarConfig.mouth = Avatar.clampIndex(avatarConfig.mouth - 1, Avatar.MOUTH_COUNT);
    renderAvatarPreview();
  });
  el("mouth-next").addEventListener("click", () => {
    avatarConfig.mouth = Avatar.clampIndex(avatarConfig.mouth + 1, Avatar.MOUTH_COUNT);
    renderAvatarPreview();
  });

  if (savedProfile && savedProfile.name) el("name-input").value = savedProfile.name;

  let canRead = (savedProfile && typeof savedProfile.canRead === "boolean") ? savedProfile.canRead : true;
  el("can-read-toggle").checked = canRead;
  el("can-read-toggle").addEventListener("change", () => {
    canRead = el("can-read-toggle").checked;
  });

  function saveProfile() {
    const name = el("name-input").value.trim() || "שחקן";
    localStorage.setItem("tvn-profile", JSON.stringify({ name, avatar: avatarConfig, canRead }));
    return name;
  }

  function doJoin(roomCode) {
    const name = saveProfile();
    el("join-error").classList.add("hidden");
    socket.emit("join", { name, avatar: avatarConfig, token: myToken, roomCode, canRead });
  }

  function doCreateRoom() {
    const name = saveProfile();
    el("join-error").classList.add("hidden");
    socket.emit("create-room", { name, avatar: avatarConfig, token: myToken, canRead });
  }

  el("play-btn").addEventListener("click", () => doJoin(undefined));
  el("name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doJoin(undefined);
  });

  el("show-join-code-btn").addEventListener("click", () => {
    el("join-code-panel").classList.toggle("hidden");
    if (!el("join-code-panel").classList.contains("hidden")) el("join-code-input").focus();
  });
  el("submit-join-code-btn").addEventListener("click", () => {
    const code = el("join-code-input").value.trim().toUpperCase();
    if (code) doJoin(code);
  });
  el("join-code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") el("submit-join-code-btn").click();
  });
  el("create-room-btn").addEventListener("click", doCreateRoom);

  setScreen("join");

  // תמיד מנסים קודם "rejoin" (עם הטוקן הקבוע + קוד החדר האחרון אם יש) - זה
  // מכסה גם טעינה ראשונה (שנכשלת בעדינות ונשארת במסך הכניסה), גם רענון
  // (F5) באמצע משחק, וגם חיבור מחדש אמיתי אחרי ניתוק - בנתיב אחד אחיד.
  socket.on("connect", () => {
    socket.emit("rejoin", { token: myToken, roomCode: myRoomCode });
  });

  socket.on("joined", (data) => {
    myId = data.id;
    myRoomCode = data.roomCode || null;
    if (myRoomCode) localStorage.setItem("tvn-room", myRoomCode);
    setScreen("main");
  });

  socket.on("rejoin-failed", () => {
    // אין מושב פעיל/בתוך חלון החסד לחדש הזה - נשארים/חוזרים למסך הכניסה הרגיל
  });

  socket.on("join-error", (data) => {
    const errEl = el("join-error");
    errEl.textContent = data.message;
    errEl.classList.remove("hidden");
  });

  socket.on("kicked", () => {
    localStorage.removeItem("tvn-room");
    showToast("הוסרת מהחדר על ידי המנהל/ת");
    setTimeout(() => location.reload(), 1500);
  });

  socket.on("action-error", (data) => showToast(data.message));

  socket.on("close-guess", () => showToast("קרוב מאוד! 🔥"));

  // ---------- חיבור מחדש: ניתוק קצר (רקע/נעילת מסך) לא מוצג, אבל אם זה נמשך
  // יותר משנייה וחצי מציגים באנר ברור שהאפליקציה במצב "לא מחובר" - כדי שלא
  // ייראה כאילו הכל תקין בזמן שהיא בעצם לא מדברת עם השרת. ----------

  const disconnectedOverlay = el("disconnected-overlay");
  const disconnectedText = el("disconnected-text");
  let disconnectedBannerTimer = null;

  function showDisconnectedBanner(text) {
    disconnectedText.textContent = text || "מנסים להתחבר מחדש...";
    disconnectedOverlay.classList.remove("hidden");
  }

  function hideDisconnectedBanner() {
    clearTimeout(disconnectedBannerTimer);
    disconnectedBannerTimer = null;
    disconnectedOverlay.classList.add("hidden");
  }

  socket.on("disconnect", () => {
    clearTimeout(disconnectedBannerTimer);
    disconnectedBannerTimer = setTimeout(() => showDisconnectedBanner(), 1500);
  });

  socket.on("connect", hideDisconnectedBanner);

  socket.io.on("reconnect_attempt", () => {
    if (!disconnectedOverlay.classList.contains("hidden")) {
      disconnectedText.textContent = "מנסים להתחבר מחדש...";
    }
  });

  socket.io.on("reconnect_failed", () => {
    showDisconnectedBanner("לא הצלחנו להתחבר מחדש. בדקו את החיבור לאינטרנט ונסו שוב.");
  });

  el("reconnect-btn").addEventListener("click", () => {
    disconnectedText.textContent = "מתחברים מחדש...";
    if (socket.connected) {
      location.reload();
    } else {
      socket.connect();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (!socket.connected) socket.connect();
      socket.emit("rejoin", { token: myToken, roomCode: myRoomCode });
    }
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      if (!socket.connected) socket.connect();
      socket.emit("rejoin", { token: myToken, roomCode: myRoomCode });
    }
  });

  // ---------- כלי ציור: מברשת/דלי/מחק, צבע ועובי (כפתור + פופאובר) ----------

  let currentTool = "brush";
  function setTool(tool) {
    currentTool = tool;
    canvas.setEraser(tool === "eraser");
    canvas.setFillMode(tool === "fill");
    ["tool-brush", "tool-fill", "tool-eraser"].forEach((id) =>
      el(id).classList.toggle("active", id === `tool-${tool}`)
    );
  }
  el("tool-brush").addEventListener("click", () => setTool("brush"));
  el("tool-fill").addEventListener("click", () => setTool("fill"));
  el("tool-eraser").addEventListener("click", () => setTool("eraser"));

  function closePopovers() {
    el("color-popover").classList.add("hidden");
    el("size-popover").classList.add("hidden");
  }

  // הפופאוברים ממוקמים ב-position:fixed ומחושבים ב-JS (ולא absolute יחסית לכפתור) כדי
  // שלעולם לא ייחתכו על ידי אב עם overflow:auto/hidden (כמו סרגל הכלים בפריסת landscape).
  function positionPopover(popoverEl, triggerEl) {
    const r = triggerEl.getBoundingClientRect();
    popoverEl.style.left = "-9999px";
    popoverEl.style.top = "-9999px";
    popoverEl.style.bottom = "";
    const popW = popoverEl.offsetWidth;
    const popH = popoverEl.offsetHeight;

    const opensUp = r.top - popH - 10 > 0;
    const top = opensUp ? r.top - popH - 8 : Math.min(r.bottom + 8, window.innerHeight - popH - 6);
    let left = r.right - popW; // מיושר לימין הכפתור (מתאים לכיוון RTL)
    left = Math.max(6, Math.min(left, window.innerWidth - popW - 6));

    popoverEl.style.top = Math.max(6, top) + "px";
    popoverEl.style.left = left + "px";
  }

  function togglePopover(id, triggerId) {
    const popoverEl = el(id);
    const isOpen = !popoverEl.classList.contains("hidden");
    closePopovers();
    if (!isOpen) {
      popoverEl.classList.remove("hidden");
      positionPopover(popoverEl, el(triggerId));
    }
  }

  window.addEventListener("resize", closePopovers);

  function buildColorPopover() {
    const container = el("color-popover");
    container.innerHTML = "";
    DRAW_COLORS.forEach((c) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "color-swatch";
      btn.style.background = c;
      btn.addEventListener("click", () => {
        canvas.setColor(c);
        el("color-btn-swatch").style.background = c;
        closePopovers();
      });
      container.appendChild(btn);
    });
  }
  buildColorPopover();
  el("color-btn-swatch").style.background = DRAW_COLORS[0];
  canvas.setColor(DRAW_COLORS[0]);

  el("tool-color").addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover("color-popover", "tool-color");
  });

  function setBrushSize(s) {
    canvas.setSize(s);
    const dotSize = Math.max(10, Math.min(s, 22));
    el("size-btn-dot").style.width = el("size-btn-dot").style.height = dotSize + "px";
    document.querySelectorAll(".size-option").forEach((o) =>
      o.classList.toggle("active", Number(o.dataset.size) === s)
    );
  }
  setBrushSize(6);

  el("tool-size").addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover("size-popover", "tool-size");
  });
  document.querySelectorAll(".size-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      setBrushSize(Number(btn.dataset.size));
      closePopovers();
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".popover-wrap")) closePopovers();
  });

  el("tool-undo").addEventListener("click", () => socket.emit("undo-canvas"));
  el("tool-clear").addEventListener("click", () => {
    if (confirm("לנקות את כל הציור?")) socket.emit("clear-canvas");
  });

  socket.on("draw-point", (data) => canvas.applyRemotePoint(data));
  socket.on("canvas-clear", () => canvas.clear());
  socket.on("canvas-redraw", (data) => canvas.setStrokes(data.strokes));

  // ---------- הגדרות חדר ----------

  const SETTING_FIELDS = ["rounds", "drawTime", "wordCount", "hints", "maxPlayers"];

  SETTING_FIELDS.forEach((key) => {
    const input = el("set-" + key);
    input.addEventListener("input", () => {
      formTouched = true;
      el("val-" + key).textContent = input.value;
    });
  });
  el("set-customWords").addEventListener("input", () => (formTouched = true));
  el("set-useCustomOnly").addEventListener("change", () => (formTouched = true));

  el("save-settings-btn").addEventListener("click", () => {
    const patch = {};
    SETTING_FIELDS.forEach((key) => (patch[key] = Number(el("set-" + key).value)));
    patch.customWords = el("set-customWords").value
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
    patch.useCustomWordsOnly = el("set-useCustomOnly").checked;
    socket.emit("update-settings", patch);
    formTouched = false;
  });

  el("start-btn").addEventListener("click", () => socket.emit("start-game"));
  el("play-again-btn").addEventListener("click", () => socket.emit("back-to-lobby"));

  if (!navigator.share) el("share-code-btn").classList.add("hidden");
  el("share-code-btn").addEventListener("click", async () => {
    const code = el("room-code-value").textContent;
    if (!code || !navigator.share) return;
    try {
      await navigator.share({ title: "בואו לשחק!", text: `הצטרפ/י אליי למשחק ציור ונחש עם הקוד: ${code}`, url: location.href });
    } catch { /* המשתמש/ת ביטל/ה את השיתוף - לא קורה כלום */ }
  });
  el("copy-code-btn").addEventListener("click", async () => {
    const code = el("room-code-value").textContent;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast("הקוד הועתק!");
    } catch {
      showToast("ההעתקה נכשלה");
    }
  });

  function syncSettingsForm(settings) {
    SETTING_FIELDS.forEach((key) => {
      el("set-" + key).value = settings[key];
      el("val-" + key).textContent = settings[key];
    });
    el("set-customWords").value = settings.customWords.join(", ");
    el("set-useCustomOnly").checked = settings.useCustomWordsOnly;
  }

  // ---------- צ'אט ----------

  el("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = el("chat-input");
    const text = input.value.trim();
    if (!text) return;
    socket.emit("chat", { text });
    input.value = "";
  });

  socket.on("chat-message", (msg) => appendChatMessage(msg));

  function appendChatMessage(msg) {
    const box = el("chat-messages");
    const div = document.createElement("div");
    div.className = "chat-msg" + (msg.system ? " system" : "") + (msg.correct ? " correct" : "");
    if (msg.name && !msg.system) {
      const who = document.createElement("span");
      who.className = "who";
      who.style.color = msg.color || "inherit";
      who.textContent = msg.name + ": ";
      div.appendChild(who);
      div.appendChild(document.createTextNode(msg.text));
    } else {
      div.textContent = msg.text;
    }
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  // ---------- תגובות אימוג'י ----------

  document.querySelectorAll(".reaction-btn").forEach((btn) => {
    btn.addEventListener("click", () => socket.emit("reaction", { emoji: btn.dataset.emoji }));
  });

  socket.on("reaction", ({ emoji }) => {
    const layer = el("reactions-layer");
    const span = document.createElement("span");
    span.className = "floating-emoji";
    span.textContent = emoji;
    span.style.right = Math.random() * 80 + 10 + "%";
    layer.appendChild(span);
    setTimeout(() => span.remove(), 2300);
  });

  // ---------- מילים לבחירה (לצייר בלבד) ----------

  socket.on("word-choices", (data) => {
    wordChoicesPayload = data;
    render(lastState);
  });

  // ---------- קבלת מצב מהשרת ----------

  socket.on("state", (state) => {
    lastState = state;
    render(state);
  });

  function render(state) {
    if (!state) return;

    const inGame = ["choosing", "drawing", "reveal"].includes(state.phase);
    document.body.classList.toggle("in-game", inGame);
    updateOrientationLock(inGame);

    renderPlayers(state);
    renderTopBar(state);

    el("lobby-panel").classList.toggle("hidden", state.phase !== "lobby");
    el("game-panel").classList.toggle("hidden", !inGame);
    el("end-panel").classList.toggle("hidden", state.phase !== "ended");

    if (state.phase === "lobby") renderLobby(state);
    if (inGame) renderGame(state);
    if (state.phase === "ended") renderEnd(state);

    if (!chatInitialized) {
      const box = el("chat-messages");
      box.innerHTML = "";
      (state.chat || []).forEach(appendChatMessage);
      chatInitialized = true;
    }
  }

  function renderPlayers(state) {
    el("player-count").textContent = `(${state.players.length})`;
    const list = el("player-list");
    list.innerHTML = "";
    state.players.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = "player-row" +
        (p.id === myId ? " me" : "") +
        (p.isDrawing ? " drawing" : "") +
        (p.guessedCorrect ? " guessed" : "") +
        (i === 0 && p.score > 0 ? " top-rank" : "");

      const avatarSlot = document.createElement("span");
      avatarSlot.className = "player-avatar";
      Avatar.renderAvatar(avatarSlot, p.avatar, 26);

      const name = document.createElement("span");
      name.className = "player-name";
      name.textContent = p.name;

      const score = document.createElement("span");
      score.className = "player-score";
      score.textContent = p.score;

      li.appendChild(avatarSlot);
      li.appendChild(name);
      if (p.isHost) {
        const badge = document.createElement("span");
        badge.className = "player-badge";
        badge.title = "מנהל/ת החדר";
        badge.textContent = "👑";
        li.appendChild(badge);
      }
      if (p.isDrawing) {
        const badge = document.createElement("span");
        badge.className = "player-badge";
        badge.title = "מצייר/ת עכשיו";
        badge.textContent = "✏️";
        li.appendChild(badge);
      }
      if (p.guessedCorrect) {
        const badge = document.createElement("span");
        badge.className = "player-badge";
        badge.textContent = "✅";
        li.appendChild(badge);
      }
      li.appendChild(score);

      if (state.you && state.you.isHost && p.id !== myId) {
        const kickBtn = document.createElement("button");
        kickBtn.className = "kick-btn";
        kickBtn.textContent = "✕";
        kickBtn.title = "הסר שחקן";
        kickBtn.addEventListener("click", () => {
          if (confirm(`להסיר את ${p.name} מהחדר?`)) socket.emit("kick", { playerId: p.id });
        });
        li.appendChild(kickBtn);
      }

      list.appendChild(li);
    });
  }

  function renderTopBar(state) {
    const roundInfo = el("round-info");
    const timer = el("timer");
    const inGame = ["choosing", "drawing", "reveal"].includes(state.phase);
    roundInfo.classList.toggle("hidden", !inGame);
    timer.classList.toggle("hidden", !inGame);
    if (inGame) roundInfo.textContent = `סבב ${state.round} מתוך ${state.totalRounds}`;

    clearInterval(window.__tvnTimerInt);
    const drawer = state.players.find((p) => p.id === state.currentDrawerId);
    const drawerPaused = !!(drawer && drawer.connected === false) && (state.phase === "choosing" || state.phase === "drawing");
    timer.classList.toggle("paused", drawerPaused);

    const endsAt = state.phase === "choosing" ? state.chooseEndsAt : state.phase === "drawing" ? state.turnEndsAt : null;
    if (endsAt && !drawerPaused) {
      const tick = () => {
        const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        timer.textContent = left;
        timer.classList.toggle("low", left <= 10);
      };
      tick();
      window.__tvnTimerInt = setInterval(tick, 250);
    } else if (drawerPaused) {
      timer.textContent = "⏸";
      timer.classList.remove("low");
    } else {
      timer.textContent = "";
    }
  }

  function renderLobby(state) {
    const iAmHost = state.you && state.you.isHost;
    el("lobby-role-hint").textContent = iAmHost
      ? "את/ה מנהל/ת החדר - קבע/י הגדרות ולחצ/י התחילו כשמוכנים."
      : "ממתינים למנהל/ת החדר שיתחיל את המשחק. ההגדרות נקבעות על ידו/ה.";

    const isPrivateRoom = !!state.roomCode && state.roomCode !== "MAIN";
    el("room-code-chip").classList.toggle("hidden", !isPrivateRoom);
    if (isPrivateRoom) el("room-code-value").textContent = state.roomCode;

    SETTING_FIELDS.forEach((key) => (el("set-" + key).disabled = !iAmHost));
    el("set-customWords").disabled = !iAmHost;
    el("set-useCustomOnly").disabled = !iAmHost;
    el("save-settings-btn").classList.toggle("hidden", !iAmHost);
    el("start-btn").classList.toggle("hidden", !iAmHost);

    const enoughPlayers = state.players.length >= 2;
    el("start-btn").disabled = !enoughPlayers;
    el("need-players-hint").textContent = enoughPlayers ? "" : "צריך לפחות 2 שחקנים כדי להתחיל.";

    const phaseChanged = lastPhaseForForm !== "lobby";
    if (!iAmHost || phaseChanged || !formTouched) {
      syncSettingsForm(state.settings);
    }
    lastPhaseForForm = "lobby";
  }

  function renderGame(state) {
    lastPhaseForForm = state.phase;

    // בד ציור
    canvas.setEnabled(state.isMeDrawing && state.phase === "drawing");
    const toolbarVisible = state.isMeDrawing && state.phase === "drawing";
    el("toolbar").classList.toggle("hidden", !toolbarVisible);
    if (!toolbarVisible) closePopovers();

    const turnKey = state.currentDrawerId ? `${state.round}-${state.currentDrawerId}` : null;
    if (turnKey && turnKey !== lastTurnKey) {
      canvas.setStrokes(state.strokes || []);
      lastTurnKey = turnKey;
      wordChoicesPayload = null;
    }

    // תצוגת מילה - לצייר/ת בזמן ציור עם מצב "לא יודע/ת לקרוא" פעיל: תמונה
    // במקום טקסט, ורק לצייר/ת (לעולם לא למנחשים, גם לא למי שכבר ניחש/ה נכון).
    const wordDisplay = el("word-display");
    const drawerImgPath = (state.phase === "drawing" && state.isMeDrawing && !canRead && state.maskedWord)
      ? imageForWord(state.maskedWord)
      : undefined;
    wordDisplay.classList.toggle("has-image", !!drawerImgPath);
    if (drawerImgPath) {
      wordDisplay.innerHTML = "";
      const img = document.createElement("img");
      img.alt = state.maskedWord;
      img.className = "word-display-img";
      img.title = "לחצ/י כדי לשמוע את המילה";
      applyAdaptiveBackground(img);
      img.addEventListener("click", () => speakWord(state.maskedWord));
      img.src = drawerImgPath;
      wordDisplay.appendChild(img);
    } else if (state.phase === "drawing" && state.maskedWord) {
      wordDisplay.textContent = state.maskedWord;
    } else if (state.phase === "reveal" && state.maskedWord) {
      wordDisplay.textContent = state.maskedWord;
    } else {
      wordDisplay.textContent = "";
    }

    // אוברליי בחירת מילה
    const choosingOverlay = el("choosing-overlay");
    choosingOverlay.classList.toggle("hidden", state.phase !== "choosing");
    if (state.phase === "choosing") {
      const drawer = state.players.find((p) => p.id === state.currentDrawerId);
      const title = el("choosing-title");
      const buttonsBox = el("word-choice-buttons");
      buttonsBox.innerHTML = "";
      if (state.isMeDrawing && wordChoicesPayload) {
        title.textContent = "בחר/י מילה לציור:";
        wordChoicesPayload.choices.forEach((w) => {
          const row = document.createElement("div");
          row.className = "word-choice-row";

          const btn = document.createElement("button");
          btn.className = "word-choice-btn";
          btn.addEventListener("click", () => socket.emit("choose-word", { word: w }));

          const imgPath = !canRead ? imageForWord(w) : undefined;
          if (imgPath) {
            btn.classList.add("has-image");
            const img = document.createElement("img");
            img.src = imgPath;
            img.alt = w;
            img.className = "word-choice-img";
            btn.appendChild(img);
          } else {
            btn.textContent = w;
          }
          row.appendChild(btn);

          if (window.speechSynthesis) {
            const speakBtn = document.createElement("button");
            speakBtn.type = "button";
            speakBtn.className = "tool-btn speak-btn";
            speakBtn.title = "השמע את המילה";
            speakBtn.setAttribute("aria-label", "השמע את המילה " + w);
            speakBtn.textContent = "🔊";
            speakBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              speakWord(w);
            });
            row.appendChild(speakBtn);
          }

          buttonsBox.appendChild(row);
        });
      } else {
        title.textContent = `${drawer ? drawer.name : "מישהו"} בוחר/ת מילה...`;
      }
      const chooseTimerEl = el("choose-timer");
      const tick = () => {
        if (!state.chooseEndsAt) return;
        const left = Math.max(0, Math.ceil((state.chooseEndsAt - Date.now()) / 1000));
        chooseTimerEl.textContent = left + " שניות";
      };
      tick();
    }

    // אוברליי חשיפת מילה
    const revealOverlay = el("reveal-overlay");
    revealOverlay.classList.toggle("hidden", state.phase !== "reveal");
    if (state.phase === "reveal") {
      el("reveal-text").textContent = `המילה הייתה: ${state.maskedWord || ""}`;
      renderRevealScores(state);
    }
  }

  function renderRevealScores(state) {
    const list = el("reveal-scores");
    list.innerHTML = "";
    const players = state.players.slice().sort((a, b) => (b.lastTurnPoints || 0) - (a.lastTurnPoints || 0));
    players.forEach((p) => {
      const row = document.createElement("li");
      row.className = "reveal-score-row" + (p.id === myId ? " me" : "");

      const avatarSlot = document.createElement("span");
      avatarSlot.className = "player-avatar";
      Avatar.renderAvatar(avatarSlot, p.avatar, 24);

      const name = document.createElement("span");
      name.className = "reveal-score-name";
      name.textContent = p.name + (p.isDrawing ? " 🖌️" : "");

      const points = document.createElement("span");
      const earned = p.lastTurnPoints || 0;
      points.className = "reveal-score-points" + (earned > 0 ? " earned" : "");
      points.textContent = earned > 0 ? `+${earned}` : "+0";

      row.appendChild(avatarSlot);
      row.appendChild(name);
      row.appendChild(points);
      list.appendChild(row);
    });
  }

  function renderEnd(state) {
    const podium = el("podium");
    podium.innerHTML = "";
    const medals = ["🥇", "🥈", "🥉"];
    state.players.forEach((p, i) => {
      const li = document.createElement("li");
      const rank = document.createElement("span");
      rank.textContent = `${medals[i] || i + 1 + "."} ${p.name}`;
      const score = document.createElement("span");
      score.textContent = p.score;
      li.appendChild(rank);
      li.appendChild(score);
      podium.appendChild(li);
    });
    const iAmHost = state.you && state.you.isHost;
    el("play-again-btn").classList.toggle("hidden", !iAmHost);
    el("end-hint").textContent = iAmHost ? "" : "ממתינים שהמנהל/ת ילחץ/תלחץ על שחקו שוב...";
  }

  // ---------- סיבוב מסך (best-effort) ----------

  let orientationLocked = false;
  function updateOrientationLock(inGame) {
    if (inGame && !orientationLocked) {
      orientationLocked = true;
      try {
        screen.orientation && screen.orientation.lock && screen.orientation.lock("landscape").catch(() => {});
      } catch { /* לא נתמך - לא קורה כלום */ }
    } else if (!inGame && orientationLocked) {
      orientationLocked = false;
      try {
        screen.orientation && screen.orientation.unlock && screen.orientation.unlock();
      } catch { /* לא נתמך - לא קורה כלום */ }
    }
  }

  el("rotate-hint-close").addEventListener("click", () => el("rotate-hint").classList.add("dismissed"));

  // ---------- נגישות: הקראת מילים + ניחוש בקול (Web Speech API, חינמי ומובנה בדפדפן) ----------

  if (window.speechSynthesis) window.speechSynthesis.getVoices(); // "מחממים" - ב-Chrome הרשימה נטענת א-סינכרונית

  function speakWord(word) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // לא לערום הקראות אם לוחצים כמה פעמים ברצף
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = "he-IL";
    const voices = window.speechSynthesis.getVoices();
    const heVoice = voices.find((v) => v.lang === "he-IL") || voices.find((v) => v.lang && v.lang.startsWith("he"));
    if (heVoice) utter.voice = heVoice;
    window.speechSynthesis.speak(utter);
  }

  function initVoiceInput() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return; // לא נתמך (לדוגמה Safari/iOS) - כפתור המיקרופון נשאר מוסתר
    const micBtn = el("mic-btn");
    micBtn.classList.remove("hidden");

    const recognition = new SR();
    recognition.lang = "he-IL";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    let listening = false;

    recognition.addEventListener("result", (e) => {
      el("chat-input").value = e.results[0][0].transcript;
      el("chat-form").requestSubmit(); // עובר דרך אותו handler של שליחה בהקלדה - בלי שינוי בלוגיקת הניחוש
    });
    recognition.addEventListener("end", () => {
      listening = false;
      micBtn.classList.remove("active");
    });
    recognition.addEventListener("error", () => {
      listening = false;
      micBtn.classList.remove("active");
    });

    micBtn.addEventListener("click", () => {
      if (listening) {
        recognition.stop();
        return;
      }
      listening = true;
      micBtn.classList.add("active");
      try {
        recognition.start();
      } catch {
        listening = false;
        micBtn.classList.remove("active");
      }
    });
  }
  initVoiceInput();

  // ---------- כלי עזר ----------

  function showToast(msg) {
    const toast = el("toast");
    toast.textContent = msg;
    toast.classList.remove("hidden");
    clearTimeout(window.__tvnToastTimeout);
    window.__tvnToastTimeout = setTimeout(() => toast.classList.add("hidden"), 3000);
  }

  function safeParse(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  // ---------- PWA ----------

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/service-worker.js").catch(() => {});
    });
  }

  let deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    el("install-btn").classList.remove("hidden");
  });
  el("install-btn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    el("install-btn").classList.add("hidden");
  });
  window.addEventListener("appinstalled", () => el("install-btn").classList.add("hidden"));
})();
