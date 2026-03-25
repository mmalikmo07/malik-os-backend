require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS — allow GitHub Pages origin ──────────────────────────────────────────
const allowedOrigins = [
  'https://mmalikmo07.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:5500',   // Live Server
  'null'                      // file:// local testing
];

app.use(cors({
  origin: (origin, cb) => {
    if(!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

app.use(express.json({ limit: '2mb' }));

// ── POSTGRES ───────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Init tables on startup
async function initDB(){
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ideas (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT,
        priority TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS gym_sessions (
        id SERIAL PRIMARY KEY,
        day_num INTEGER,
        day_title TEXT,
        weights JSONB,
        logged_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS gym_weights (
        id SERIAL PRIMARY KEY,
        day_num INTEGER,
        exercise_idx INTEGER,
        weight TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(day_num, exercise_idx)
      );

      CREATE TABLE IF NOT EXISTS modules (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        credits INTEGER DEFAULT 10,
        year INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS assessments (
        id SERIAL PRIMARY KEY,
        module_id INTEGER REFERENCES modules(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        weight NUMERIC,
        score NUMERIC,
        max_score NUMERIC DEFAULT 100,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS quran_log (
        id SERIAL PRIMARY KEY,
        date DATE DEFAULT CURRENT_DATE,
        sabaq INTEGER DEFAULT 0,
        sabqi INTEGER DEFAULT 0,
        manzil INTEGER DEFAULT 0,
        tilawah INTEGER DEFAULT 0,
        notes TEXT,
        UNIQUE(date)
      );

      CREATE TABLE IF NOT EXISTS habits (
        id SERIAL PRIMARY KEY,
        week_start DATE,
        habit_idx INTEGER,
        day_idx INTEGER,
        done BOOLEAN DEFAULT false,
        UNIQUE(week_start, habit_idx, day_idx)
      );

      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT,
        status TEXT DEFAULT 'idea',
        progress INTEGER DEFAULT 0,
        mindmap_text TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✓ Database tables ready');
  } catch(e) {
    console.error('DB init error:', e.message);
  }
}

// ── HEALTH CHECK ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'MALIK OS Backend Online',
  version: '1.0.0',
  timestamp: new Date().toISOString()
}));

app.get('/health', (req, res) => res.json({ ok: true }));

// ═══════════════════════════════════════════════════════════════════════════════
// TAVILY WEB SEARCH
// ═══════════════════════════════════════════════════════════════════════════════
const TAVILY_KEY = process.env.TAVILY_API_KEY;

const SEARCH_TRIGGERS = [
  'news','latest','today','current','right now','this week','this month',
  '2026','just happened','recently','update','announced','released',
  'launched','new model','new version','stock','price','who is',
  'what happened','trending','breaking','march','april','may'
];

function needsWebSearch(prompt) {
  if(!TAVILY_KEY) return false;
  const lower = prompt.toLowerCase();
  return SEARCH_TRIGGERS.some(t => lower.includes(t));
}

async function tavilySearch(query) {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: true
      })
    });
    if(!res.ok) throw new Error('Tavily ' + res.status);
    const data = await res.json();
    const results = (data.results || []).slice(0, 5).map((r, i) =>
      '[' + (i+1) + '] ' + r.title + '\nSource: ' + r.url + '\n' + (r.content || '').substring(0, 400)
    ).join('\n\n');
    return { answer: data.answer || '', results };
  } catch(e) {
    console.warn('Tavily search failed:', e.message);
    return null;
  }
}

async function askWithSearch(prompt, maxTokens, system) {
  if(needsWebSearch(prompt)) {
    const searchData = await tavilySearch(prompt);
    if(searchData && (searchData.answer || searchData.results)) {
      const augmented =
        'The user asked: "' + prompt + '"\n\n' +
        'I searched the web and found this live data:\n\n' +
        (searchData.answer ? 'DIRECT ANSWER: ' + searchData.answer + '\n\n' : '') +
        'SOURCES:\n' + searchData.results + '\n\n' +
        'Now answer the user using this live data. Be specific, reference sources naturally, ' +
        'add your own analysis and connect it to their EEE/tech interests where relevant. ' +
        'Do not say you lack real-time access — you have the data above.';
      return callClaude(augmented, maxTokens, system);
    }
  }
  return callClaude(prompt, maxTokens, system);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI ROUTES — all Claude calls happen server-side, zero CORS issues
// ═══════════════════════════════════════════════════════════════════════════════
async function callClaude(prompt, maxTokens = 600, systemPrompt = null) {
  const messages = [{ role: 'user', content: prompt }];
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages
  };
  if(systemPrompt) body.system = systemPrompt;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if(!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

const MALIK_SYSTEM = `You are JARVIS — Malik's personal AI assistant, built directly into his custom OS.

MALIK'S PROFILE:
- 1st year EEE (Electrical & Electronic Engineering) student at Swansea University, Wales, UK
- Ambitious, self-driven, building a personal OS to optimise every area of his life
- Muslim — observes prayer times, doing Quran hifz (memorisation) using سبق/سبقي/منزل method
- Training at the gym 4 days/week (beginner, progressive overload focus)
- Exploring boxing and table tennis for sport
- Building towards: embedded systems, AI/ML, side hustles, and eventually freelance/startup work
- Uses tools: STM32/Arduino, KiCad, GitHub, Python, n8n automation
- Current grades: EG-158 Software Engineering 88%, EG-151 Microcontrollers 79%, EG-155 Circuit Analysis 71%, EG-133 Hackathon 68%, EG-143 Digital Design 65%

HIS OS DEPARTMENTS:
1. Project Lab — hardware/software projects, one per month, replicate then original
2. Curiosity Lab — AI/ML pathway (3B1B → MIT → Andrew Ng → MIT 6.034), maths for fun
3. University Core — first class target, research track, professor outreach
4. Quran & Deen — daily hifz, tilawah, spiritual consistency
5. Physical Edge — 4-day gym split (Chest/Back/Biceps x2, Shoulders/Legs/Tris x2)
6. Sport — boxing or table tennis (deciding)
7. Side Hustle Lab — tutoring now, freelance embedded/PCB later, SaaS eventually
8. Habits — daily tracking grid

YOUR PERSONALITY & RULES:
- You are direct, sharp, and genuinely useful — like a brilliant friend who happens to know everything
- You give REAL, SPECIFIC, DETAILED answers — not generic Amazon customer service responses
- You never hedge excessively or add pointless disclaimers
- You never say "I don't have access to real-time information" as your entire answer — always give what you DO know, then acknowledge the limitation briefly at the end if relevant
- You speak to Malik as an equal — not as a student who needs hand-holding
- You use his context naturally — reference his EEE background, his Swansea courses, his goals
- For technical questions: go deep, use actual examples, real code if helpful
- For current events/news: you have LIVE web search — use the search results provided to give up-to-date, specific answers. Never claim you lack real-time access when search results are present in the prompt
- Format responses clearly with structure when helpful, but don't pad with filler
- You are ambitious on his behalf — push him to think bigger, move faster, aim higher
- Never be preachy about religion, health, or lifestyle choices — he has those covered`;

// General AI chat — uses Tavily web search for current events questions
app.post('/api/ai/ask', async (req, res) => {
  try {
    const { prompt, maxTokens = 1200 } = req.body;
    if(!prompt) return res.status(400).json({ error: 'prompt required' });
    const text = await askWithSearch(prompt, maxTokens, MALIK_SYSTEM);
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Expand project idea
app.post('/api/ai/expand-idea', async (req, res) => {
  try {
    const { title, description } = req.body;
    const prompt =
      `Malik's project idea: "${title}". ${description ? 'Description: ' + description : ''}\n\n` +
      `Expand with:\n1) Why it's great for a 1st year EEE student\n` +
      `2) Exact components/tech stack needed with approximate UK prices\n` +
      `3) 5-step build plan\n4) Skills he'll gain\n5) How to make it portfolio-worthy\n\n` +
      `Be specific and motivating. Format with clear sections.`;
    const text = await callClaude(prompt, 800, MALIK_SYSTEM);
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Study explainer
app.post('/api/ai/explain', async (req, res) => {
  try {
    const { concept, level } = req.body;
    const levelMap = {
      'ELI5':      "explain like he is 12 using very simple everyday analogies",
      'Student':   "explain at first-year university level with mathematical intuition",
      'Deep Dive': "give a rigorous deep technical explanation with key equations and derivations"
    };
    const prompt =
      `Please ${levelMap[level] || levelMap['Student']}: ${concept}. ` +
      `Connect it to electrical engineering applications wherever possible. ` +
      `Use proper markdown formatting: # for main title, ## for section headers, ### for subsections, ` +
      `**bold** for key terms, *italic* for emphasis, - for bullet points, and > for important notes. ` +
      `For ALL equations and mathematical expressions, use LaTeX notation: $...$ for inline math and $$...$$ for display math. ` +
      `Never write equations as plain text. Structure the explanation with clear sections.`;
    const text = await callClaude(prompt, 1200, MALIK_SYSTEM);
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Simulation suggestions
app.post('/api/ai/sim-suggest', async (req, res) => {
  try {
    const { concept } = req.body;
    const prompt =
      `For the concept "${concept}", list 3-5 aspects that could be visualised as interactive simulations. ` +
      `Format each as a numbered list: "1. Title — Brief description of what the simulation would show". ` +
      `Focus on things that can be visualised with HTML5 Canvas, animations, sliders, or graphs. ` +
      `Only suggest things that are genuinely simulatable and educational.`;
    const text = await callClaude(prompt, 300, MALIK_SYSTEM);
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Simulation code generation
app.post('/api/ai/simulate', async (req, res) => {
  try {
    const { concept, simulation } = req.body;
    const prompt =
      `Generate a COMPLETE working HTML page that creates an interactive simulation of "${simulation}" for the concept "${concept}".\n\n` +
      `CRITICAL REQUIREMENTS — the simulation MUST actually draw and animate:\n` +
      `1. Use <canvas> elements. Get context with canvas.getContext('2d').\n` +
      `2. Write a draw() function that CLEARS the canvas (ctx.clearRect), then draws shapes/lines/arcs using ctx.beginPath(), ctx.moveTo(), ctx.lineTo(), ctx.arc(), ctx.stroke(), ctx.fill(), ctx.fillText() etc.\n` +
      `3. Call draw() inside a requestAnimationFrame loop so it animates continuously.\n` +
      `4. For waveforms: use ctx.beginPath(), loop through x values, compute y = amplitude * Math.sin(2*Math.PI*freq*x/width + phase), and use ctx.lineTo(x, centerY - y).\n` +
      `5. Make sliders update variables that the draw() function reads. Add 'input' event listeners to each slider.\n` +
      `6. Set canvas.width and canvas.height EXPLICITLY in JavaScript (not just CSS), e.g. canvas.width = canvas.parentElement.clientWidth.\n` +
      `7. Color scheme: background #0a0a0e, text #e8e8f0, use colors #c8ff00 (lime), #00e5cc (teal), #ff3366 (red), #fbbf24 (gold) for different data series.\n` +
      `8. All code in a single HTML file with inline <style> and <script>.\n` +
      `9. Put ALL JavaScript inside window.onload = function() { ... } to ensure DOM is ready.\n` +
      `10. Do NOT use any external libraries.\n\n` +
      `Structure your code like this:\n` +
      `<html><head><style>/* dark theme styles */</style></head><body>\n` +
      `<div id="controls"><!-- sliders with labels --></div>\n` +
      `<canvas id="mainCanvas"></canvas>\n` +
      `<script>\n` +
      `window.onload = function() {\n` +
      `  const canvas = document.getElementById('mainCanvas');\n` +
      `  const ctx = canvas.getContext('2d');\n` +
      `  canvas.width = canvas.parentElement.clientWidth || 800;\n` +
      `  canvas.height = 400;\n` +
      `  let param1 = 50; // from slider\n` +
      `  document.getElementById('slider1').addEventListener('input', function(e) { param1 = parseFloat(e.target.value); });\n` +
      `  function draw() {\n` +
      `    ctx.clearRect(0, 0, canvas.width, canvas.height);\n` +
      `    // ACTUAL DRAWING CODE HERE using ctx\n` +
      `    requestAnimationFrame(draw);\n` +
      `  }\n` +
      `  draw();\n` +
      `};\n` +
      `</script></body></html>\n\n` +
      `Return ONLY the HTML code. No markdown fences. No explanations.`;
    const text = await callClaude(prompt, 4096, MALIK_SYSTEM);
    // Extract just the HTML if wrapped in code fences
    let code = text.trim();
    const fence = '`'.repeat(3);
    if(code.startsWith(fence)) {
      code = code.replace(/^```html?\n?/, '').replace(/\n?```$/, '');
    }
    res.json({ code });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Notes autocomplete
app.post('/api/ai/notes-complete', async (req, res) => {
  try {
    const { lastLine } = req.body;
    const prompt =
      `Malik is taking EEE study notes. Continue his thought in 1–2 sentences naturally. ` +
      `Do NOT repeat what is already written. Note so far: "${lastLine}"`;
    const text = await callClaude(prompt, 120, MALIK_SYSTEM);
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Notes expand
app.post('/api/ai/notes-expand', async (req, res) => {
  try {
    const { notes } = req.body;
    const prompt =
      `Malik wrote these EEE study notes: "${notes}". ` +
      `Add 3–4 key points he might have missed, one key formula or definition, ` +
      `and one real-world application. Use bullet points.`;
    const text = await callClaude(prompt, 500, MALIK_SYSTEM);
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Career advice
app.post('/api/ai/career-advice', async (req, res) => {
  try {
    const { careerTitle } = req.body;
    const prompt =
      `Malik is a 1st year EEE student at Swansea University interested in ${careerTitle}. ` +
      `He has no industry experience yet. Give him:\n` +
      `1) 3 specific, actionable things to do THIS TERM (next 3 months)\n` +
      `2) One thing about this career most students don't know\n` +
      `3) One Swansea-specific resource or opportunity to look into\n\n` +
      `Be very specific and practical.`;
    const text = await callClaude(prompt, 500, MALIK_SYSTEM);
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Gym coach advice
app.post('/api/ai/gym-advice', async (req, res) => {
  try {
    const { dayNum, dayTitle, exercises } = req.body;
    const prompt =
      `Malik is a beginner lifter doing Day ${dayNum}: ${dayTitle}. ` +
      `Exercises: ${exercises.join(', ')}. ` +
      `Give: 3 form tips for the most important exercises, ` +
      `1 progressive overload tip, 1 recovery tip. Under 160 words.`;
    const text = await callClaude(prompt, 350, MALIK_SYSTEM);
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Hustle idea generator
app.post('/api/ai/hustle-ideas', async (req, res) => {
  try {
    const { skills, timeAvailable } = req.body;
    const prompt =
      `Malik is a 1st year EEE student at Swansea University, UK. ` +
      `His skills: ${skills}. Available time: ${timeAvailable || 'a few hours per week'}.\n\n` +
      `Generate 5 realistic side hustle ideas. For each provide:\n` +
      `- Name and one-line description\n` +
      `- How to start THIS WEEK (specific first step)\n` +
      `- Realistic monthly income potential (honest, not inflated)\n` +
      `- Weekly time commitment\n` +
      `- Why his EEE skills give him an edge\n\n` +
      `Be specific and brutally honest about what's achievable as a busy student.`;
    const text = await callClaude(prompt, 800, MALIK_SYSTEM);
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Business idea deep analysis (new feature)
app.post('/api/ai/business-analysis', async (req, res) => {
  try {
    const { idea } = req.body;
    const prompt =
      `Analyse this business idea for Malik, a 1st year EEE student at Swansea University:\n\n` +
      `"${idea}"\n\n` +
      `Provide a structured report covering:\n` +
      `1) **Concept Summary** — what it is in plain English\n` +
      `2) **Estimated Startup Cost** — realistic UK figures, broken down\n` +
      `3) **Revenue Model** — how it makes money\n` +
      `4) **Scalability** — ceiling and growth path (1→10→100 customers)\n` +
      `5) **EEE Advantage** — how his engineering skills give him an edge\n` +
      `6) **Biggest Risk** — one honest risk to watch out for\n` +
      `7) **First 3 Steps** — what to do this week to validate it\n` +
      `8) **Verdict** — honest 1-sentence assessment\n\n` +
      `Be direct, specific, and honest. No fluff.`;
    const text = await callClaude(prompt, 1000, MALIK_SYSTEM);
    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Project autocomplete
app.post('/api/ai/project-autocomplete', async (req, res) => {
  try {
    const { text, context } = req.body;
    const prompts = {
      title:
        `Malik is typing a project idea title: "${text}". ` +
        `Give a one-sentence improved title, then suggest 3 related EEE project ideas. Concise.`,
      description:
        `Malik typed this project description: "${text}". ` +
        `Expand with: exact components needed, skills gained, time estimate, one technical challenge. Under 100 words.`
    };
    const prompt = prompts[context] || `Complete this EEE project thought: "${text}"`;
    const response = await callClaude(prompt, 250, MALIK_SYSTEM);
    res.json({ text: response });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// IDEAS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/ideas', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM ideas ORDER BY created_at DESC');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ideas', async (req, res) => {
  try {
    const { title, description, category, priority } = req.body;
    const result = await db.query(
      'INSERT INTO ideas (title, description, category, priority) VALUES ($1,$2,$3,$4) RETURNING *',
      [title, description, category, priority]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/ideas/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM ideas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GYM ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/gym/weights', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM gym_weights ORDER BY day_num, exercise_idx');
    const weights = {};
    result.rows.forEach(r => { weights[`d${r.day_num}-${r.exercise_idx}`] = r.weight; });
    res.json(weights);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/gym/weights', async (req, res) => {
  try {
    const { dayNum, exerciseIdx, weight } = req.body;
    await db.query(
      `INSERT INTO gym_weights (day_num, exercise_idx, weight) VALUES ($1,$2,$3)
       ON CONFLICT (day_num, exercise_idx) DO UPDATE SET weight=$3, updated_at=NOW()`,
      [dayNum, exerciseIdx, weight]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gym/sessions', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM gym_sessions ORDER BY logged_at DESC LIMIT 30');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/gym/sessions', async (req, res) => {
  try {
    const { dayNum, dayTitle, weights } = req.body;
    const result = await db.query(
      'INSERT INTO gym_sessions (day_num, day_title, weights) VALUES ($1,$2,$3) RETURNING *',
      [dayNum, dayTitle, JSON.stringify(weights)]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/gym/sessions/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM gym_sessions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Gym progress data for chart
app.get('/api/gym/progress/:dayNum/:exerciseIdx', async (req, res) => {
  try {
    const { dayNum, exerciseIdx } = req.params;
    const result = await db.query(
      `SELECT logged_at, weights->$1 as weight FROM gym_sessions 
       WHERE day_num=$2 AND weights ? $1
       ORDER BY logged_at ASC LIMIT 20`,
      [`${exerciseIdx}`, dayNum]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MODULES / GRADE CALCULATOR ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/modules', async (req, res) => {
  try {
    const mods = await db.query('SELECT * FROM modules WHERE year=$1 ORDER BY id', [1]);
    const assessments = await db.query(
      'SELECT * FROM assessments WHERE module_id = ANY($1)',
      [mods.rows.map(m => m.id)]
    );
    const result = mods.rows.map(m => ({
      ...m,
      assessments: assessments.rows.filter(a => a.module_id === m.id)
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/modules', async (req, res) => {
  try {
    const { name, credits, year = 1 } = req.body;
    const result = await db.query(
      'INSERT INTO modules (name, credits, year) VALUES ($1,$2,$3) RETURNING *',
      [name, credits, year]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/modules/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM modules WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/modules/:id/assessments', async (req, res) => {
  try {
    const { name, weight, score, maxScore = 100 } = req.body;
    const result = await db.query(
      'INSERT INTO assessments (module_id, name, weight, score, max_score) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.id, name, weight, score, maxScore]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/assessments/:id', async (req, res) => {
  try {
    const { score } = req.body;
    const result = await db.query(
      'UPDATE assessments SET score=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [score, req.params.id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/assessments/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM assessments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECTS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/projects', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM projects ORDER BY created_at DESC');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const { title, description, category, mindmapText } = req.body;
    const result = await db.query(
      'INSERT INTO projects (title, description, category, mindmap_text) VALUES ($1,$2,$3,$4) RETURNING *',
      [title, description, category, mindmapText]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    const { title, description, status, progress, mindmapText } = req.body;
    const result = await db.query(
      `UPDATE projects SET title=$1, description=$2, status=$3, progress=$4, 
       mindmap_text=$5, updated_at=NOW() WHERE id=$6 RETURNING *`,
      [title, description, status, progress, mindmapText, req.params.id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM projects WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// QURAN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/quran/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await db.query('SELECT * FROM quran_log WHERE date=$1', [today]);
    res.json(result.rows[0] || { sabaq:0, sabqi:0, manzil:0, tilawah:0, notes:'' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/quran/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { sabaq, sabqi, manzil, tilawah, notes } = req.body;
    await db.query(
      `INSERT INTO quran_log (date, sabaq, sabqi, manzil, tilawah, notes) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (date) DO UPDATE SET sabaq=$2, sabqi=$3, manzil=$4, tilawah=$5, notes=$6`,
      [today, sabaq, sabqi, manzil, tilawah, notes]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// HABITS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = (day === 6) ? 0 : (day + 1); // Week starts Saturday
  d.setDate(d.getDate() - diff);
  return d.toISOString().split('T')[0];
}

app.get('/api/habits', async (req, res) => {
  try {
    const week = getWeekStart();
    const result = await db.query(
      'SELECT * FROM habits WHERE week_start=$1', [week]
    );
    const state = {};
    result.rows.forEach(r => { state[`${r.habit_idx}-${r.day_idx}`] = r.done; });
    res.json({ weekStart: week, state });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/habits/toggle', async (req, res) => {
  try {
    const { habitIdx, dayIdx, done } = req.body;
    const week = getWeekStart();
    await db.query(
      `INSERT INTO habits (week_start, habit_idx, day_idx, done) VALUES ($1,$2,$3,$4)
       ON CONFLICT (week_start, habit_idx, day_idx) DO UPDATE SET done=$4`,
      [week, habitIdx, dayIdx, done]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/habits/reset', async (req, res) => {
  try {
    const week = getWeekStart();
    await db.query('DELETE FROM habits WHERE week_start=$1', [week]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`MALIK OS Backend running on port ${PORT}`);
  await initDB();
});
