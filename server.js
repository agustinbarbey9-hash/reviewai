require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const Groq = require('groq-sdk');
const path = require('path');

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

const GROQ_KEY = process.env.GROQ_API_KEY;
if (!GROQ_KEY) { console.error('❌ Falta GROQ_API_KEY en las variables de entorno'); process.exit(1); }
const groq = new Groq({ apiKey: GROQ_KEY });

// In-memory users for MVP (reemplazar con Supabase después)
const users = {};

// ── AUTH ──────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { email, password, business } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Faltan datos' });
  if (users[email]) return res.status(400).json({ error: 'El email ya está registrado' });
  users[email] = { email, password, business: business || '', plan: 'trial', reviewsResponded: 0, connected: false, createdAt: new Date() };
  req.session.user = email;
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = users[email];
  if (!user || user.password !== password) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  req.session.user = email;
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  const email = req.session.user;
  if (!email || !users[email]) return res.status(401).json({ error: 'No autenticado' });
  const { password, ...safe } = users[email];
  res.json(safe);
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
app.post('/api/connect-google', (req, res) => {
  const email = req.session.user;
  if (!email || !users[email]) return res.status(401).json({ error: 'No autenticado' });
  users[email].connected = true;
  users[email].businessName = req.body.businessName || 'Mi Negocio';
  res.json({ success: true });
});

// ── DASHBOARD: simular reseñas respondidas ────────────
app.get('/api/reviews', (req, res) => {
  const email = req.session.user;
  if (!email || !users[email]) return res.status(401).json({ error: 'No autenticado' });
  // Reseñas de ejemplo para el dashboard
  res.json([
    { id: 1, author: 'María González', stars: 5, text: 'Excelente servicio, volvería sin dudarlo!', response: 'Muchas gracias María! Nos alegra muchísimo que hayas tenido una gran experiencia. Te esperamos pronto!', date: '2026-04-15', status: 'responded' },
    { id: 2, author: 'Carlos Ruiz', stars: 2, text: 'Esperé 45 minutos y la comida llegó fría.', response: 'Lamentamos mucho tu experiencia Carlos. Eso no refleja nuestros estándares. Te invitamos a contactarnos para compensarte.', date: '2026-04-14', status: 'responded' },
    { id: 3, author: 'Ana Martínez', stars: 5, text: 'El mejor lugar de la ciudad, el ambiente es increíble!', response: 'Gracias Ana!! Esas palabras nos llenan de energía. El equipo te manda saludos y te espera pronto!', date: '2026-04-13', status: 'responded' },
    { id: 4, author: 'Diego López', stars: 4, text: 'Muy buena atención, aunque un poco caro.', response: 'Gracias Diego por tu honestidad! Trabajamos para ofrecer la mejor calidad. Tu opinión nos ayuda a mejorar.', date: '2026-04-12', status: 'responded' },
  ]);
});

// ── PÁGINAS ───────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const PORT = process.env.PORT || 3020;
app.listen(PORT, () => console.log(`\n🚀 ReviewAI corriendo en http://localhost:${PORT}\n`));
