require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fetch    = require('node-fetch');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

let multer, pdfParse, mammoth;
try { multer   = require('multer');    } catch(e) {}
try { pdfParse = require('pdf-parse'); } catch(e) {}
try { mammoth  = require('mammoth');   } catch(e) {}
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } }) : null;

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG ────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY  || '';
const INSFORGE_URL  = (process.env.INSFORGE_URL || '').replace(/\/$/, '');
const INSFORGE_KEY  = process.env.INSFORGE_ADMIN_KEY || '';
const TINYFISH_KEY  = process.env.TINYFISH_API_KEY   || '';
const JWT_SECRET    = process.env.JWT_SECRET || 'civicpulse_secret';

const GOV_CREDS = {};
(process.env.GOV_CREDENTIALS || 'gov_admin:Admin@2024,gov_officer:Officer@2024')
  .split(',').forEach(pair => {
    const [u, p] = pair.trim().split(':');
    if (u && p) GOV_CREDS[u] = p;
  });

const useIF = () => !!(INSFORGE_URL && INSFORGE_KEY);

console.log('\n═══════════════ CivicPulse Config ════════════════');
console.log('  INSFORGE_URL  :', INSFORGE_URL  || '(not set)');
console.log('  INSFORGE_KEY  :', INSFORGE_KEY  ? INSFORGE_KEY.slice(0,12)+'...' : '(not set)');
console.log('  ANTHROPIC_KEY :', ANTHROPIC_KEY ? ANTHROPIC_KEY.slice(0,16)+'...' : '(not set)');
console.log('  useInsForge() :', useIF());
console.log('══════════════════════════════════════════════════\n');

// ── IN-MEMORY FALLBACK ────────────────────────────────────
let mem = { users: [], surveys: [], responses: [] };
let memId = { users: 1, surveys: 1, responses: 1 };
// Analysis cache — keyed by survey id
const analysisCache = {};
const CHUNK_SIZE = 250; // InsForge string column max ~255 chars

// Split a string into chunks
function toChunks(str) {
  const chunks = {};
  for (let i = 0; i < 20; i++) {
    chunks[`chunk_${i}`] = str.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) || null;
  }
  return chunks;
}

// Reassemble chunks back into string
function fromChunks(row) {
  let result = '';
  for (let i = 0; i < 20; i++) {
    if (row[`chunk_${i}`]) result += row[`chunk_${i}`];
    else break;
  }
  return result;
}

// Save analysis to InsForge cp_analysis table
async function saveAnalysisToIF(surveyId, analysisJson) {
  try {
    // Check if record exists
    const existing = await ifGet(`/api/database/records/cp_analysis?survey_id=eq.${encodeURIComponent(surveyId)}`);
    const rows = unwrap(existing);
    const chunks = toChunks(analysisJson);
    const payload = { survey_id: String(surveyId), ...chunks, created_at: new Date().toISOString() };
    if (rows.length > 0) {
      // Update existing
      await ifPatch(`/api/database/records/cp_analysis/${rows[0].id}`, chunks);
      console.log('  ✓ Analysis updated in InsForge cp_analysis');
    } else {
      // Insert new
      await ifPost('/api/database/records/cp_analysis', payload);
      console.log('  ✓ Analysis saved to InsForge cp_analysis');
    }
  } catch(e) {
    console.warn('  ⚠ Could not save analysis to InsForge:', e.message);
  }
}

// Load analysis from InsForge cp_analysis table
async function loadAnalysisFromIF(surveyId) {
  try {
    const raw = await ifGet(`/api/database/records/cp_analysis?survey_id=eq.${encodeURIComponent(surveyId)}`);
    const rows = unwrap(raw);
    if (rows.length > 0) {
      const json = fromChunks(rows[0]);
      if (json && json.length > 10) return json;
    }
  } catch(e) {
    console.warn('  ⚠ Could not load analysis from InsForge:', e.message);
  }
  return null;
}

// ── INSFORGE HELPERS ──────────────────────────────────────
async function ifReq(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${INSFORGE_KEY}` }
  };
  if (body) opts.body = JSON.stringify(body);
  const r    = await fetch(INSFORGE_URL + path, opts);
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}
const ifGet   = p      => ifReq('GET',    p);
const ifPost  = (p, b) => ifReq('POST',   p, b);
const ifPatch = (p, b) => ifReq('PATCH',  p, b);
const ifDel   = p      => ifReq('DELETE', p);

// Unwrap any InsForge list response into a plain array
function unwrap(raw) {
  if (Array.isArray(raw))                    return raw;
  if (raw && Array.isArray(raw.data))        return raw.data;
  if (raw && Array.isArray(raw.records))     return raw.records;
  if (raw && Array.isArray(raw.rows))        return raw.rows;
  if (raw && Array.isArray(raw.results))     return raw.results;
  return [];
}

// Filter records by column value
async function ifWhere(table, col, val) {
  const raw = await ifGet(`/api/database/records/${table}?${col}=eq.${encodeURIComponent(val)}`);
  return unwrap(raw);
}

// ── DB INIT ───────────────────────────────────────────────
async function initDB() {
  if (!useIF()) {
    console.log('⚡ In-memory mode (no InsForge configured)');
    return;
  }
  console.log('🔌 InsForge DB Init...');

  // List existing tables
  let existing = [];
  try {
    const r = await ifGet('/api/database/tables');
    existing = Array.isArray(r) ? r : [];
    console.log('  → Existing tables:', existing.join(', ') || 'none');
  } catch(e) { console.log('  → Could not list tables:', e.message); }

  // InsForge column schema (confirmed from validator errors):
  // { columnName, type, isNullable, isUnique, defaultValue? }
  // Valid types: string, text, integer, boolean, timestamp, uuid
  const c = (columnName, type, isNullable, isUnique, defaultValue) =>
    ({ columnName, type, isNullable, isUnique, ...(defaultValue ? { defaultValue } : {}) });

  // InsForge confirmed valid types: string, integer, boolean, datetime
  // 'text' crashes with sqlType error, 'timestamp' must be 'datetime', 'uuid' → 'string'
  const TABLES = [
    {
      tableName: 'cp_users', rlsEnabled: false,
      columns: [
        c('username',      'string',   false, true),
        c('password_hash', 'string',   false, false),
        c('created_at',    'datetime', true,  false)
      ]
    },
    {
      tableName: 'cp_surveys', rlsEnabled: false,
      columns: [
        c('question',         'string',   false, false),
        c('author',           'string',   false, false),
        c('target_responses', 'integer',  true,  false),
        c('context_json',     'string',   true,  false),
        c('status',           'string',   true,  false),
        c('analysis_json',    'string',   true,  false),
        c('published_at',     'datetime', true,  false)
      ]
    },
    {
      tableName: 'cp_responses', rlsEnabled: false,
      columns: [
        c('survey_id',    'string',   false, false),
        c('username',     'string',   false, false),
        c('answer',       'string',   false, false),
        c('submitted_at', 'datetime', true,  false)
      ]
    },
    {
      tableName: 'cp_analysis', rlsEnabled: false,
      columns: [
        c('survey_id',    'string',   false, true),
        c('chunk_0',      'string',   true,  false),
        c('chunk_1',      'string',   true,  false),
        c('chunk_2',      'string',   true,  false),
        c('chunk_3',      'string',   true,  false),
        c('chunk_4',      'string',   true,  false),
        c('chunk_5',      'string',   true,  false),
        c('chunk_6',      'string',   true,  false),
        c('chunk_7',      'string',   true,  false),
        c('chunk_8',      'string',   true,  false),
        c('chunk_9',      'string',   true,  false),
        c('chunk_10',     'string',   true,  false),
        c('chunk_11',     'string',   true,  false),
        c('chunk_12',     'string',   true,  false),
        c('chunk_13',     'string',   true,  false),
        c('chunk_14',     'string',   true,  false),
        c('chunk_15',     'string',   true,  false),
        c('chunk_16',     'string',   true,  false),
        c('chunk_17',     'string',   true,  false),
        c('chunk_18',     'string',   true,  false),
        c('chunk_19',     'string',   true,  false),
        c('created_at',   'datetime', true,  false)
      ]
    }
  ];

  // Always drop our tables to ensure correct column types (text for long fields)
  for (const t of ['cp_analysis', 'cp_responses', 'cp_surveys', 'cp_users']) {
    if (existing.includes(t)) {
      try {
        await ifDel(`/api/database/tables/${t}`);
        console.log(`  ✓ Dropped: ${t}`);
      } catch(e) { console.log(`  ~ Could not drop ${t}: ${e.message}`); }
    }
  }

  // Recreate with correct types
  for (const t of TABLES) {
    try {
      const r = await ifPost('/api/database/tables', t);
      if (r && r.error) {
        console.error(`  ✗ ${t.tableName}: ${r.message || JSON.stringify(r).slice(0,150)}`);
      } else {
        console.log(`  ✓ Created: ${t.tableName}`);
      }
    } catch(e) { console.error(`  ✗ ${t.tableName}:`, e.message); }
  }
  console.log('✅ InsForge ready\n');
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── CITIZEN REGISTER ──────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    // Check duplicate
    if (useIF()) {
      const rows = await ifWhere('cp_users', 'username', username);
      if (rows.length > 0) return res.status(409).json({ error: 'Username already taken' });
    } else {
      if (mem.users.find(u => u.username === username))
        return res.status(409).json({ error: 'Username already taken' });
    }
    const hash = await bcrypt.hash(password, 10);
    if (useIF()) {
      const r = await ifPost('/api/database/records/cp_users', { username, password_hash: hash });
      console.log(`✓ Registered: ${username} →`, JSON.stringify(r).slice(0,100));
      if (r && (r.code || r.error)) throw new Error(r.message || JSON.stringify(r));
    } else {
      mem.users.push({ id: memId.users++, username, password_hash: hash });
    }
    // Auto-login — return token immediately
    const token = jwt.sign({ username, role: 'citizen' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, username });
  } catch(e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Registration failed: ' + e.message });
  }
});

// ── CITIZEN LOGIN ─────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  console.log(`🔐 Login: "${username}"`);
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });
  try {
    let user;
    if (useIF()) {
      const rows = await ifWhere('cp_users', 'username', username);
      console.log(`  → InsForge lookup: ${rows.length} row(s)`);
      user = rows[0] || null;
    } else {
      user = mem.users.find(u => u.username === username) || null;
    }
    if (!user) return res.status(401).json({ error: 'User not found. Please register first.' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });
    const token = jwt.sign({ username, role: 'citizen' }, JWT_SECRET, { expiresIn: '7d' });
    console.log(`  ✓ Login success: "${username}"`);
    res.json({ token, username });
  } catch(e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Login failed: ' + e.message });
  }
});

// ── GOVERNMENT LOGIN ──────────────────────────────────────
app.post('/api/auth/gov-login', (req, res) => {
  const { username, password } = req.body;
  if (!GOV_CREDS[username] || GOV_CREDS[username] !== password)
    return res.status(401).json({ error: 'Invalid government credentials' });
  const token = jwt.sign({ username, role: 'government' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username });
});

// ── GET ALL SURVEYS ───────────────────────────────────────
app.get('/api/surveys', async (req, res) => {
  try {
    let surveys;
    if (useIF()) {
      const raw = await ifGet('/api/database/records/cp_surveys');
      surveys = unwrap(raw);
      console.log(`📋 GET surveys → ${surveys.length} rows`);
      // Inject analysis — from memory cache first, then load from InsForge if missing
      for (let i = 0; i < surveys.length; i++) {
        const sv = surveys[i];
        if (analysisCache[sv.id]) {
          surveys[i] = { ...sv, analysis_json: analysisCache[sv.id] };
        } else if (sv.status === 'complete') {
          // Not in memory cache — load from InsForge
          const stored = await loadAnalysisFromIF(sv.id);
          if (stored) {
            analysisCache[sv.id] = stored; // re-cache
            surveys[i] = { ...sv, analysis_json: stored };
            console.log(`  ✓ Loaded analysis from InsForge for survey ${sv.id}`);
          }
        }
      }
    } else {
      surveys = mem.surveys;
    }
    res.json(surveys);
  } catch(e) {
    console.error('GET surveys:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST SURVEY (gov only) ────────────────────────────────
app.post('/api/surveys', auth, async (req, res) => {
  if (req.user.role !== 'government')
    return res.status(403).json({ error: 'Government only' });
  try {
    const sv = {
      question:         req.body.question,
      author:           req.user.username,
      target_responses: req.body.target_responses || 10,
      status:           'active',
      published_at:     new Date().toISOString()
    };
    if (req.body.context_json) sv.context_json = req.body.context_json;

    let saved;
    if (useIF()) {
      const raw = await ifPost('/api/database/records/cp_surveys', sv);
      console.log(`  → Survey insert raw:`, JSON.stringify(raw).slice(0, 200));
      if (raw && (raw.code || raw.error)) throw new Error(raw.message || JSON.stringify(raw));
      // Extract saved record
      if      (Array.isArray(raw) && raw[0])            saved = raw[0];
      else if (raw && raw.data && Array.isArray(raw.data)) saved = raw.data[0];
      else if (raw && raw.data)                          saved = raw.data;
      else if (raw && raw.id)                            saved = raw;
      else                                               saved = { ...sv, id: 'local_' + Date.now() };
    } else {
      sv.id = memId.surveys++;
      mem.surveys.push(sv);
      saved = sv;
    }
    console.log(`✓ Survey posted by ${req.user.username}: "${sv.question.slice(0,50)}" id=${saved.id}`);
    res.json(saved);
  } catch(e) {
    console.error('POST survey:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH SURVEY ──────────────────────────────────────────
app.patch('/api/surveys/:id', auth, async (req, res) => {
  if (req.user.role !== 'government') return res.status(403).json({ error: 'Forbidden' });
  try {
    if (useIF()) {
      await ifPatch(`/api/database/records/cp_surveys/${req.params.id}`, req.body);
    } else {
      const s = mem.surveys.find(s => s.id == req.params.id);
      if (s) Object.assign(s, req.body);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET RESPONSES ─────────────────────────────────────────
app.get('/api/responses/:surveyId', async (req, res) => {
  try {
    let responses;
    if (useIF()) {
      const raw = await ifGet(`/api/database/records/cp_responses?survey_id=eq.${encodeURIComponent(req.params.surveyId)}`);
      responses = unwrap(raw);
    } else {
      responses = mem.responses.filter(r => r.survey_id == req.params.surveyId);
    }
    res.json(responses);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST RESPONSE (citizen) ───────────────────────────────
app.post('/api/responses', auth, async (req, res) => {
  const { survey_id, answer } = req.body;
  const username = req.user.username;
  if (!answer || !answer.trim()) return res.status(400).json({ error: 'Answer cannot be empty' });
  try {
    // Duplicate check
    if (useIF()) {
      const raw = await ifGet(`/api/database/records/cp_responses?survey_id=eq.${survey_id}&username=eq.${encodeURIComponent(username)}`);
      if (unwrap(raw).length > 0) return res.status(409).json({ error: 'Already responded' });
    } else {
      if (mem.responses.some(r => r.survey_id == survey_id && r.username === username))
        return res.status(409).json({ error: 'Already responded' });
    }

    const resp = { survey_id: String(survey_id), username, answer, submitted_at: new Date().toISOString() };
    if (useIF()) {
      const r = await ifPost('/api/database/records/cp_responses', resp);
      if (r && (r.code || r.error)) throw new Error(r.message || JSON.stringify(r));
    } else {
      resp.id = memId.responses++;
      mem.responses.push(resp);
    }

    // Check if target reached
    let allResp;
    if (useIF()) {
      const raw = await ifGet(`/api/database/records/cp_responses?survey_id=eq.${survey_id}`);
      allResp = unwrap(raw);
    } else {
      allResp = mem.responses.filter(r => r.survey_id == survey_id);
    }

    let survey;
    if (useIF()) {
      const raw = await ifGet(`/api/database/records/cp_surveys/${survey_id}`);
      survey = Array.isArray(raw) ? raw[0] : (raw && raw.id ? raw : null);
    } else {
      survey = mem.surveys.find(s => s.id == survey_id);
    }

    if (survey && allResp.length >= (survey.target_responses || 10)) {
      if (useIF()) {
        await ifPatch(`/api/database/records/cp_surveys/${survey_id}`, { status: 'complete' });
      } else {
        Object.assign(survey, { status: 'complete' });
      }
      triggerAnalysis(survey, allResp);
    }
    res.json({ success: true });
  } catch(e) {
    console.error('Response error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AI PROXY ──────────────────────────────────────────────
app.post('/api/ai', auth, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'No Anthropic API key' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: req.body.model || 'claude-sonnet-4-20250514',
        max_tokens: req.body.max_tokens || 1000,
        system: req.body.system,
        messages: req.body.messages
      })
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TINYFISH PROXY ────────────────────────────────────────
app.post('/api/research', auth, async (req, res) => {
  if (!TINYFISH_KEY) return res.status(503).json({ error: 'TinyFish not configured' });
  try {
    const r = await fetch('https://agent.tinyfish.ai/v1/automation/run-sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': TINYFISH_KEY },
      body: JSON.stringify({ url: req.body.url, goal: req.body.goal, proxy_config: { enabled: false } })
    });
    const lines = (await r.text()).split('\n').filter(l => l.startsWith('data:'));
    let result = '';
    for (const l of lines) {
      try { const d = JSON.parse(l.slice(5)); result += d.result || d.output || d.text || ''; } catch {}
    }
    res.json({ result: result || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CONFIG STATUS ─────────────────────────────────────────
app.get('/api/config/status', (req, res) => {
  res.json({
    ai:       !!ANTHROPIC_KEY,
    insforge: useIF(),
    tinyfish: !!TINYFISH_KEY,
    storage:  useIF() ? 'insforge' : 'memory',
    mem_users: useIF() ? null : mem.users.length
  });
});



// ── DOCUMENT UPLOAD ───────────────────────────────────────
app.post('/api/upload-doc', auth, (req, res, next) => {
  if (req.user.role !== 'government') return res.status(403).json({ error: 'Government only' });
  if (!upload) return res.status(503).json({ error: 'multer not installed' });
  upload.single('document')(req, res, next);
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { originalname, mimetype, buffer } = req.file;
  try {
    let text = '';
    if (mimetype === 'application/pdf' || originalname.endsWith('.pdf')) {
      if (!pdfParse) return res.status(503).json({ error: 'pdf-parse not installed' });
      text = (await pdfParse(buffer)).text;
    } else if (originalname.endsWith('.docx')) {
      if (!mammoth) return res.status(503).json({ error: 'mammoth not installed' });
      text = (await mammoth.extractRawText({ buffer })).value;
    } else {
      return res.status(400).json({ error: 'Only PDF and DOCX supported' });
    }
    res.json({ text: text.slice(0, 15000), filename: originalname, length: text.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SHOOT QUESTION TO PUBLIC ──────────────────────────────
const shootQs = {};
app.post('/api/surveys/:id/shoot-question', auth, (req, res) => {
  if (req.user.role !== 'government') return res.status(403).json({ error: 'Government only' });
  const { question } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Question required' });
  const svId = req.params.id;
  if (!shootQs[svId]) shootQs[svId] = [];
  const q = { id: Date.now(), question: question.trim(), author: req.user.username, postedAt: new Date().toISOString() };
  shootQs[svId].push(q);
  res.json(q);
});
app.get('/api/surveys/:id/shoot-questions', (req, res) => {
  res.json(shootQs[req.params.id] || []);
});

// ── AI ANALYSIS (background) ──────────────────────────────
// ── TINYFISH HELPER ──────────────────────────────────────
// ── TINYFISH: SSE reader using node-fetch v2 buffer ─────
async function tinyfishSearch(url, goal) {
  if (!TINYFISH_KEY) return '';

  return new Promise((resolve) => {
    let result = '';
    let settled = false;
    let buffer  = '';

    const done = (val) => {
      if (settled) return;
      settled = true;
      console.log('  TinyFish done, chars:', (val||'').length);
      resolve((val || '').trim());
    };

    const hardTimer = setTimeout(() => {
      console.warn('  ⏱ TinyFish 90s timeout — partial:', result.length, 'chars');
      done(result);
    }, 90000);

    const processLine = (line) => {
      line = line.trim();
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw) return;
      try {
        const d = JSON.parse(raw);
        if (d.type) console.log('    TinyFish event:', d.type);

        // COMPLETE event — result can be object or string
        if (d.type === 'COMPLETE' || d.type === 'complete') {
          let text = '';
          if (typeof d.result === 'string') {
            text = d.result;
          } else if (typeof d.result === 'object' && d.result !== null) {
            text = JSON.stringify(d.result);
          } else if (typeof d.output === 'string') {
            text = d.output;
          } else if (d.data) {
            text = typeof d.data === 'string' ? d.data : JSON.stringify(d.data);
          }
          if (text) result = text;
          console.log('    ✓ TinyFish COMPLETE, result chars:', result.length);
          clearTimeout(hardTimer);
          done(result);
          return;
        }

        // PROGRESS events may carry partial data
        if (d.type === 'PROGRESS' || d.type === 'progress') {
          const partial = d.result || d.output || d.text || d.content || '';
          if (partial && typeof partial === 'string') result += partial;
        }

        // Error event
        if (d.type === 'ERROR' || d.type === 'error' || d.status === 'FAILED') {
          console.warn('    TinyFish error event:', d.message || d.error || JSON.stringify(d).slice(0,100));
          clearTimeout(hardTimer);
          done(result);
        }
      } catch {}
    };

    fetch('https://agent.tinyfish.ai/v1/automation/run-sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': TINYFISH_KEY },
      body: JSON.stringify({ url, goal, proxy_config: { enabled: false } })
    }).then(r => {
      if (!r.ok) { console.warn('  TinyFish HTTP', r.status); clearTimeout(hardTimer); done(''); return; }
      console.log('  TinyFish connected, streaming...');
      r.body.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line
        lines.forEach(processLine);
      });
      r.body.on('end',   () => { clearTimeout(hardTimer); done(result); });
      r.body.on('error', e => { console.warn('  TinyFish stream error:', e.message); clearTimeout(hardTimer); done(result); });
    }).catch(e => {
      console.warn('  TinyFish fetch error:', e.message);
      clearTimeout(hardTimer); done('');
    });
  });
}

async function triggerAnalysis(surveyInput, responsesInput) {
  console.log('\n🔬 ═══════════════════════════════════════════════════');
  console.log('   CIVICAI ANALYSIS PIPELINE STARTED');
  console.log('═══════════════════════════════════════════════════');
  console.log('  → Input survey fields:', surveyInput ? Object.keys(surveyInput).join(', ') : 'NULL');

  // ── STEP 1: Re-fetch fresh data from InsForge ─────────
  let survey = surveyInput;
  let responses = responsesInput;
  // Normalize field names (InsForge may return capitalized keys)
  if (survey) {
    survey = {
      id:               survey.id               || survey.Id,
      question:         survey.question         || survey.Question         || '',
      author:           survey.author           || survey.Author           || '',
      target_responses: survey.target_responses || survey.Target_responses || 10,
      context_json:     survey.context_json     || survey.Context_json     || null,
      status:           survey.status           || survey.Status           || 'active',
      analysis_json:    survey.analysis_json    || survey.Analysis_json    || null,
      published_at:     survey.published_at     || survey.Published_at     || null,
    };
  }

  if (useIF()) {
    try {
      console.log('  📥 Step 1: Fetching fresh survey data from InsForge...');
      const svRaw = await ifGet(`/api/database/records/cp_surveys/${surveyInput.id}`);
      const svFresh = Array.isArray(svRaw) ? svRaw[0] : (svRaw && svRaw.id ? svRaw : null);
      if (svFresh) { survey = svFresh; console.log('  ✓ Survey fetched:', survey.question.slice(0,60)); }

      const respRaw = await ifGet(`/api/database/records/cp_responses?survey_id=eq.${encodeURIComponent(surveyInput.id)}`);
      const respFresh = unwrap(respRaw);
      if (respFresh.length > 0) { responses = respFresh; }
      console.log(`  ✓ Responses fetched: ${responses.length} total`);
      responses.forEach((r, i) => console.log(`    [${i+1}] ${r.username}: "${String(r.answer).slice(0,60)}"`));
    } catch(e) {
      console.warn('  ⚠ Could not re-fetch from InsForge, using passed data:', e.message);
    }
  }

  // ── STEP 2: Extract government document ───────────────
  let govDoc = '';
  try {
    const ctx = JSON.parse(survey.context_json || '[]');
    if (Array.isArray(ctx)) {
      const d = ctx.find(m => m.role === 'system' && m.content && m.content.startsWith('[GOV_DOC]:'));
      if (d) govDoc = d.content.replace('[GOV_DOC]:', '').trim();
    }
  } catch {}
  console.log(`  📄 Step 2: Gov document: ${govDoc ? govDoc.length + ' chars' : 'none'}`);

  // ── STEP 3: TinyFish research (Wikipedia only — reliable) ──
  console.log('  🐟 Step 3: TinyFish research...');
  const topic = survey.question || '(unknown topic)';
  const topicShort = topic.split(' ').slice(0, 6).join(' ');
  const citizenOpinions = responses.map((r, i) => `${i+1}. ${r.username}: "${r.answer}"`).join('\n');
  const govDocSnippet = govDoc ? govDoc.slice(0, 3000) : '';

  let precedentData = '';
  try {
    console.log('    🐟 Searching Wikipedia for policy precedents...');
    precedentData = await tinyfishSearch(
      `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(topicShort + ' government policy transport infrastructure')}&ns0=1`,
      `Search for and read the most relevant Wikipedia article about "${topicShort}". Extract: (1) real countries or cities that implemented similar government policies, (2) specific statistics and measurable outcomes, (3) lessons learned. Return as plain text with bullet points and numbers.`
    );
    console.log(`    ✓ Research: ${precedentData.length} chars`);
  } catch(e) { console.warn('    ⚠ Research error:', e.message); }

    // ── STEP 4: TinyFish AI analysis ────────────────────────
  console.log('  🐟 Step 4: TinyFish AI analysis with all data...');

  // ── STEP 5: TinyFish analysis call ──────────────────────
  try {
    // Build comprehensive goal for TinyFish AI analysis
    const analysisGoal = `You are a government policy analyst. Analyse the following data and return a JSON report.

SURVEY QUESTION: "${survey.question}"

GOVERNMENT DOCUMENT (${govDoc ? govDoc.length + ' chars' : 'none provided'}):
${govDocSnippet || 'No document uploaded.'}

CITIZEN RESPONSES (${responses.length} total):
${citizenOpinions}

RESEARCH DATA:
${precedentData ? 'Policy Precedents:\n' + precedentData.slice(0,1000) : ''}
${impactData ? 'Impact Data:\n' + impactData.slice(0,1000) : ''}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{"final_decision":"2-3 sentence decision","government_intent":"what gov wants to achieve","government_concern":"core problem being solved","citizen_emotions":"emotions in responses","citizen_concerns":"main citizen concerns","sentiment_breakdown":{"support_percent":60,"oppose_percent":30,"neutral_percent":10,"support_reasons":["reason"],"oppose_reasons":["reason"]},"conflict_analysis":"where they conflict","win_win_solution":"creative solution for both sides","alternative_approaches":[{"name":"name","description":"how","benefits":"benefits","tradeoffs":"tradeoffs"}],"recommended_course_of_action":["Step 1","Step 2","Step 3"],"statistics":{"key_stats":["stat with number"],"comparable_cases":["case with outcome"],"projected_impact":"expected outcome"},"pros":["pro"],"cons":["con"],"environmental_social_factors":"context","urgency":"MEDIUM","confidence":85}`;

    console.log('  🐟 Sending to TinyFish for AI analysis...');
    const rawResult = await tinyfishSearch(
      'https://en.wikipedia.org/wiki/Government',
      analysisGoal
    );

    console.log('  🐟 TinyFish analysis result length:', rawResult.length);
    if (!rawResult || rawResult.length < 50) {
      throw new Error('TinyFish returned empty analysis — check your TinyFish credits/quota');
    }

    // Parse JSON from result
    const clean = rawResult.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
    let analysis;
    try {
      analysis = JSON.parse(clean);
    } catch(parseErr) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        analysis = JSON.parse(match[0]);
      } else {
        // TinyFish couldn't do structured analysis — build basic one from what we have
        console.warn('  ⚠ Could not parse JSON, building basic analysis...');
        const supportCount = responses.filter(r =>
          /good|useful|benefit|support|like|great|yes|agree|positive/i.test(r.answer)
        ).length;
        const opposeCount = responses.length - supportCount;
        analysis = {
          final_decision: `Based on ${responses.length} citizen responses about "${survey.question}", the analysis shows mixed public opinion requiring careful consideration.`,
          government_intent: survey.question,
          government_concern: govDoc ? 'See uploaded policy document for details.' : 'As stated in survey question.',
          citizen_emotions: responses.map(r => r.answer).join(' | '),
          citizen_concerns: responses.map(r => `${r.username}: ${r.answer}`).join('; '),
          sentiment_breakdown: {
            support_percent: Math.round((supportCount / responses.length) * 100),
            oppose_percent: Math.round((opposeCount / responses.length) * 100),
            neutral_percent: 0,
            support_reasons: responses.filter(r => /good|useful|benefit/i.test(r.answer)).map(r => r.answer),
            oppose_reasons: responses.filter(r => /bad|not|don't|against/i.test(r.answer)).map(r => r.answer)
          },
          conflict_analysis: 'Citizens have differing views on this policy.',
          win_win_solution: 'Implement in phases with public consultation at each stage.',
          alternative_approaches: [{ name: 'Phased Implementation', description: 'Roll out in stages with feedback', benefits: 'Reduces risk', tradeoffs: 'Takes longer' }],
          recommended_course_of_action: ['Conduct detailed feasibility study', 'Hold public consultation', 'Implement pilot phase', 'Evaluate and expand'],
          statistics: { key_stats: [precedentData.slice(0,200) || 'Research data unavailable'], comparable_cases: ['Similar projects in other cities have shown mixed results'], projected_impact: 'Impact depends on implementation quality' },
          pros: ['Addresses stated government goal', 'Has some public support'],
          cons: ['Some citizen opposition', 'Requires careful planning'],
          environmental_social_factors: impactData.slice(0,300) || 'Environmental assessment required.',
          urgency: 'MEDIUM',
          confidence: 60
        };
      }
    }

    const analysisJson = JSON.stringify(analysis);
    console.log('  ✓ Analysis parsed, length:', analysisJson.length);

    // ── STEP 6: Save analysis ─────────────────────────
    // Cache in memory for fast access
    analysisCache[survey.id] = analysisJson;
    console.log('  ✓ Cached analysis in memory, length:', analysisJson.length);

    if (useIF()) {
      // Save chunks to cp_analysis table
      await saveAnalysisToIF(survey.id, analysisJson);
      // Update survey status
      await ifPatch(`/api/database/records/cp_surveys/${survey.id}`, { status: 'complete' });
      console.log('  ✓ Survey status set to complete in InsForge');
    } else {
      const s = mem.surveys.find(s => s.id == survey.id);
      if (s) { s.analysis_json = analysisJson; s.status = 'complete'; }
    }

    console.log('\n  ✅ ANALYSIS COMPLETE for survey:', survey.id);
    console.log('  📊 Sentiment:', analysis.sentiment_breakdown?.support_percent + '% support,', analysis.sentiment_breakdown?.oppose_percent + '% oppose');
    console.log('  ⚡ Urgency:', analysis.urgency, '| Confidence:', analysis.confidence + '%');
    console.log('═══════════════════════════════════════════════════\n');

  } catch(e) {
    console.error('\n  ❌ ANALYSIS FAILED:', e.message);
    console.error('═══════════════════════════════════════════════════\n');
  }
}

// ── MANUAL TRIGGER (for testing without hitting response target) ──
app.post('/api/admin/trigger-analysis/:surveyId', auth, async (req, res) => {
  if (req.user.role !== 'government') return res.status(403).json({ error: 'Government only' });
  try {
    const surveyId = req.params.surveyId;
    let survey, responses;
    if (useIF()) {
      // Fetch all surveys and find by id (single record fetch may return unexpected shape)
      const allRaw = await ifGet('/api/database/records/cp_surveys');
      const all = unwrap(allRaw);
      console.log(`  → All surveys: ${all.length}, looking for id="${surveyId}"`);
      survey = all.find(s => String(s.id) === String(surveyId));
      if (!survey) {
        // Also try direct fetch
        const svRaw = await ifGet(`/api/database/records/cp_surveys/${surveyId}`);
        console.log('  → Direct fetch raw:', JSON.stringify(svRaw).slice(0,200));
        survey = Array.isArray(svRaw) ? svRaw[0] : (svRaw && svRaw.id ? svRaw : null);
        if (!survey && svRaw && typeof svRaw === 'object') {
          // Try unwrapping
          const arr = unwrap(svRaw);
          survey = arr[0] || null;
        }
      }
      const respRaw = await ifGet(`/api/database/records/cp_responses?survey_id=eq.${encodeURIComponent(surveyId)}`);
      responses = unwrap(respRaw);
      console.log(`  → Survey found: ${!!survey}, responses: ${responses.length}`);
      if (survey) console.log('  → Survey fields:', Object.keys(survey).join(', '));
    } else {
      survey = mem.surveys.find(s => String(s.id) === String(surveyId));
      responses = mem.responses.filter(r => String(r.survey_id) === String(surveyId));
    }
    if (!survey) return res.status(404).json({ error: `Survey not found (id=${surveyId})` });
    if (!responses.length) return res.status(400).json({ error: 'No responses yet to analyse' });
    const q = survey.question || survey.Question || '(no question field)';
    res.json({ success: true, message: `Analysis triggered for "${String(q).slice(0,50)}" with ${responses.length} response(s)` });
    triggerAnalysis(survey, responses);
  } catch(e) {
    console.error('trigger-analysis error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET ANALYSIS FOR A SURVEY ────────────────────────────
app.get('/api/surveys/:id/analysis', (req, res) => {
  const cached = analysisCache[req.params.id];
  if (cached) return res.json({ analysis_json: cached, source: 'cache' });
  res.status(404).json({ error: 'Analysis not ready yet' });
});

// ── SERVE FRONTEND ────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🏛️  CivicPulse → http://localhost:${PORT}`);
    console.log(`   AI:       ${ANTHROPIC_KEY ? '✅ Claude'    : '❌ No key'}`);
    console.log(`   Backend:  ${useIF()       ? '✅ InsForge'  : '⚡ Memory'}`);
    console.log(`   Research: ${TINYFISH_KEY  ? '✅ TinyFish'  : '⚠️  No key'}\n`);
  });
});
