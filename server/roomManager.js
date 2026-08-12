// רישום כל החדרים הפעילים בשרת: חדר "כללי" אחד קבוע (משותף לכולם, בדיוק
// כמו שהמשחק תמיד עבד) בתוספת חדרים פרטיים אפמריים שנוצרים לפי דרישה ומתפנים
// אוטומטית ברגע שהם מתרוקנים.

const { Room } = require("./room");

const GENERAL_CODE = "MAIN";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // בלי 0/O/1/I/L - קלים לבלבול
const CODE_LENGTH = 5;

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // code -> Room
  }

  async init() {
    const general = new Room(this.io, { code: GENERAL_CODE, persistent: true });
    await general.init();
    this.rooms.set(GENERAL_CODE, general);
    return general;
  }

  get(code) {
    return code ? this.rooms.get(String(code).toUpperCase()) : undefined;
  }

  generateCode() {
    let code;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
    } while (this.rooms.has(code));
    return code;
  }

  createPrivateRoom() {
    const code = this.generateCode();
    const room = new Room(this.io, { code, persistent: false });
    room.onEmpty = () => this.cleanupIfEmpty(code);
    this.rooms.set(code, room);
    return room;
  }

  cleanupIfEmpty(code) {
    if (code === GENERAL_CODE) return;
    const room = this.rooms.get(code);
    if (room && room.players.size === 0) {
      room.clearTimers();
      this.rooms.delete(code);
    }
  }
}

module.exports = { RoomManager, GENERAL_CODE };
