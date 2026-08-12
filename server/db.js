// שכבת שמירה של הגדרות החדר.
// אם קיים MONGODB_URI - ההגדרות נשמרות ב-MongoDB Atlas ושורדות אתחול/דיפלוי מחדש של השרת.
// אחרת - נופלים לקובץ JSON מקומי (מספיק לפיתוח, לא מובטח לשרוד דיפלוי מחדש בכל אחסון חינמי).

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const LOCAL_FILE = path.join(DATA_DIR, "settings.json");
const DOC_ID = "room-settings";

let mongoClient = null;
let mongoCollection = null;
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

module.exports = { init, loadSettings, saveSettings };
