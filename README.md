# Deepfake Scanner

A web app that scans a webcam feed or an uploaded photo for face
manipulation and synthetic artifacts, using NVIDIA's hosted **`meta/llama-3.2-11b-vision-instruct`**
model on build.nvidia.com. It draws bounding boxes and confidence scores over
detected faces, explains forensic cues (skin texture, lighting, artifacts), and keeps a running scan log.

```
┌────────────┐   frame every N sec   ┌──────────────┐   image (base64)   ┌────────────────────────┐
│  Browser   │ ────────────────────▶ │ Node/Express │ ─────────────────▶ │ integrate.api.nvidia.com │
│ (webcam/   │ ◀──────────────────── │   server     │ ◀───────────────── │ meta/llama-3.2-11b-      │
│  upload)   │   boxes + analysis    │ (holds key)  │   forensic JSON    │ vision-instruct          │
└────────────┘                       └──────────────┘                    └────────────────────────┘
```

## Why a backend at all?

The NVIDIA API key must stay secret, and the endpoint doesn't allow
browser-based CORS calls with an exposed key. So the browser talks only to
a tiny local Express server, which forwards the frame to NVIDIA and relays
the result back. This also means you can swap in a different provider later
without touching the frontend.

## Setup

1. **Get an API key** — go to
   [build.nvidia.com](https://build.nvidia.com),
   sign in, and click "Get API Key" (NVIDIA provides free evaluation credits for developers).
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Add your key**
   ```bash
   cp .env.example .env
   # then edit .env and paste your key into NVIDIA_API_KEY=
   ```
4. **Run it**
   ```bash
   npm start
   ```
   Open `http://localhost:3000`.

## Using it

- **Start webcam** samples a frame every N seconds (adjustable 1–5s) and
  sends it for analysis. This is *near*-real-time, not frame-by-frame video
  analysis — see "About 'real-time'" below.
- **Upload image** analyzes a single photo.
- **Flag threshold** controls the confidence level (for detections that
  don't already return an explicit real/fake label) above which a face is
  marked "FLAGGED" instead of "AUTHENTIC".

## About "real-time"

True frame-by-frame video analysis (24–30 fps) against a cloud API isn't
realistic — network round-trips and model inference add up to hundreds of
milliseconds per call, and most providers rate-limit hosted endpoints. This
app instead **samples** the webcam every 1–5 seconds, which is a reasonable
and honest interpretation of "real-time" for a browser-based tool. If you
need true low-latency video inference:

- Run the model **locally** via NVIDIA's downloadable NIM container
  (the [deploy tab](https://build.nvidia.com/hive/deepfake-image-detection/deploy)
  on the model page has the Docker command) on a machine with an NVIDIA GPU —
  this removes network latency and rate limits entirely. Point `server.js`
  at `http://localhost:8003/v1/infer` instead of the hosted URL.
- Or reduce the sampling interval and accept the added API cost/latency.

## About accuracy — please read

- This is a **single detector's probabilistic score**, not a forensic proof.
  Deepfake detectors — this one included — have known blind spots: they can
  be fooled by re-encoding, compression, unusual lighting, low resolution,
  or newer generation techniques not in their training data, and they can
  also flag genuine images (false positives), especially at low resolution
  or unusual angles.
- Treat mid-range confidence scores (roughly 35–65%) as **inconclusive**,
  not a verdict either way.
- For anything with real consequences (legal, journalistic, safety-related),
  corroborate with source verification, metadata/provenance checks (e.g.
  C2PA content credentials), and human judgement — don't rely on a single
  model's output.

## Adjusting the parser

NVIDIA's exact JSON response shape for this endpoint can change between API
versions, and wasn't fully documented at the time this was built. `app.js`'s
`normalizeDetections()` function tries several common shapes for the
bounding box and classification fields. If boxes don't appear or look
misaligned:

1. Open the browser console — on an error it logs the raw response.
2. Compare the field names to the current schema at
   [docs.api.nvidia.com/nim/reference/hive-deepfake-image-detection-infer](https://docs.api.nvidia.com/nim/reference/hive-deepfake-image-detection-infer).
3. Adjust the key names in `normalizeDetections()` accordingly.

## Extending it ("and other")

A few natural next steps if you want to go further:

- **Video-file upload**: sample frames from an uploaded `.mp4` on a canvas
  (same `captureFrame()` path already used for webcam/photos) instead of
  just live webcam + still images.
- **Second opinion**: also call NVIDIA's `hive/ai-generated-image-detection`
  model (same API pattern) for a separate "is this AI-generated at all"
  signal alongside the face-specific deepfake score.
- **Provenance check**: look for C2PA content-credential metadata on
  uploaded files as a complementary, non-ML signal.
- **Persistence**: log scans to a database if you need an audit trail.

## Project structure

```
deepfake-detector/
├── server.js        # Express backend, proxies to NVIDIA, hides the API key
├── package.json
├── .env.example
└── public/
    ├── index.html    # layout
    ├── style.css     # design system
    └── app.js        # webcam/upload capture, API calls, overlay drawing
```
