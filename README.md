# PrintMate 🖨️
> **Contactless Self-Service Print Vending Machine (PVM)**
> Real-time hardware synchronization, ephemeral zero-trace privacy shredder, and instant mobile-to-printer dispatch.

---

## 📁 Repository Structure

```
printMate/
│
├── backend/                       # 🚀 DEPLOY TO RENDER
│   ├── lib/
│   │   ├── hardware.js            # USB & Wi-Fi supply monitors (Paper trays, CMYK ink)
│   │   ├── printer.js             # Windows Print Spooler execution & simulation
│   │   ├── sessions.js            # Ephemeral 5-min sessions & zero-trace shredder
│   │   └── network.js             # Network IP discovery
│   ├── uploads/                   # Ephemeral upload folder (auto-wiped upon print)
│   ├── .env.example               # Render environment variables template
│   ├── package.json               # Backend dependencies
│   ├── render.yaml                # Render Blueprint deployment specification
│   ├── server.js                  # Express API + Socket.IO server
│   └── test-e2e.js                # 9-step automated verification suite
│
├── frontend/                      # ⚡ DEPLOY TO VERCEL
│   ├── css/
│   │   ├── kiosk.css              # Minimal dark-mode Kiosk styles
│   │   └── mobile.css             # Touch-optimized mobile web app styles
│   ├── js/
│   │   ├── config.js              # Production Render URL configuration
│   │   ├── kiosk.js               # Kiosk display controller (QR, status, modal)
│   │   └── mobile.js              # Page counter, dynamic cost estimator, payment
│   ├── index.html                 # Default Kiosk entry point
│   ├── kiosk.html                 # Kiosk screen display
│   ├── mobile.html                # Customer mobile upload & pay screen
│   └── vercel.json                # Vercel URL rewrite rules (/kiosk and /session/:id)
│
├── local-agent/                   # 🖨️ RUNS ON LAPTOP (CONNECTED TO USB PRINTER)
│   ├── .env.example               # Agent environment template
│   ├── agent.js                   # WebSocket bridge receiving cloud jobs & printing via USB
│   └── package.json               # Lightweight socket.io-client dependency
│
└── package.json                   # Root package runner scripts
```

---

## 🌐 Real-Time Cloud Deployment (Render + Vercel)

### Step 1: Deploy Backend on [Render](https://render.com)
1. Push this repository to GitHub.
2. Go to **Render Dashboard** > **New +** > **Web Service**.
3. Connect your repository and configure:
   - **Root Directory**: `backend`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
4. Under **Environment Variables**, add:
   - `FRONTEND_URL`: `https://your-printmate.vercel.app` (your Vercel URL from Step 2)
5. Click **Deploy Web Service**. You will receive your backend URL:
   `https://printmate-backend.onrender.com`

---

### Step 2: Deploy Frontend on [Vercel](https://vercel.com)
1. Open [`frontend/js/config.js`](file:///c:/Users/Madhusudhanreddy/OneDrive/Desktop/printMate/frontend/js/config.js) and update with your live Render URL:
   ```javascript
   window.PRINTMATE_CONFIG = {
     BACKEND_URL: 'https://printmate-backend.onrender.com'
   };
   ```
2. Go to **Vercel Dashboard** > **Add New...** > **Project**.
3. Select your repository:
   - Set **Root Directory** to `frontend`.
   - **Framework Preset**: `Other`.
4. Click **Deploy**. Your frontend is live at:
   `https://your-printmate.vercel.app`

---

### Step 3: Run the Local Hardware Agent (With USB Printer)
On the laptop connected to your physical printer:
```powershell
cd local-agent
npm install
$env:BACKEND_URL="https://printmate-backend.onrender.com"; node agent.js
```
The agent establishes a secure WebSocket connection to your Render cloud backend. When a customer pays on mobile, the document is streamed to the laptop, printed via Windows Spooler, and deleted immediately after.

---

## 💻 Local Testing & Development

Run both backend and frontend locally on your laptop:
```bash
npm run backend
```
- Open Kiosk: `http://localhost:3000/kiosk`
- Scan QR code or open: `http://localhost:3000/kiosk/<session-id>`
- Run Test Suite: `npm test`
