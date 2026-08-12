// לוגיקת המשחק - חדר בודד. יכול להיות חדר-על "כללי" משותף לכולם (persistent,
// הגדרותיו נשמרות דרך db.js) או חדר פרטי ואפמרי שנוצר לפי דרישה ומתפרק
// כשהוא מתרוקן (ראה server/roomManager.js). מי שנכנס ראשון לחדר ריק הופך
// למנהל (host).

const { ALL_WORDS } = require("./words");
const db = require("./db");

const DEFAULT_SETTINGS = {
  rounds: 3,
  drawTime: 80,
  wordCount: 3,
  hints: 2,
  maxPlayers: 12,
  customWords: [],
  useCustomWordsOnly: false,
};

const CHOOSE_TIME = 15; // שניות לבחירת מילה
const REVEAL_TIME = 6; // שניות הפסקה בין תורות
const MIN_PLAYERS_TO_START = 2;
const GRACE_PERIOD_MS = 10000; // חלון חסד לניתוק (רקע/נעילת מסך/רשת רגעית) לפני הסרה סופית

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalize(str) {
  return String(str || "")
    .normalize("NFC")
    .replace(/[֑-ׇ]/g, "") // ניקוד עברי
    .replace(/["'׳״]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function maskWord(word, revealedIdx) {
  let idx = 0;
  const parts = word.split(" ").map((wordPart) => {
    const rendered = wordPart
      .split("")
      .map((ch) => {
        const shown = revealedIdx.has(idx);
        idx++;
        return shown ? ch : "_";
      })
      .join(" ");
    idx++; // סופרים גם את הרווח המפריד עצמו, כדי ש-revealedIdx יישאר מבוסס על אינדקס מוחלט במחרוזת המקורית
    return rendered;
  });
  return parts.join("   ");
}

class Room {
  constructor(io, { code = "MAIN", persistent = true } = {}) {
    this.io = io;
    this.code = code;
    this.persistent = persistent;
    this.onEmpty = null; // hook שקורא לו roomManager כדי לפנות חדר פרטי ריק
    this.players = new Map(); // socketId -> player
    this.disconnectTimers = new Map(); // socketId -> Timeout (חלון חסד לניתוק)
    this.settings = { ...DEFAULT_SETTINGS };
    this.joinCounter = 0;
    this.chatHistory = [];
    this.resetGameState();
  }

  async init() {
    if (!this.persistent) return; // חדרים פרטיים לא נשמרים בין הפעלות שרת
    const saved = await db.loadSettings();
    if (saved) {
      this.settings = { ...DEFAULT_SETTINGS, ...saved };
    }
  }

  resetGameState() {
    this.phase = "lobby"; // lobby | choosing | drawing | reveal | ended
    this.round = 0;
    this.drawOrder = [];
    this.turnIndex = -1;
    this.currentDrawerId = null;
    this.currentWord = null;
    this.wordChoices = [];
    this.revealedIdx = new Set();
    this.guessedThisTurn = new Set();
    this.turnEndsAt = null;
    this.chooseEndsAt = null;
    this.strokes = [];
    this.strokeBuffer = null;
    this.turnPoints = new Map();
    this.hintSchedule = [];
    this.choosePausedRemainingMs = null;
    this.drawPausedRemainingMs = null;
    this.pausedHints = null;
    this.clearTimers();
  }

  clearTimers() {
    clearTimeout(this._chooseTimer);
    clearTimeout(this._drawTimer);
    clearTimeout(this._revealTimer);
    (this._hintTimers || []).forEach((t) => clearTimeout(t));
    this._hintTimers = [];
  }

  // ---------- שחקנים ----------

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  addPlayer(socketId, name, avatar, token) {
    const isFirst = this.players.size === 0;
    if (isFirst) {
      // חדר ריק לגמרי -> מאפסים משחק פעיל קודם, ההגדרות נשארות.
      this.resetGameState();
    }
    const player = {
      id: socketId,
      token: token || null,
      name: name.slice(0, 18),
      color: avatar.color,
      score: 0,
      connected: true,
      disconnectedAt: null,
      isHost: isFirst,
      joinOrder: this.joinCounter++,
      guessedCorrect: false,
      joinedMidGame: this.phase !== "lobby" && this.phase !== "ended",
      avatar: { eyes: avatar.eyes, mouth: avatar.mouth },
    };
    this.players.set(socketId, player);
    return player;
  }

  // מתבצע ברגע שסוקט מתנתק. לא מוחקים את השחקן/ית מיד - מסמנים "מנותק/ת
  // זמנית" ונותנים חלון חסד (GRACE_PERIOD_MS) לחזור, כדי שנעילת מסך/מעבר
  // לרקע/רשת רגעית לא יוציאו אף אחד מהמשחק. אם המנותק/ת הוא/היא הצייר/ת
  // הנוכחי/ת, גם התור עצמו מוקפא (לא רץ נגד מישהו שלא שם).
  handleDisconnect(socketId) {
    const player = this.players.get(socketId);
    if (!player || !player.connected) return;
    player.connected = false;
    player.disconnectedAt = Date.now();

    if (this.currentDrawerId === socketId && (this.phase === "drawing" || this.phase === "choosing")) {
      this.pauseTurnForDrawerDisconnect();
    } else if (this.phase === "drawing") {
      this.checkAllGuessed();
    }

    clearTimeout(this.disconnectTimers.get(socketId));
    this.disconnectTimers.set(
      socketId,
      setTimeout(() => this.finalizeDisconnect(socketId), GRACE_PERIOD_MS)
    );
  }

  // מריץ את מה שפעם קרה מיד עם ניתוק (removePlayer הישן) - אבל רק אחרי
  // שחלון החסד נגמר בלי שהשחקן/ית חזר/ה.
  finalizeDisconnect(socketId) {
    this.disconnectTimers.delete(socketId);
    const player = this.players.get(socketId);
    if (!player || player.connected) return; // כבר חזר/ה בינתיים - לא עושים כלום
    const wasHost = player.isHost;
    const wasDrawer = this.currentDrawerId === socketId;
    this.players.delete(socketId);

    if (this.players.size === 0) {
      // כולם עזבו סופית - שומרים הגדרות, מאפסים הכל מלבד ה-Map הריק ממילא.
      this.resetGameState();
      this.players.clear();
      if (this.onEmpty) this.onEmpty();
      return;
    }

    if (wasHost) {
      const next = [...this.players.values()].sort((a, b) => a.joinOrder - b.joinOrder)[0];
      if (next) next.isHost = true;
    }

    if ((this.phase === "drawing" || this.phase === "choosing") && wasDrawer) {
      this.endTurn(true);
    } else if (this.phase === "drawing") {
      this.checkAllGuessed();
    }

    if (this.connectedPlayers().length < MIN_PLAYERS_TO_START && this.phase !== "lobby" && this.phase !== "ended") {
      this.endGame();
    }
    this.broadcastState();
  }

  // חיבור מחדש: מוצאים שחקן/ית "מנותק/ת זמנית" לפי טוקן קבוע (נשמר ב-
  // localStorage אצל הקליינט) ומעבירים אותו/ה לסוקט החדש - בלי לאבד ניקוד,
  // מקום בחדר, או תפקיד מנהל.
  tryRejoin(socket, token) {
    if (!token) return { ok: false, reason: "no-token" };
    const entry = [...this.players.entries()].find(([, p]) => p.token === token);
    if (!entry) return { ok: false, reason: "not-found" };
    const [oldId, player] = entry;
    if (oldId === socket.id) return { ok: true };
    if (player.connected) return { ok: false, reason: "token-in-use" };

    clearTimeout(this.disconnectTimers.get(oldId));
    this.disconnectTimers.delete(oldId);
    this.rekeyPlayer(oldId, socket.id);
    player.connected = true;
    player.disconnectedAt = null;

    if (this.currentDrawerId === socket.id) this.resumeTurnAfterDrawerReconnect();
    return { ok: true };
  }

  // מעביר את כל ההפניות למזהה הסוקט הישן (מפתח ה-Map, currentDrawerId,
  // drawOrder, guessedThisTurn, turnPoints) למזהה החדש שקיבל אותו סוקט אחרי
  // חיבור מחדש.
  rekeyPlayer(oldId, newId) {
    const player = this.players.get(oldId);
    player.id = newId;
    this.players.delete(oldId);
    this.players.set(newId, player);
    if (this.currentDrawerId === oldId) this.currentDrawerId = newId;
    this.drawOrder = this.drawOrder.map((id) => (id === oldId ? newId : id));
    if (this.guessedThisTurn.has(oldId)) {
      this.guessedThisTurn.delete(oldId);
      this.guessedThisTurn.add(newId);
    }
    if (this.turnPoints.has(oldId)) {
      this.turnPoints.set(newId, this.turnPoints.get(oldId));
      this.turnPoints.delete(oldId);
    }
  }

  findPlayerByToken(token) {
    if (!token) return null;
    for (const entry of this.players.entries()) {
      if (entry[1].token === token) return entry;
    }
    return null;
  }

  // מנסה "להשתלט" על מושב קיים לפי הטוקן הקבוע - גם אם הוא עדיין מסומן
  // "מחובר" (סוקט קודם שלא זוהה כמנותק עדיין בצד השרת, למשל כי האפליקציה
  // נסגרה לגמרי בטלפון והחיבור עוד לא הבשיל ל-timeout) וגם אם הוא בתוך חלון
  // החסד. זה מונע לחלוטין את המצב של "אותו שחקן/ית מופיע/ה פעמיים" - כל
  // ניסיון join עם טוקן קיים ממזג לתוך המושב הישן במקום ליצור שחקן/ית חדש/ה.
  // מחזיר את השחקן/ית המעודכן/ת, או null אם אין התאמה (הקורא/ת ימשיך ב-addPlayer רגיל).
  takeOverByToken(io, socketId, name, avatar, token) {
    const found = this.findPlayerByToken(token);
    if (!found) return null;
    const [oldId, player] = found;
    if (oldId !== socketId) {
      const oldSocket = io.sockets.sockets.get(oldId);
      if (oldSocket) oldSocket.disconnect(true);
      clearTimeout(this.disconnectTimers.get(oldId));
      this.disconnectTimers.delete(oldId);
      this.rekeyPlayer(oldId, socketId);
    } else {
      clearTimeout(this.disconnectTimers.get(socketId));
      this.disconnectTimers.delete(socketId);
    }
    player.connected = true;
    player.disconnectedAt = null;
    player.name = name;
    player.color = avatar.color;
    player.avatar = { eyes: avatar.eyes, mouth: avatar.mouth };
    if (this.currentDrawerId === socketId) this.resumeTurnAfterDrawerReconnect();
    return player;
  }

  publicPlayer(p) {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score,
      isHost: p.isHost,
      connected: p.connected,
      isDrawing: p.id === this.currentDrawerId,
      guessedCorrect: p.guessedCorrect,
      lastTurnPoints: this.turnPoints.get(p.id) || 0,
      avatar: { color: p.color, eyes: p.avatar.eyes, mouth: p.avatar.mouth },
    };
  }

  // ---------- הגדרות ----------

  async updateSettings(socketId, patch) {
    const player = this.players.get(socketId);
    if (!player || !player.isHost) return { ok: false, error: "רק המנהל יכול לשנות הגדרות" };
    if (this.phase !== "lobby" && this.phase !== "ended") {
      return { ok: false, error: "אי אפשר לשנות הגדרות באמצע משחק" };
    }
    const s = { ...this.settings };
    if (patch.rounds !== undefined) s.rounds = clamp(patch.rounds, 1, 10);
    if (patch.drawTime !== undefined) s.drawTime = clamp(patch.drawTime, 30, 240);
    if (patch.wordCount !== undefined) s.wordCount = clamp(patch.wordCount, 1, 4);
    if (patch.hints !== undefined) s.hints = clamp(patch.hints, 0, 6);
    if (patch.maxPlayers !== undefined) s.maxPlayers = clamp(patch.maxPlayers, 2, 24);
    if (patch.customWords !== undefined && Array.isArray(patch.customWords)) {
      s.customWords = patch.customWords
        .map((w) => String(w).trim())
        .filter((w) => w.length > 0 && w.length <= 30)
        .slice(0, 300);
    }
    if (patch.useCustomWordsOnly !== undefined) {
      s.useCustomWordsOnly = Boolean(patch.useCustomWordsOnly) && s.customWords.length > 0;
    }
    this.settings = s;
    if (this.persistent) await db.saveSettings(s);
    return { ok: true };
  }

  // ---------- זרימת משחק ----------

  wordPool() {
    const { customWords, useCustomWordsOnly } = this.settings;
    if (useCustomWordsOnly && customWords.length > 0) return customWords;
    return customWords.length > 0 ? ALL_WORDS.concat(customWords) : ALL_WORDS;
  }

  pickWordChoices() {
    const pool = shuffle(this.wordPool());
    const count = Math.min(this.settings.wordCount, pool.length) || 1;
    return pool.slice(0, count);
  }

  startGame(socketId) {
    const player = this.players.get(socketId);
    if (!player || !player.isHost) return { ok: false, error: "רק המנהל יכול להתחיל משחק" };
    if (this.connectedPlayers().length < MIN_PLAYERS_TO_START) {
      return { ok: false, error: "צריך לפחות שני שחקנים כדי להתחיל" };
    }
    this.round = 0;
    this.turnIndex = -1;
    this.players.forEach((p) => (p.score = 0));
    this.startNextRoundIfNeeded();
    this.advanceTurn();
    return { ok: true };
  }

  startNextRoundIfNeeded() {
    if (this.turnIndex === -1 || this.turnIndex >= this.drawOrder.length) {
      this.round++;
      this.turnIndex = 0;
      this.drawOrder = shuffle(this.connectedPlayers().map((p) => p.id));
      this.players.forEach((p) => (p.joinedMidGame = false));
    }
  }

  advanceTurn() {
    this.clearTimers();
    this.strokes = [];
    this.strokeBuffer = null;

    if (this.round > this.settings.rounds) {
      this.endGame();
      return;
    }

    // מדלגים על שחקנים שהתנתקו
    while (
      this.turnIndex < this.drawOrder.length &&
      !this.players.get(this.drawOrder[this.turnIndex])?.connected
    ) {
      this.turnIndex++;
    }

    if (this.turnIndex >= this.drawOrder.length) {
      this.startNextRoundIfNeeded();
      if (this.round > this.settings.rounds) {
        this.endGame();
        return;
      }
    }

    const drawerId = this.drawOrder[this.turnIndex];
    if (!drawerId || !this.players.get(drawerId)?.connected) {
      // אין יותר ציירים זמינים
      this.endGame();
      return;
    }

    this.currentDrawerId = drawerId;
    this.currentWord = null;
    this.wordChoices = this.pickWordChoices();
    this.revealedIdx = new Set();
    this.guessedThisTurn = new Set();
    this.turnPoints = new Map();
    this.players.forEach((p) => (p.guessedCorrect = false));
    this.phase = "choosing";
    this.chooseEndsAt = Date.now() + CHOOSE_TIME * 1000;

    this.broadcastState();
    this.emitToPlayer(drawerId, "word-choices", { choices: this.wordChoices, endsAt: this.chooseEndsAt });

    this._chooseTimer = setTimeout(() => {
      if (this.phase === "choosing") {
        this.chooseWord(drawerId, this.wordChoices[0]);
      }
    }, CHOOSE_TIME * 1000 + 500);
  }

  chooseWord(socketId, word) {
    if (this.phase !== "choosing" || socketId !== this.currentDrawerId) return;
    if (!this.wordChoices.includes(word)) word = this.wordChoices[0];
    clearTimeout(this._chooseTimer);
    this.currentWord = word;
    this.phase = "drawing";
    this.turnEndsAt = Date.now() + this.settings.drawTime * 1000;

    this.scheduleHints();
    this._drawTimer = setTimeout(() => this.endTurn(false), this.settings.drawTime * 1000);
    this.broadcastState();
    this.systemMessage(`${this.players.get(socketId)?.name || "מישהו"} מצייר/ת עכשיו!`);
  }

  scheduleHints() {
    const word = this.currentWord;
    const letterIdx = word.split("").map((c, i) => (c !== " " ? i : -1)).filter((i) => i >= 0);
    const maxHints = Math.min(this.settings.hints, Math.max(letterIdx.length - 1, 0));
    this.hintSchedule = [];
    if (maxHints <= 0) return;
    const order = shuffle(letterIdx).slice(0, maxHints);
    const interval = Math.floor((this.settings.drawTime * 1000) / (maxHints + 1));
    order.forEach((idx, i) => {
      const delay = interval * (i + 1);
      this.hintSchedule.push({ idx, fireAt: Date.now() + delay });
      const t = setTimeout(() => {
        if (this.phase !== "drawing") return;
        this.revealedIdx.add(idx);
        this.broadcastState();
      }, delay);
      this._hintTimers.push(t);
    });
  }

  // מקפיא את שעון התור (בחירה/ציור, כולל רמזים ממתינים) כשהצייר/ת הנוכחי/ת
  // מתנתק/ת - כדי שהתור לא ירוץ/יסתיים נגד מישהו שלא נמצא/ת כרגע.
  pauseTurnForDrawerDisconnect() {
    if (this.phase === "choosing") {
      clearTimeout(this._chooseTimer);
      this.choosePausedRemainingMs = Math.max(0, this.chooseEndsAt - Date.now());
    } else if (this.phase === "drawing") {
      clearTimeout(this._drawTimer);
      this.drawPausedRemainingMs = Math.max(0, this.turnEndsAt - Date.now());
      this._hintTimers.forEach((t) => clearTimeout(t));
      this._hintTimers = [];
      this.pausedHints = this.hintSchedule
        .filter((h) => !this.revealedIdx.has(h.idx))
        .map((h) => ({ idx: h.idx, remainingMs: Math.max(0, h.fireAt - Date.now()) }));
    }
  }

  // ממשיך את התור המוקפא מהנקודה שבה הוא נעצר, ברגע שהצייר/ת חוזר/ת.
  resumeTurnAfterDrawerReconnect() {
    if (this.phase === "choosing" && this.choosePausedRemainingMs != null) {
      const remaining = this.choosePausedRemainingMs;
      this.choosePausedRemainingMs = null;
      this.chooseEndsAt = Date.now() + remaining;
      this._chooseTimer = setTimeout(() => {
        if (this.phase === "choosing") this.chooseWord(this.currentDrawerId, this.wordChoices[0]);
      }, remaining + 500);
      this.emitToPlayer(this.currentDrawerId, "word-choices", { choices: this.wordChoices, endsAt: this.chooseEndsAt });
    } else if (this.phase === "drawing" && this.drawPausedRemainingMs != null) {
      const remaining = this.drawPausedRemainingMs;
      this.drawPausedRemainingMs = null;
      this.turnEndsAt = Date.now() + remaining;
      this._drawTimer = setTimeout(() => this.endTurn(false), remaining);
      (this.pausedHints || []).forEach((h) => {
        const t = setTimeout(() => {
          if (this.phase === "drawing") {
            this.revealedIdx.add(h.idx);
            this.broadcastState();
          }
        }, h.remainingMs);
        this._hintTimers.push(t);
      });
      this.pausedHints = null;
    }
  }

  handleChat(socketId, rawText) {
    const player = this.players.get(socketId);
    if (!player) return;
    const text = String(rawText || "").slice(0, 200).trim();
    if (!text) return;

    const isDrawer = socketId === this.currentDrawerId;
    const canGuess = this.phase === "drawing" && !isDrawer && !player.guessedCorrect;

    if (canGuess) {
      const guess = normalize(text);
      const answer = normalize(this.currentWord);
      if (guess === answer) {
        this.registerCorrectGuess(player);
        return;
      }
      if (
        answer.length >= 3 &&
        Math.abs(guess.length - answer.length) <= 2 &&
        levenshtein(guess, answer) === 1
      ) {
        this.emitToPlayer(socketId, "close-guess", {});
      }
    }

    this.systemMessage(text, player);
  }

  registerCorrectGuess(player) {
    player.guessedCorrect = true;
    this.guessedThisTurn.add(player.id);
    const timeLeft = Math.max(0, this.turnEndsAt - Date.now());
    const ratio = timeLeft / (this.settings.drawTime * 1000);
    const isFirst = this.guessedThisTurn.size === 1;
    const points = Math.max(20, Math.round(100 * ratio)) + (isFirst ? 20 : 0);
    player.score += points;
    this.turnPoints.set(player.id, (this.turnPoints.get(player.id) || 0) + points);
    const drawer = this.players.get(this.currentDrawerId);
    if (drawer) {
      const drawerPoints = Math.round(points * 0.4);
      drawer.score += drawerPoints;
      this.turnPoints.set(drawer.id, (this.turnPoints.get(drawer.id) || 0) + drawerPoints);
    }

    this.chatHistory.push({
      system: true,
      correct: true,
      text: `${player.name} ניחש/ה נכון! (+${points})`,
      ts: Date.now(),
    });
    this.io.to(this.code).emit("chat-message", this.chatHistory[this.chatHistory.length - 1]);
    this.broadcastState();
    this.checkAllGuessed();
  }

  checkAllGuessed() {
    if (this.phase !== "drawing") return;
    const eligible = this.connectedPlayers().filter((p) => p.id !== this.currentDrawerId);
    if (eligible.length > 0 && eligible.every((p) => p.guessedCorrect)) {
      this._revealSoonTimer = setTimeout(() => this.endTurn(false), 1200);
    }
  }

  endTurn(drawerLeft) {
    this.clearTimers();
    if (!this.currentWord) {
      // אף אחד לא הספיק לבחור מילה
      this.turnIndex++;
      this.advanceTurn();
      return;
    }
    this.phase = "reveal";
    const word = this.currentWord;
    this.systemMessage(
      drawerLeft ? `הצייר/ת עזב/ה. המילה הייתה: ${word}` : `הזמן נגמר! המילה הייתה: ${word}`
    );
    this.broadcastState();
    this._revealTimer = setTimeout(() => {
      this.turnIndex++;
      this.startNextRoundIfNeeded();
      this.advanceTurn();
    }, REVEAL_TIME * 1000);
  }

  endGame() {
    this.clearTimers();
    this.phase = "ended";
    this.currentDrawerId = null;
    this.currentWord = null;
    this.broadcastState();
  }

  backToLobby(socketId) {
    const player = this.players.get(socketId);
    if (!player || !player.isHost) return;
    if (this.phase !== "ended") return;
    this.resetGameState();
    this.broadcastState();
  }

  // ---------- ציור ----------

  handleDrawPoint(socketId, data) {
    if (socketId !== this.currentDrawerId || this.phase !== "drawing") return;
    if (data.fill) {
      if (this.strokeBuffer) this.strokes.push(this.strokeBuffer);
      this.strokeBuffer = null;
      if (typeof data.x === "number" && typeof data.y === "number") {
        this.strokes.push({ color: data.color, size: 1, fill: true, points: [{ x: data.x, y: data.y }] });
      }
      this.io.to(this.code).except(socketId).emit("draw-point", data);
      return;
    }
    if (data.newStroke) {
      if (this.strokeBuffer) this.strokes.push(this.strokeBuffer);
      this.strokeBuffer = { color: data.color, size: data.size, fill: false, points: [] };
    }
    if (!this.strokeBuffer) this.strokeBuffer = { color: data.color, size: data.size, fill: false, points: [] };
    if (typeof data.x === "number" && typeof data.y === "number") {
      this.strokeBuffer.points.push({ x: data.x, y: data.y });
    }
    this.io.to(this.code).except(socketId).emit("draw-point", data);
  }

  handleDrawEnd(socketId) {
    if (socketId !== this.currentDrawerId) return;
    if (this.strokeBuffer) {
      this.strokes.push(this.strokeBuffer);
      this.strokeBuffer = null;
    }
  }

  handleClear(socketId) {
    if (socketId !== this.currentDrawerId || this.phase !== "drawing") return;
    this.strokes = [];
    this.strokeBuffer = null;
    this.io.to(this.code).emit("canvas-clear");
  }

  handleUndo(socketId) {
    if (socketId !== this.currentDrawerId || this.phase !== "drawing") return;
    if (this.strokeBuffer) {
      this.strokeBuffer = null;
    } else {
      this.strokes.pop();
    }
    this.io.to(this.code).emit("canvas-redraw", { strokes: this.strokes });
  }

  currentStrokesSnapshot() {
    const strokes = this.strokes.slice();
    if (this.strokeBuffer) strokes.push(this.strokeBuffer);
    return strokes;
  }

  // ---------- עזר: הודעות ומצב ----------

  systemMessage(text, fromPlayer) {
    const msg = fromPlayer
      ? { name: fromPlayer.name, color: fromPlayer.color, text, ts: Date.now() }
      : { system: true, text, ts: Date.now() };
    this.chatHistory.push(msg);
    if (this.chatHistory.length > 80) this.chatHistory.shift();
    this.io.to(this.code).emit("chat-message", msg);
  }

  emitToPlayer(socketId, event, payload) {
    this.io.to(socketId).emit(event, payload);
  }

  stateFor(socketId) {
    const me = this.players.get(socketId);
    const seesFullWord =
      this.currentWord &&
      (socketId === this.currentDrawerId || (me && me.guessedCorrect) || this.phase === "reveal" || this.phase === "ended");
    return {
      phase: this.phase,
      roomCode: this.code,
      round: this.round,
      totalRounds: this.settings.rounds,
      players: [...this.players.values()]
        .sort((a, b) => b.score - a.score)
        .map((p) => this.publicPlayer(p)),
      settings: this.settings,
      currentDrawerId: this.currentDrawerId,
      isMeDrawing: socketId === this.currentDrawerId,
      maskedWord: this.currentWord
        ? seesFullWord
          ? this.currentWord
          : maskWord(this.currentWord, this.revealedIdx)
        : null,
      wordLength: this.currentWord ? this.currentWord.replace(/ /g, "").length : null,
      turnEndsAt: this.turnEndsAt,
      chooseEndsAt: this.phase === "choosing" ? this.chooseEndsAt : null,
      you: me ? this.publicPlayer(me) : null,
      chat: this.chatHistory.slice(-50),
      strokes: this.currentStrokesSnapshot(),
    };
  }

  broadcastState() {
    for (const id of this.players.keys()) {
      this.emitToPlayer(id, "state", this.stateFor(id));
    }
  }
}

function clamp(v, min, max) {
  const n = Number(v);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

module.exports = { Room, MIN_PLAYERS_TO_START, clamp };
