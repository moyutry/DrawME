// לוח הציור - עובד עם קואורדינטות יחסיות (0..1) כדי שיתאים לכל גודל מסך.
// כל הלקוחות מציגים בדיוק אותם strokes, כשהשרת הוא המקור האמיתי (source of truth).

class DrawingCanvas {
  constructor(canvasEl, { onPoint, onEnd } = {}) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.strokes = [];
    this.onPoint = onPoint || (() => {});
    this.onEnd = onEnd || (() => {});

    this.enabled = false;
    this.color = "#1e1e1e";
    this.size = 6;
    this.isEraser = false;
    this.isFillMode = false;

    this._drawing = false;
    this._remoteBuffer = null;
    this._lastLocalPoint = null;
    this._lastRemotePoint = null;

    // #draw-canvas -> #canvas-wrap (ממדים בפועל, ב-px, נקבעים כאן) -> #canvas-stage
    // (עוטף גמיש שתופס את השטח הפנוי - זה מה שצריך למדוד כדי לדעת כמה מקום יש).
    this._stage = this.canvas.parentElement.parentElement;

    this._bindPointerEvents();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this._stage);
    this.resize();
  }

  setEnabled(v) {
    this.enabled = v;
    this.canvas.style.cursor = v ? (this.isFillMode ? "copy" : "crosshair") : "not-allowed";
  }

  setColor(c) { this.color = c; }
  setSize(s) { this.size = s; }
  setEraser(v) { this.isEraser = v; if (v) this.isFillMode = false; }
  setFillMode(v) { this.isFillMode = v; if (v) this.isEraser = false; this.setEnabled(this.enabled); }

  // מחשב את הגודל הגדול ביותר שנכנס בשטח הפנוי (#canvas-stage) תוך שמירה על
  // --canvas-ratio קבוע ("contain"), וקובע אותו בפועל על #canvas-wrap - כדי
  // שלוח הציור יישמר תמיד באותו יחס פרופורציה בכל גודל מסך (לא נמתח בין
  // מחשב לטלפון), בלי להסתמך על טריקים שבירים של flex+container-query ב-CSS.
  resize() {
    const wrap = this.canvas.parentElement;
    const stageRect = this._stage.getBoundingClientRect();
    const ratioRaw = getComputedStyle(document.documentElement).getPropertyValue("--canvas-ratio");
    const ratio = parseFloat(ratioRaw) || 0.75;

    let w = stageRect.width;
    let h = w / ratio;
    if (h > stageRect.height) {
      h = stageRect.height;
      w = h * ratio;
    }
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    wrap.style.width = `${w}px`;
    wrap.style.height = `${h}px`;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssWidth = w;
    this.cssHeight = h;
    this.canvas.width = this.cssWidth * dpr;
    this.canvas.height = this.cssHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redrawAll();
  }

  setStrokes(strokes) {
    this.strokes = (strokes || []).map((s) => ({ ...s, points: (s.points || []).map((p) => ({ ...p })) }));
    this._remoteBuffer = null;
    this._lastRemotePoint = null;
    this.redrawAll();
  }

  clear() {
    this.strokes = [];
    this._remoteBuffer = null;
    this.redrawAll();
  }

  redrawAll() {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
    for (const stroke of this.strokes) this._paintStroke(stroke);
  }

  _paintStroke(stroke) {
    if (stroke.fill && stroke.points[0]) {
      this._floodFill(stroke.points[0].x, stroke.points[0].y, stroke.color);
      return;
    }
    if (!stroke.points.length) return;
    const ctx = this.ctx;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const first = this._toPx(stroke.points[0]);
    if (stroke.points.length === 1) {
      ctx.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
      return;
    }
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < stroke.points.length; i++) {
      const p = this._toPx(stroke.points[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  _toPx(rel) {
    return { x: rel.x * this.cssWidth, y: rel.y * this.cssHeight };
  }

  _relFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  _bindPointerEvents() {
    this.canvas.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return;
      this.canvas.setPointerCapture(e.pointerId);
      const { x, y } = this._relFromEvent(e);

      if (this.isFillMode) {
        const color = this.color;
        this.strokes.push({ color, size: 1, fill: true, points: [{ x, y }] });
        this._floodFill(x, y, color);
        this.onPoint({ newStroke: true, fill: true, x, y, color, size: 1 });
        this.onEnd();
        return;
      }

      this._drawing = true;
      const color = this.isEraser ? "#ffffff" : this.color;
      this._localStroke = { color, size: this.size, fill: false, points: [{ x, y }] };
      this.strokes.push(this._localStroke);
      this._paintDot(x, y, color, this.size);
      this.onPoint({ newStroke: true, fill: false, x, y, color, size: this.size });
    });

    const move = (e) => {
      if (!this._drawing) return;
      const { x, y } = this._relFromEvent(e);
      const last = this._localStroke.points[this._localStroke.points.length - 1];
      this._localStroke.points.push({ x, y });
      this._drawSegment(last, { x, y }, this._localStroke.color, this._localStroke.size);
      this.onPoint({ newStroke: false, fill: false, x, y, color: this._localStroke.color, size: this._localStroke.size });
    };
    this.canvas.addEventListener("pointermove", move);

    const end = (e) => {
      if (!this._drawing) return;
      this._drawing = false;
      this._localStroke = null;
      this.onEnd();
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    this.canvas.addEventListener("pointerleave", end);
  }

  _paintDot(x, y, color, size) {
    const p = this._toPx({ x, y });
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  _drawSegment(relA, relB, color, size) {
    const a = this._toPx(relA);
    const b = this._toPx(relB);
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // מטפל בנקודות ציור שהתקבלו משחקן אחר (הצייר/ת) בזמן אמת
  applyRemotePoint(data) {
    if (data.fill) {
      const stroke = { color: data.color, size: 1, fill: true, points: [{ x: data.x, y: data.y }] };
      this.strokes.push(stroke);
      this._floodFill(data.x, data.y, data.color);
      this._lastRemotePoint = null;
      return;
    }
    if (data.newStroke || !this._remoteBuffer) {
      this._remoteBuffer = { color: data.color, size: data.size, fill: false, points: [] };
      this.strokes.push(this._remoteBuffer);
    }
    const point = { x: data.x, y: data.y };
    const last = this._remoteBuffer.points[this._remoteBuffer.points.length - 1];
    this._remoteBuffer.points.push(point);
    if (last) this._drawSegment(last, point, this._remoteBuffer.color, this._remoteBuffer.size);
    else this._paintDot(point.x, point.y, this._remoteBuffer.color, this._remoteBuffer.size);
  }

  // Flood fill פשוט מבוסס פיקסלים בפועל על הקנבס
  _floodFill(xRel, yRel, hexColor) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return;
    const dpr = w / this.cssWidth;
    const startX = Math.min(w - 1, Math.max(0, Math.round(xRel * this.cssWidth * dpr)));
    const startY = Math.min(h - 1, Math.max(0, Math.round(yRel * this.cssHeight * dpr)));

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const target = getPixel(data, w, startX, startY);
    const fill = hexToRgba(hexColor);

    if (colorsMatch(target, fill, 10)) return;

    const stack = [[startX, startY]];
    const visited = new Uint8Array(w * h);
    const tolerance = 40;

    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const idx = y * w + x;
      if (visited[idx]) continue;
      const px = getPixel(data, w, x, y);
      if (!colorsMatch(px, target, tolerance)) continue;
      visited[idx] = 1;
      setPixel(data, w, x, y, fill);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    ctx.putImageData(imgData, 0, 0);
  }
}

function getPixel(data, w, x, y) {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}
function setPixel(data, w, x, y, rgba) {
  const i = (y * w + x) * 4;
  data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = rgba[3];
}
function colorsMatch(a, b, tolerance) {
  return (
    Math.abs(a[0] - b[0]) <= tolerance &&
    Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance &&
    Math.abs(a[3] - b[3]) <= tolerance
  );
}
function hexToRgba(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return [r, g, b, 255];
}

window.DrawingCanvas = DrawingCanvas;
