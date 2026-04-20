require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const Groq = require('groq-sdk');
const path = require('path');
const cron = require('node-cron');
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
const memUsers = {};

// ── HELPERS SUPABASE ──────────────────────────────────
async function getUser(email) {
  if (!supabase) return memUsers[email] || null;
  const { data } = await supabase.from('users').select('*').eq('email', email).single();
  return data;
}

async function getAllConnectedUsers() {
  if (!supabase) return Object.values(memUsers).filter(u => u.connected && u.google_access_token);
  const { data } = await supabase.from('users').select('*').eq('connected', true).not('google_access_token', 'is', null);
  return data || [];
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

// ── GOOGLE CONFIG ──────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL  = process.env.GOOGLE_CALLBACK_URL || 'https://reviewai-production-dc76.up.railway.app/api/auth/google/callback';
const GOOGLE_MAPS_KEY      = process.env.GOOGLE_MAPS_API_KEY;

// ── MERCADOPAGO ────────────────────────────────────────
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;
let mpClient = null;
if (MP_TOKEN) {
  mpClient = new MercadoPagoConfig({ accessToken: MP_TOKEN });
  console.log('✅ MercadoPago configurado');
}
const MP_PLANS = {
  starter: { name: 'ReviewAI Starter',    amount: 19, currency_id: 'ARS' },
  pro:     { name: 'ReviewAI Profesional', amount: 39, currency_id: 'ARS' },
  agency:  { name: 'ReviewAI Agencia',     amount: 99, currency_id: 'ARS' }
};

// ════════════════════════════════════════════════════════
// ── GOOGLE BUSINESS PROFILE (GBP) HELPERS ─────────────
// ════════════════════════════════════════════════════════

// Refrescar access_token usando refresh_token
async function refreshGoogleToken(user) {
  if (!user.google_refresh_token) return user.google_access_token;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: user.google_refresh_token,
        grant_type: 'refresh_token'
      })
    });
    const data = await res.json();
    if (data.access_token) {
      await updateUser(user.email, { google_access_token: data.access_token });
      return data.access_token;
    }
  } catch (e) {
    console.error('Error refreshing token:', e.message);
  }
  return user.google_access_token;
}

// Obtener cuentas GBP del usuario
async function getGBPAccounts(accessToken) {
  const res = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(`GBP Accounts: ${data.error.message}`);
  return data.accounts || [];
}

// Obtener locations (negocios) de una cuenta
async function getGBPLocations(accessToken, accountName) {
  const res = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(`GBP Locations: ${data.error.message}`);
  return data.locations || [];
}

// Obtener reseñas de una location (API v4)
async function getGBPReviews(accessToken, accountId, locationId) {
  const res = await fetch(
    `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews?pageSize=50&orderBy=updateTime+desc`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (data.error) throw new Error(`GBP Reviews: ${data.error.message}`);
  return data.reviews || [];
}

// Publicar respuesta a una reseña (API v4)
async function postGBPReply(accessToken, accountId, locationId, reviewId, replyText) {
  const res = await fetch(
    `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment: replyText })
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(`GBP Reply: ${data.error.message}`);
  return data;
}

// Generar respuesta con IA
async function generateAIResponse(review, businessName) {
  const stars = review.starRating === 'FIVE' ? 5 : review.starRating === 'FOUR' ? 4 : review.starRating === 'THREE' ? 3 : review.starRating === 'TWO' ? 2 : 1;
  const text = review.comment || '(Sin comentario)';
  const author = review.reviewer?.displayName || 'Cliente';
  const sentiment = stars >= 4 ? 'positiva' : stars === 3 ? 'neutra' : 'negativa';

  const prompt = `Sos el community manager de "${businessName}".
Respondé esta reseña de Google de manera profesional y cordial.

REGLAS:
- Máximo 4 oraciones
- Agradecé siempre al cliente por tomarse el tiempo
- Si es negativa (1-2 estrellas), pedí disculpas sinceras y ofrecé solución
- Si es neutra (3 estrellas), agradecé y comprometete a mejorar
- Si es positiva (4-5 estrellas), celebrá e invitá a volver
- Mencioná el nombre del negocio
- Soná humano y cálido, no robótico
- En español latinoamericano

RESEÑA de ${author} (${stars} ⭐ - ${sentiment}):
"${text}"

Respondé SOLO la respuesta, sin explicaciones ni comillas.`;

  const aiRes = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 200,
    temperature: 0.75,
    messages: [{ role: 'user', content: prompt }]
  });
  return aiRes.choices[0].message.content.trim();
}

// ── PROCESO AUTOMÁTICO PARA UN USUARIO ────────────────
async function autoRespondForUser(user) {
  console.log(`\n🔄 Auto-respondiendo para: ${user.email}`);
  if (!user.gbp_account_id || !user.gbp_location_id) {
    console.log(`  ⚠️  Sin account/location configurado`);
    return { responded: 0, error: 'Sin negocio configurado' };
  }

  try {
    const accessToken = await refreshGoogleToken(user);
    const reviews = await getGBPReviews(accessToken, user.gbp_account_id, user.gbp_location_id);
    const businessName = user.business_name || 'el negocio';

    const unanswered = reviews.filter(r => !r.reviewReply);
    console.log(`  📝 ${reviews.length} reseñas, ${unanswered.length} sin responder`);

    let responded = 0;
    for (const review of unanswered) {
      try {
        const reply = await generateAIResponse(review, businessName);
        await postGBPReply(accessToken, user.gbp_account_id, user.gbp_location_id, review.reviewId, reply);
        responded++;
        console.log(`  ✅ Respondida reseña de ${review.reviewer?.displayName}`);
        // Esperar 2 seg entre respuestas para no saturar la API
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`  ❌ Error respondiendo reseña: ${err.message}`);
      }
    }

    // Actualizar contador en Supabase
    if (responded > 0) {
      await updateUser(user.email, {
        reviews_responded: (user.reviews_responded || 0) + responded
      });
    }

    return { responded, total: reviews.length };
  } catch (err) {
    console.error(`  ❌ Error para ${user.email}: ${err.message}`);
    return { responded: 0, error: err.message };
  }
}

// ── CRON JOB: cada hora revisa y responde ─────────────
cron.schedule('0 * * * *', async () => {
  console.log('\n⏰ CRON: Iniciando ciclo automático de respuestas...');
  try {
    const users = await getAllConnectedUsers();
    console.log(`  👥 ${users.length} usuarios conectados`);
    for (const user of users) {
      await autoRespondForUser(user);
    }
    console.log('⏰ CRON: Ciclo completado\n');
  } catch (err) {
    console.error('CRON error:', err.message);
  }
});

// ════════════════════════════════════════════════════════
// ── RUTAS AUTH ────────────────────────────────────────
// ════════════════════════════════════════════════════════

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

// ── DEMO PÚBLICA ────────────────────────────────────
app.post('/api/demo', async (req, res) => {
  const { review, business_type, tone } = req.body;
  if (!review) return res.status(400).json({ error: 'Falta la reseña' });
  const tones = { profesional: 'profesional y cordial', amigable: 'cálido y amigable', formal: 'muy formal' };
  const tonoTexto = tones[tone] || tones.profesional;
  const prompt = `Sos el community manager de ${business_type || 'un negocio local'}.
Respondé esta reseña de manera ${tonoTexto}. Máximo 4 oraciones. En español latinoamericano.
RESEÑA: "${review}"
Respondé SOLO la respuesta, sin comillas.`;
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile', max_tokens: 300, temperature: 0.8,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ success: true, response: response.choices[0].message.content.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// ── GOOGLE OAUTH FLOW ─────────────────────────────────
// ════════════════════════════════════════════════════════

app.get('/api/auth/google', (req, res) => {
  if (!req.session.user) return res.redirect('/login.html');
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google OAuth no configurado' });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_CALLBACK_URL,
    response_type: 'code',
    // business.manage = permiso para leer y responder reseñas
    scope: 'openid email profile https://www.googleapis.com/auth/business.manage',
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

    // Guardar tokens
    await updateUser(email, {
      google_access_token: tokens.access_token,
      google_refresh_token: tokens.refresh_token || null,
      connected: true
    });

    // Intentar obtener el negocio de GBP automáticamente
    try {
      const accounts = await getGBPAccounts(tokens.access_token);
      if (accounts.length > 0) {
        const account = accounts[0];
        const accountId = account.name.split('/')[1];
        const locations = await getGBPLocations(tokens.access_token, account.name);
        if (locations.length > 0) {
          const location = locations[0];
          const locationId = location.name.split('/')[1];
          await updateUser(email, {
            gbp_account_id: accountId,
            gbp_location_id: locationId,
            business_name: location.title || 'Mi Negocio'
          });
          console.log(`✅ GBP configurado: ${location.title} (${accountId}/${locationId})`);
        }
      }
    } catch (gbpErr) {
      console.warn('⚠️  No se pudo obtener GBP automáticamente:', gbpErr.message);
      // No es error fatal — el usuario puede configurar manualmente
    }

    console.log(`✅ Google conectado para ${email}`);
    res.redirect('/dashboard?connected=1');
  } catch (err) {
    console.error('Google OAuth callback error:', err.message);
    res.redirect('/dashboard?error=oauth_failed');
  }
});

// ── TRIGGER MANUAL: responder ahora ───────────────────
app.post('/api/respond-now', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  try {
    const user = await getUser(email);
    const result = await autoRespondForUser(user);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CONFIGURAR NEGOCIO GBP ────────────────────────────
app.post('/api/setup-business', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  try {
    const user = await getUser(email);
    const accessToken = await refreshGoogleToken(user);
    const accounts = await getGBPAccounts(accessToken);

    if (accounts.length === 0) return res.status(404).json({ error: 'No se encontraron cuentas de Google Business' });

    const results = [];
    for (const account of accounts) {
      const accountId = account.name.split('/')[1];
      const locations = await getGBPLocations(accessToken, account.name);
      for (const loc of locations) {
        results.push({
          accountId,
          locationId: loc.name.split('/')[1],
          name: loc.title
        });
      }
    }
    res.json({ success: true, businesses: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/select-business', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  const { accountId, locationId, name } = req.body;
  try {
    await updateUser(email, {
      gbp_account_id: accountId,
      gbp_location_id: locationId,
      business_name: name
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── VER RESEÑAS DEL NEGOCIO ───────────────────────────
app.get('/api/my-reviews', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  try {
    const user = await getUser(email);
    if (!user.gbp_account_id || !user.gbp_location_id) {
      return res.json({ reviews: [], message: 'Negocio no configurado' });
    }
    const accessToken = await refreshGoogleToken(user);
    const reviews = await getGBPReviews(accessToken, user.gbp_account_id, user.gbp_location_id);

    const formatted = reviews.map(r => ({
      id: r.reviewId,
      author: r.reviewer?.displayName || 'Anónimo',
      stars: r.starRating === 'FIVE' ? 5 : r.starRating === 'FOUR' ? 4 : r.starRating === 'THREE' ? 3 : r.starRating === 'TWO' ? 2 : 1,
      text: r.comment || '',
      date: r.createTime,
      hasReply: !!r.reviewReply,
      reply: r.reviewReply?.comment || null
    }));

    res.json({ success: true, reviews: formatted, business: user.business_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BUSCAR LUGAR (Places API) ─────────────────────────
app.get('/api/search-place', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  if (!GOOGLE_MAPS_KEY) return res.status(503).json({ error: 'Maps API no configurada' });
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Falta query' });
  try {
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address,rating&key=${GOOGLE_MAPS_KEY}&language=es`;
    const response = await fetch(url);
    const data = await response.json();
    res.json({ places: data.candidates || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EJEMPLO DE RESEÑAS (fallback) ────────────────────
app.get('/api/reviews', (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  res.json([
    { id: 1, author: 'María González', stars: 5, text: 'Excelente servicio!', hasReply: true, reply: 'Muchas gracias María! Te esperamos pronto.', date: '15/04/2026' },
    { id: 2, author: 'Carlos Ruiz', stars: 2, text: 'La comida llegó fría.', hasReply: true, reply: 'Lamentamos tu experiencia Carlos. Contactanos.', date: '14/04/2026' },
    { id: 3, author: 'Ana Martínez', stars: 5, text: 'El mejor lugar!', hasReply: false, reply: null, date: '13/04/2026' },
  ]);
});

// ── SUSCRIPCIONES MERCADOPAGO ─────────────────────────
app.post('/api/subscribe', async (req, res) => {
  const email = req.session.user;
  if (!email) return res.status(401).json({ error: 'No autenticado' });
  if (!mpClient) return res.status(503).json({ error: 'Pagos no configurados' });
  const { plan } = req.body;
  const planData = MP_PLANS[plan];
  if (!planData) return res.status(400).json({ error: 'Plan inválido' });
  try {
    const preApproval = new PreApproval(mpClient);
    const response = await preApproval.create({
      body: {
        reason: planData.name,
        auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: planData.amount, currency_id: planData.currency_id },
        payer_email: email,
        back_url: 'https://reviewai-production-dc76.up.railway.app/dashboard',
        status: 'pending'
      }
    });
    res.json({ init_point: response.init_point });
  } catch (err) {
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
