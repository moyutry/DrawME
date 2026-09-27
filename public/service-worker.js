// Service Worker פשוט ל-PWA: מאפשר התקנה ותצוגה בסיסית גם אופליין.
// לא נוגע בכלל בבקשות socket.io כדי לא לשבור את החיבור בזמן אמת.

const CACHE_NAME = "tvn-cache-v3";
const APP_SHELL = [
  "/",
  "/index.html",
  "/css/style.css",
  "/js/app.js",
  "/js/canvas.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET" || url.pathname.startsWith("/socket.io/")) {
    return; // אל תיגע בתעבורת socket.io בזמן אמת
  }

  // ניווט לדף עצמו (טעינה/רענון) - תמיד רשת קודם. כך גרסה שבורה/ישנה של
  // ה-HTML לעולם לא "תיתקע" במטמון ותוצג שוב ושוב בכל רענון (מסך שחור שלא
  // זז) - רק אם הרשת ממש לא זמינה נופלים חזרה לעותק השמור.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
