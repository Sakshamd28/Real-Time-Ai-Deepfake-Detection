// server.js
// Express backend that:
//  1. Serves the frontend in /public
//  2. Proxies image frames to NVIDIA's hosted Vision LLM (e.g. meta/llama-3.2-11b-vision-instruct)
//     on build.nvidia.com for forensic authenticity and deepfake detection,
//     keeping your API key secure on the server.
//
// Endpoint used: POST https://integrate.api.nvidia.com/v1/chat/completions
// Catalog: https://build.nvidia.com

import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 3000;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_VISION_MODEL =
  process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct";
const NVIDIA_CHAT_ENDPOINT =
  "https://integrate.api.nvidia.com/v1/chat/completions";

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Simple in-memory rate-limiter to prevent hammering the API faster than desired
const MIN_INTERVAL_MS = 600;
let lastRequestAt = 0;

const FORENSIC_SYSTEM_PROMPT = `You are an expert AI forensic analyst and synthetic media detector.
Analyze the provided image carefully.

First, check if any human face is present in the image.
If NO human face is present, return:
{
  "has_face": false,
  "verdict": "inconclusive",
  "confidence": 0,
  "faces": [],
  "reasoning": "No human face detected in the image."
}

If human faces ARE present:
Evaluate whether each face or the overall image is authentic/real or an AI deepfake / synthetic generation.
Look for:
- Blending seams, boundary blur, or distortion around the hairline, jaw, teeth, ears, or eyeglasses
- Eye reflections, iris asymmetry, or unnatural gaze alignment
- Unnatural skin smoothing, plastic/waxy textures, or digital diffusion artifacts
- Inconsistent lighting direction or shadow mismatches between face and background

Return valid JSON with this exact schema:
{
  "has_face": true,
  "verdict": "authentic" | "flagged",
  "confidence": number between 0.0 and 1.0 (probability the image/face is synthetic if flagged, or genuine if authentic),
  "faces": [
    {
      "id": 0,
      "box": { "x_min": float, "y_min": float, "x_max": float, "y_max": float } (normalized between 0.0 and 1.0),
      "verdict": "authentic" | "flagged",
      "confidence": number between 0.0 and 1.0,
      "details": "short explanation of detected forensic cues"
    }
  ],
  "reasoning": "concise forensic explanation (1-2 sentences) of visual artifacts, skin texture, lighting, and authenticity cues"
}

Output ONLY valid JSON. Do not include markdown codeblocks, comments, or extra text.`;

app.post("/api/detect", async (req, res) => {
  if (!NVIDIA_API_KEY) {
    return res.status(500).json({
      error:
        "Server is missing NVIDIA_API_KEY. Add it to a .env file (see .env.example) and restart the server.",
    });
  }

  const { image } = req.body || {};
  if (!image || typeof image !== "string" || !image.startsWith("data:image")) {
    return res.status(400).json({
      error: "Request body must be { image: 'data:image/jpeg;base64,...' }",
    });
  }

  const approxBytes = Math.ceil((image.length * 3) / 4);
  if (approxBytes > 4 * 1024 * 1024) {
    return res.status(413).json({
      error: "Image is too large (must be under ~4MB).",
    });
  }

  const now = Date.now();
  if (now - lastRequestAt < MIN_INTERVAL_MS) {
    return res.status(429).json({ error: "Throttled, slow down slightly." });
  }
  lastRequestAt = now;

  try {
    const upstream = await fetch(NVIDIA_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: NVIDIA_VISION_MODEL,
        messages: [
          { role: "system", content: FORENSIC_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Analyze this image for deepfake or synthetic generation cues.",
              },
              {
                type: "image_url",
                image_url: { url: image },
              },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 450,
      }),
    });

    const rawText = await upstream.text();
    let upstreamData;
    try {
      upstreamData = JSON.parse(rawText);
    } catch {
      upstreamData = { raw: rawText };
    }

    if (!upstream.ok) {
      console.error("NVIDIA API error:", upstream.status, upstreamData);
      return res.status(upstream.status).json({
        error: "NVIDIA API returned an error.",
        status: upstream.status,
        detail: upstreamData,
      });
    }

    const messageContent =
      upstreamData?.choices?.[0]?.message?.content?.trim() || "";

    // Parse JSON from model response (cleaning any markdown code ticks if present)
    let parsedResult;
    try {
      const cleanJson = messageContent
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      parsedResult = JSON.parse(cleanJson);
    } catch {
      // Regex extraction fallback
      const jsonMatch = messageContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsedResult = JSON.parse(jsonMatch[0]);
        } catch {
          parsedResult = null;
        }
      }
    }

    if (!parsedResult) {
      parsedResult = {
        has_face: true,
        verdict: "inconclusive",
        confidence: 0.5,
        faces: [],
        reasoning: messageContent || "Model response could not be parsed as structured JSON.",
      };
    }

    parsedResult.model = NVIDIA_VISION_MODEL;
    res.json(parsedResult);
  } catch (err) {
    console.error("Upstream call failed:", err);
    res.status(502).json({
      error: "Could not reach NVIDIA API.",
      detail: String(err),
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    keyConfigured: Boolean(NVIDIA_API_KEY),
    model: NVIDIA_VISION_MODEL,
  });
});

app.listen(PORT, () => {
  console.log(`Deepfake detector running at http://localhost:${PORT}`);
  console.log(`Using NVIDIA Vision Model: ${NVIDIA_VISION_MODEL}`);
  if (!NVIDIA_API_KEY) {
    console.warn(
      "WARNING: NVIDIA_API_KEY is not set. Copy .env.example to .env and add your key."
    );
  }
});
