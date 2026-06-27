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
    const { competitor1Name: eq1, competitor2Name: eq2, sportId, tournamentId, matchStart } = match;
    if (!eq1 || !eq2) continue;
    const league = (state.tournaments[tournamentId] || {}).tournamentName || '';
    for (const [bid, bet] of Object.entries(state.bets)) {
      if (String(bet.matchId) !== String(mid)) continue;
      const outcomes = bet.outcomes || [];
      if (!outcomes.length) continue;
      const coteVal = state.odds[outcomes[0]];
      if (!coteVal) continue;
      const coteInit = bet.initialOdds || bet.baseOdds || null;
      const miseMax  = bet.maxBet || bet.stakeLimit || bet.maxStake || null;
      results.push({
        id: bid,
        sport: sportName(sportId),
        competition: league,
        equipe1: eq1,
        equipe2: eq2,
        heureMatch: matchStart ? new Date(matchStart * 1000).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : null,
        libelle: bet.label || bet.betTitle || bet.name || '',
        coteBoostee: coteVal,
        coteInitiale: coteInit,
        miseMax,
        url: 'https://www.winamax.fr/paris-sportifs/sports/' + (sportId || 100000),
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

  // Step 1: handshake — get SID + session cookies
  const initUrl = SIO_HTTP + '?EIO=4&transport=polling&' + SIO_Q + '&t=' + Date.now();
  const initRes = await fetch(initUrl, { headers: BROWSER_HEADERS });
  if (!initRes.ok) throw new Error('Handshake HTTP ' + initRes.status);
  const initText = await initRes.text();
  if (!initText.startsWith('0')) throw new Error('Reponse inattendue: ' + initText.slice(0, 120));
  const sid = JSON.parse(initText.slice(1)).sid;

  // Capture cookies from handshake and forward to all subsequent requests
  const setCookies = (initRes.headers.getSetCookie ? initRes.headers.getSetCookie() : []);
  const cookieStr  = [
    'wm_cookie_policy=1',
    'wm_gdpr_analytics=0',
    ...setCookies.map(c => c.split(';')[0]),
  ].join('; ');

  const sessionHeaders = { ...BROWSER_HEADERS, 'Cookie': cookieStr };
  const pollBase = SIO_HTTP + '?EIO=4&transport=polling&sid=' + sid + '&' + SIO_Q;

  console.log('[Winamax] SID:', sid);

  // Step 2: namespace connect (POST "40")
  await fetch(pollBase, {
    method: 'POST',
    headers: { ...sessionHeaders, 'Content-Type': 'text/plain;charset=UTF-8' },
    body: '40',
  });

  // Step 3: flush GET (receive "40" namespace connect confirmation)
  const flushRes  = await fetch(pollBase + '&t=' + Date.now(), { headers: sessionHeaders });
  const flushText = await flushRes.text();
  console.log('[Winamax] NS confirm:', flushText.slice(0, 80));

  // Step 4: subscribe to boost routes
  const subPackets = BOOST_ROUTES.map(route =>
    '42' + JSON.stringify(['m', { route, requestId: Date.now() + '_' + route }])
  ).join('\x1e');

  await fetch(pollBase, {
    method: 'POST',
    headers: { ...sessionHeaders, 'Content-Type': 'text/plain;charset=UTF-8' },
    body: subPackets,
  });

  BOOST_ROUTES.forEach(r => console.log('[Winamax] Abonne:', r));

  // Step 5: polling loop for COLLECT_MS
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
  const debug  = { matchCount: Object.keys(state.matches).length, betCount: Object.keys(state.bets).length };
  console.log('[Winamax]', boosts.length, 'cotes boostees', debug);
  return { boosts, _debug: debug };
}

app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/boosts', async (_req, res) => {
  console.log('[API] GET /boosts');
  try {
    const result = await fetchWinamaxBoosts();
    res.json({ success: true, count: result.boosts.length, boosts: result.boosts, _debug: result._debug });
  } catch (err) {
    console.error('[API] Erreur:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('Winamax boosts server (HTTP polling) — port ' + PORT);
  console.log('Routes: ' + BOOST_ROUTES.join(', '));
});
