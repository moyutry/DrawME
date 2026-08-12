// מושך תמונה אחת לכל מילה במאגר (server/words.js) בשביל מצב "לא יודע/ת לקרוא"
// (תמונה במקום טקסט). ריצה חד-פעמית, בלי שום קריאת רשת בזמן משחק בפועל:
//   1. הרשמה חינמית ב-pixabay.com/api/docs וקבלת API key
//   2. הוספת PIXABAY_API_KEY=... לקובץ .env
//   3. npm run fetch-word-images
//
// התוצאה נשמרת קבוע בפרויקט: public/images/words/*.jpg + public/data/word-images.json
// (מיפוי מילה -> נתיב תמונה יחסי). מילים בלי תמונה טובה פשוט לא מופיעות
// במיפוי - הקליינט נופל אוטומטית חזרה לטקסט רגיל עבורן (בדיוק כמו מילה
// מותאמת-אישית שמישהו הוסיף בהגדרות חדר, שגם לה לעולם לא תהיה תמונה).
//
// ריצה חוזרת (למשל אחרי הוספת מילים חדשות ל-words.js) מדלגת אוטומטית על
// מילים שכבר יש להן תמונה שמורה בדיסק - בטוח להריץ שוב ושוב.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ALL_WORDS } = require("../server/words");

const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
const TRANSLATE_EMAIL = "yatimabit@gmail.com"; // מעלה את המכסה החינמית היומית של MyMemory מ-1000 ל-10000
const IMAGES_DIR = path.join(__dirname, "..", "public", "images", "words");
const MANIFEST_PATH = path.join(__dirname, "..", "public", "data", "word-images.json");
const REQUEST_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugFor(word) {
  return crypto.createHash("sha1").update(word, "utf8").digest("hex").slice(0, 16);
}

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveManifest(manifest) {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

async function translateViaGoogle(hebrewWord) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=he&tl=en&dt=t&q=${encodeURIComponent(hebrewWord)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const translated = data && data[0] ? data[0].map((seg) => seg[0]).join("") : null;
  return translated && translated.trim() ? translated.trim() : null;
}

async function translateViaMyMemory(hebrewWord) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(hebrewWord)}&langpair=he|en&de=${encodeURIComponent(TRANSLATE_EMAIL)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const translated = data && data.responseData && data.responseData.translatedText;
  return translated || null;
}

async function translateToEnglish(hebrewWord) {
  // Google's endpoint handles single words/short phrases much more reliably than
  // MyMemory (which often returns transliterations or unrelated names for bare words).
  const translated = (await translateViaGoogle(hebrewWord)) || (await translateViaMyMemory(hebrewWord));
  if (!translated) throw new Error("תרגום נכשל");
  return translated;
}

function pickBestHit(hits, englishTerm) {
  if (!hits || hits.length === 0) return null;
  // Pixabay's relevance ranking is often loose (e.g. "wolf" returning a generic
  // paw-print icon) - re-rank candidates by whether the searched word actually
  // appears in the image's own tags, so we don't just blindly take hit #1.
  const primary = englishTerm.toLowerCase().split(/\s+/)[0];
  const scored = hits.map((hit) => {
    const tags = (hit.tags || "").toLowerCase().split(",").map((t) => t.trim());
    const score = tags.includes(primary) ? 2 : tags.some((t) => t.includes(primary)) ? 1 : 0;
    return { hit, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].hit;
}

async function searchPixabay(englishTerm, imageType) {
  const url = `https://pixabay.com/api/?key=${encodeURIComponent(PIXABAY_KEY)}&q=${encodeURIComponent(englishTerm)}&image_type=${imageType}&safesearch=true&per_page=8&lang=en`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay נכשל (${res.status})`);
  const data = await res.json();
  return pickBestHit(data && data.hits, englishTerm);
}

function extensionFor(contentType) {
  if (contentType && contentType.includes("png")) return ".png";
  if (contentType && contentType.includes("webp")) return ".webp";
  return ".jpg";
}

async function downloadImage(url, baseName) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const ext = extensionFor(res.headers.get("content-type"));
      const buffer = Buffer.from(await res.arrayBuffer());
      const fileName = baseName + ext;
      fs.writeFileSync(path.join(IMAGES_DIR, fileName), buffer);
      return `images/words/${fileName}`;
    }
    if (res.status === 429 && attempt < 2) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    throw new Error(`הורדת תמונה נכשלה (${res.status})`);
  }
}

async function main() {
  if (!PIXABAY_KEY) {
    console.error("חסר PIXABAY_API_KEY. הירשמו חינם ב-https://pixabay.com/api/docs/ והוסיפו את המפתח לקובץ .env בשורש הפרויקט.");
    process.exit(1);
  }

  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const manifest = loadManifest();

  let fetched = 0, skipped = 0, failed = 0;

  for (const word of ALL_WORDS) {
    const cached = manifest[word];
    if (cached && fs.existsSync(path.join(__dirname, "..", "public", cached))) {
      skipped++;
      continue;
    }
    try {
      const englishTerm = await translateToEnglish(word);
      const hit =
        (await searchPixabay(englishTerm, "vector")) ||
        (await searchPixabay(englishTerm, "illustration")) ||
        (await searchPixabay(englishTerm, "photo"));
      if (!hit) {
        console.warn(`⚠ אין תמונה מתאימה עבור: "${word}" (${englishTerm})`);
        failed++;
        continue;
      }
      const relPath = await downloadImage(hit.webformatURL, slugFor(word));
      manifest[word] = relPath;
      saveManifest(manifest); // שמירה אחרי כל הצלחה - עמיד להפרעה/עצירה באמצע
      fetched++;
      console.log(`✓ ${word} -> ${relPath}`);
    } catch (err) {
      console.warn(`⚠ שגיאה עבור "${word}":`, err.message);
      failed++;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\nסיום. נשלפו: ${fetched}, כבר במטמון: ${skipped}, נכשלו/דולגו: ${failed}, סה"כ מילים: ${ALL_WORDS.length}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("שגיאה קריטית:", err);
    process.exit(1);
  });
}

module.exports = { translateToEnglish, searchPixabay, pickBestHit, sleep, REQUEST_DELAY_MS };
