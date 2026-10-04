// app.js — runs entirely in the browser. Talks only to our own /api/detect
// endpoint; the NVIDIA API key never appears here.

const els = {
  video: document.getElementById("video"),
  stillImage: document.getElementById("stillImage"),
  overlay: document.getElementById("overlay"),
  viewportEmpty: document.getElementById("viewportEmpty"),
  sweep: document.getElementById("sweep"),
  startWebcam: document.getElementById("startWebcam"),
  stopWebcam: document.getElementById("stopWebcam"),
  fileInput: document.getElementById("fileInput"),
  intervalSlider: document.getElementById("intervalSlider"),
  intervalValue: document.getElementById("intervalValue"),
  thresholdSlider: document.getElementById("thresholdSlider"),
  thresholdValue: document.getElementById("thresholdValue"),
  statusPill: document.getElementById("statusPill"),
  statusText: document.getElementById("statusText"),
  faceList: document.getElementById("faceList"),
  forensicReasoning: document.getElementById("forensicReasoning"),
  modelPill: document.getElementById("modelPill"),
  log: document.getElementById("log"),
  keyWarning: document.getElementById("keyWarning"),
};

const ctx = els.overlay.getContext("2d");

let stream = null;
let scanTimer = null;
let inFlight = false;
let sourceEl = els.video; // whichever media element is currently active
let lastSentDims = { width: 0, height: 0 };
let flagThreshold = 0.5;

init();

async function init() {
  bindControls();
  await checkHealth();
  resizeOverlayToContainer();
  window.addEventListener("resize", resizeOverlayToContainer);
}

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    els.keyWarning.hidden = Boolean(data.keyConfigured);
    if (data.model && els.modelPill) {
      els.modelPill.textContent = data.model;
    }
  } catch {
    // Backend might not be running yet on first paint; ignore.
  }
}

function bindControls() {
  els.startWebcam.addEventListener("click", startWebcam);
  els.stopWebcam.addEventListener("click", stopWebcam);
  els.fileInput.addEventListener("change", handleFileUpload);

  els.intervalSlider.addEventListener("input", () => {
    els.intervalValue.textContent = `${Number(els.intervalSlider.value).toFixed(1)}s`;
    if (scanTimer) restartScanLoop();
  });

  els.thresholdSlider.addEventListener("input", () => {
    flagThreshold = Number(els.thresholdSlider.value) / 100;
    els.thresholdValue.textContent = `${els.thresholdSlider.value}%`;
  });
}

/* ---------------- Webcam ---------------- */

async function startWebcam() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (err) {
    logEntry("error", `Camera access denied or unavailable (${err.name}).`);
    return;
  }

  els.video.srcObject = stream;
  els.video.hidden = false;
  els.stillImage.hidden = true;
  els.viewportEmpty.hidden = true;
  sourceEl = els.video;

  els.startWebcam.hidden = true;
  els.stopWebcam.hidden = false;

  await els.video.play();
  resizeOverlayToContainer();
  restartScanLoop();
}

function stopWebcam() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  clearInterval(scanTimer);
  scanTimer = null;
  setSweep(false);
  els.startWebcam.hidden = false;
  els.stopWebcam.hidden = true;
  els.video.hidden = true;
  els.viewportEmpty.hidden = false;
  clearOverlay();
  setStatus("idle", "Idle");
}

function restartScanLoop() {
  clearInterval(scanTimer);
  const seconds = Number(els.intervalSlider.value);
  scanTimer = setInterval(() => runScan(els.video), seconds * 1000);
  runScan(els.video);
}

/* ---------------- Upload ---------------- */

function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  stopWebcam();

  const url = URL.createObjectURL(file);
  els.stillImage.onload = () => {
    URL.revokeObjectURL(url);
    els.stillImage.hidden = false;
    els.viewportEmpty.hidden = true;
    sourceEl = els.stillImage;
    resizeOverlayToContainer();
    runScan(els.stillImage);
  };
  els.stillImage.src = url;
}

/* ---------------- Capture + send ---------------- */

function naturalSize(el) {
  if (el === els.video) return { w: el.videoWidth, h: el.videoHeight };
  return { w: el.naturalWidth, h: el.naturalHeight };
}

// Downscale + compress until the base64 payload is comfortably under the
// API's ~200KB inline limit.
function captureFrame(el, maxWidth = 480, startQuality = 0.75) {
  const { w, h } = naturalSize(el);
  if (!w || !h) return null;

  const scale = Math.min(1, maxWidth / w);
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  canvas.getContext("2d").drawImage(el, 0, 0, cw, ch);

  let quality = startQuality;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);

  while (dataUrl.length * 0.75 > 190 * 1024 && quality > 0.3) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  return { dataUrl, width: cw, height: ch };
}

async function runScan(el) {
  if (inFlight) return;
  const frame = captureFrame(el);
  if (!frame) return;

  inFlight = true;
  lastSentDims = { width: frame.width, height: frame.height };
  setSweep(true);
  setStatus("scanning", "Scanning…");

  try {
    const res = await fetch("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: frame.dataUrl }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    renderScanResult(data);
  } catch (err) {
    console.error(err);
    setStatus("error", "Error");
    logEntry("error", err.message || "Request failed.");
    checkHealth();
  } finally {
    inFlight = false;
    setSweep(false);
  }
}

/* ---------------- Response processing & Rendering ---------------- */

function renderScanResult(data) {
  clearOverlay();

  // 1. Update forensic reasoning readout
  if (els.forensicReasoning) {
    els.forensicReasoning.dataset.verdict = data.verdict || "inconclusive";
    els.forensicReasoning.textContent = data.reasoning || "Analysis complete.";
  }

  // 2. Handle no-face scenario
  if (!data.has_face || !Array.isArray(data.faces) || data.faces.length === 0) {
    els.faceList.innerHTML = `<p class="muted">No human face detected in this frame.</p>`;
    setStatus("idle", "No face");
    logEntry("authentic", `Frame analyzed — No face detected.`);
    return;
  }

  // 3. Process detected faces
  const faces = data.faces.map((item, i) => {
    const box = item.box || item.bounding_box || {};
    const x0 = box.x_min ?? 0;
    const y0 = box.y_min ?? 0;
    const x1 = box.x_max ?? 1;
    const y1 = box.y_max ?? 1;

    const label = (item.verdict || data.verdict || "inconclusive").toLowerCase();
    const score = typeof item.confidence === "number" ? item.confidence : (data.confidence ?? 0.5);

    const isFake = label.includes("fake") || label.includes("flagged") || label.includes("synthetic");
    const isReal = label.includes("real") || label.includes("authentic");
    const verdict = isFake
      ? "flagged"
      : isReal
        ? "authentic"
        : (score >= flagThreshold ? "flagged" : "authentic");

    return {
      id: item.id ?? i,
      x0: Number(x0) || 0,
      y0: Number(y0) || 0,
      x1: Number(x1) || 0,
      y1: Number(y1) || 0,
      verdict,
      confidence: Number(score) || 0,
      details: item.details || ""
    };
  });

  const anyFlagged = faces.some((f) => f.verdict === "flagged") || data.verdict === "flagged";
  setStatus(anyFlagged ? "flagged" : "authentic", anyFlagged ? "Flagged" : "Looks authentic");

  els.faceList.innerHTML = "";
  faces.forEach((face) => {
    const row = document.createElement("div");
    row.className = "face-row";
    row.dataset.verdict = face.verdict;
    row.innerHTML = `
      <div class="face-row-header">
        <span>Face ${face.id + 1}</span>
        <span class="score">${(face.confidence * 100).toFixed(0)}%</span>
        <span class="verdict">${face.verdict === "flagged" ? "FLAGGED" : "AUTHENTIC"}</span>
      </div>
      ${face.details ? `<div class="face-details">${escapeHtml(face.details)}</div>` : ""}
    `;
    els.faceList.appendChild(row);
    drawBox(face);
  });

  const topConfidence = Math.max(...faces.map((f) => f.confidence), data.confidence || 0);
  logEntry(
    anyFlagged ? "flagged" : "authentic",
    `${faces.length} face${faces.length > 1 ? "s" : ""} — ${
      anyFlagged ? "possible deepfake" : "clean"
    } (${(topConfidence * 100).toFixed(0)}%)`
  );
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

function drawBox(face) {
  const rect = containedRect();
  if (!rect || !lastSentDims.width) return;

  const sx = rect.w / lastSentDims.width;
  const sy = rect.h / lastSentDims.height;

  // Coordinates may already be normalized (0–1); detect and scale accordingly.
  const norm = face.x1 <= 1 && face.y1 <= 1;
  const x0 = norm ? face.x0 * lastSentDims.width : face.x0;
  const y0 = norm ? face.y0 * lastSentDims.height : face.y0;
  const x1 = norm ? face.x1 * lastSentDims.width : face.x1;
  const y1 = norm ? face.y1 * lastSentDims.height : face.y1;

  const px = rect.x + x0 * sx;
  const py = rect.y + y0 * sy;
  const pw = (x1 - x0) * sx;
  const ph = (y1 - y0) * sy;

  ctx.lineWidth = 2;
  ctx.strokeStyle = face.verdict === "flagged" ? "#E2604C" : "#4FBFA8";
  ctx.strokeRect(px, py, pw, ph);

  const label = `${face.verdict === "flagged" ? "FLAGGED" : "AUTHENTIC"} ${(face.confidence * 100).toFixed(0)}%`;
  ctx.font = "12px 'IBM Plex Mono', monospace";
  const textW = ctx.measureText(label).width + 10;
  ctx.fillStyle = face.verdict === "flagged" ? "#E2604C" : "#4FBFA8";
  ctx.fillRect(px, Math.max(0, py - 18), textW, 18);
  ctx.fillStyle = "#0D1012";
  ctx.fillText(label, px + 5, Math.max(12, py - 5));
}

function containedRect() {
  const container = els.overlay;
  const { w, h } = naturalSize(sourceEl);
  if (!w || !h) return null;

  const cw = container.width;
  const ch = container.height;
  const mediaRatio = w / h;
  const boxRatio = cw / ch;

  let rw, rh;
  if (mediaRatio > boxRatio) {
    rw = cw;
    rh = cw / mediaRatio;
  } else {
    rh = ch;
    rw = ch * mediaRatio;
  }
  return { x: (cw - rw) / 2, y: (ch - rh) / 2, w: rw, h: rh };
}

function resizeOverlayToContainer() {
  const box = els.overlay.parentElement.getBoundingClientRect();
  els.overlay.width = box.width;
  els.overlay.height = box.height;
}

function clearOverlay() {
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
}

function setSweep(active) {
  els.sweep.classList.toggle("active", active);
}

function setStatus(state, text) {
  els.statusPill.dataset.state = state;
  els.statusText.textContent = text;
}

function logEntry(verdict, message) {
  const row = document.createElement("div");
  row.className = "log-entry";
  row.dataset.verdict = verdict;
  const t = new Date().toLocaleTimeString();
  row.innerHTML = `<span class="t">${t}</span><span class="v">${message}</span>`;
  els.log.prepend(row);
  while (els.log.children.length > 60) {
    els.log.removeChild(els.log.lastChild);
  }
}
