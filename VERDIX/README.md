# VERDIX – AI-Based Smart Waste Sorting and Management System

Webcam → Node.js/Express → Groq Vision AI → classification (PLASTIC / PAPER / METAL / ORGANIC / UNKNOWN) → user confirms → ESP32 over Wi-Fi → 3 MG90S servos → correct bin.

## Install & run locally
```bash
npm install
cp .env.example .env     # then edit .env
npm start                # http://localhost:3000
```

## Environment variables
| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq key (server only, required) |
| `GROQ_MODEL` | Optional vision model (default `meta-llama/llama-4-scout-17b-16e-instruct`) |
| `ESP32_URL` | e.g. `http://192.168.1.50`. Empty = simulation mode |
| `PORT` | Defaults to 3000 |

## Get a Groq API key
Sign in at https://console.groq.com → API Keys → Create API Key → paste into `.env` as `GROQ_API_KEY`. If the default model is retired, check Groq's docs for a current vision model and set `GROQ_MODEL`.

## Camera access
Works on `localhost` or HTTPS (Render is HTTPS). Click **Start Camera** and choose *Allow*. If blocked, click the lock icon in the address bar → Camera → Allow. Use the dropdown to switch between built-in and USB webcams.

## Connect the ESP32
1. Put the ESP32 on the same Wi-Fi as the machine running the server.
2. Set `ESP32_URL=http://<esp32-ip>` in `.env`.
3. Expose `POST /sort` on the ESP32:
```
POST http://ESP32_IP/sort
Content-Type: application/json
{"material": "PLASTIC"}
```
Reply with HTTP 200. Mapping: PLASTIC→Bin 1, PAPER→Bin 2, METAL→Bin 3, ORGANIC→Bin 4.

**Note:** a Render-hosted server cannot reach an ESP32 on your private LAN (192.168.x.x). For the exhibition, run the server locally, or expose the ESP32 through a tunnel.

## Deploy (GitHub → Render backend + Netlify frontend)
Everything lives in this one repo/folder. Push it to GitHub once, then connect it to both services.

**1. Backend on Render**
- New → Web Service → select the repo (Root Directory empty).
- Build command: `npm install` · Start command: `npm start`
- Environment variables: `GROQ_API_KEY`, `FRONTEND_URL` (your Netlify URL, no trailing slash), optional `ESP32_URL`.
- After deploy, copy the URL (e.g. `https://verdix-api.onrender.com`). Check `/health` returns `ok`.

**2. Frontend on Netlify**
- Edit `public/config.js` and set `window.VERDIX_API_URL = "https://verdix-api.onrender.com";`, commit and push.
- Netlify → Add new site → Import from GitHub → select the repo. `netlify.toml` already sets publish directory `public` and no build command.
- Copy your Netlify URL into Render's `FRONTEND_URL` and redeploy the backend.

Render's free tier sleeps when idle; the first scan after a pause can take ~30 s. Open the site once before your demo.

## Security
**Never put `GROQ_API_KEY` in frontend code or commit it to GitHub.** It lives only in server environment variables. The server validates image format and size (≤4 MB) and material values, and survives an offline ESP32 (5 s timeout).
