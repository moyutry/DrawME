// שכבת שמירה של הגדרות החדר.
// אם קיים MONGODB_URI - ההגדרות נשמרות ב-MongoDB Atlas ושורדות אתחול/דיפלוי מחדש של השרת.
// אחרת - נופלים לקובץ JSON מקומי (מספיק לפיתוח, לא מובטח לשרוד דיפלוי מחדש בכל אחסון חינמי).

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const LOCAL_FILE = path.join(DATA_DIR, "settings.json");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");
const DOC_ID = "room-settings";

let mongoClient = null;
let mongoCollection = null;
let mongoPlayers = null;
let useMongo = false;

async function init() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    try {
      const { MongoClient } = require("mongodb");
      mongoClient = new MongoClient(uri);
      await mongoClient.connect();
      const dbName = process.env.MONGODB_DB || "tsayer_venachesh";
      mongoCollection = mongoClient.db(dbName).collection("settings");
      mongoPlayers = mongoClient.db(dbName).collection("players");
      useMongo = true;
      console.log("[db] מחובר ל-MongoDB - ההגדרות יישמרו לצמיתות.");
    } catch (err) {
      console.error("[db] נכשל להתחבר ל-MongoDB, נופל לאחסון קובץ מקומי:", err.message);
      useMongo = false;
    }
  } else {
    console.log("[db] לא הוגדר MONGODB_URI - נשמר לקובץ מקומי (server/data/settings.json).");
  }
}

async function loadSettings() {
  if (useMongo) {
    const doc = await mongoCollection.findOne({ _id: DOC_ID });
    if (doc) {
      delete doc._id;
      return doc;
    }
    return null;
  }
  try {
    if (fs.existsSync(LOCAL_FILE)) {
      const raw = fs.readFileSync(LOCAL_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error("[db] שגיאה בקריאת קובץ הגדרות מקומי:", err.message);
  }
  return null;
}

async function saveSettings(settings) {
  if (useMongo) {
    await mongoCollection.updateOne(
      { _id: DOC_ID },
      { $set: settings },
      { upsert: true }
    );
    return;
  }
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(settings, null, 2), "utf-8");
  } catch (err) {
    console.error("[db] שגיאה בשמירת קובץ הגדרות מקומי:", err.message);
  }
}

// ---------- סטטיסטיקות שחקן/ית לצמיתות (לפי הטוקן הקבוע של המכשיר) ----------
// זהה למכשיר/דפדפן, לא לאדם - ניקוי אחסון/דפדפן אחר/מכשיר משותף מאפסים/
// מפצלים את הסטטיסטיקה. מקובל למשחק קליל בלי הרשמה, לא מוצג כ"הישגי משתמש".

const BADGE_CATALOG = [
  { id: "first-win", label: "🏆 ניצחון ראשון", check: (s) => s.totalWins >= 1 },
  { id: "ten-wins", label: "🥇 10 ניצחונות", check: (s) => s.totalWins >= 10 },
  { id: "veteran", label: "🎮 20 משחקים", check: (s) => s.totalGamesPlayed >= 20 },
  { id: "streak-5", label: "🔥 רצף של 5", check: (s) => s.bestGuessStreakEver >= 5 },
];

function deriveStats(raw) {
  const s = {
    totalGamesPlayed: 0,
    totalWins: 0,
    totalScore: 0,
    bestGuessStreakEver: 0,
    ...raw,
  };
  s.level = Math.floor(s.totalScore / 500) + 1;
  s.badges = BADGE_CATALOG.filter((b) => b.check(s)).map((b) => b.label);
  return s;
}

function readLocalPlayers() {
  try {
    if (fs.existsSync(PLAYERS_FILE)) return JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf-8"));
  } catch (err) {
    console.error("[db] שגיאה בקריאת קובץ סטטיסטיקות מקומי:", err.message);
  }
  return {};
}

function writeLocalPlayers(all) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(all, null, 2), "utf-8");
  } catch (err) {
    console.error("[db] שגיאה בשמירת קובץ סטטיסטיקות מקומי:", err.message);
  }
}

async function getPlayerStats(token) {
  if (!token) return deriveStats({});
  if (useMongo) {
    const doc = await mongoPlayers.findOne({ _id: token });
    return deriveStats(doc || {});
  }
  return deriveStats(readLocalPlayers()[token] || {});
}

// נקרא פעם אחת בסיום כל משחק לכל שחקן/ית שהיה/הייתה בחדר - מעדכן את
// המונים המצטברים ומחזיר את הסטטיסטיקה המעודכנת (כדי שהשרת יוכל לשדר אותה
// מיד חזרה ללקוח, בלי קריאה נוספת).
async function recordGameResult(token, { name, won, scoreEarned, bestStreakThisGame }) {
  if (!token) return deriveStats({});
  if (useMongo) {
    await mongoPlayers.updateOne(
      { _id: token },
      {
        $set: { lastSeenName: name, updatedAt: new Date() },
        $inc: { totalGamesPlayed: 1, totalWins: won ? 1 : 0, totalScore: Math.max(0, scoreEarned || 0) },
        $max: { bestGuessStreakEver: bestStreakThisGame || 0 },
      },
      { upsert: true }
    );
    const doc = await mongoPlayers.findOne({ _id: token });
    return deriveStats(doc || {});
  }
  const all = readLocalPlayers();
  const prev = all[token] || {};
  const next = {
    lastSeenName: name,
    totalGamesPlayed: (prev.totalGamesPlayed || 0) + 1,
    totalWins: (prev.totalWins || 0) + (won ? 1 : 0),
    totalScore: (prev.totalScore || 0) + Math.max(0, scoreEarned || 0),
    bestGuessStreakEver: Math.max(prev.bestGuessStreakEver || 0, bestStreakThisGame || 0),
    updatedAt: new Date().toISOString(),
  };
  all[token] = next;
  writeLocalPlayers(all);
  return deriveStats(next);
}

module.exports = { init, loadSettings, saveSettings, getPlayerStats, recordGameResult };
