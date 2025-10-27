

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import pLimit from 'p-limit';
import { format as csvFormat } from 'fast-csv';
import { bold, red, yellow, green, cyan, dim } from 'colorette';

// Config (read from env with sensible defaults)
const FIDS_PATH = process.env.FIDS_FILE ;
const OUTPUT_DIR = process.env.OUT_DIR || 'out';
const MAX_CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const API_BASE = process.env.BASE;
const WALLET_ADDR = process.env.WALLET_ADDRESS || process.env.ADDR || '';
const ONLY_RARE = String(process.env.RARE_ONLY || '0') === '1';
const TOP_K_LIMIT = parseInt(process.env.TOP_K || '10', 10);
const MIN_RARITY_SCORE = parseFloat(process.env.MIN_SCORE || '0');

// Logger helpers
function ts(){ return dim(new Date().toISOString()); }
function info(msg){ console.log(`${ts()} ${cyan(msg)}`); }
function good(msg){ console.log(`${ts()} ${green(msg)}`); }
function warn(msg){ console.warn(`${ts()} ${yellow(msg)}`); }
function error(msg){ console.error(`${ts()} ${red(msg)}`); }

function section(title){ console.log('\n' + bold(cyan(`=== ${title} ===`))); }

if (!fs.existsSync(FIDS_PATH)) {
  error(`Missing ${FIDS_PATH}. Harus berisi satu FID per baris.`);
  console.log('Contoh:');
  console.log('  1234abcdef');
  console.log('  9876fedcba');
  console.log('\nAtau set ENV FIDS_FILE ke path yang benar.');
  process.exit(1);
}
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const fids = fs.readFileSync(FIDS_PATH, 'utf8')
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean);

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function jitter(ms){ return Math.round(ms * (0.8 + Math.random()*0.4)); }

function explainAxiosError(e){
  // Return a friendly error string with suggestions
  if (!e) return 'Unknown error';
  if (e.code === 'ECONNABORTED') return 'Timeout — server did not respond in time. Try increasing timeout or check network.';
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return `DNS/network error while reaching ${API_BASE}. Check BASE and network.`;
  const status = e.response?.status;
  if (status) {
    const msg = e.response?.data?.message || e.response?.data || e.message;
    return `HTTP ${status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)} (check URL, API key or rate limits)`;
  }
  return e.message || String(e);
}

async function httpPost(url, body={}, {timeout=15000}={}) {
  return axios.post(url, body, { timeout });
}

function maybeSavePng(data, fid){
  const b64 = data?.generatedImage || data?.imageBase64 || null;
  if (!b64) return null;
  try {
    const bin = Buffer.from(b64, 'base64');
    const out = path.join(OUTPUT_DIR, `warplet-${fid}.png`);
    fs.writeFileSync(out, bin);
    return out;
  } catch { return null; }
}

/** Normalize traits to [{trait_type, value, percent?, rarity?}] */
function normalizeTraits(data){
  // Common shapes:
  // - data.attributes: [{trait_type, value, percent or rarity or frequency}]
  // - data.traits:     same idea
  const raw = Array.isArray(data?.attributes) ? data.attributes :
              Array.isArray(data?.traits) ? data.traits : [];
  return raw.map(t => {
    const percent = t.percent ?? t.percentage ?? t.frequency ?? t.rarityPercent ?? null;
    const rarity = t.rarity ?? t.score ?? null;
    return {
      trait_type: t.trait_type ?? t.traitType ?? t.type ?? 'trait',
      value: t.value ?? t.name ?? t.val ?? '',
      percent: typeof percent === 'string' && percent.endsWith('%')
        ? parseFloat(percent) : (typeof percent === 'number' ? percent : null),
      rarity
    };
  });
}

/** Rarity scoring:
 * 1) use data.rarityScore if present
 * 2) else: sum(-log(p)) where p = percent/100; if no percent, +0.5 as tiny weight
 */
function rarityScore(data){
  if (typeof data?.rarityScore === 'number') return data.rarityScore;
  const traits = normalizeTraits(data);
  let score = 0;
  for (const t of traits){
    if (typeof t.percent === 'number' && t.percent > 0){
      const p = t.percent / 100;
      score += -Math.log(p); // natural log, lebih besar = lebih langka
    } else if (typeof t.rarity === 'number') {
      score += t.rarity;
    } else {
      score += 0.5; // sedikit bobot kalau tak ada info
    }
  }
  return Number(score.toFixed(6));
}

function traitsSummary(data){
  const traits = normalizeTraits(data);
  return traits.map(t => {
    const pct = (t.percent != null) ? `${t.percent}%` : '';
    return `${t.trait_type}:${t.value}${pct ? `(${pct})` : ''}`;
  }).join(' | ');
}

/** GENERATE loop: keep retrying w/ capped backoff */
async function generateMeta(fid){
  // Unlimited retry loop (with backoff). This will keep trying until success.
  let backoff = 100; // ms
  const maxBack = 5000;
  let attempt = 0;
  for (;;){
    attempt++;
    try{
  info(`${fid}: generate attempt ${attempt} (unlimited retries)`);
  const { data, status } = await httpPost(`${API_BASE}/api/warplet/${fid}`, {}, { timeout: 15000 });
      if (status === 200 && data){
  const jsonPath = path.join(OUTPUT_DIR, `warplet-${fid}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
        const pngPath = maybeSavePng(data, fid);
        good(`${fid}: generated (saved ${path.basename(jsonPath)}${pngPath ? `, ${path.basename(pngPath)}` : ''})`);
        return { ok:true, data, jsonPath, pngPath };
      }
      warn(`${fid} -> HTTP ${status}`);
    }catch(e){
      const explain = explainAxiosError(e);
      warn(`${fid} -> ${explain}`);
      // continue and retry indefinitely
    }
    // backoff and retry
    await sleep(jitter(Math.min(maxBack, backoff)));
    backoff = Math.min(maxBack, Math.floor(backoff * 1.8));
  }
}

/** SIGN: request signature for mint */
async function requestSignature(fid, wallet){
  // Unlimited retry loop for signature requests. Will keep trying until success.
  let backoff = 500;
  let attempt = 0;
  for (;;){
    attempt++;
    try{
  info(`${fid}: signature request attempt ${attempt} (unlimited retries)`);
  const url = `${API_BASE}/api/warplet/generateSignature/${fid}`;
  const { data, status } = await httpPost(url, { walletAddress: wallet }, { timeout: 15000 });
      if (status === 200 && data){
  const out = path.join(OUTPUT_DIR, `sign-${fid}.json`);
        fs.writeFileSync(out, JSON.stringify(data, null, 2));
        good(`${fid}: signature received -> ${path.basename(out)}`);
        return { ok:true, data, path: out };
      }
      warn(`sign ${fid} -> HTTP ${status}`);
    }catch(e){
      const explain = explainAxiosError(e);
      warn(`sign ${fid} -> ${explain}`);
      // continue and retry indefinitely
    }
    await sleep(jitter(backoff));
    backoff = Math.min(10000, Math.floor(backoff * 1.8));
  }
}

/** MAIN */
const limit = pLimit(MAX_CONCURRENCY);

// 1) Generate all first (biar kita bisa ranking)
section(`Generate ${fids.length} FIDs (concurrency=${MAX_CONCURRENCY})`);
const metas = await Promise.all(fids.map(fid => limit(async () => {
  const res = await generateMeta(fid);
  const score = res.ok ? rarityScore(res.data) : -1; // errors go to bottom
  const summary = res.ok ? traitsSummary(res.data) : `ERROR: ${res.error}`;
  return {
    fid,
    score,
    summary,
    jsonPath: res.jsonPath || '',
    pngPath: res.pngPath || '',
    data: res.data || null,
    gen_ok: Boolean(res.ok),
    gen_error: res.error || ''
  };
})));

metas.sort((a,b)=> b.score - a.score);

// 2) Tulis index.csv
const csvPath = path.join(OUTPUT_DIR, 'index.csv');
await new Promise(resolve => {
  const stream = csvFormat({ headers: true });
  const ws = fs.createWriteStream(csvPath);
  stream.pipe(ws).on('finish', resolve);
  for (const m of metas){
    stream.write({
      fid: m.fid,
      rarityScore: m.score,
      traits: m.summary,
      json: m.jsonPath ? path.basename(m.jsonPath) : '',
      png: m.pngPath ? path.basename(m.pngPath) : '',
      gen_ok: m.gen_ok ? '1' : '0',
      gen_error: m.gen_error || '',
      signature: '',      // diisi setelah langkah 3
      sig_error: ''
    });
  }
  stream.end();
});
good(`📄  Wrote ${csvPath}`);
section('Top 10 by score');
metas.slice(0, 10).forEach((m,i)=>console.log(`#${i+1} FID=${m.fid} score=${m.score} :: ${m.summary}`));

// 3) Request signature
let targets;
if (!WALLET_ADDR){
  warn('WALLET_ADDRESS kosong → skip signature step. (Set WALLET_ADDRESS=0x...)');
  targets = [];
} else if (ONLY_RARE){
  targets = metas.filter(m => m.score >= MIN_RARITY_SCORE).slice(0, TOP_K_LIMIT);
  info(`RARE_ONLY=1 → request signature untuk ${targets.length} kandidat (TOP_K=${TOP_K_LIMIT}, MIN_SCORE=${MIN_RARITY_SCORE})`);
} else {
  targets = metas;
  info(`Request signature untuk semua (${targets.length})`);
}

section('Requesting signatures');
const sigResults = await Promise.all(targets.map(m => limit(async () => {
  const r = await requestSignature(m.fid, WALLET_ADDR);
  return { fid: m.fid, ok: r.ok, path: r.path || '', error: r.ok ? '' : (r.error || 'unknown') };
})));

// 4) Update index.csv (signature info)
const sigMap = new Map(sigResults.map(s => [s.fid, s]));
const rows = metas.map(m => ({
  fid: m.fid,
  rarityScore: m.score,
  traits: m.summary,
  json: m.jsonPath ? path.basename(m.jsonPath) : '',
  png: m.pngPath ? path.basename(m.pngPath) : '',
  signature: sigMap.get(m.fid)?.ok ? path.basename(sigMap.get(m.fid)?.path) : '',
  sig_error: sigMap.get(m.fid)?.error || (WALLET_ADDR ? '' : 'NO_WALLET')
}));
await new Promise(resolve => {
  const stream = csvFormat({ headers: true });
  const ws = fs.createWriteStream(csvPath);
  stream.pipe(ws).on('finish', resolve);
  for (const r of rows) stream.write(r);
  stream.end();
});
console.log(`✅  Updated ${csvPath} with signature results.`);

console.log('\nTips: untuk hanya mint kandidat rare, jalankan dengan:');
console.log('  RARE_ONLY=1 TOP_K=5 WALLET_ADDRESS=0x... node warplet.js');