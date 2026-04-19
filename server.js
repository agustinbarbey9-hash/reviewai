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

// ── GOOGLE OAUTH CONFIG ────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL  = process.env.GOOGLE_CALLBACK_URL || 'https://reviewai-production-dc76.up.railway.app/api/auth/google/callback';
const GOOGLE_MAPS_KEY      = process.env.GOOGLE_MAPS_API_KEY;

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
    const { password, google_access_token, google_refresh_token, ...safe } = user;
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

// ── GOOGLE OAUTH FLOW ──────────────────────────────────
app.get('/api/auth/google', (req, res) => {
  if (!req.session.user) return res.redirect('/login.html');
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth no configurado' });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_CALLBACK_URL,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent'
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  const email = req.session.user;

  if (error) return res.redirect('/dashboard?error=google_denied');
  if (!email) return res.redirect('/login.html');
  if (!code) return res.redirect('/dashboard?error=no_code');

  try {
    // Intercambiar código por tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_CALLBACK_URL,
        grant_type: 'authorization_code',
        code
      })
    });

    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    // Guardar tokens en Supabase
    await updateUser(email, {
      google_access_token: tokens.access_token,
      google_refresh_token: tokens.refresh_token || null,
      connected: true
    });

    console.log(`✅ Google conectado para ${email}`);
    res.redirect('/dashboard?connected=1');
  } catch (err) {
    console.error('Google OAuth callback error:', err.message);
    res.redirect('/dashboard?error=oauth_failed');
  }
});

// ── BUSCAR NEGOCIO EN GOOGLE ───────────────────────────
app.get('/api/search-place', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  if (!GOOGLE_MAPS_KEY) return res.status(503).json({ error: 'Google Maps API no configurada' });

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Falta el nombre del negocio' });

  try {
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address,rating&key=${GOOGLE_MAPS_KEY}&language=es`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') {
      return res.json({ places: [] });
    }

    res.json({ places: data.candidates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OBTENER Y RESPONDER RESEÑAS (Places API) ──────────
app.post('/api/fetch-reviews', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  if (!GOOGLE_MAPS_KEY) return res.status(503).json({ error: 'Google Maps API no configurada' });

  const { place_id } = req.body;
  if (!place_id) return res.status(400).json({ error: 'Falta place_id' });

  try {
    // Obtener reseñas de Places API
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=name,rating,reviews&key=${GOOGLE_MAPS_KEY}&language=es&reviews_sort=newest`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') throw new Error(`Places API: ${data.status}`);

    const reviews = data.result.reviews || [];
    const businessName = data.result.name || 'el negocio';

    // Guardar place_id y business_name del usuario
    await updateUser(email, { place_id, business_name: businessName });

    // Generar respuestas con IA para cada reseña
    const processedReviews = await Promise.all(reviews.map(async (review) => {
      const stars = review.rating;
      const text = review.text || '(Sin texto)';
      const author = review.author_name || 'Cliente';

      const sentiment = stars >= 4 ? 'positiva' : stars === 3 ? 'neutra' : 'negativa';
      const prompt = `Sos el community manager de "${businessName}".
Respondé esta reseña de Google de manera profesional y cordial.

REGLAS:
- Máximo 4 oraciones
- Agradecé siempre al cliente por tomarse el tiempo de dejar su reseña
- Si es negativa (1-2 estrellas), pedí disculpas sinceras y ofrecé solución concreta
- Si es neutra (3 estrellas), agradecé y comprometete a mejorar
- Si es positiva (4-5 estrellas), celebrá y mencioná que esperan volver a verlo
- Mencioná el nombre del negocio
- Soná humano y cálido, no robótico ni corporativo
- En español latinoamericano

RESEÑA de ${author} (${stars} estrellas - reseña ${sentiment}):
"${text}"

Respondé SOLO la respuesta, sin explicaciones ni comillas.`;

      try {
        const aiRes = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 200,
          temperature: 0.75,
          messages: [{ role: 'user', content: prompt }]
        });

        return {
          author,
          stars,
          text,
          date: new Date(review.time * 1000).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }),
          profile_photo_url: review.profile_photo_url || null,
          ai_response: aiRes.choices[0].message.content.trim(),
          status: 'pending'
        };
      } catch (aiErr) {
        return { author, stars, text, date: '', ai_response: 'Error generando respuesta', status: 'error' };
      }
    }));

    // Actualizar contador
    const user = await getUser(email);
    const totalResponded = (user.reviews_responded || 0) + processedReviews.length;
    await updateUser(email, { reviews_responded: totalResponded });

    res.json({
      success: true,
      business: businessName,
      total: processedReviews.length,
      reviews: processedReviews
    });
  } catch (err) {
    console.error('Fetch reviews error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GENERAR RESPUESTA INDIVIDUAL ───────────────────────
app.post('/api/generate-response', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });

  const { review, stars, author, business_name, tone } = req.body;
  if (!review) return res.status(400).json({ error: 'Falta la reseña' });

  const tones = {
    profesional: 'profesional y cordial',
    amigable: 'cálido, cercano y amigable',
    formal: 'muy formal y corporativo'
  };
  const tonoTexto = tones[tone] || tones.profesional;

  const prompt = `Sos el community manager de "${business_name || 'el negocio'}".
Respondé esta reseña de Google de manera ${tonoTexto}.

REGLAS:
- Máximo 4 oraciones
- Agradecé siempre al cliente
- Si es negativa (menos de 3 estrellas), pedí disculpas y ofrecé solución
- Si es positiva, celebrá e invitá a volver
- Soná humano, no robótico
- En español latinoamericano

RESEÑA de ${author || 'Cliente'} (${stars || '?'} estrellas):
"${review}"

Respondé SOLO la respuesta, sin explicaciones ni comillas.`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 250,
      temperature: 0.8,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.choices[0].message.content.trim();
    res.json({ success: true, response: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CONECTAR GOOGLE (guardar place_id manualmente) ────
app.post('/api/connect-google', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  try {
    await updateUser(email, {
      connected: true,
      business_name: req.body.businessName || 'Mi Negocio',
      place_id: req.body.placeId || null
    });
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
    { id: 1, author: 'María González', stars: 5, text: 'Excelente servicio, volvería sin dudarlo!', response: 'Muchas gracias María! Nos alegra muchísimo que hayas tenido una gran experiencia. Te esperamos pronto!', date: '15/04/2026', status: 'responded' },
    { id: 2, author: 'Carlos Ruiz', stars: 2, text: 'Esperé 45 minutos y la comida llegó fría.', response: 'Lamentamos mucho tu experiencia Carlos. Eso no refleja nuestros estándares. Te invitamos a contactarnos para compensarte.', date: '14/04/2026', status: 'responded' },
    { id: 3, author: 'Ana Martínez', stars: 5, text: 'El mejor lugar de la ciudad, el ambiente es increíble!', response: 'Gracias Ana!! Esas palabras nos llenan de energía. El equipo te manda saludos y te espera pronto!', date: '13/04/2026', status: 'responded' },
    { id: 4, author: 'Diego López', stars: 4, text: 'Muy buena atención, aunque un poco caro.', response: 'Gracias Diego por tu honestidad! Trabajamos para ofrecer la mejor calidad. Tu opinión nos ayuda a mejorar.', date: '12/04/2026', status: 'responded' },
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
