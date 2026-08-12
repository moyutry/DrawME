require("dotenv").config();
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const db = require("./db");
const { RoomManager, GENERAL_CODE } = require("./roomManager");
const { clamp } = require("./room");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  // מקטין את הזמן המרבי לזהות חיבור "מת בשקט" (למשל אפליקציה שנסגרה לגמרי
  // בטלפון בלי סגירה נקייה של הסוקט) - ברירת המחדל (25s/20s) יכולה לקחת עד
  // כ-45 שניות; כאן עד כ-20 שניות. לא אגרסיבי מדי כדי לא לזהות ניתוק שווא
  // בקפיצת רשת רגילה (מעבר וויפי/סלולרי) - וגם אם כן, חלון החסד שבהמשך סופג את זה.
  pingInterval: 10000,
  pingTimeout: 10000,
});

app.use(express.static(path.join(__dirname, "..", "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("service-worker.js")) {
      // אף פעם לא לקאש את קובץ ה-service worker עצמו
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

app.get("/healthz", (req, res) => res.status(200).send("ok"));

// חייב להישאר זהה לפלטת COLORS ב-public/js/avatar.js
const AVATAR_COLORS = [
  "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c",
  "#3498db", "#9b59b6", "#e84393", "#795548", "#34495e",
];
// חייב להישאר זהה לאורך EYE_VARIANTS/MOUTH_VARIANTS ב-public/js/avatar.js
const EYES_COUNT = 12;
const MOUTH_COUNT = 12;

function buildAvatar(avatar) {
  avatar = avatar && typeof avatar === "object" ? avatar : {};
  const color = AVATAR_COLORS.includes(avatar.color)
    ? avatar.color
    : AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const eyes = clamp(avatar.eyes, 0, EYES_COUNT - 1);
  const mouth = clamp(avatar.mouth, 0, MOUTH_COUNT - 1);
  return { color, eyes, mouth };
}

async function main() {
  await db.init();
  const roomManager = new RoomManager(io);
  await roomManager.init();

  io.on("connection", (socket) => {
    const currentRoom = () => roomManager.get(socket.data.roomCode);

    function enterRoom(room, name, avatar, token, canRead) {
      name = String(name || "שחקן").trim().slice(0, 18) || "שחקן";
      const avatarObj = buildAvatar(avatar);
      canRead = canRead !== false;

      // קודם מנסים למזג לתוך מושב קיים לפי הטוקן (אם יש) - כך שאם החיבור
      // הקודם עדיין לא זוהה כמנותק בצד השרת (למשל אפליקציה שנסגרה לגמרי
      // והתחברות מחדש קרתה לפני שה-timeout הבשיל), לא נוצר שחקן/ית כפול/ה.
      const takenOver = room.takeOverByToken(io, socket.id, name, avatarObj, token, canRead);
      if (!takenOver) {
        if (room.connectedPlayers().length >= room.settings.maxPlayers) {
          socket.emit("join-error", {
            message: room.code === GENERAL_CODE
              ? "החדר הכללי מלא כרגע. אפשר לנסות שוב מאוחר יותר או ליצור חדר פרטי משלכם!"
              : "החדר מלא כרגע.",
          });
          return;
        }
        room.addPlayer(socket.id, name, avatarObj, token, canRead);
      }
      socket.data.roomCode = room.code;
      socket.join(room.code);
      socket.emit("joined", { id: socket.id, roomCode: room.code });
      room.broadcastState();
    }

    socket.on("join", ({ name, avatar, token, roomCode, canRead }) => {
      if (currentRoom() && currentRoom().players.has(socket.id)) return;
      let room;
      if (roomCode) {
        room = roomManager.get(roomCode);
        if (!room) {
          socket.emit("join-error", { message: "לא נמצא חדר עם הקוד הזה. בדקו שהקוד נכון ונסו שוב." });
          return;
        }
      } else {
        room = roomManager.get(GENERAL_CODE);
      }
      enterRoom(room, name, avatar, token, canRead);
    });

    socket.on("create-room", ({ name, avatar, token, canRead }) => {
      const room = roomManager.createPrivateRoom();
      enterRoom(room, name, avatar, token, canRead);
    });

    socket.on("rejoin", ({ token, roomCode }) => {
      const room = roomCode ? roomManager.get(roomCode) : roomManager.get(GENERAL_CODE);
      if (!room) {
        socket.emit("rejoin-failed", { reason: "room-gone" });
        return;
      }
      const result = room.tryRejoin(socket, token);
      if (result.ok) {
        socket.data.roomCode = room.code;
        socket.join(room.code);
        socket.emit("joined", { id: socket.id, roomCode: room.code });
        room.broadcastState();
      } else {
        socket.emit("rejoin-failed", { reason: result.reason });
      }
    });

    socket.on("update-settings", async (patch) => {
      const room = currentRoom();
      if (!room) return;
      const result = await room.updateSettings(socket.id, patch || {});
      if (!result.ok) socket.emit("action-error", { message: result.error });
      else room.broadcastState();
    });

    socket.on("start-game", () => {
      const room = currentRoom();
      if (!room) return;
      const result = room.startGame(socket.id);
      if (!result.ok) socket.emit("action-error", { message: result.error });
    });

    socket.on("choose-word", ({ word }) => currentRoom()?.chooseWord(socket.id, word));

    socket.on("back-to-lobby", () => currentRoom()?.backToLobby(socket.id));

    socket.on("chat", ({ text }) => currentRoom()?.handleChat(socket.id, text));

    socket.on("draw-point", (data) => currentRoom()?.handleDrawPoint(socket.id, data));
    socket.on("draw-end", () => currentRoom()?.handleDrawEnd(socket.id));
    socket.on("clear-canvas", () => currentRoom()?.handleClear(socket.id));
    socket.on("undo-canvas", () => currentRoom()?.handleUndo(socket.id));

    socket.on("reaction", ({ emoji }) => {
      const room = currentRoom();
      if (!room) return;
      const player = room.players.get(socket.id);
      if (!player) return;
      const allowed = ["😂", "👍", "😮", "❤️", "🎉", "🤔"];
      if (!allowed.includes(emoji)) return;
      io.to(room.code).emit("reaction", { emoji, name: player.name });
    });

    socket.on("kick", ({ playerId }) => {
      const room = currentRoom();
      if (!room) return;
      const me = room.players.get(socket.id);
      if (!me || !me.isHost || playerId === socket.id) return;
      const target = io.sockets.sockets.get(playerId);
      // הסרה מיידית וסופית - קיק לא אמור לתת חלון חסד לחזרה כמו ניתוק רגיל
      room.handleDisconnect(playerId);
      room.finalizeDisconnect(playerId);
      if (target) {
        target.emit("kicked");
        target.disconnect(true);
      }
    });

    socket.on("disconnect", () => {
      const room = currentRoom();
      if (!room) return;
      room.handleDisconnect(socket.id);
      room.broadcastState();
    });
  });

  server.listen(PORT, () => {
    console.log(`[server] מאזין על פורט ${PORT}`);
  });
}

main().catch((err) => {
  console.error("שגיאה קריטית באתחול השרת:", err);
  process.exit(1);
});
