const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

const SIO_HTTP = 'https://sports-eu-west-3.winamax.fr/uof-sports-server/socket.io/';
const SIO_WS   = 'wss://sports-eu-west-3.winamax.fr/uof-sports-server/socket.io/';
const SIO_Q    = 'language=FR&version=3.9.1&embed=false';

const BROWSER_HEADERS = {
  'Origin': 'https://www.winamax.fr',
  'Referer': 'https://www.winamax.fr/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
};

const COLLECT_MS = parseInt(process.env.COLLECT_MS || '8000');
const BOOST_ROUTES = (process.env.BOOST_ROUTES || 'sport:100000').split(',');

const SPORT_NAMES = { 1:'Football', 2:'Basketball', 4:'Hockey sur Glace', 5:'Tennis', 100000:'Extras' };
function sportName(id) { return SPORT_NAMES[id] || 'Sport ' + id; }

async function fetchWinamaxBoosts() {
  return new Promise(async (resolve, reject) => {
    const hardTimeout = setTimeout(() => {
      reject(new Error('Timeout - Winamax est peut-etre geo-bloque depuis Railway'));
    }, COLLECT_MS + 6000);

    let sid;
    try {
      const url = SIO_HTTP + '?EIO=4&transport=polling&' + SIO_Q + '&t=' + Date.now();
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      const text = await res.text();
      if (!text.startsWith('0')) throw new Error('Reponse inattendue: ' + text.slice(0, 80));
      sid = JSON.parse(text.slice(1)).sid;
      console.log('[Winamax] SID:', sid);
    } catch (e) {
      clearTimeout(hardTimeout);
      return reject(new Error('Warm-up echoue: ' + e.message));
    }

    const ws = new WebSocket(SIO_WS + '?EIO=4&transport=websocket&sid=' + sid + '&' + SIO_Q, {
      headers: { ...BROWSER_HEADERS, 'Cookie': 'wm_cookie_policy=1; wm_gdpr_analytics=0' }
    });

    const state = { matches: {}, bets: {}, odds: {}, tournaments: {} };

    function merge(payload) {
      if (!payload || typeof payload !== 'object') return;
      ['matches','bets','odds','tournaments'].forEach(k => {
        if (payload[k]) Object.assign(state[k], payload[k]);
      });
    }

    function buildBoosts() {
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
          const miseMax = bet.maxBet || bet.stakeLimit || bet.maxStake || null;
          results.push({
            id: bid,
            sport: sportName(sportId),
            competition: league,
            equipe1: eq1,
            equipe2: eq2,
            heureMatch: matchStart ? new Date(matchStart * 1000).toLocaleString('fr-FR', {timeZone:'Europe/Paris'}) : null,
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

    let subscribed = false;
    let collectTimer = null;

    function startCollect() {
      if (collectTimer) return;
      collectTimer = setTimeout(() => {
        const boosts = buildBoosts();
        const debug = { matchCount: Object.keys(state.matches).length, betCount: Object.keys(state.bets).length };
        console.log('[Winamax] ' + boosts.length + ' cotes boostees', debug);
        ws.close();
        clearTimeout(hardTimeout);
        resolve({ boosts, _debug: debug });
      }, COLLECT_MS);
    }

    ws.on('open', () => { ws.send('2probe'); });
    ws.on('message', (raw) => {
      const msg = raw.toString();
      if (msg === '3probe') { ws.send('5'); return; }
      if (msg === '2') { ws.send('3'); return; }
      if (msg.startsWith('0')) { ws.send('40'); return; }
      if (msg.startsWith('40') && !subscribed) {
        subscribed = true;
        BOOST_ROUTES.forEach(route => {
          ws.send('42' + JSON.stringify(['m', { route, requestId: Date.now() + '_' + route }]));
          console.log('[Winamax] Abonne a:', route);
        });
        startCollect();
        return;
      }
      if (msg.startsWith('42')) {
        try {
          const [evtName, data] = JSON.parse(msg.slice(2));
          if (evtName === 'm' && data) merge(data);
        } catch {}
      }
    });
    ws.on('error', (err) => {
      clearTimeout(hardTimeout);
      clearTimeout(collectTimer);
      reject(new Error('WebSocket error: ' + err.message));
    });
  });
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
  console.log('Winamax boosts server - port ' + PORT);
  console.log('Routes WS: ' + BOOST_ROUTES.join(', '));
});
