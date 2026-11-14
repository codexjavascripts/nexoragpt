import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const MODEL = 'openai/gpt-oss-120b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GUEST_DAYS = 30;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

try {
  const env = await readFile(resolve(ROOT, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch {}

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'groqgpt-private';

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked.' }); }
    catch { return res.status(403).json({ error: 'Cross-origin request blocked.' }); }
  }
  next();
});
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
const aiLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Please wait a moment before sending another request.' } });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' } });
const guestLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, skip: req => Boolean(cookieValue(req, cookieName)), message: { error: 'Guest workspaces are being created too quickly from this connection. Try again later.' } });

const cookieName = 'groqgpt_session';
const sessionMs = 30 * 24 * 60 * 60 * 1000;
const cookieSecure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
const defaultWorkspace = () => ({ chats: [], projects: [], assistants: [], folders: [], memory: [], settings: { memoryEnabled: true }, images: [] });
const isConfigured = () => Boolean(supabase && process.env.GROQ_API_KEY);

function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function cookieValue(req, name) {
  const row = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return row ? decodeURIComponent(row.slice(name.length + 1)) : '';
}
function setSessionCookie(res, token) { res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionMs / 1000)}${cookieSecure}`); }
function clearSessionCookie(res) { res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure}`); }
function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string' || !encoded.includes(':')) return false;
  const [salt, hash] = encoded.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
function cleanName(name) { return String(name || 'Untitled').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || 'Untitled'; }
function publicUser(user) { return { id: user.id, email: user.email || null, displayName: user.display_name || 'Guest', isGuest: Boolean(user.is_guest), role: user.role || 'user' }; }
function sendError(res, status, message) { return res.status(status).json({ error: message }); }

async function createSession(res, { userId = null, isAdmin = false } = {}) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + sessionMs).toISOString();
  const { error } = await supabase.from('app_sessions').insert({ token_hash: sha(token), user_id: userId, is_admin: isAdmin, expires_at: expires });
  if (error) throw error;
  setSessionCookie(res, token);
  return token;
}

async function resolveIdentity(req, res, createGuest = true) {
  if (!supabase) throw new Error('The private database has not been configured by the site owner.');
  const token = cookieValue(req, cookieName);
  if (token) {
    const tokenHash = sha(token);
    const { data: session } = await supabase.from('app_sessions').select('token_hash,user_id,is_admin,expires_at').eq('token_hash', tokenHash).gt('expires_at', new Date().toISOString()).maybeSingle();
    if (session?.is_admin) return { user: { id: null, email: process.env.ADMIN_EMAIL || 'Owner', display_name: 'Owner', role: 'admin', is_guest: false }, isAdmin: true, tokenHash };
    if (session?.user_id) {
      const { data: user } = await supabase.from('app_users').select('id,email,display_name,role,is_guest,expires_at').eq('id', session.user_id).maybeSingle();
      if (user && (!user.expires_at || Date.parse(user.expires_at) > Date.now())) return { user, isAdmin: user.role === 'admin', tokenHash };
    }
    await supabase.from('app_sessions').delete().eq('token_hash', tokenHash);
    clearSessionCookie(res);
  }
  if (!createGuest) return null;
  const expiresAt = new Date(Date.now() + GUEST_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: user, error } = await supabase.from('app_users').insert({ display_name: 'Guest', is_guest: true, role: 'user', expires_at: expiresAt }).select('id,email,display_name,role,is_guest,expires_at').single();
  if (error) throw error;
  await createSession(res, { userId: user.id });
  await supabase.from('workspaces').insert({ user_id: user.id, state: defaultWorkspace() });
  return { user, isAdmin: false };
}

async function requireUser(req, res, next) {
  try {
    const identity = await resolveIdentity(req, res, false);
    if (!identity?.user?.id) return sendError(res, 401, 'Sign in to continue.');
    req.identity = identity;
    next();
  } catch (error) { sendError(res, 503, 'GROQGPT is getting ready. Please try again shortly.'); }
}
async function requireAdmin(req, res, next) {
  try {
    const identity = await resolveIdentity(req, res, false);
    if (!identity?.isAdmin) return sendError(res, 403, 'Owner access required.');
    req.identity = identity;
    next();
  } catch { sendError(res, 403, 'Owner access required.'); }
}

function sanitizeWorkspace(input) {
  const state = input && typeof input === 'object' ? input : {};
  const arrays = ['chats', 'projects', 'assistants', 'folders', 'memory', 'images'];
  const out = {};
  for (const key of arrays) out[key] = Array.isArray(state[key]) ? state[key].slice(0, key === 'chats' ? 500 : 250) : [];
  out.settings = state.settings && typeof state.settings === 'object' ? {
    displayName: cleanName(state.settings.displayName || 'Guest'),
    systemPrompt: String(state.settings.systemPrompt || '').slice(0, 6000),
    memoryEnabled: state.settings.memoryEnabled !== false,
    plugins: state.settings.plugins && typeof state.settings.plugins === 'object' ? state.settings.plugins : {},
    theme: state.settings.theme === 'dark' ? 'dark' : 'light'
  } : { memoryEnabled: true, theme: 'light' };
  for (const chat of out.chats) {
    chat.id = String(chat.id || randomUUID()).slice(0, 120);
    chat.title = cleanName(chat.title);
    chat.messages = Array.isArray(chat.messages) ? chat.messages.slice(-500).map(m => ({
      role: ['user', 'assistant'].includes(m.role) ? m.role : 'user',
      text: String(m.text || '').slice(0, 100_000),
      content: String(m.content ?? m.text ?? '').slice(0, 100_000),
      attachments: Array.isArray(m.attachments) ? m.attachments.slice(0, 15).map(a => ({ name: cleanName(a.name) })) : [],
      created: Number(m.created) || Date.now()
    })) : [];
    chat.created = Number(chat.created) || Date.now();
    chat.updated = Number(chat.updated) || chat.created;
    chat.archived = Boolean(chat.archived);
    chat.projectId = typeof chat.projectId === 'string' ? chat.projectId.slice(0, 120) : null;
    chat.systemPrompt = String(chat.systemPrompt || '').slice(0, 6000);
    chat.assistantName = String(chat.assistantName || '').slice(0, 120);
  }
  return out;
}

async function getWorkspace(userId) {
  let { data, error } = await supabase.from('workspaces').select('state').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) {
    const created = await supabase.from('workspaces').insert({ user_id: userId, state: defaultWorkspace() }).select('state').single();
    if (created.error) throw created.error;
    data = created.data;
  }
  return data.state || defaultWorkspace();
}

async function writeUsage(userId, eventType) {
  try { await supabase.from('usage_events').insert({ user_id: userId, event_type: eventType, model: MODEL }); } catch {}
}

async function groqCompletion(messages, options = {}) {
  return fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, max_completion_tokens: options.maxTokens || 4096, ...options.payload }),
    signal: options.signal
  });
}

const tools = [
  { type: 'function', function: { name: 'calculator', description: 'Evaluate a basic arithmetic expression.', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'], additionalProperties: false } } },
  { type: 'function', function: { name: 'weather', description: 'Get current weather and a short forecast for a city.', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'], additionalProperties: false } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web for current facts and sources.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } },
  { type: 'function', function: { name: 'search_library', description: 'Search the current visitor’s private uploaded files.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } },
  { type: 'function', function: { name: 'calendar_list', description: 'List upcoming events in the visitor’s private GROQGPT calendar.', parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90 } }, additionalProperties: false } } }
];

function evaluateExpression(source) {
  const tokens = String(source).replace(/×/g, '*').replace(/÷/g, '/').match(/\d+(?:\.\d+)?|[()+\-*/%^]/g);
  if (!tokens || tokens.join('') !== String(source).replace(/\s/g, '').replace(/×/g, '*').replace(/÷/g, '/')) throw new Error('Use numbers and basic arithmetic operators.');
  let at = 0;
  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
  function atom() {
    const token = tokens[at++];
    if (token === '-') return -atom();
    if (token === '+') return atom();
    if (token === '(') { const value = expr(0); if (tokens[at++] !== ')') throw new Error('Missing closing parenthesis.'); return value; }
    const value = Number(token); if (!Number.isFinite(value)) throw new Error('Invalid expression.'); return value;
  }
  function expr(min) {
    let left = atom();
    while (at < tokens.length) {
      const op = tokens[at], p = precedence[op]; if (!p || p < min) break; at++;
      const right = expr(p + (op === '^' ? 0 : 1));
      if (op === '+') left += right; else if (op === '-') left -= right; else if (op === '*') left *= right; else if (op === '/') left /= right; else if (op === '%') left %= right; else left = left ** right;
    }
    return left;
  }
  const result = expr(0); if (at !== tokens.length || !Number.isFinite(result)) throw new Error('Invalid or non-finite result.'); return String(Number(result.toPrecision(12)));
}

async function searchWeb(query) {
  if (process.env.TAVILY_API_KEY) {
    const response = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5, include_answer: true }) });
    const json = await response.json().catch(() => ({}));
    if (response.ok) return { answer: json.answer || '', results: (json.results || []).map(x => ({ title: x.title, url: x.url, content: x.content })) };
  }
  try {
    const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, { signal: AbortSignal.timeout(10_000) });
    const json = await response.json().catch(() => ({}));
    const related = (json.RelatedTopics || []).flatMap(item => item.Topics || [item]).filter(item => item.Text && item.FirstURL).slice(0, 8).map(item => ({ title: item.Text, url: item.FirstURL, content: item.Text }));
    return { answer: json.AbstractText || '', heading: json.Heading || '', source: json.AbstractURL || '', results: related };
  } catch { return { error: 'Web search is temporarily unavailable.' }; }
}

async function getWeather(location) {
  const geoResponse = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`);
  const geo = await geoResponse.json().catch(() => ({})); const place = geo.results?.[0];
  if (!place) return { error: `No location found for ${location}.` };
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=3`);
  const weather = await response.json().catch(() => ({}));
  return { location: `${place.name}${place.admin1 ? `, ${place.admin1}` : ''}`, current: weather.current, daily: weather.daily };
}

async function executeTool(name, args, userId) {
  if (name === 'calculator') return { result: evaluateExpression(args.expression) };
  if (name === 'weather') return getWeather(args.location);
  if (name === 'web_search') return searchWeb(args.query);
  if (name === 'search_library') {
    const { data, error } = await supabase.from('library_files').select('name,extracted_text,project_id').eq('user_id', userId).textSearch('search_vector', args.query, { type: 'websearch', config: 'english' }).limit(5);
    if (error) return { error: 'Could not search the private library.' };
    return { results: (data || []).map(file => ({ name: file.name, excerpt: file.extracted_text.slice(0, 1600) })) };
  }
  if (name === 'calendar_list') {
    const from = new Date().toISOString(), to = new Date(Date.now() + Math.min(90, Math.max(1, Number(args.days) || 7) * 86_400_000)).toISOString();
    const { data, error } = await supabase.from('calendar_events').select('title,description,starts_at,ends_at').eq('user_id', userId).gte('starts_at', from).lte('starts_at', to).order('starts_at').limit(50);
    return error ? { error: 'Calendar is unavailable.' } : { events: data || [] };
  }
  return { error: 'This tool is not available.' };
}

async function workspaceContext(userId, projectId) {
  const state = await getWorkspace(userId);
  const pieces = [];
  if (state.settings?.systemPrompt) pieces.push(`Visitor preferences:\n${state.settings.systemPrompt}`);
  if (state.settings?.memoryEnabled !== false && state.memory?.length) pieces.push(`Saved memory:\n${state.memory.map(item => typeof item === 'string' ? item : item.content).filter(Boolean).join('\n')}`);
  if (projectId) {
    const project = state.projects?.find(x => x.id === projectId);
    if (project) pieces.push(`Current project: ${project.name}\n${project.instructions || ''}`);
  }
  return pieces.length ? pieces.join('\n\n') : '';
}

async function chatHandler(req, res) {
  if (!isConfigured()) return sendError(res, 503, 'Chat service is temporarily unavailable.');
  const input = req.body?.messages;
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) return sendError(res, 400, 'Send between 1 and 100 messages.');
  let total = 0;
  const messages = input.filter(m => m && ['user', 'assistant'].includes(m.role)).map(m => {
    const content = String(m.text ?? m.content ?? '').slice(0, 100_000); total += content.length; return { role: m.role, content };
  });
  if (total > 400_000 || !messages.some(m => m.role === 'user')) return sendError(res, 413, 'Conversation is too long or has no user message.');
  const controller = new AbortController();
  try {
    const privateContext = await workspaceContext(req.identity.user.id, req.body.projectId);
    const system = [`You are GROQGPT, a helpful assistant powered by OpenAI GPT OSS 120B on Groq. Be accurate and clearly say when you do not know. You may use the provided tools for live web search, calculations, weather, private library search, or calendar lookup. Never claim a tool ran unless a tool result is present.`, privateContext].filter(Boolean).join('\n\n');
    const prompt = [{ role: 'system', content: system }, ...messages];
    const plugins = await getWorkspace(req.identity.user.id).then(x => x.settings?.plugins || {});
    const enabledTools = tools.filter(t => {
      const id = t.function.name;
      if (id === 'web_search') return plugins.web_search !== false && Boolean(process.env.TAVILY_API_KEY);
      if (id === 'weather') return plugins.weather !== false;
      if (id === 'calculator') return plugins.calculator !== false;
      if (id === 'search_library') return plugins.file_analyzer !== false;
      return plugins.calendar !== false;
    });
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let done = false;
    for (let turn = 0; turn < 5 && !done; turn++) {
      const upstream = await groqCompletion(prompt, { signal: controller.signal, payload: { stream: true, tools: enabledTools, tool_choice: enabledTools.length ? 'auto' : 'none' } });
      if (!upstream.ok) {
        const err = await upstream.json().catch(() => ({}));
        res.write(`data: ${JSON.stringify({ error: err.error?.message || 'AI service is temporarily unavailable.' })}\n\n`);
        break;
      }
      let buffer = '', toolCalls = {}, finishReason = null;
      const reader = upstream.body.getReader(); const decoder = new TextDecoder();
      while (true) {
        const { value, done: ended } = await reader.read(); if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const datum = line.slice(5).trim(); if (!datum || datum === '[DONE]') continue;
          let part; try { part = JSON.parse(datum); } catch { continue; }
          const choice = part.choices?.[0]; const delta = choice?.delta;
          if (typeof delta?.content === 'string') res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta.content } }] })}\n\n`);
          if (Array.isArray(delta?.tool_calls)) for (const item of delta.tool_calls) {
            const entry = toolCalls[item.index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (item.id) entry.id += item.id;
            if (item.function?.name) entry.function.name += item.function.name;
            if (item.function?.arguments) entry.function.arguments += item.function.arguments;
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        }
      }
      const calls = Object.values(toolCalls);
      if (finishReason === 'tool_calls' && calls.length) {
        prompt.push({ role: 'assistant', content: null, tool_calls: calls });
        for (const call of calls) {
          let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
          const status = { calculator: 'Calculating…', weather: 'Checking the forecast…', web_search: 'Searching the web…', search_library: 'Searching your library…', calendar_list: 'Checking your calendar…' }[call.function.name] || 'Using a tool…';
          res.write(`data: ${JSON.stringify({ status })}\n\n`);
          let result;
          try { result = await executeTool(call.function.name, args, req.identity.user.id); }
          catch { result = { error: 'This tool is temporarily unavailable.' }; }
          prompt.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12_000) });
        }
      } else done = true;
    }
    res.write('data: [DONE]\n\n'); res.end();
    await writeUsage(req.identity.user.id, 'chat');
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error('GROQGPT chat failed:', error.message);
    if (!res.headersSent) sendError(res, 503, 'Chat service is temporarily unavailable.');
    else if (!res.writableEnded) { res.write(`data: ${JSON.stringify({ error: 'Chat service is temporarily unavailable.' })}\n\n`); res.end('data: [DONE]\n\n'); }
  }
}

async function summarizeTask(task) {
  if (!process.env.GROQ_API_KEY) throw new Error('Chat service is unavailable.');
  const response = await groqCompletion([{ role: 'system', content: 'Complete this scheduled task. Be concise and useful.' }, { role: 'user', content: task.prompt }], { maxTokens: 2048 });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error?.message || 'Task could not be completed.');
  return json.choices?.[0]?.message?.content || 'No result.';
}

function nextTaskDate(date, cadence) {
  const next = new Date(date);
  if (cadence === 'once') return next.toISOString();
  let attempts = 0;
  do {
    if (cadence === 'daily') next.setUTCDate(next.getUTCDate() + 1);
    else if (cadence === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
    else if (cadence === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);
    attempts++;
  } while (next.getTime() <= Date.now() && attempts < 120);
  return next.toISOString();
}

async function runSchedulerBatch() {
  if (!supabase || !process.env.GROQ_API_KEY) return;
  const { data: due, error } = await supabase.rpc('claim_due_ai_tasks', { batch_size: 10 });
  if (error || !due?.length) return;
  for (const task of due) {
    try {
      const result = await summarizeTask(task);
      const recurring = task.cadence !== 'once';
      await supabase.from('scheduled_tasks').update({ status: recurring ? 'scheduled' : 'completed', enabled: recurring, next_run_at: recurring ? nextTaskDate(task.next_run_at, task.cadence) : task.next_run_at, last_result: result, last_error: null, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', task.id);
      await writeUsage(task.user_id, 'scheduled_task');
    } catch (error) {
      await supabase.from('scheduled_tasks').update({ status: 'failed', last_error: String(error.message).slice(0, 500), last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', task.id);
    }
  }
}

async function cleanupGuests() {
  if (!supabase) return;
  const { data: guests } = await supabase.from('app_users').select('id').eq('is_guest', true).lt('expires_at', new Date().toISOString()).limit(100);
  for (const guest of guests || []) {
    const { data: files } = await supabase.from('library_files').select('object_key').eq('user_id', guest.id);
    const { data: images } = await supabase.from('image_assets').select('object_key').eq('user_id', guest.id);
    const keys = [...(files || []), ...(images || [])].map(x => x.object_key);
    if (keys.length) await supabase.storage.from(STORAGE_BUCKET).remove(keys).catch(() => {});
    await supabase.from('app_users').delete().eq('id', guest.id);
  }
  await supabase.from('app_sessions').delete().lt('expires_at', new Date().toISOString());
}

app.get('/api/status', async (_req, res) => {
  res.json({ ready: Boolean(supabase && process.env.GROQ_API_KEY), model: MODEL, images: Boolean(process.env.IMAGE_API_KEY), webSearch: true, storage: Boolean(supabase) });
});

app.get('/api/session', guestLimiter, async (req, res) => {
  try { const identity = await resolveIdentity(req, res, true); res.json({ user: publicUser(identity.user) }); }
  catch (error) { sendError(res, 503, 'The hosted workspace is not connected yet.'); }
});

app.post('/api/auth/register', loginLimiter, requireUser, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase(); const password = String(req.body?.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || password.length > 128) return sendError(res, 400, 'Use a valid email and a password with 10 to 128 characters.');
  const { data, error } = await supabase.from('app_users').update({ email, password_hash: passwordHash(password), is_guest: false, expires_at: null }).eq('id', req.identity.user.id).select('id,email,display_name,role,is_guest').single();
  if (error) return sendError(res, 409, 'That email may already have an account. Try signing in instead.');
  res.json({ user: publicUser(data) });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  if (!supabase) return sendError(res, 503, 'Account service is temporarily unavailable.');
  const email = String(req.body?.email || '').trim().toLowerCase(); const password = String(req.body?.password || '');
  if (password.length > 128) return sendError(res, 401, 'Email or password is incorrect.');
  const { data: user } = await supabase.from('app_users').select('id,email,password_hash,display_name,role,is_guest').eq('email', email).eq('is_guest', false).maybeSingle();
  if (!user || !verifyPassword(password, user.password_hash)) return sendError(res, 401, 'Email or password is incorrect.');
  const oldToken = cookieValue(req, cookieName); if (oldToken) await supabase.from('app_sessions').delete().eq('token_hash', sha(oldToken));
  await createSession(res, { userId: user.id });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = cookieValue(req, cookieName); if (token && supabase) await supabase.from('app_sessions').delete().eq('token_hash', sha(token));
  clearSessionCookie(res); res.json({ ok: true });
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase(); const password = String(req.body?.password || '');
  const expectedEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase(); const expectedPassword = String(process.env.ADMIN_PASSWORD || '');
  const same = (a, b) => { const aa = Buffer.from(String(a)), bb = Buffer.from(String(b)); return aa.length === bb.length && timingSafeEqual(aa, bb); };
  if (!supabase || !expectedEmail || !expectedPassword || !same(email, expectedEmail) || !same(password, expectedPassword)) return sendError(res, 401, 'Owner credentials were not accepted.');
  const oldToken = cookieValue(req, cookieName); if (oldToken) await supabase.from('app_sessions').delete().eq('token_hash', sha(oldToken));
  await createSession(res, { isAdmin: true }); res.json({ ok: true });
});

app.get('/api/workspace', requireUser, async (req, res) => {
  try { res.json({ state: await getWorkspace(req.identity.user.id) }); }
  catch { sendError(res, 503, 'Your private workspace is temporarily unavailable.'); }
});

app.put('/api/workspace', requireUser, async (req, res) => {
  try {
    const state = sanitizeWorkspace(req.body?.state);
    const bytes = Buffer.byteLength(JSON.stringify(state));
    if (bytes > 4_000_000) return sendError(res, 413, 'Workspace is too large. Remove older content or files.');
    const { error } = await supabase.from('workspaces').upsert({ user_id: req.identity.user.id, state, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) throw error;
    res.json({ ok: true });
  } catch { sendError(res, 503, 'Could not save your private workspace.'); }
});

app.patch('/api/profile', requireUser, async (req, res) => {
  const displayName = cleanName(req.body?.displayName);
  const { data, error } = await supabase.from('app_users').update({ display_name: displayName }).eq('id', req.identity.user.id).select('id,email,display_name,role,is_guest').single();
  if (error) return sendError(res, 400, 'Could not update profile.');
  res.json({ user: publicUser(data) });
});

app.post('/api/chat', aiLimiter, requireUser, chatHandler);
app.post('/api/search', aiLimiter, requireUser, async (req, res) => {
  const query = String(req.body?.query || '').trim();
  if (!query || query.length > 1000) return sendError(res, 400, 'Enter a search phrase up to 1,000 characters.');
  const result = await searchWeb(query);
  if (result.error) return sendError(res, 503, 'Search is temporarily unavailable.');
  await writeUsage(req.identity.user.id, 'web_search'); res.json(result);
});
app.post('/api/complete', aiLimiter, requireUser, async (req, res) => {
  if (!isConfigured()) return sendError(res, 503, 'AI tools are temporarily unavailable.');
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt || prompt.length > 30_000) return sendError(res, 400, 'Text must be between 1 and 30,000 characters.');
  try {
    const response = await groqCompletion([{ role: 'system', content: 'Help with the user’s request. Be clear and concise.' }, { role: 'user', content: prompt }], { maxTokens: 2048 });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return sendError(res, response.status, 'AI tools are temporarily unavailable.');
    await writeUsage(req.identity.user.id, 'plugin'); res.json({ text: result.choices?.[0]?.message?.content || '' });
  } catch { sendError(res, 503, 'AI tools are temporarily unavailable.'); }
});

app.get('/api/plugins/status', requireUser, (_req, res) => res.json({ plugins: {
  calculator: { enabled: true, configured: true }, weather: { enabled: true, configured: true },
  web_search: { enabled: true, configured: true },
  translator: { enabled: true, configured: Boolean(process.env.GROQ_API_KEY) },
  summarizer: { enabled: true, configured: Boolean(process.env.GROQ_API_KEY) },
  pdf_reader: { enabled: true, configured: true }, file_analyzer: { enabled: true, configured: true },
  image_generator: { enabled: true, configured: Boolean(process.env.IMAGE_API_KEY) }, calendar: { enabled: true, configured: true }
} }));

app.get('/api/community/assistants', async (_req, res) => {
  if (!supabase) return res.json({ assistants: [] });
  const { data } = await supabase.from('community_assistants').select('id,name,description,instructions,category,use_count,created_at').order('use_count', { ascending: false }).order('created_at', { ascending: false }).limit(100);
  res.json({ assistants: data || [] });
});
app.post('/api/community/assistants', loginLimiter, requireUser, async (req, res) => {
  if (req.identity.user.is_guest) return sendError(res, 403, 'Create an account before publishing an assistant.');
  const name = cleanName(req.body?.name), instructions = String(req.body?.instructions || '').trim(), description = String(req.body?.description || '').trim().slice(0, 500), category = cleanName(req.body?.category || 'General').slice(0, 40);
  if (!instructions || instructions.length > 6000) return sendError(res, 400, 'Assistant instructions must be between 1 and 6,000 characters.');
  const { data, error } = await supabase.from('community_assistants').insert({ owner_id: req.identity.user.id, name, description: description || instructions.slice(0, 140), instructions, category }).select('id,name,description,instructions,category,use_count,created_at').single();
  if (error) return sendError(res, 503, 'Could not publish this assistant.');
  res.status(201).json({ assistant: data });
});
app.post('/api/community/assistants/:id/use', requireUser, async (req, res) => {
  const { data: current } = await supabase.from('community_assistants').select('use_count').eq('id', req.params.id).maybeSingle();
  if (!current) return sendError(res, 404, 'Assistant not found.');
  const { error } = await supabase.from('community_assistants').update({ use_count: Number(current.use_count || 0) + 1 }).eq('id', req.params.id);
  if (error) return sendError(res, 503, 'Could not open this assistant.');
  res.json({ ok: true });
});
app.delete('/api/community/assistants/:id', requireUser, async (req, res) => {
  const { data } = await supabase.from('community_assistants').delete().eq('id', req.params.id).eq('owner_id', req.identity.user.id).select('id').maybeSingle();
  if (!data) return sendError(res, 404, 'Assistant not found.');
  res.json({ ok: true });
});

app.get('/api/files', requireUser, async (req, res) => {
  const { data, error } = await supabase.from('library_files').select('id,project_id,name,mime_type,file_size,created_at').eq('user_id', req.identity.user.id).order('created_at', { ascending: false }).limit(200);
  if (error) return sendError(res, 503, 'Your library is temporarily unavailable.');
  res.json({ files: data || [] });
});

app.post('/api/files', requireUser, async (req, res) => {
  if (!supabase) return sendError(res, 503, 'File storage is unavailable.');
  const name = cleanName(req.body?.name); const extension = name.split('.').pop().toLowerCase();
  const allowedTypes = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  if (!allowedTypes[extension]) return sendError(res, 415, 'Upload a PDF, DOCX, TXT, CSV, or common image file.');
  const mime = allowedTypes[extension];
  const base64 = String(req.body?.dataBase64 || '').replace(/^data:[^,]+,/, '');
  if (!base64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) return sendError(res, 400, 'The file could not be read.');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_FILE_BYTES) return sendError(res, 413, 'Files must be 10 MB or smaller.');
  const extractedText = String(req.body?.extractedText || '').slice(0, 250_000);
  const objectKey = `${req.identity.user.id}/${randomUUID()}/${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  try {
    const stored = await supabase.storage.from(STORAGE_BUCKET).upload(objectKey, bytes, { contentType: mime, upsert: false });
    if (stored.error) throw stored.error;
    const { data, error } = await supabase.from('library_files').insert({ user_id: req.identity.user.id, project_id: req.body?.projectId || null, name, mime_type: mime, file_size: bytes.length, object_key: objectKey, extracted_text: extractedText }).select('id,project_id,name,mime_type,file_size,created_at').single();
    if (error) { await supabase.storage.from(STORAGE_BUCKET).remove([objectKey]); throw error; }
    await writeUsage(req.identity.user.id, 'file_upload'); res.status(201).json({ file: data });
  } catch { sendError(res, 503, 'Could not save this file to your private library.'); }
});

app.get('/api/files/:id/download', requireUser, async (req, res) => {
  const { data: file } = await supabase.from('library_files').select('object_key,name,mime_type').eq('id', req.params.id).eq('user_id', req.identity.user.id).maybeSingle();
  if (!file) return sendError(res, 404, 'File not found.');
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(file.object_key);
  if (error) return sendError(res, 503, 'File download is temporarily unavailable.');
  const bytes = Buffer.from(await data.arrayBuffer());
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.setHeader('Cache-Control', 'private, no-store'); res.send(bytes);
});

app.delete('/api/files/:id', requireUser, async (req, res) => {
  const { data: file } = await supabase.from('library_files').select('object_key').eq('id', req.params.id).eq('user_id', req.identity.user.id).maybeSingle();
  if (!file) return sendError(res, 404, 'File not found.');
  await supabase.storage.from(STORAGE_BUCKET).remove([file.object_key]);
  await supabase.from('library_files').delete().eq('id', req.params.id).eq('user_id', req.identity.user.id);
  res.json({ ok: true });
});

app.post('/api/tasks', requireUser, async (req, res) => {
  const title = cleanName(req.body?.title); const prompt = String(req.body?.prompt || '').trim();
  const cadence = ['once', 'daily', 'weekly', 'monthly'].includes(req.body?.cadence) ? req.body.cadence : 'once';
  const nextRun = new Date(req.body?.nextRunAt);
  if (!prompt || prompt.length > 10_000 || !Number.isFinite(nextRun.getTime()) || nextRun.getTime() < Date.now() + 10_000) return sendError(res, 400, 'Add a task and choose a future run time.');
  const existing = await supabase.from('scheduled_tasks').select('id', { count: 'exact', head: true }).eq('user_id', req.identity.user.id).in('status', ['scheduled', 'running']);
  if (existing.error) return sendError(res, 503, 'Task scheduling is temporarily unavailable.');
  if ((existing.count || 0) >= 20) return sendError(res, 429, 'You can have up to 20 active scheduled tasks.');
  const { data, error } = await supabase.from('scheduled_tasks').insert({ user_id: req.identity.user.id, title, prompt, cadence, next_run_at: nextRun.toISOString() }).select('id,title,prompt,cadence,next_run_at,enabled,status,last_result,last_error,last_run_at,created_at').single();
  if (error) return sendError(res, 503, 'Task scheduling is temporarily unavailable.');
  res.status(201).json({ task: data });
});

app.get('/api/tasks', requireUser, async (req, res) => {
  const { data, error } = await supabase.from('scheduled_tasks').select('id,title,prompt,cadence,next_run_at,enabled,status,last_result,last_error,last_run_at,created_at').eq('user_id', req.identity.user.id).order('created_at', { ascending: false }).limit(200);
  if (error) return sendError(res, 503, 'Tasks are temporarily unavailable.');
  res.json({ tasks: data || [] });
});

app.patch('/api/tasks/:id', requireUser, async (req, res) => {
  const updates = {};
  if (typeof req.body?.enabled === 'boolean') { updates.enabled = req.body.enabled; updates.status = req.body.enabled ? 'scheduled' : 'paused'; }
  if (req.body?.title) updates.title = cleanName(req.body.title);
  if (req.body?.prompt) updates.prompt = String(req.body.prompt).slice(0, 10_000);
  const { data, error } = await supabase.from('scheduled_tasks').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', req.identity.user.id).select('id,title,prompt,cadence,next_run_at,enabled,status,last_result,last_error,last_run_at,created_at').maybeSingle();
  if (error || !data) return sendError(res, 404, 'Task not found.');
  res.json({ task: data });
});

app.delete('/api/tasks/:id', requireUser, async (req, res) => {
  const { data } = await supabase.from('scheduled_tasks').delete().eq('id', req.params.id).eq('user_id', req.identity.user.id).select('id').maybeSingle();
  if (!data) return sendError(res, 404, 'Task not found.');
  res.json({ ok: true });
});

app.get('/api/images', requireUser, async (req, res) => {
  const { data, error } = await supabase.from('image_assets').select('id,prompt,is_favorite,object_key,created_at').eq('user_id', req.identity.user.id).order('created_at', { ascending: false }).limit(100);
  if (error) return sendError(res, 503, 'Image history is unavailable.');
  const images = await Promise.all((data || []).map(async image => {
    const signed = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(image.object_key, 3600);
    return { id: image.id, prompt: image.prompt, favorite: image.is_favorite, created: image.created_at, url: signed.data?.signedUrl || '' };
  }));
  res.json({ images });
});

app.post('/api/image', aiLimiter, requireUser, async (req, res) => {
  if (!process.env.IMAGE_API_KEY) return sendError(res, 503, 'Image generation is unavailable right now.');
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt || prompt.length > 4000) return sendError(res, 400, 'Image prompts must be 1 to 4,000 characters.');
  const allowedSize = new Set(['1024x1024', '1024x1536', '1536x1024']);
  const size = allowedSize.has(req.body.size) ? req.body.size : '1024x1024';
  const model = process.env.IMAGE_MODEL || 'gpt-image-1'; const base = (process.env.IMAGE_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
  try {
    let response;
    if (req.body.imageData) {
      const match = String(req.body.imageData).match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/);
      if (!match) return sendError(res, 400, 'Choose a PNG, JPEG, or WebP image.');
      const raw = Buffer.from(match[2], 'base64'); if (raw.length > 8_000_000) return sendError(res, 413, 'Edit images must be 8 MB or smaller.');
      const form = new FormData(); form.append('model', model); form.append('prompt', prompt); form.append('size', size); form.append('image', new Blob([raw], { type: match[1] }), 'edit.jpeg');
      response = await fetch(`${base}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.IMAGE_API_KEY}` }, body: form, signal: AbortSignal.timeout(120_000) });
    } else {
      const quality = model.toLowerCase().startsWith('dall-e-3') ? (req.body.quality === 'hd' ? 'hd' : 'standard') : (req.body.quality === 'hd' ? 'high' : 'medium');
      response = await fetch(`${base}/images/generations`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.IMAGE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt, n: 1, size, quality }), signal: AbortSignal.timeout(120_000) });
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return sendError(res, response.status, 'Image generation is temporarily unavailable.');
    const image = result.data?.[0]; let bytes;
    if (image?.b64_json) bytes = Buffer.from(image.b64_json, 'base64');
    else if (image?.url) { const download = await fetch(image.url, { signal: AbortSignal.timeout(60_000) }); if (!download.ok) throw new Error('Image download failed.'); bytes = Buffer.from(await download.arrayBuffer()); }
    else return sendError(res, 502, 'Image provider returned no image.');
    if (bytes.length > MAX_FILE_BYTES) return sendError(res, 413, 'Generated image is too large to store.');
    const objectKey = `${req.identity.user.id}/images/${randomUUID()}.png`;
    const stored = await supabase.storage.from(STORAGE_BUCKET).upload(objectKey, bytes, { contentType: 'image/png', upsert: false });
    if (stored.error) throw stored.error;
    const { data: asset, error } = await supabase.from('image_assets').insert({ user_id: req.identity.user.id, prompt, object_key: objectKey }).select('id,prompt,is_favorite,object_key,created_at').single();
    if (error) { await supabase.storage.from(STORAGE_BUCKET).remove([objectKey]); throw error; }
    const signed = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(objectKey, 3600);
    await writeUsage(req.identity.user.id, 'image_generation');
    res.json({ image: { id: asset.id, prompt, favorite: false, created: asset.created_at, url: signed.data?.signedUrl || '' } });
  } catch (error) { console.error('Image generation failed:', error.message); sendError(res, 503, 'Image generation is temporarily unavailable.'); }
});

app.patch('/api/images/:id', requireUser, async (req, res) => {
  const { data, error } = await supabase.from('image_assets').update({ is_favorite: Boolean(req.body?.favorite) }).eq('id', req.params.id).eq('user_id', req.identity.user.id).select('id').maybeSingle();
  if (error || !data) return sendError(res, 404, 'Image not found.');
  res.json({ ok: true });
});

app.delete('/api/images/:id', requireUser, async (req, res) => {
  const { data } = await supabase.from('image_assets').delete().eq('id', req.params.id).eq('user_id', req.identity.user.id).select('object_key').maybeSingle();
  if (!data) return sendError(res, 404, 'Image not found.');
  await supabase.storage.from(STORAGE_BUCKET).remove([data.object_key]); res.json({ ok: true });
});

app.get('/api/calendar', requireUser, async (req, res) => {
  const { data, error } = await supabase.from('calendar_events').select('id,title,description,starts_at,ends_at,created_at').eq('user_id', req.identity.user.id).order('starts_at').limit(200);
  if (error) return sendError(res, 503, 'Calendar is temporarily unavailable.'); res.json({ events: data || [] });
});
app.post('/api/calendar', requireUser, async (req, res) => {
  const title = cleanName(req.body?.title), startsAt = new Date(req.body?.startsAt), endsAt = new Date(req.body?.endsAt || req.body?.startsAt);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) return sendError(res, 400, 'Choose a valid date and time.');
  const { data, error } = await supabase.from('calendar_events').insert({ user_id: req.identity.user.id, title, description: String(req.body?.description || '').slice(0, 2000), starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() }).select('id,title,description,starts_at,ends_at,created_at').single();
  if (error) return sendError(res, 503, 'Could not save this event.'); res.status(201).json({ event: data });
});
app.delete('/api/calendar/:id', requireUser, async (req, res) => {
  const { data } = await supabase.from('calendar_events').delete().eq('id', req.params.id).eq('user_id', req.identity.user.id).select('id').maybeSingle();
  if (!data) return sendError(res, 404, 'Event not found.'); res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  const [users, guests, events, tasks, logs] = await Promise.all([
    supabase.from('app_users').select('id', { count: 'exact', head: true }),
    supabase.from('app_users').select('id', { count: 'exact', head: true }).eq('is_guest', true),
    supabase.from('usage_events').select('id', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 86_400_000).toISOString()),
    supabase.from('scheduled_tasks').select('id,status,title,next_run_at').order('created_at', { ascending: false }).limit(50),
    supabase.from('usage_events').select('id,event_type,model,created_at').order('created_at', { ascending: false }).limit(100)
  ]);
  res.json({ users: users.count || 0, guests: guests.count || 0, events24h: events.count || 0, tasks: tasks.data || [], logs: logs.data || [] });
});

app.get('/api/announcements', async (_req, res) => {
  if (!supabase) return res.json({ announcements: [] });
  const { data } = await supabase.from('announcements').select('id,title,message,created_at').eq('active', true).order('created_at', { ascending: false }).limit(5);
  res.json({ announcements: data || [] });
});
app.post('/api/admin/announcements', requireAdmin, async (req, res) => {
  const title = cleanName(req.body?.title), message = String(req.body?.message || '').trim().slice(0, 3000);
  if (!message) return sendError(res, 400, 'Add an announcement message.');
  const { data, error } = await supabase.from('announcements').insert({ title, message, active: true }).select('id,title,message,active,created_at').single();
  if (error) return sendError(res, 503, 'Could not post the announcement.'); res.status(201).json({ announcement: data });
});

app.get('/api/tasks/notifications', requireUser, async (req, res) => {
  const after = req.query.after ? new Date(req.query.after).toISOString() : new Date(Date.now() - 60_000).toISOString();
  const { data } = await supabase.from('scheduled_tasks').select('id,title,status,last_result,last_error,last_run_at').eq('user_id', req.identity.user.id).gte('last_run_at', after).order('last_run_at', { ascending: false }).limit(20);
  res.json({ notifications: data || [] });
});

app.get('/api/status/full', requireUser, async (_req, res) => {
  const { data } = await supabase.from('announcements').select('id,title,message,created_at').eq('active', true).order('created_at', { ascending: false }).limit(5);
  res.json({ model: MODEL, plugins: { webSearch: true, images: Boolean(process.env.IMAGE_API_KEY), calendar: true }, announcements: data || [] });
});

app.get('/api', (_req, res) => sendError(res, 404, 'Not found.'));
app.get('/api/*path', (_req, res) => sendError(res, 404, 'Not found.'));

for (const [route, file] of [['/', 'index.html'], ['/index.html', 'index.html'], ['/app.js', 'app.js'], ['/styles.css', 'styles.css']]) {
  app.get(route, (_req, res) => res.sendFile(resolve(ROOT, file)));
}
app.get(/.*/, (_req, res) => res.sendFile(resolve(ROOT, 'index.html')));

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const server = app.listen(port, host, () => console.log(`GROQGPT web server listening on ${host}:${port} · ${supabase ? 'database configured' : 'database missing'} · ${process.env.GROQ_API_KEY ? 'AI provider configured' : 'AI provider missing'}`));
server.requestTimeout = 120_000;
let lastGuestCleanup = 0;
setInterval(() => {
  runSchedulerBatch().catch(error => console.error('Scheduler batch failed:', error.message));
  if (Date.now() - lastGuestCleanup > 24 * 60 * 60 * 1000) {
    lastGuestCleanup = Date.now();
    cleanupGuests().catch(error => console.error('Guest cleanup failed:', error.message));
  }
}, 30_000).unref();
