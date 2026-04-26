'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const { HttpsProxyAgent } = require('https-proxy-agent');
const AdmZip = require('adm-zip');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing config.json. Copy config.example.json -> config.json and fill in SMTP + email.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const SEEN_FILE = path.join(__dirname, 'seen_jobs.json');
const ALERTS_LOG = path.join(__dirname, 'alerts.log');
const PAYLOADS_DIR = path.join(__dirname, 'payloads');
const PAYLOADS_KEEP = 30;
const LISTING_URL = 'https://www.peopleperhour.com/freelance-jobs';
const POLL_INTERVAL_MS = (config.pollIntervalMinutes || 15) * 60 * 1000;
const MIN_BUDGET = config.minBudgetUsd || 200;
const RUN_ONCE = process.argv.includes('--once');
const RUN_SERVER = process.argv.includes('--server');
const HTTP_PORT = parseInt(process.env.PORT || config.httpPort || 3000, 10);
const TRIGGER_TOKEN = process.env.TRIGGER_TOKEN || config.triggerToken || '';

const KEYWORDS = (config.keywords || []).map(k => k.toLowerCase());
const ALLOWED_COUNTRIES = new Set((config.allowedCountries || []).map(c => c.toLowerCase().trim()));
const ALLOWED_COUNTRY_CODES = new Set((config.allowedCountryCodes || [
  'US','CA','GB','IE',
  'DE','FR','IT','ES','PT','NL','BE','LU','AT','CH','LI','MC','AD',
  'SE','NO','DK','FI','IS',
  'PL','CZ','SK','HU','SI','HR','EE','LV','LT','RO','BG','GR','MT','CY',
  'AU','NZ',
]).map(c => c.toUpperCase().trim()));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="132", "Not_A Brand";v="24", "Google Chrome";v="132"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const LOG_BUFFER_MAX = 1000;
const _logBuffer = [];
const log = (...args) => {
  const ts = new Date().toISOString();
  const line = `[${ts}] ` + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(line);
  _logBuffer.push(line);
  if (_logBuffer.length > LOG_BUFFER_MAX) _logBuffer.splice(0, _logBuffer.length - LOG_BUFFER_MAX);
};

const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const loadSeen = () => {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set(); }
};
const saveSeen = (set) => {
  const trimmed = [...set].slice(-3000);
  const tmp = SEEN_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
  fs.renameSync(tmp, SEEN_FILE);
};

const appendAlerts = (matches) => {
  if (!matches.length) return;
  const ts = new Date().toISOString();
  const lines = matches.map(m => JSON.stringify({
    ts, id: m.id, title: m.title, budget: m.budget,
    country: m.country || m.countryCode || '', url: m.url,
  })).join('\n') + '\n';
  fs.appendFileSync(ALERTS_LOG, lines);
};

const _cookieJar = new Map();
function captureCookies(setCookie) {
  if (!setCookie) return;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const sc of arr) {
    const pair = sc.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    _cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader() {
  if (!_cookieJar.size) return '';
  return [..._cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy || config.proxyUrl || '';
const httpsAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
if (PROXY_URL) console.log(`[boot] using HTTPS proxy: ${PROXY_URL.replace(/:[^:@/]+@/, ':***@')}`);

async function get(url, opts = {}) {
  const headers = { ...HEADERS, ...(opts.headers || {}) };
  const c = cookieHeader();
  if (c) headers.Cookie = c;
  const res = await axios.get(url, {
    headers, timeout: 45000, maxRedirects: 5, validateStatus: () => true,
    httpsAgent, proxy: false,
  });
  captureCookies(res.headers['set-cookie']);
  if (res.status >= 400) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    err.status = res.status;
    err.body = typeof res.data === 'string' ? res.data.slice(0, 400) : '';
    throw err;
  }
  return res.data;
}

let _warmupAt = 0;
async function warmup() {
  // Refresh session at most every 30 minutes
  if (Date.now() - _warmupAt < 30 * 60 * 1000 && _cookieJar.size) return;
  try {
    await get('https://www.peopleperhour.com/', {
      headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1' },
    });
    _warmupAt = Date.now();
    log(`warmup ok — ${_cookieJar.size} cookie(s)`);
  } catch (e) {
    log('warmup failed:', e.message, e.status || '');
  }
}

function parseBudget(b) {
  if (b == null) return null;
  if (typeof b === 'number') return b;
  if (typeof b === 'object') {
    const n = parseFloat(b.amount ?? b.value ?? b.usd ?? b.min ?? b.max ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const m = String(b).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function buildUrl(p) {
  if (p.url) return p.url.startsWith('http') ? p.url : `https://www.peopleperhour.com${p.url}`;
  if (p.slug) return `https://www.peopleperhour.com/freelance-jobs/${p.slug}`;
  if (p.id) return `https://www.peopleperhour.com/freelance-jobs/${p.id}`;
  return LISTING_URL;
}

function collectSkills(p) {
  const arr = p.skills || p.tags || p.categories || [];
  if (!Array.isArray(arr)) return [];
  return arr.map(s => {
    if (typeof s === 'string') return s.toLowerCase();
    return String(s.name || s.title || s.label || '').toLowerCase();
  }).filter(Boolean);
}

function extractInitialState(html) {
  const m = html.match(/window\.PPHReact\.initialState\s*=\s*({[\s\S]*?});\s*window\.PPHReact/);
  if (!m) return null;
  try { return JSON.parse(m[1]); }
  catch (e) { log('PPHReact JSON parse failed:', e.message); return null; }
}

function extractProjectsFromInitialState(state) {
  const projectsObj = state && state.entities && state.entities.projects;
  if (!projectsObj || typeof projectsObj !== 'object') return [];
  const out = [];
  for (const key of Object.keys(projectsObj)) {
    const node = projectsObj[key];
    const a = node && node.attributes;
    if (!a) continue;
    if (a.item_type && a.item_type !== 'job') continue;

    const id = String(a.proj_id || node.id || key);
    const title = String(a.title || '').trim();
    const description = String(a.proj_desc || '').trim();
    const projectType = a.project_type || '';
    const budget = parseBudget(a.budget_converted ?? a.budget);
    const c = a.client || {};
    const country = String(c.country || '').toLowerCase().trim();
    const countryCode = String(c.country_code || '').toUpperCase().trim();
    const url = a.url || `https://www.peopleperhour.com/freelance-jobs/${id}`;
    const skills = [];
    if (a.category && a.category.cate_name) skills.push(String(a.category.cate_name).toLowerCase());
    if (a.sub_category && a.sub_category.subcate_name) skills.push(String(a.sub_category.subcate_name).toLowerCase());

    out.push({ id, title, description, skills, budget, country, countryCode, url, projectType });
  }
  return out;
}

function extractProjectsFromNextData(json) {
  const candidates = [];
  const visit = new WeakSet();
  (function walk(node) {
    if (!node || typeof node !== 'object' || visit.has(node)) return;
    visit.add(node);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const looksLikeProject =
      (node.id || node.projectId) &&
      (node.title || node.heading) &&
      (node.budget || node.price || node.fixedPriceBudget || node.hourlyRate);
    if (looksLikeProject) candidates.push(node);
    Object.values(node).forEach(walk);
  })(json);

  return candidates.map(p => {
    const id = String(p.id || p.projectId);
    const title = String(p.title || p.heading || '').trim();
    const description = String(p.description || p.summary || p.body || '').trim();
    const skills = collectSkills(p);
    const budget = parseBudget(p.budget || p.price || p.fixedPriceBudget || p.hourlyRate);
    const country = String(
      (p.user && (p.user.country || p.user.location || (p.user.address && p.user.address.country))) ||
      (p.client && (p.client.country || p.client.location)) ||
      (p.buyer && (p.buyer.country || p.buyer.location)) ||
      p.country || p.location || ''
    ).toLowerCase().trim();
    const url = buildUrl(p);
    return { id, title, description, skills, budget, country, url };
  }).filter(p => p.title && p.id);
}

function extractProjectsFromHtml($) {
  const out = [];
  const seenUrls = new Set();
  $('a[href*="/freelance-jobs/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const clean = href.split('?')[0].split('#')[0];
    if (clean === '/freelance-jobs' || clean === '/freelance-jobs/') return;
    const url = clean.startsWith('http') ? clean : `https://www.peopleperhour.com${clean}`;
    if (seenUrls.has(url)) return;
    seenUrls.add(url);
    const $card = $(el).closest('article, li, div');
    const title =
      ($(el).text().trim()) ||
      $card.find('h1, h2, h3').first().text().trim();
    if (!title || title.length < 5) return;
    const cardText = $card.text();
    const budgetMatch = cardText.match(/[$£€]\s?[\d,]+(?:\.\d+)?/);
    const budget = budgetMatch ? parseBudget(budgetMatch[0]) : null;
    out.push({
      id: url,
      title,
      description: cardText.replace(/\s+/g, ' ').trim().slice(0, 400),
      skills: [],
      budget,
      country: '',
      url,
    });
  });
  return out;
}

function projectsFromHtml(html) {
  const state = extractInitialState(html);
  if (state) {
    const fromState = extractProjectsFromInitialState(state);
    if (fromState.length) return fromState;
  }
  const $ = cheerio.load(html);
  const nextData = $('#__NEXT_DATA__').html();
  if (nextData) {
    try {
      const json = JSON.parse(nextData);
      const fromNext = extractProjectsFromNextData(json);
      if (fromNext.length) return fromNext;
    } catch (e) {
      log('Failed to parse __NEXT_DATA__:', e.message);
    }
  }
  return extractProjectsFromHtml($);
}

async function fetchListing() {
  await warmup();
  const html = await get(LISTING_URL, {
    headers: {
      'Referer': 'https://www.peopleperhour.com/',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  return projectsFromHtml(html);
}

async function enrichDetail(p) {
  if (p.country && p.budget) return p;
  try {
    const html = await get(p.url, {
      headers: { 'Referer': LISTING_URL, 'Sec-Fetch-Site': 'same-origin' },
    });
    const $ = cheerio.load(html);
    const nd = $('#__NEXT_DATA__').html();
    if (nd) {
      try {
        const json = JSON.parse(nd);
        let foundCountry = '';
        let foundBudget = null;
        const visit = new WeakSet();
        (function walk(n) {
          if (!n || typeof n !== 'object' || visit.has(n)) return;
          visit.add(n);
          if (Array.isArray(n)) { n.forEach(walk); return; }
          if (!foundCountry) {
            const c = n.country || n.location || (n.address && n.address.country);
            if (typeof c === 'string' && c.length > 1 && c.length < 50) foundCountry = c.toLowerCase().trim();
          }
          if (foundBudget == null) {
            const b = parseBudget(n.budget || n.fixedPriceBudget || n.price);
            if (b) foundBudget = b;
          }
          Object.values(n).forEach(walk);
        })(json);
        if (foundCountry) p.country = foundCountry;
        if (foundBudget && !p.budget) p.budget = foundBudget;
      } catch {}
    }
    if (!p.country) {
      const m = html.match(/"country"\s*:\s*"([^"]{2,40})"/);
      if (m) p.country = m[1].toLowerCase().trim();
    }
    if (!p.budget) {
      const m = html.match(/[$£€]\s?[\d,]+(?:\.\d+)?/);
      if (m) p.budget = parseBudget(m[0]);
    }
  } catch (e) {
    log(`enrichDetail failed for ${p.url}:`, e.message);
  }
  return p;
}

const matchesKeywords = (p) => {
  const hay = (p.title + ' ' + p.description + ' ' + p.skills.join(' ')).toLowerCase();
  return KEYWORDS.some(k => hay.includes(k));
};
const matchesBudget = (p) => p.budget != null && p.budget >= MIN_BUDGET;
const matchesCountry = (p) =>
  (p.countryCode && ALLOWED_COUNTRY_CODES.has(p.countryCode)) ||
  (!!p.country && ALLOWED_COUNTRIES.has(p.country));

let _transporter = null;
function transporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port || 587,
    secure: !!config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return _transporter;
}

async function sendEmail(jobs) {
  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:680px">
      <h2 style="margin:0 0 12px">${jobs.length} new PeoplePerHour project${jobs.length === 1 ? '' : 's'}</h2>
      ${jobs.map(j => `
        <div style="border:1px solid #e0e0e0;padding:14px;margin:10px 0;border-radius:8px">
          <h3 style="margin:0 0 6px"><a href="${j.url}" style="color:#0a58ca;text-decoration:none">${escapeHtml(j.title)}</a></h3>
          <p style="margin:4px 0;color:#444">
            <b>Budget:</b> $${j.budget}${j.projectType ? ` (${escapeHtml(j.projectType.replace('_', ' '))})` : ''}
            &nbsp;·&nbsp;
            <b>Country:</b> ${escapeHtml(j.country || j.countryCode || 'unknown')}
          </p>
          ${j.skills.length ? `<p style="margin:4px 0;color:#666;font-size:13px"><b>Skills:</b> ${escapeHtml(j.skills.slice(0, 12).join(', '))}</p>` : ''}
          ${j.description ? `<p style="margin:6px 0;color:#555;font-size:14px">${escapeHtml(j.description.slice(0, 400))}${j.description.length > 400 ? '…' : ''}</p>` : ''}
          <p style="margin:8px 0 0"><a href="${j.url}">Open project →</a></p>
        </div>
      `).join('')}
    </div>
  `;
  await transporter().sendMail({
    from: config.email.from,
    to: config.email.to,
    subject: `[PPH] ${jobs.length} new project${jobs.length === 1 ? '' : 's'} to bid on`,
    html,
  });
}

async function processProjects(projects, { allowEnrich = false, source = 'unknown' } = {}) {
  const startedAt = new Date().toISOString();
  const result = { startedAt, source, fetched: projects.length, candidates: 0, matches: 0, emailSent: false, matched: [], errors: [] };
  try {
    const seen = loadSeen();
    const fresh = projects.filter(p => !seen.has(p.id));
    const candidates = fresh.filter(p => matchesKeywords(p) && (p.budget == null || matchesBudget(p)));
    result.candidates = candidates.length;
    log(`${source}: ${projects.length} fetched, ${candidates.length} candidate(s) after keyword filter`);

    if (allowEnrich) {
      for (const c of candidates) {
        if (!c.country || !c.budget) await enrichDetail(c);
      }
    }

    const matches = candidates.filter(p => matchesBudget(p) && matchesCountry(p));
    result.matches = matches.length;
    result.matched = matches.map(m => ({
      id: m.id, title: m.title, budget: m.budget,
      country: m.country || m.countryCode, url: m.url,
    }));
    log(`${source}: ${matches.length} match(es) after budget + country filter`);

    if (matches.length) {
      try {
        await sendEmail(matches);
        result.emailSent = true;
        appendAlerts(matches);
        log(`Email sent for ${matches.length} project(s)`);
      } catch (e) {
        result.errors.push('sendEmail: ' + e.message);
        log('sendEmail failed:', e.message);
      }
    }
    fresh.forEach(p => seen.add(p.id));
    saveSeen(seen);
  } catch (err) {
    result.errors.push('process: ' + err.message);
    log('process error:', err.message);
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

async function tick() {
  log('Polling PeoplePerHour…');
  try {
    const projects = await fetchListing();
    return await processProjects(projects, { allowEnrich: true, source: 'tick' });
  } catch (err) {
    log('tick fetch error:', err.message);
    return {
      startedAt: new Date().toISOString(),
      source: 'tick',
      fetched: 0, candidates: 0, matches: 0, emailSent: false, matched: [],
      errors: ['tick: ' + err.message],
      finishedAt: new Date().toISOString(),
    };
  }
}

let _running = false;
let _lastResult = null;
async function runTickGuarded() {
  if (_running) return { ok: false, error: 'tick_in_progress', lastResult: _lastResult };
  _running = true;
  try {
    const r = await tick();
    _lastResult = r;
    return { ok: true, ...r };
  } finally {
    _running = false;
  }
}

function parseJsonOrJsonl(body) {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try { const v = JSON.parse(trimmed); return Array.isArray(v) ? v : [v]; } catch {}
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); }
    catch { return null; }
  }
  return out.length ? out : null;
}

function projectsFromAnyShape(item) {
  if (Array.isArray(item)) return item;
  if (!item || typeof item !== 'object') return null;
  if (Array.isArray(item.projects)) return item.projects;
  for (const key of ['html', 'result', 'body', 'content']) {
    if (typeof item[key] === 'string') return projectsFromHtml(item[key]);
  }
  return null;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload_too_large'), { httpStatus: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function detectKind(buf) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
      (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
  const s = buf.toString('utf8', 0, Math.min(buf.length, 200)).trim().toLowerCase();
  if (s.startsWith('{') || s.startsWith('[')) return s.includes('\n{') ? 'jsonl' : 'json';
  if (s.startsWith('<!doctype') || s.startsWith('<html') || s.startsWith('<')) return 'html';
  return 'bin';
}

function savePayload(buf, kind) {
  try { fs.mkdirSync(PAYLOADS_DIR, { recursive: true }); } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${ts}.${kind}`;
  fs.writeFileSync(path.join(PAYLOADS_DIR, name), buf);
  try {
    const files = fs.readdirSync(PAYLOADS_DIR).sort();
    while (files.length > PAYLOADS_KEEP) {
      const f = files.shift();
      try { fs.unlinkSync(path.join(PAYLOADS_DIR, f)); } catch {}
    }
  } catch {}
  return name;
}

function logHtmlPreview(label, html) {
  if (!html) return;
  const head = html.slice(0, 800).replace(/\s+/g, ' ').trim();
  log(`${label}: ${html.length} chars, head: ${head}${html.length > 800 ? '…' : ''}`);
}

function looksLikeZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

function projectsFromZip(buf) {
  const zip = new AdmZip(buf);
  const all = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    const lower = name.toLowerCase();
    let text;
    try { text = entry.getData().toString('utf8'); }
    catch (e) { log(`zip: skipping ${name} — ${e.message}`); continue; }

    if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) {
      const items = parseJsonOrJsonl(text);
      if (!items) { log(`zip: ${name} not valid JSON/JSONL`); continue; }
      log(`zip: parsed ${name} (${items.length} record(s))`);
      for (const [i, item] of items.entries()) {
        const html = item && (item.html || item.result || item.body || item.content);
        if (typeof html === 'string') logHtmlPreview(`zip:${name}[${i}].html`, html);
        const fromItem = projectsFromAnyShape(item);
        if (fromItem) all.push(...fromItem);
      }
    } else if (lower.endsWith('.json')) {
      try {
        const json = JSON.parse(text);
        const items = Array.isArray(json) ? json : [json];
        log(`zip: parsed ${name}`);
        for (const [i, item] of items.entries()) {
          const html = item && (item.html || item.result || item.body || item.content);
          if (typeof html === 'string') logHtmlPreview(`zip:${name}[${i}].html`, html);
          const fromItem = projectsFromAnyShape(item);
          if (fromItem) all.push(...fromItem);
        }
      } catch (e) { log(`zip: ${name} JSON parse failed — ${e.message}`); }
    } else if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      logHtmlPreview(`zip:${name}`, text);
      all.push(...projectsFromHtml(text));
    } else {
      log(`zip: skipping ${name} (unrecognized extension)`);
    }
  }
  return all;
}

function checkToken(req, url) {
  if (!TRIGGER_TOKEN) return true;
  const auth = req.headers.authorization || '';
  const provided =
    url.searchParams.get('token') ||
    req.headers['x-trigger-token'] ||
    auth.replace(/^Bearer\s+/i, '');
  return provided === TRIGGER_TOKEN;
}

async function runWebhookGuarded(projects, source) {
  if (_running) return { ok: false, error: 'tick_in_progress', lastResult: _lastResult };
  _running = true;
  try {
    const r = await processProjects(projects, { allowEnrich: false, source });
    _lastResult = r;
    return { ok: true, ...r };
  } finally {
    _running = false;
  }
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body, null, 2));
    };
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return send(400, { ok: false, error: 'bad_request' }); }

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, { ok: true, running: _running, lastResult: _lastResult });
    }

    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/tick') {
      if (!checkToken(req, url)) return send(401, { ok: false, error: 'unauthorized' });
      const out = await runTickGuarded();
      return send(out.ok ? 200 : 409, out);
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
      if (!checkToken(req, url)) return send(401, { ok: false, error: 'unauthorized' });
      let buf;
      try { buf = await readBody(req); }
      catch (e) { return send(e.httpStatus || 400, { ok: false, error: e.message }); }

      const ct = String(req.headers['content-type'] || '').toLowerCase();
      const kind = detectKind(buf);
      let savedAs = null;
      try { savedAs = savePayload(buf, kind); } catch (e) { log('savePayload failed:', e.message); }
      log(`webhook: received ${buf.length} bytes (kind=${kind}, content-type=${ct || 'n/a'})${savedAs ? `, saved to payloads/${savedAs}` : ''}`);

      let projects;
      try {
        if (kind === 'zip') {
          projects = projectsFromZip(buf);
        } else {
          const body = buf.toString('utf8');
          const looksJson = ct.includes('json') || kind === 'json' || kind === 'jsonl';
          if (looksJson) {
            const items = parseJsonOrJsonl(body);
            if (!items) return send(400, { ok: false, error: 'invalid_json_or_jsonl' });
            const all = [];
            for (const [i, item] of items.entries()) {
              const html = item && (item.html || item.result || item.body || item.content);
              if (typeof html === 'string') logHtmlPreview(`webhook:item[${i}].html`, html);
              const fromItem = projectsFromAnyShape(item);
              if (fromItem === null) return send(400, { ok: false, error: 'object missing html / result / projects' });
              all.push(...fromItem);
            }
            projects = all;
          } else {
            logHtmlPreview('webhook:body', body);
            projects = projectsFromHtml(body);
          }
        }
        const idSeen = new Set();
        projects = (projects || []).filter(p => p && p.id != null && !idSeen.has(String(p.id)) && idSeen.add(String(p.id)));
      } catch (e) {
        return send(400, { ok: false, error: 'parse_failed: ' + e.message });
      }

      if (!Array.isArray(projects)) return send(400, { ok: false, error: 'no_projects_extracted' });
      const out = await runWebhookGuarded(projects, 'webhook');
      return send(out.ok ? 200 : 409, out);
    }

    if (req.method === 'GET' && url.pathname === '/logs') {
      if (!checkToken(req, url)) return send(401, { ok: false, error: 'unauthorized' });
      const n = Math.max(1, Math.min(_logBuffer.length, parseInt(url.searchParams.get('n') || '200', 10)));
      const tail = _logBuffer.slice(-n).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(tail + '\n');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/payloads') {
      if (!checkToken(req, url)) return send(401, { ok: false, error: 'unauthorized' });
      try {
        const files = fs.readdirSync(PAYLOADS_DIR)
          .map(f => {
            const st = fs.statSync(path.join(PAYLOADS_DIR, f));
            return { name: f, size: st.size, mtime: st.mtime.toISOString() };
          })
          .sort((a, b) => b.mtime.localeCompare(a.mtime));
        return send(200, { ok: true, count: files.length, files });
      } catch {
        return send(200, { ok: true, count: 0, files: [] });
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/payloads/')) {
      if (!checkToken(req, url)) return send(401, { ok: false, error: 'unauthorized' });
      const name = decodeURIComponent(url.pathname.slice('/payloads/'.length));
      if (!name || /[\/\\]/.test(name) || name.includes('..')) return send(400, { ok: false, error: 'bad_filename' });
      const fullPath = path.join(PAYLOADS_DIR, name);
      if (!fullPath.startsWith(PAYLOADS_DIR + path.sep)) return send(400, { ok: false, error: 'bad_filename' });
      if (!fs.existsSync(fullPath)) return send(404, { ok: false, error: 'not_found' });
      const ext = path.extname(name).toLowerCase();
      const ctMap = { '.zip': 'application/zip', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8' };
      res.writeHead(200, {
        'Content-Type': ctMap[ext] || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${name}"`,
      });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }

    return send(404, { ok: false, error: 'not_found' });
  });
  server.listen(HTTP_PORT, () => {
    log(`HTTP server listening on :${HTTP_PORT}`);
    log(`  GET  /health`);
    log(`  GET  /logs${TRIGGER_TOKEN ? '?token=…' : ''}[&n=200]`);
    log(`  GET  /tick${TRIGGER_TOKEN ? '?token=…' : ''}`);
    log(`  GET  /payloads${TRIGGER_TOKEN ? '?token=…' : ''}  (list)  &  /payloads/{name}  (download)`);
    log(`  POST /webhook${TRIGGER_TOKEN ? '?token=…' : ''}  (body: ZIP, JSONL, JSON {html|result|projects}, or raw HTML)`);
    if (!TRIGGER_TOKEN) log('WARNING: triggerToken is empty — endpoints are unauthenticated');
  });
}

(async () => {
  if (RUN_ONCE) {
    await tick();
    log('--once flag set, exiting');
    return;
  }
  if (RUN_SERVER) {
    startServer();
    return;
  }
  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
  log(`Scheduler running every ${POLL_INTERVAL_MS / 60000} min`);
})();
