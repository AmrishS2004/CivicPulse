# 🏛️ CivicPulse — AI-Powered Civic Intelligence Platform

> **Where government policy meets citizen voice — AI bridges the gap, understands both sides, and delivers an informed decision.**

[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![InsForge](https://img.shields.io/badge/DB-InsForge-purple)](https://insforge.app)
[![TinyFish](https://img.shields.io/badge/Research-TinyFish-teal)](https://tinyfish.ai)

---

## 📌 What is CivicPulse?

CivicPulse is a full-stack civic engagement platform that connects **government officers** with **citizens** in real time. Governments post policy surveys, citizens respond in free text, and an AI pipeline analyses the data — understanding government intent, citizen emotions, conflicts, and proposing **win-win solutions**.

### Key Highlights
- **Two-portal system** — Government Portal (dark theme) and Citizen Portal (light theme)
- **AI Decision Report** — sentiment breakdown, conflict analysis, win-win solution, course of action, statistics
- **InsForge cloud database** — all data persists across sessions
- **TinyFish web research** — real-world policy precedents from Wikipedia
- **JWT authentication** — bcrypt-hashed passwords, 7-day tokens
- **PDF/DOCX upload** — government can attach policy documents (up to 15,000 chars extracted)

---

## 🏗️ Architecture

```
CivicPulse/
├── server.js          ← Express backend (API + AI pipeline)
├── public/
│   └── index.html     ← Full frontend (both portals, single file)
├── .env.example       ← Environment config template
├── package.json       ← Dependencies
└── LICENSE
```

### Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Frontend | Vanilla HTML/CSS/JS (single-page) |
| Database | InsForge (cloud PostgreSQL REST API) |
| AI Analysis | In-server sentiment engine |
| Web Research | TinyFish AI (Wikipedia scraping) |
| AI Proxy | Anthropic Claude (via /api/ai) |
| Auth | JWT + bcryptjs |
| File Upload | multer + pdf-parse + mammoth |

---

## 🚀 Quick Start

### 1. Clone & Install
```bash
git clone https://github.com/AmrishS2004/CivicPulse.git
cd CivicPulse
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Open `.env` and fill in your keys:

| Variable | Where to Get |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `INSFORGE_URL` | [insforge.app](https://insforge.app) → Create Project → copy URL |
| `INSFORGE_ADMIN_KEY` | InsForge → Settings → API Keys |
| `TINYFISH_API_KEY` | [tinyfish.ai](https://tinyfish.ai) — 500 free steps |
| `JWT_SECRET` | Any long random string |
| `GOV_CREDENTIALS` | `username:password` pairs, comma-separated |

### 3. Start
```bash
npm start          # production
npm run dev        # development (auto-reload with nodemon)
```

### 4. Open
Visit **http://localhost:3000**

You should see:
```
✅ InsForge ready
🏛️ CivicPulse → http://localhost:3000
   AI:       ✅ Claude
   Backend:  ✅ InsForge
   Research: ✅ TinyFish
```

---

## 🔐 Government Login

Government credentials are pre-configured in `.env` via `GOV_CREDENTIALS`. No self-registration is allowed for the government portal.

Default credentials (change in `.env`):
```
gov_admin     / Admin@2024
gov_officer   / Officer@2024
ministry_lead / Ministry@2024
```

---

## 📊 Database

CivicPulse auto-creates four tables in InsForge on startup:

| Table | Purpose |
|---|---|
| `cp_users` | Citizen accounts (bcrypt hashed passwords) |
| `cp_surveys` | Government surveys + uploaded document text |
| `cp_responses` | Citizen free-text responses |
| `cp_analysis` | AI analysis stored as 20 chunked string columns |

---

## 🤖 AI Analysis Pipeline

When the target response count is reached (or manually triggered):

1. **Fetch** — pulls fresh survey + responses from InsForge
2. **Extract** — parses uploaded policy document from `context_json`
3. **Research** — TinyFish browses Wikipedia for real-world policy precedents
4. **Analyse** — sentiment engine classifies each response (support / neutral / oppose)
5. **Report** — builds 14-section decision report with win-win solution
6. **Save** — chunks JSON into InsForge `cp_analysis` table (persists across restarts)

### AI Decision Report includes:
- ⚖️ Final Decision
- 📊 Citizen Sentiment Breakdown (visual bar with %)
- ⚡ Conflict Analysis
- 🏆 Win-Win Solution
- 🗺️ Recommended Course of Action
- 📈 Statistics & Comparable Cases
- 💡 Alternative Approaches
- ✅ Pros & ❌ Cons

---

## 🌐 API Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/register` | None | Register citizen |
| POST | `/api/auth/login` | None | Citizen login |
| POST | `/api/auth/gov-login` | None | Government login |
| GET | `/api/surveys` | None | List all surveys |
| POST | `/api/surveys` | Gov | Create survey |
| GET | `/api/responses/:id` | None | Get responses |
| POST | `/api/responses` | Citizen | Submit response |
| POST | `/api/upload-doc` | Gov | Upload PDF/DOCX |
| POST | `/api/admin/trigger-analysis/:id` | Gov | Manually trigger analysis |
| GET | `/api/config/status` | None | Service health check |

---

## 📦 Dependencies

```bash
npm install              # installs everything from package.json
```

Core: `express`, `cors`, `dotenv`, `node-fetch`, `bcryptjs`, `jsonwebtoken`, `multer`, `pdf-parse`, `mammoth`

---

## 👤 Author

**Amrish Sasikumar**
- Email: amrish.s2004p@gmail.com
- LinkedIn: [linkedin.com/in/amrish-sasikumar](https://linkedin.com/in/amrish-sasikumar)

---

## 📄 License

MIT License — see [LICENSE](LICENSE)
