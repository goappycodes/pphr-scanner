'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');

const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('Missing config.json. Copy config.example.json -> config.json and fill in SMTP + email.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const SEEN_FILE = path.join(__dirname, 'seen_jobs.json');
const LISTING_URL = 'https://www.peopleperhour.com/freelance-jobs';
const POLL_INTERVAL_MS = (config.pollIntervalMinutes || 15) * 60 * 1000;
const MIN_BUDGET = config.minBudgetUsd || 200;
const RUN_ONCE = process.argv.includes('--once');

const KEYWORDS = (config.keywords || []).map(k => k.toLowerCase());
const ALLOWED_COUNTRIES = new Set((config.allowedCountries || []).map(c => c.toLowerCase().trim()));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const loadSeen = () => {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set(); }
};
const saveSeen = (set) => {
  const trimmed = [...set].slice(-3000);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed, null, 2));
};

async function get(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 30000, maxRedirects: 5 });
  return res.data;
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

async function fetchListing() {
  const html = await get(LISTING_URL);
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

async function enrichDetail(p) {
  if (p.country && p.budget) return p;
  try {
    const html = await get(p.url);
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
const matchesCountry = (p) => !!p.country && ALLOWED_COUNTRIES.has(p.country);

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
            <b>Budget:</b> $${j.budget}
            &nbsp;·&nbsp;
            <b>Country:</b> ${escapeHtml(j.country || 'unknown')}
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

async function tick() {
  log('Polling PeoplePerHour…');
  try {
    const projects = await fetchListing();
    log(`Fetched ${projects.length} project(s) from listing`);

    const seen = loadSeen();
    const fresh = projects.filter(p => !seen.has(p.id));
    const candidates = fresh.filter(p => matchesKeywords(p) && (p.budget == null || matchesBudget(p)));
    log(`${candidates.length} candidate(s) after keyword filter`);

    for (const c of candidates) {
      if (!c.country || !c.budget) await enrichDetail(c);
    }

    const matches = candidates.filter(p => matchesBudget(p) && matchesCountry(p));
    log(`${matches.length} match(es) after budget + country filter`);

    if (matches.length) {
      try {
        await sendEmail(matches);
        log(`Email sent for ${matches.length} project(s)`);
      } catch (e) {
        log('sendEmail failed:', e.message);
      }
    }
    fresh.forEach(p => seen.add(p.id));
    saveSeen(seen);
  } catch (err) {
    log('tick error:', err.message);
  }
}

(async () => {
  await tick();
  if (RUN_ONCE) {
    log('--once flag set, exiting');
    return;
  }
  setInterval(tick, POLL_INTERVAL_MS);
  log(`Scheduler running every ${POLL_INTERVAL_MS / 60000} min`);
})();
