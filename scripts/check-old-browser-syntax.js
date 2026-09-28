// בודק שקבצי ה-JS שרצים בדפדפן (public/js/*.js) אכן מתפענחים (parse) תחת
// גרסת ECMAScript ישנה/שמרנית - ולא רק תחת מנוע Node המודרני (שבו node -c
// לא באמת תופס את זה, כי V8 עדכני מבין הכל). הרצה: node scripts/check-old-browser-syntax.js
//
// ECMA_TARGET = 2015 (ES6 - Chrome 49+/2016, Safari 10+, כמעט כל מכשיר עם
// Chrome מעודכן ולו פעם אחת מ-Play Store) - הרף המחמיר ביותר שהקוד עומד
// בו כרגע בלי לפרק אותו לגמרי (עדיין מרשה arrow functions/template
// literals/const/let/classes/destructuring/spread במערכים - כל אלה כבר
// בשימוש בכל הקוד ומ-2015 בעצמם). תופס בוודאות כל תוסף מ-2017 ואילך כמו
// async/await, "?." ו-"??" - אלה שוברים parsing של הקובץ כולו בדפדפן ישן,
// לא רק את השורה הספציפית.

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const ECMA_TARGET = 2015;
const FILES = [
  "public/js/app.js",
  "public/js/avatar.js",
  "public/js/canvas.js",
];

let ok = true;
for (const rel of FILES) {
  const file = path.join(__dirname, "..", rel);
  const code = fs.readFileSync(file, "utf8");
  try {
    acorn.parse(code, { ecmaVersion: ECMA_TARGET, sourceType: "script" });
    console.log(`✅ ${rel} - מתפענח תקין תחת ES${ECMA_TARGET}`);
  } catch (err) {
    ok = false;
    console.error(`❌ ${rel} - נכשל תחת ES${ECMA_TARGET}:`);
    console.error(`   ${err.message}`);
  }
}

if (!ok) {
  console.error("\nיש קוד שלא יעבוד בדפדפנים ישנים - יש לתקן לפני פרסום.");
  process.exit(1);
}
console.log("\nכל הקבצים תואמים לדפדפנים ישנים (ES" + ECMA_TARGET + ").");
