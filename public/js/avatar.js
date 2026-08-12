// מערכת עיצוב דמות (אווטאר) - בלוב צבעוני עם עיניים ופה להחלפה, בהשראת סקריבל.
// מודול עצמאי בלי תלות בשאר האתר - כל הצורות מצוירות בקוד (SVG), בלי קבצי תמונה.

(() => {
  "use strict";

  const INK = "#1b1b1b";

  const COLORS = [
    "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c",
    "#3498db", "#9b59b6", "#e84393", "#795548", "#34495e",
  ];

  function bodySVG(color) {
    return `
      <ellipse cx="35" cy="87" rx="11" ry="8" fill="${color}" stroke="${INK}" stroke-width="4"/>
      <ellipse cx="65" cy="87" rx="11" ry="8" fill="${color}" stroke="${INK}" stroke-width="4"/>
      <rect x="16" y="10" width="68" height="66" rx="30" ry="30" fill="${color}" stroke="${INK}" stroke-width="4"/>
    `;
  }

  function starPoints(cx, cy, rOuter, rInner) {
    const points = 5;
    const step = Math.PI / points;
    const pts = [];
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? rOuter : rInner;
      const angle = -Math.PI / 2 + i * step;
      pts.push(`${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)}`);
    }
    return pts.join(" ");
  }

  function heartShape(cx, cy, s) {
    return `<path d="M${cx},${cy + s * 0.8} C${cx - s * 1.4},${cy - s * 0.4} ${cx - s * 0.6},${cy - s * 1.6} ${cx},${cy - s * 0.4} C${cx + s * 0.6},${cy - s * 1.6} ${cx + s * 1.4},${cy - s * 0.4} ${cx},${cy + s * 0.8} Z" fill="#ff4d6d" stroke="${INK}" stroke-width="1.2"/>`;
  }

  // כל וריאנט הוא פונקציה שמחזירה markup פנימי של SVG (בלי תג <svg> עצמו)
  const EYE_VARIANTS = [
    // 0 - נקודות רגילות
    () => `
      <circle cx="36" cy="40" r="5" fill="${INK}"/>
      <circle cx="64" cy="40" r="5" fill="${INK}"/>
    `,
    // 1 - עיניים גדולות עגולות (אנימה)
    () => `
      <circle cx="36" cy="40" r="9" fill="#fff" stroke="${INK}" stroke-width="3"/>
      <circle cx="38" cy="38" r="4" fill="${INK}"/>
      <circle cx="39.5" cy="36.3" r="1.4" fill="#fff"/>
      <circle cx="64" cy="40" r="9" fill="#fff" stroke="${INK}" stroke-width="3"/>
      <circle cx="62" cy="38" r="4" fill="${INK}"/>
      <circle cx="60.5" cy="36.3" r="1.4" fill="#fff"/>
    `,
    // 2 - שמח (^ ^)
    () => `
      <path d="M30,42 Q36,32 42,42" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M58,42 Q64,32 70,42" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>
    `,
    // 3 - קריצה
    () => `
      <path d="M30,42 Q36,32 42,42" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <circle cx="64" cy="40" r="6" fill="#fff" stroke="${INK}" stroke-width="3"/>
      <circle cx="64" cy="40" r="3" fill="${INK}"/>
    `,
    // 4 - מופתע
    () => `
      <circle cx="36" cy="40" r="10" fill="#fff" stroke="${INK}" stroke-width="3"/>
      <circle cx="36" cy="40" r="3.2" fill="${INK}"/>
      <circle cx="64" cy="40" r="10" fill="#fff" stroke="${INK}" stroke-width="3"/>
      <circle cx="64" cy="40" r="3.2" fill="${INK}"/>
    `,
    // 5 - ישנוני
    () => `
      <path d="M29,41 L43,38" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
      <path d="M57,38 L71,41" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
    `,
    // 6 - עיניים-כוכב
    () => `
      <polygon points="${starPoints(36, 40, 7, 3)}" fill="${INK}"/>
      <polygon points="${starPoints(64, 40, 7, 3)}" fill="${INK}"/>
    `,
    // 7 - מבולבל (X X)
    () => `
      <path d="M30,35 L42,45 M42,35 L30,45" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M58,35 L70,45 M70,35 L58,45" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>
    `,
    // 8 - מאוהב (לב-עיניים)
    () => `${heartShape(36, 40, 5)}${heartShape(64, 40, 5)}`,
    // 9 - כועס
    () => `
      <path d="M28,34 L44,40" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
      <circle cx="40" cy="42" r="4" fill="${INK}"/>
      <path d="M72,34 L56,40" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
      <circle cx="60" cy="42" r="4" fill="${INK}"/>
    `,
    // 10 - בוכה
    () => `
      <circle cx="36" cy="38" r="4" fill="${INK}"/>
      <circle cx="64" cy="38" r="4" fill="${INK}"/>
      <path d="M36,44 Q33,52 36,56 Q39,52 36,44 Z" fill="#3aa0ff"/>
    `,
    // 11 - מגניב (משקפי שמש)
    () => `
      <rect x="26" y="34" width="18" height="12" rx="6" fill="${INK}"/>
      <rect x="56" y="34" width="18" height="12" rx="6" fill="${INK}"/>
      <rect x="44" y="38" width="12" height="3" fill="${INK}"/>
      <path d="M30,37 L36,37" stroke="#ffffff" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
      <path d="M60,37 L66,37" stroke="#ffffff" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
    `,
  ];

  const MOUTH_VARIANTS = [
    // 0 - חיוך קטן
    () => `<path d="M40,58 Q50,66 60,58" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    // 1 - חיוך גדול פתוח
    () => `<path d="M32,56 Q50,78 68,56" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    // 2 - "או" מופתע
    () => `<ellipse cx="50" cy="61" rx="6" ry="8" fill="${INK}"/>`,
    // 3 - שטוח/ניטרלי
    () => `<line x1="38" y1="60" x2="62" y2="60" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`,
    // 4 - חיוך עם שן חסרה
    () => `
      <path d="M32,54 Q50,72 68,54 Q50,64 32,54 Z" fill="${INK}"/>
      <rect x="40" y="55" width="20" height="6" rx="2" fill="#fff"/>
      <line x1="50" y1="55" x2="50" y2="61" stroke="${INK}" stroke-width="2"/>
    `,
    // 5 - לשון בחוץ / עקום
    () => `
      <path d="M38,58 Q52,68 64,54" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M50,63 Q54,72 58,63 Q54,66 50,63 Z" fill="#ff6b81" stroke="${INK}" stroke-width="2"/>
    `,
    // 6 - עצוב
    () => `<path d="M40,64 Q50,54 60,64" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    // 7 - גלי/עצבני
    () => `<path d="M35,60 Q42,55 50,60 Q58,65 65,60" stroke="${INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
    // 8 - צחוק גדול עם לשון
    () => `<ellipse cx="50" cy="63" rx="14" ry="12" fill="${INK}"/><ellipse cx="50" cy="68" rx="9" ry="5" fill="#ff8fa3"/>`,
    // 9 - חיוך שובב א-סימטרי
    () => `<path d="M38,60 Q46,66 60,58" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    // 10 - נשיקה
    () => `<ellipse cx="50" cy="61" rx="4" ry="5" fill="#ff6b81" stroke="${INK}" stroke-width="2"/>`,
    // 11 - ניבים (ערפד)
    () => `
      <path d="M32,56 Q50,72 68,56" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M40,58 L43,66 L46,58 Z" fill="#fff" stroke="${INK}" stroke-width="1"/>
      <path d="M54,58 L57,66 L60,58 Z" fill="#fff" stroke="${INK}" stroke-width="1"/>
    `,
  ];

  function clampIndex(n, count) {
    n = Math.round(Number(n));
    if (!Number.isFinite(n)) return 0;
    return ((n % count) + count) % count;
  }

  function avatarSVG(config, size) {
    config = config || {};
    const color = COLORS.includes(config.color) ? config.color : COLORS[0];
    const eyes = clampIndex(config.eyes, EYE_VARIANTS.length);
    const mouth = clampIndex(config.mouth, MOUTH_VARIANTS.length);
    return (
      `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="דמות שחקן">` +
      bodySVG(color) +
      `<g>${EYE_VARIANTS[eyes]()}</g>` +
      `<g>${MOUTH_VARIANTS[mouth]()}</g>` +
      `</svg>`
    );
  }

  function renderAvatar(container, config, size) {
    if (!container) return;
    container.innerHTML = avatarSVG(config, size);
  }

  window.Avatar = {
    COLORS,
    EYES_COUNT: EYE_VARIANTS.length,
    MOUTH_COUNT: MOUTH_VARIANTS.length,
    clampIndex,
    avatarSVG,
    renderAvatar,
  };
})();
