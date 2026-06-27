const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const SIO_HTTP = 'https://sports-eu-west-3.winamax.fr/uof-sports-server/socket.io/';
const SIO_Q    = 'language=FR&version=3.9.1&embed=false';

const BROWSER_HEADERS = {
  'Origin': 'https://www.winamax.fr',
  'Referer': 'https://www.winamax.fr/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Accept': '*/*',
};

const COLLECT_MS   = parseInt(process.env.COLLECT_MS || '10000');
const BOOST_ROUTES = (process.env.BOOST_ROUTES || 'sport:100000').split(',');

const SPORT_NAMES = { 1:'Football', 2:'Basketball', 4:'Hockey sur Glace', 5:'Tennis', 100000:'Extras' };
function sportName(id) { return SPORT_NAMES[id] || 'Sport ' + id; }

function buildBoosts(state) {
  const results = [];
  for (const [mid, match] of Object.entries(state.matches)) {
    // match.title = "Cote Boostée : Team1 - Team2"
    const rawTitle = match.title || '';
    const matchTitle = rawTitle.replace(/^Cote Boost\u00e9e\s*:\s*/i, '').replace(/^Cote Boostee\s*:\s*/i, '').trim();
    const parts = matchTitle.split(' - ');
    const eq1 = parts[0]?.trim() || rawTitle || String(mid);
    const eq2 = parts.slice(1).join(' - ').trim();
    const sportId = match.sportId || 100000;
    const tournamentId = match.tournamentId || '';
    const matchStart = match.matchStart || null;
    const league = (state.tournaments[tournamentId] || {}).tournamentName || (state.tournaments[tournamentId] || {}).name || '';

    for (const [bid, bet] of Object.entries(state.bets)) {
      if (String(bet.matchId || '') !== String(mid)) continue;
      const outcomes = bet.outcomes || [];
      if (!outcomes.length) continue;
      const coteVal = state.odds[outcomes[0]];
      if (!coteVal) continue;
      // bet.previousOdd = cote initiale avant boost
      const coteInit = bet.previousOdd || null;
      // mise max depuis betTypeHelp "20 € maximum" ou betTitle "mise max 20 €"
      const helpText = bet.betTypeHelp || bet.betTitle || '';
      const miseMatch = helpText.match(/(\d+)\s*\u20ac\s*max/i) || helpText.match(/max(?:imum)?\s*(\d+)\s*\u20ac/i) || helpText.match(/mise\s*max\s*(\d+)/i);
      const miseMax = miseMatch ? parseInt(miseMatch[1]) : null;

      results.push({
        id: bid,
        sport: sportName(sportId),
        competition: league,
        equipe1: eq1,
        equipe2: eq2,
        heureMatch: matchStart ? new Date(matchStart * 1000).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : null,
        libelle: bet.betTitle || bet.betTypeName || '',
        coteBoostee: coteVal,
        coteInitiale: coteInit,
        miseMax,
        url: 'https://www.winamax.fr/paris-sportifs/sports/' + sportId,
      });
    }
  }
  return results;
}

function parsePackets(text) {
  return text.split('\x1e').filter(Boolean);
}

async function fetchWinamaxBoosts() {
  const state = { matches: {}, bets: {}, odds: {}, tournaments: {} };

  const initUrl = SIO_HTTP + '?EIO=4&transport=polling&' + SIO_Q + '&t=' + Date.now();
  const initRes = await fetch(initUrl, { headers: BROWSER_HEADERS });
  if (!initRes.ok) throw new Error('Handshake HTTP ' + initRes.status);
  const initText = await initRes.text();
  if (!initText.startsWith('0')) throw new Error('Reponse inattendue: ' + initText.slice(0, 120));
  const sid = JSON.parse(initText.slice(1)).sid;

  const setCookies = (initRes.headers.getSetCookie ? initRes.headers.getSetCookie() : []);
  const cookieStr  = [
    'wm_cookie_policy=1',
    'wm_gdpr_analytics=0',
    ...setCookies.map(c => c.split(';')[0]),
  ].join('; ');

  const sessionHeaders = { ...BROWSER_HEADERS, 'Cookie': cookieStr };
  const pollBase = SIO_HTTP + '?EIO=4&transport=polling&sid=' + sid + '&' + SIO_Q;

  console.log('[Winamax] SID:', sid);

  await fetch(pollBase, {
    method: 'POST',
    headers: { ...sessionHeaders, 'Content-Type': 'text/plain;charset=UTF-8' },
    body: '40',
  });

  const flushRes  = await fetch(pollBase + '&t=' + Date.now(), { headers: sessionHeaders });
  const flushText = await flushRes.text();
  console.log('[Winamax] NS confirm:', flushText.slice(0, 80));

  const subPackets = BOOST_ROUTES.map(route =>
    '42' + JSON.stringify(['m', { route, requestId: Date.now() + '_' + route }])
  ).join('\x1e');

  await fetch(pollBase, {
    method: 'POST',
    headers: { ...sessionHeaders, 'Content-Type': 'text/plain;charset=UTF-8' },
    body: subPackets,
  });

  BOOST_ROUTES.forEach(r => console.log('[Winamax] Abonne:', r));

  const endTime = Date.now() + COLLECT_MS;

  while (Date.now() < endTime) {
    const res = await fetch(pollBase + '&t=' + Date.now(), { headers: sessionHeaders });
    if (!res.ok) { console.warn('[Winamax] Poll erreur HTTP', res.status); break; }
    const text = await res.text();

    for (const packet of parsePackets(text)) {
      if (packet === '2') {
        fetch(pollBase, {
          method: 'POST',
          headers: { ...sessionHeaders, 'Content-Type': 'text/plain;charset=UTF-8' },
          body: '3',
        }).catch(() => {});
        continue;
      }
      if (packet.startsWith('42')) {
        try {
          const [evtName, data] = JSON.parse(packet.slice(2));
          if (evtName === 'm' && data) {
            ['matches', 'bets', 'odds', 'tournaments'].forEach(k => {
              if (data[k]) Object.assign(state[k], data[k]);
            });
          }
        } catch (_) {}
      }
    }
  }

  const boosts = buildBoosts(state);
  console.log('[Winamax]', boosts.length, 'cotes boostees |', Object.keys(state.matches).length, 'matchs |', Object.keys(state.odds).length, 'odds');
  return { boosts, count: boosts.length };
}

app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/boosts', async (_req, res) => {
  console.log('[API] GET /boosts');
  try {
    const result = await fetchWinamaxBoosts();
    res.json({ success: true, count: result.boosts.length, boosts: result.boosts });
  } catch (err) {
    console.error('[API] Erreur:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('Winamax boosts server (HTTP polling) — port ' + PORT);
  console.log('Routes: ' + BOOST_ROUTES.join(', '));
});
