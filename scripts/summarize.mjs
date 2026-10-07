#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const CHANNEL_ID = 'UCy9j5kvO1BDxB6ZJ8eAe7lQ';
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const APIFY_ACTOR = 'pintostudio~youtube-transcript-scraper';
const RECIPIENT = 'pierpaolo.maggio84@gmail.com';
const MIN_TRANSCRIPT_LEN = 1500;
const STATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'state.json');

const APIFY_TOKEN = (process.env.APIFY_TOKEN || '').trim();
const OPENROUTER_KEY = (process.env.OPENROUTER_KEY || '').trim();
const GMAIL_USER = (process.env.GMAIL_USER || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').trim();

for (const [k, v] of Object.entries({ APIFY_TOKEN, OPENROUTER_KEY, GMAIL_USER, GMAIL_APP_PASSWORD })) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
  console.log(`env ${k}: length=${v.length}, prefix=${v.slice(0, 6)}***`);
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
  } catch {
    return { seeded: false, processed: [] };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function fetchRSS() {
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch(RSS_URL);
    if (res.ok) break;
    if (attempt === 3) {
      console.log(`RSS fetch failed: ${res.status} after 3 attempts, skipping run`);
      return [];
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  const xml = await res.text();
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const e = m[1];
    const videoId = (e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (e.match(/<title>([^<]+)<\/title>/) || [])[1];
    const published = (e.match(/<published>([^<]+)<\/published>/) || [])[1];
    if (videoId) entries.push({
      videoId,
      title: title ? decodeHtml(title) : '',
      published,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return entries;
}

// /shorts/<id> answers 200 for a Short and 303 (redirect to /watch) for a regular video.
// Fail-open: any other outcome (rate limit, consent redirect, network error) returns false
// so the video goes on to the normal transcript-length check instead of being lost.
async function isShort(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: 'HEAD',
      redirect: 'manual',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9',
        // without the consent cookie YouTube answers with a 302 to the consent page
        cookie: 'CONSENT=YES+1; SOCS=CAI',
      },
    });
    if (res.status === 200) return true;
    if (res.status >= 300 && res.status < 400 && (res.headers.get('location') || '').includes('/watch')) return false;
    console.log(`  shorts check inconclusive (HTTP ${res.status}, location ${(res.headers.get('location') || '').slice(0, 80)}), continuing`);
    return false;
  } catch (e) {
    console.log(`  shorts check failed (${e.message}), continuing`);
    return false;
  }
}

async function fetchTranscript(videoUrl) {
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl }),
  });
  if (!res.ok) throw new Error(`Apify failed: ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  let segs = [];
  if (Array.isArray(data)) {
    for (const d of data) {
      if (Array.isArray(d?.transcript)) segs = segs.concat(d.transcript);
      else if (Array.isArray(d?.data)) segs = segs.concat(d.data);
      else if (d?.text) segs.push(d);
    }
  }
  return segs
    .map(s => (typeof s === 'string' ? s : s.text || s.snippet || ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function summarize({ title, transcript }) {
  const systemPrompt = 'Sei un esperto analista di contenuti video di e-commerce, performance marketing, CRO e crescita di brand DTC. Produci sempre output HTML pulito (solo <h2>, <h3>, <p>, <strong>, <ul>, <li>, <code>) senza tag <html>, <body> o <style>. Non aggiungere preamboli, commenti o note finali. Mai usare blocchi triple-backtick.';

  const userPrompt = `Ti fornisco la trascrizione automatica in inglese di un video di Patrick O'Driscoll (canale "Patrick O'Driscoll | E-Commerce Growth Marketer", co-founder di The Visionary Group, growth marketing per brand e-commerce) intitolato: ${title}

Devi produrre un singolo output HTML in italiano con esattamente questa struttura:

<h2>Riassunto</h2>
<p><strong>Argomento principale:</strong> una frase concisa che identifichi il tema centrale del video.</p>

<h3>Concetti chiave</h3>
<ul>
  <li>Da 4 a 8 punti, ciascuno una frase compatta su un concetto o un'idea distinta affrontata nel video.</li>
</ul>

<h3>Framework, numeri e tattiche</h3>
<p>Se il video contiene un framework, un processo step-by-step, benchmark o numeri concreti (metriche, soglie, percentuali, budget), riportali in modo strutturato:</p>
<ul>
  <li><strong>Obiettivo:</strong> cosa si vuole ottenere.</li>
  <li><strong>Passaggi/tattiche:</strong> elenco preciso di ciò che viene fatto o consigliato.</li>
  <li><strong>Numeri e soglie:</strong> ogni dato quantitativo citato, con il contesto in cui vale.</li>
</ul>
<p>Se il video <strong>non</strong> contiene nulla di operativo, sostituisci questa sezione con: <em>Nessun framework pratico in questo video.</em></p>

<h3>Strumenti, brand e casi citati</h3>
<ul>
  <li><strong>Nome:</strong> spiegazione breve in 1-2 frasi di come viene usato o perché è citato.</li>
</ul>

<h3>Cosa si può applicare ai clienti</h3>
<p>Una sintesi in 2-4 frasi su cosa è trasferibile a un freelance che segue brand e-commerce (strategia, email marketing, CRO, lanci), indicando dove il contenuto è valido solo a scala o budget molto diversi da quelli di una PMI italiana.</p>

Tutto in italiano. Mantieni intatti nomi propri, sigle, riferimenti a strumenti, brand e persone. Restituisci direttamente l'HTML pronto, senza markdown, commenti o blocchi di codice.

Trascrizione originale:
${transcript}`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/PierpaoloMaggio/tvg-summarizer',
      'X-Title': 'The Visionary Group Summarizer',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4.5',
      max_tokens: 4000,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter failed: ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter response missing content: ' + JSON.stringify(data).slice(0, 300));
  return content
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

function buildEmailHtml({ title, videoUrl, summaryHtml }) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:720px;margin:0 auto;color:#1a1a1a;line-height:1.6">
<p style="color:#666;font-size:13px;margin:0 0 8px 0">Nuovo video &middot; Patrick O&#39;Driscoll | The Visionary Group</p>
<h1 style="font-size:22px;margin:0 0 4px 0">${title}</h1>
<p style="margin:0 0 24px 0"><a href="${videoUrl}" style="color:#0066cc">Guarda su YouTube</a></p>
<hr style="border:none;border-top:1px solid #eee;margin:0 0 24px 0">
${summaryHtml}
</div>`;
}

async function sendEmail({ subject, html }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({ from: GMAIL_USER, to: RECIPIENT, subject, html });
}

async function main() {
  const state = await loadState();
  const entries = await fetchRSS();
  console.log(`RSS entries: ${entries.length}`);

  if (!state.seeded) {
    state.seeded = true;
    state.processed = entries.map(e => e.videoId);
    await saveState(state);
    console.log(`First run — seeded ${state.processed.length} videoIds without processing.`);
    return;
  }

  const newOnes = entries.filter(e => !state.processed.includes(e.videoId));
  console.log(`New videos: ${newOnes.length}`);
  if (newOnes.length === 0) return;

  for (const entry of newOnes.reverse()) {
    console.log(`Processing ${entry.videoId} — ${entry.title}`);
    // Pre-Apify filters (this channel posts many Shorts): skip without paying for a transcript.
    let skipReason = null;
    if (/#\w+/.test(entry.title)) skipReason = 'title contains a hashtag (channel tags its Shorts)';
    else if (await isShort(entry.videoId)) skipReason = 'YouTube classifies it as a Short';
    if (skipReason) {
      console.log(`  skipped (${skipReason})`);
      state.processed.push(entry.videoId);
      if (state.processed.length > 200) state.processed = state.processed.slice(-200);
      await saveState(state);
      continue;
    }
    try {
      const transcript = await fetchTranscript(entry.videoUrl);
      console.log(`  transcript length: ${transcript.length}`);
      if (transcript.length < MIN_TRANSCRIPT_LEN) {
        console.log(`  skipped (too short, likely a Short)`);
        state.processed.push(entry.videoId);
      } else {
        const summaryHtml = await summarize({ title: entry.title, transcript });
        const html = buildEmailHtml({ title: entry.title, videoUrl: entry.videoUrl, summaryHtml });
        await sendEmail({ subject: `Patrick O'Driscoll (TVG) — ${entry.title}`, html });
        console.log(`  mail sent`);
        state.processed.push(entry.videoId);
      }
    } catch (e) {
      console.error(`  ERROR on ${entry.videoId}: ${e.message}`);
    }
    if (state.processed.length > 200) state.processed = state.processed.slice(-200);
    await saveState(state);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
