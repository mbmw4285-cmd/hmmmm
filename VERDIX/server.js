require('dotenv').config();
const express = require('express');
const path = require('path');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const MATERIALS = ['PLASTIC', 'PAPER', 'METAL', 'ORGANIC'];
const MODEL = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // Groq limit for base64 images is 4MB
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// CORS: lets the Netlify frontend call this Render backend. Set FRONTEND_URL to your Netlify URL.
const ORIGINS = (process.env.FRONTEND_URL || '*').split(',').map(s => s.trim().replace(/\/+$/, ''));
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (ORIGINS.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (o && ORIGINS.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/health', (req, res) => res.send('ok'));
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PROMPT = `You are the vision system of a waste-sorting machine. Look at the single waste item in the image and classify its main material into exactly one of: PLASTIC, PAPER, METAL, ORGANIC. If the image is blurry, empty, shows no waste item, or the material cannot be determined, use UNKNOWN.
Reply with ONLY a JSON object:
{"material":"PLASTIC|PAPER|METAL|ORGANIC|UNKNOWN","confidence":0-100,"item":"short item name","reason":"one short sentence"}`;

app.get('/api/status', (req, res) => res.json({
  ai: Boolean(groq),
  esp32: process.env.ESP32_URL ? 'configured' : 'simulation',
}));

app.post('/api/classify', async (req, res) => {
  const image = req.body && req.body.image;
  if (typeof image !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image))
    return res.status(400).json({ error: 'Invalid image. Send a base64 JPEG data URL.' });
  if (Buffer.byteLength(image, 'utf8') > MAX_IMAGE_BYTES)
    return res.status(413).json({ error: 'Image too large (max 4 MB).' });
  if (!groq) return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server.' });

  const models = [...new Set([MODEL, 'meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'qwen/qwen3.6-27b'])];
  let lastErr;
  for (const model of models) {
    try {
      const completion = await groq.chat.completions.create({
        model, temperature: 0.1, max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: image } },
        ] }],
      });
      const raw = completion.choices?.[0]?.message?.content || '{}';
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]); }
      let material = String(parsed.material || '').toUpperCase().trim();
      if (!MATERIALS.includes(material)) material = 'UNKNOWN';
      const confidence = Math.max(0, Math.min(100, Math.round(Number(parsed.confidence) || 0)));
      return res.json({
        material,
        confidence: material === 'UNKNOWN' ? Math.min(confidence, 40) : confidence,
        item: String(parsed.item || 'Unidentified object').slice(0, 80),
        reason: String(parsed.reason || 'No explanation provided.').slice(0, 300),
      });
    } catch (err) {
      lastErr = err;
      console.error(`Groq error [${model}] status=${err.status}:`, err.message);
      const modelProblem = err.status === 404 || /decommission|not found|does not exist|no longer supported|model/i.test(err.message || '');
      if (!modelProblem || err.status === 401 || err.status === 429) break; // try next model only for model problems
    }
  }
  const st = lastErr?.status;
  const msg = st === 401 ? 'Invalid GROQ_API_KEY. Check the key in Render environment variables.'
    : st === 429 ? 'AI rate limit reached. Try again shortly.'
    : 'AI service error: ' + String(lastErr?.message || 'unknown').slice(0, 200);
  res.status(st === 429 ? 429 : 502).json({ error: msg });
});

app.post('/api/sort', async (req, res) => {
  const material = String(req.body?.material || '').toUpperCase();
  if (!MATERIALS.includes(material)) return res.status(400).json({ error: 'Invalid material category.' });
  const label = material[0] + material.slice(1).toLowerCase();
  const base = (process.env.ESP32_URL || '').trim().replace(/\/+$/, '');
  if (!base) return res.json({ ok: true, simulated: true, material, message: `${label} selected – ESP32 simulation mode.` });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${base}/sort`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ material }), signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`ESP32 responded ${r.status}`);
    res.json({ ok: true, simulated: false, material, message: `ESP32 received ${material}. Servo sorting triggered.` });
  } catch (err) {
    console.error('ESP32 error:', err.message);
    res.status(504).json({ ok: false, error: 'ESP32 is offline or unreachable. Check ESP32_URL and Wi-Fi.' });
  } finally { clearTimeout(timer); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`VERDIX running on port ${PORT}`));
