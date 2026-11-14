// Token Radar dashboard. Reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, filters, a per-protocol detail view and the calibration the
// model was priced from. No network: every byte shown is already in data.js.
//
// The page does not trust the numbers it is handed: it recomputes each row's implied
// value from the snapshot figures and the calibration table, and regenerates each farm
// plan from the row's category, chains, TVL and age, then says whether the recomputed
// values match what board.json carries. The model lives here in full, so the page and
// the board are visibly the same arithmetic.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', band: 'all', watch: false, tab: 'pre', sort: 'implied', dir: -1, selected: null };

  var money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return money.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtRatio(n) { return Number(n).toFixed(3); }

  // ---- the model, as the page recomputes it ---------------------------------
  // ratio: the category's shrunk median mcap/TVL from the calibration table, or the
  // global median when the category has no trading comps.
  function ratioOf(row) {
    var line = null;
    for (var i = 0; i < DATA.calibration.lines.length; i++) {
      if (DATA.calibration.lines[i].category === (row.category || 'Uncategorised')) { line = DATA.calibration.lines[i]; break; }
    }
    if (line) return { ratio: line.ratio_used, comps: line.comps };
    return { ratio: DATA.calibration.global_median, comps: 0 };
  }
  function impliedOf(row) {
    var m = DATA.model;
    var r = ratioOf(row);
    var growth = Math.min(m.growth_max, Math.max(m.growth_min, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + growth * m.growth_per_point;
    var age = row.age_days === null || row.age_days === undefined ? row.model.age_used : row.age_days;
    var maturity = m.maturity_min + (Math.min(Math.max(age, 0), m.maturity_days) / m.maturity_days) * m.maturity_span;
    var chains = Math.max(1, (row.chains || []).length);
    var chainMult = Math.min(m.chain_max, 1 + m.chain_per_log * Math.log(chains));
    var base = row.tvl_usd * r.ratio;
    return {
      implied: Math.max(1, Math.round(base * growthMult * maturity * chainMult)),
      base: Math.round(base), ratio: r.ratio, comps: r.comps,
      growth: growth, growthMult: growthMult, maturity: maturity, chainMult: chainMult, age: age
    };
  }

  // ---- the farm plan, as the page regenerates it -----------------------------
  function firstChain(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdFor(age) {
    if (age === null || age === undefined) return 45;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function gasFor(chain) {
    var cheap = ['base', 'arbitrum', 'optimism', 'solana', 'polygon', 'bsc', 'avalanche', 'blast', 'mode', 'linea', 'scroll', 'zksync', 'mantle', 'sei', 'sui', 'aptos'];
    var low = String(chain).toLowerCase();
    if (low === 'ethereum') return 'about $8 of gas';
    for (var i = 0; i < cheap.length; i++) if (low.indexOf(cheap[i]) >= 0) return 'about $1 of gas';
    return 'about $3 of gas';
  }
  function mainAction(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('cex') >= 0 || c.indexOf('central') >= 0) return 'Open an account on ' + name + ', finish its verification, and put $' + capital + ' into its earn product on ' + chain + '.';
    if (c.indexOf('chain') >= 0 && c.indexOf('cross') < 0 && c.indexOf('bridge') < 0) return 'Bridge $' + capital + ' of USDC to ' + name + " and use it in two of the chain's own apps.";
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the loan position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('amm') >= 0 || c.indexOf('swap') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0 || c.indexOf('cross chain') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ', then use the bridged funds inside its app.';
    if (c.indexOf('stak') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + capital + " of the chain's staking asset through " + name + ' on ' + chain + ' and keep the receipt token.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedged position.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the yield-bearing asset " + name + ' issues on ' + chain + ' and hold it.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('risk') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the vault shares.';
    if (c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('aggregator') >= 0) return 'Deposit $' + capital + " into " + name + "'s main farm on " + chain + ' and keep the position open.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(text, cost, time) {
    var s = text + ' Cost: ' + cost + '. Time: ' + time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = firstChain(p);
    var second = p.chains && p.chains.length > 1 ? p.chains[1] : null;
    var capital = capitalFor(p);
    var hold = holdFor(p.age_days);
    var weekly = second === null
      ? 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.'
      : 'Make one qualifying action each week on ' + chain + ', and repeat the main position once on ' + second + ' so the activity shows on two chains.';
    return [
      stepText('Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', 'under $3 of gas for the first transaction', '5 minutes'),
      stepText(mainAction(p, capital, chain), '$' + capital + ' of capital and ' + gasFor(chain), '15 minutes to set up'),
      stepText(weekly, 'about $2 of gas a week', '10 minutes a week'),
      stepText('Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', 'the $' + capital + ' stays in the position', hold + ' days'),
      stepText("Before you withdraw, open " + p.name + "'s own points or rewards page and claim only from the link it publishes, then write the wallet, the dates and every transaction in a farm log.", 'no fee to check, and never pay to claim', '15 minutes')
    ];
  }

  // ---- helpers ----------------------------------------------------------------
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function bandOf(tvl) {
    if (tvl < 5e7) return 'micro';
    if (tvl < 5e8) return 'mid';
    if (tvl < 5e9) return 'large';
    return 'mega';
  }
  function bandLabel(b) {
    return { micro: '$5M – $50M', mid: '$50M – $500M', large: '$500M – $5B', mega: '$5B+' }[b] || b;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('band')) state.band = params.get('band');
    if (params.get('w') === '1') state.watch = true;
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.band !== 'all') params.set('band', state.band);
    if (state.watch) params.set('w', '1');
    if (state.tab !== 'pre') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.band !== 'all' && bandOf(r.tvl_usd) !== state.band) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // ---- sections ---------------------------------------------------------------
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', null, 'Every pre-token protocol, ranked by ', el('em', { text: 'what its launch would be worth' }), '.'),
        el('p', { text: 'The watchlist is the floor: ' + DATA.watchlist_size + ' protocols with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. This board ranks all ' + DATA.board_size + ' protocols that record no token, priced from the ' + DATA.calibration.comps_total + ' that already trade. Implied value is a model, not a promise — and never proof a token is coming.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows ranked' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Trading comps priced' }), el('b', { text: String(DATA.calibration.comps_total) })),
        el('div', { class: 'fact' }, el('span', { text: 'Top implied value' }), el('b', { text: fmtUsd(DATA.rows[0] ? DATA.rows[0].implied_value_usd : 0) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Uncategorised'; }))).sort();
    var chainCounts = {};
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { chainCounts[c] = (chainCounts[c] || 0) + 1; }); });
    var chains = Object.keys(chainCounts).sort(function (a, b) { return chainCounts[b] - chainCounts[a]; });
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var cat = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var chain = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c + ' (' + chainCounts[c] + ')', selected: c === state.chain ? 'selected' : null }); })
    );
    chain.addEventListener('change', function () { state.chain = chain.value; writeHash(); render(); });
    var band = el('select', { id: 'band', 'aria-label': 'Filter by TVL band' },
      el('option', { value: 'all', text: 'All TVL bands' }),
      ['micro', 'mid', 'large', 'mega'].map(function (b) { return el('option', { value: b, text: bandLabel(b), selected: b === state.band ? 'selected' : null }); })
    );
    band.addEventListener('change', function () { state.band = band.value; writeHash(); render(); });
    var watch = el('input', { type: 'checkbox', id: 'watch', checked: state.watch ? 'checked' : null });
    watch.addEventListener('change', function () { state.watch = watch.checked; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre' ? 'true' : 'false', text: 'Pre-token board', onclick: function () { state.tab = 'pre'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Trading reference', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), cat),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chain),
      el('div', { class: 'field' }, el('label', { for: 'band', text: 'TVL band' }), band),
      el('label', { class: 'check', for: 'watch' }, watch, 'Watchlist only'),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'View' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre' ? filteredRows().length + ' of ' + DATA.board_size + ' rows shown' : DATA.live.length + ' trading protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'name' ? 1 : -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category, chain or band to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.band = 'all'; state.watch = false; writeHash(); render(); } })
      ));
    }
    var max = DATA.rows[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: r.watchlist ? 'status watch' : 'status', text: r.watchlist ? 'watchlist' : 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its value breakdown and farm plan. "No token" means the record carries none, never that none exists.' }),
          el('thead', null, el('tr', null,
            sortHeader('rank', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Uncategorised') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: fmtRatio(r.tvl_usd > 0 ? r.mcap_usd / r.tvl_usd : 0) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Trading reference only: the largest token-bearing protocols by market cap. Their market caps are facts, not a model — they priced the ratios below, and they are never ranked on this board.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var c = DATA.calibration;
    var cells = [
      ['Base multiple', 'TVL x category ratio'],
      ['Growth', 'clamp(7d, ' + m.growth_min + ', ' + m.growth_max + ')%, x ' + m.growth_per_point + ' a point'],
      ['Maturity', m.maturity_min + ' + 0.3 x min(age, ' + m.maturity_days + 'd) / ' + m.maturity_days + 'd'],
      ['Chain breadth', '1 + ' + m.chain_per_log + ' x ln(chains), capped ' + m.chain_max],
      ['Shrinkage', 'category median pulled to global with k = ' + m.shrink_k],
      ['Ratio band', fmtRatio(m.ratio_min) + ' to ' + fmtRatio(m.ratio_max)]
    ];
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'One function scores every protocol. The market sets the price: for each category, the median market-cap-to-TVL ratio of the protocols that already trade, shrunk toward the global median of ' + fmtRatio(c.global_median) + ' (' + c.comps_total + ' comparables carry a market cap). A pre-token protocol is its TVL at that ratio, moved by its seven-day growth, how long it has run with no token, and how many chains it runs on.' }),
      el('div', { class: 'formula' }, 'implied = round( tvl_usd x ratio(category) x (1 + clamp(change_7d, ' + m.growth_min + ', ' + m.growth_max + ') x ' + m.growth_per_point + ') x (' + m.maturity_min + ' + ' + m.maturity_span + ' x min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ') x min(' + m.chain_max + ', 1 + ' + m.chain_per_log + ' x ln(chains)) )'),
      el('div', { class: 'model-grid' }, cells.map(function (cell) {
        return el('div', { class: 'model-cell' }, el('span', { text: cell[0] }), el('b', { text: cell[1] }));
      })),
      el('p', { class: 'sub', text: 'Age is the time since DefiLlama first listed the protocol; a protocol with no listed date uses the pre-token median age. No protocol name is special-cased, and no row is hand-picked.' })
    );
  }

  function calibPanel() {
    var c = DATA.calibration;
    var tbody = el('tbody');
    c.lines.forEach(function (l) {
      tbody.appendChild(el('tr', null,
        el('td', { text: l.category }),
        el('td', { class: 'num', text: String(l.comps) }),
        el('td', { class: 'num', text: fmtRatio(l.median_ratio) }),
        el('td', { class: 'num', text: fmtRatio(l.ratio_used) })
      ));
    });
    return el('section', { class: 'panel' },
      el('h2', { text: 'Calibration: what the trading market pays per TVL dollar' }),
      el('p', { class: 'sub', text: 'Each line is one category of the ' + c.comps_total + ' trading protocols with a recorded market cap. The median ratio is what the market pays; the ratio used is that median shrunk toward the global median of ' + fmtRatio(c.global_median) + ' (k = ' + DATA.model.shrink_k + '), so a category with one or two comps cannot set the price on its own. Categories with no trading comps use the global median.' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'calib' },
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Comps' }), el('th', { scope: 'col', text: 'Median mcap / TVL' }), el('th', { scope: 'col', text: 'Ratio used' }))),
          tbody
        )
      )
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = null;
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) { row = DATA.rows[i]; break; }
    if (!row) return;
    state.selected = slug;
    writeHash();
    var calc = impliedOf(row);
    var plan = farmSteps(row);
    var stored = row.farm_steps || [];
    var planMatch = plan.length === stored.length && plan.every(function (s, j) { return s === stored[j]; });
    var valueMatch = calc.implied === row.implied_value_usd;
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'kicker', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' — watchlist' : '') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Uncategorised') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' — records no token.' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value — the working' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category ratio (' + (calc.comps === 1 ? '1 comp' : calc.comps + ' comps') + ')' }), el('b', { class: 'num', text: fmtRatio(calc.ratio) })),
        el('div', null, el('span', { text: 'Base value (TVL x ratio)' }), el('b', { class: 'num', text: fmtUsd(calc.base) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(calc.growth) + ' -> x' + calc.growthMult.toFixed(3) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) + ' -> x' + calc.maturity.toFixed(3) })),
        el('div', null, el('span', { text: 'Chains (' + (row.chains || []).length + ')' }), el('b', { class: 'num', text: 'x' + calc.chainMult.toFixed(3) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
        el('div', null, el('span', { text: 'Page recompute' }), el('b', { class: 'num', text: fmtUsd(calc.implied) }))
      ),
      el('p', { class: 'sub', text: 'The ratio comes from the ' + calc.comps + ' trading ' + (row.category || 'Uncategorised') + ' protocols with a market cap; categories with no comps use the global median ' + fmtRatio(DATA.calibration.global_median) + '. The page recomputes this row as ' + fmtUsd(calc.implied) + (valueMatch ? ', the same number board.json carries.' : ' — which differs from the board, so the data would be stale.') + ' An estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, plan.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      })),
      el('p', { class: 'sub', text: planMatch ? 'This plan is the one board.json carries for this protocol, regenerated here from its category, chains, TVL and age.' : 'This plan is regenerated here from the protocol record; it differs from the stored plan, so the data would be stale.' })
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre' ? boardTable() : liveTable());
    if (state.tab === 'pre') {
      shell.appendChild(modelPanel());
      shell.appendChild(calibPanel());
    } else {
      shell.appendChild(el('section', { class: 'panel' },
        el('h2', { text: 'Why these are set aside' }),
        el('p', { class: 'sub', text: 'A protocol whose token already trades has a market price, so there is nothing to imply. These ' + DATA.live.length + ' are the largest of them by market cap; their ratios priced the board above. The full calibration table sits under the pre-token board.' })
      ));
    }
    shell.appendChild(el('p', { class: 'foot', text: 'Source: ' + DATA.source + '. "No token" means the DefiLlama record carries no token — it is not proof that none exists. Implied values are this radar\u2019s own model, never a price or a promise.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
