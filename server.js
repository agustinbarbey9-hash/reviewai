require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const Groq = require('groq-sdk');
const path = require('path');
const { MercadoPagoConfig, PreApproval } = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'reviewai_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ── GROQ ──────────────────────────────────────────────
const GROQ_KEY = process.env.GROQ_API_KEY;
if (!GROQ_KEY) { console.error('❌ Falta GROQ_API_KEY'); process.exit(1); }
const groq = new Groq({ apiKey: GROQ_KEY });

// ── SUPABASE ──────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uofrrbokiucittfxrrsf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
let supabase = null;
if (SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('✅ Supabase configurado');
} else {
  console.warn('⚠️  SUPABASE_SERVICE_KEY no configurado — usando memoria temporal');
}

// Fallback en memoria para desarrollo local sin Supabase
const memUsers = {};

// ── HELPERS SUPABASE ──────────────────────────────────
async function getUser(email) {
  if (!supabase) return memUsers[email] || null;
  const { data } = await supabase.from('users').select('*').eq('email', email).single();
  return data;
}

async function createUser(email, password, business) {
  if (!supabase) {
    memUsers[email] = { email, password, business: business || '', plan: 'trial', reviews_responded: 0, connected: false, business_name: '', created_at: new Date() };
    return memUsers[email];
  }
  const { data, error } = await supabase.from('users').insert([
    { email, password, business: business || '', plan: 'trial', reviews_responded: 0, connected: false, business_name: '' }
  ]).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function updateUser(email, fields) {
  if (!supabase) {
    if (memUsers[email]) Object.assign(memUsers[email], fields);
    return;
  }
  await supabase.from('users').update(fields).eq('email', email);
}

// ── MERCADOPAGO ────────────────────────────────────────
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
let mpClient = null;
if (MP_TOKEN) {
  mpClient = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  console.log('✅ MercadoPago configurado');
} else {
  console.warn('⚠️  MP_ACCESS_TOKEN no configurado — pagos desactivados');
}

const MP_PLANS = {
  starter:  { name: 'ReviewAI Starter',      amount: 19,  currency_id: 'ARS' },
  pro:      { name: 'ReviewAI Profesional',   amount: 39,  currency_id: 'ARS' },
  agency:   { name: 'ReviewAI Agencia',       amount: 99,  currency_id: 'ARS' }
};

// ── AUTH ──────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { email, password, business } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Faltan datos' });
  try {
    const existing = await getUser(email);
    if (existing) return res.status(400).json({ error: 'El email ya está registrado' });
    await createUser(email, password, business);
    req.session.user = email;
    res.json({ success: true });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await getUser(email);
    if (!user || user.password !== password) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    req.session.user = email;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  try {
    const user = await getUser(email);
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    const { password, ...safe } = user;
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DEMO PÚBLICA (sin auth) ────────────────────────────
app.post('/api/demo', async (req, res) => {
  const { review, business_type, tone } = req.body;
  if (!review) return res.status(400).json({ error: 'Falta la reseña' });

  const tones = {
    profesional: 'profesional y cordial',
    amigable: 'cálido, cercano y amigable',
    formal: 'muy formal y corporativo'
  };
  const tonoTexto = tones[tone] || tones.profesional;

  const prompt = `Sos el community manager de ${business_type || 'un negocio local'}.
Tenés que responder esta reseña de Google de manera ${tonoTexto}.

REGLAS:
- Máximo 4 oraciones
- Agradecé siempre al cliente
- Si es negativa, pedí disculpas y ofrecé solución
- Si es positiva, celebrá e invitá a volver
- Usá el nombre del negocio si lo mencionan
- Soná humano, no robótico
- En español latinoamericano

RESEÑA DEL CLIENTE:
"${review}"

Respondé SOLO la respuesta, sin explicaciones ni comillas.`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      temperature: 0.8,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.choices[0].message.content.trim();
    res.json({ success: true, response: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DASHBOARD: conectar Google (simulado para MVP) ────
app.post('/api/connect-google', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  try {
    await updateUser(email, { connected: true, business_name: req.body.businessName || 'Mi Negocio' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DASHBOARD: reseñas de ejemplo ─────────────────────
app.get('/api/reviews', (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  res.json([
    { id: 1, author: 'María González', stars: 5, text: 'Excelente servicio, volvería sin dudarlo!', response: 'Muchas gracias María! Nos alegra muchísimo que hayas tenido una gran experiencia. Te esperamos pronto!', date: '2026-04-15', status: 'responded' },
    { id: 2, author: 'Carlos Ruiz', stars: 2, text: 'Esperé 45 minutos y la comida llegó fría.', response: 'Lamentamos mucho tu experiencia Carlos. Eso no refleja nuestros estándares. Te invitamos a contactarnos para compensarte.', date: '2026-04-14', status: 'responded' },
    { id: 3, author: 'Ana Martínez', stars: 5, text: 'El mejor lugar de la ciudad, el ambiente es increíble!', response: 'Gracias Ana!! Esas palabras nos llenan de energía. El equipo te manda saludos y te espera pronto!', date: '2026-04-13', status: 'responded' },
    { id: 4, author: 'Diego López', stars: 4, text: 'Muy buena atención, aunque un poco caro.', response: 'Gracias Diego por tu honestidad! Trabajamos para ofrecer la mejor calidad. Tu opinión nos ayuda a mejorar.', date: '2026-04-12', status: 'responded' },
  ]);
});

// ── SUSCRIPCIONES MERCADOPAGO ─────────────────────────
app.post('/api/subscribe', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  if (!mpClient) return res.status(503).json({ error: 'Pagos no configurados aún' });

  const { plan } = req.body;
  const planData = MP_PLANS[plan];
  if (!planData) return res.status(400).json({ error: 'Plan inválido' });

  try {
    const preApproval = new PreApproval(mpClient);
    const response = await preApproval.create({
      body: {
        reason: planData.name,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: planData.amount,
          currency_id: planData.currency_id
        },
        payer_email: email,
        back_url: 'https://reviewai-production-dc76.up.railway.app/dashboard',
        status: 'pending'
      }
    });
    res.json({ init_point: response.init_point });
  } catch (err) {
    console.error('MP Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PÁGINAS ───────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = process.env.PORT || 3020;
app.listen(PORT, () => console.log(`\n🚀 ReviewAI corriendo en http://localhost:${PORT}\n`));
