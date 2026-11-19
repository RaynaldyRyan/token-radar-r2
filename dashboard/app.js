// Token Radar dashboard. Reads window.RADAR (main.ts, same board as board.json); FDV, bands and farm plans derive here, so page and board cannot drift.
(function () {
'use strict';
var R = window.RADAR;
// Rows arrive in rank order without their rank; restore it so every index below is stable.
R.r.forEach(function (r, i) { r.unshift(i + 1); });
// Row arrays are positional: [rank,slug,name,catIdx,chainIdxs,tvl,chg7d,ageDays,implied,oddsBucket,rankLo,rankHi,watchlist]
var RK = 0, SL = 1, NM = 2, CT = 3, CH = 4, TV = 5, CG = 6, AG = 7, IM = 8, OD = 9, RL = 10, RH = 11, WL = 12;
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
var fmtInt = function (n) { return Math.round(n).toLocaleString('en-US'); };
var money = function (n) {
  return n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(0) + 'K' : '$' + fmtInt(n);
};
var ageStr = function (a) { return a === null ? '—' : a < 365 ? a + 'd' : (a / 365).toFixed(1) + 'y'; };
var chgStr = function (c) { return c === null ? '—' : (c >= 0 ? '+' : '') + c.toFixed(1) + '%'; };
var slugName = function (s) { return s.split('-').map(function (w) { return w ? w[0].toUpperCase() + w.slice(1) : w; }).join(' '); };

// The model, re-derived (same rules as lib/model.ts).
var FEES = { Ethereum: 18, Bittensor: 12, Bitcoin: 10, Tron: 6, Solana: 1.4, Binance: 1.6, Arbitrum: 2.4, Base: 2.4, Optimism: 2.4, Polygon: 2, Avalanche: 3.2 };
var ACTS = [
  ['lend', 'Lend / supply', 2, ['lend', 'cdp', 'collateral']],
  ['lp', 'Provide liquidity', 2.5, ['dex', 'yield', 'leveraged farm']],
  ['stake', 'Stake', 1.5, ['staking', 'restak']],
  ['trade', 'Trade / margin', 3, ['perpetual', 'derivative']],
  ['predict', 'Predict', 2, ['prediction']],
  ['vault', 'Vault deposit', 1.5, ['curator', 'allocator']],
  ['mint', 'Mint / hold', 1.5, ['stable', 'rwa']],
  ['cover', 'Buy cover', 1.5, ['insurance']]
];
var oddsOf = function (r) { return r[OD] < 0 ? R.ov : R.o[r[OD]][1]; };
var fdvOf = function (r) { return r[IM] / oddsOf(r); };
var bandOf = function (r, q) { return r[IM] * Math.pow(10, q); };
var farmAction = function (cat) {
  var c = (cat || '').toLowerCase();
  for (var i = 0; i < ACTS.length; i++) { var a = ACTS[i]; for (var j = 0; j < a[3].length; j++) if (c.indexOf(a[3][j]) >= 0) return a; }
  return ['deposit', 'Deposit', 2, []];
};
var farmFees = function (ch) { return FEES[ch] === undefined ? 5 : FEES[ch]; };
var farmDays = function (age) { return age === null ? 60 : age < 180 ? 90 : age < 365 ? 60 : 30; };
var farmOf = function (r, ticket, share, hurdle) {
  var cat = R.cats[r[CT]], ch = r[CH].length ? R.chs[r[CH][0]] : 'its main chain';
  var a = farmAction(cat), fees = farmFees(r[CH].length ? R.chs[r[CH][0]] : '');
  var slice = r[TV] > 0 ? (r[IM] * share * ticket) / (0.2 * r[TV]) : 0;
  var net = slice - fees - a[2] * 75;
  var verdict = net >= hurdle * ticket ? 'FARM' : net > 0 ? 'THIN' : 'SKIP';
  return { id: a[0], label: a[1], hours: a[2], chain: ch, fees: fees, days: farmDays(r[AG]), slice: slice, net: net, verdict: verdict };
};
// The farm steps: the same six templates main.ts writes into board.json, from the same inputs.
var stepText = function (t, c, ti) {
  var s = t + ' Cost: ' + c + '. Time: ' + ti + '.';
  if (s.length > 600) s = s.slice(0, 596) + '...';
  if (s.length < 20) s += ' Hold the position and check the protocol\'s own page.';
  return s;
};
var ageWords = function (a) { return a === null ? 'an unrecorded time' : a < 365 ? a + ' days' : (a / 365).toFixed(1) + ' years'; };
var actionSentence = function (id, name, chain, cap) {
  var c = '$' + fmtInt(cap);
  switch (id) {
    case 'lend': return 'Supply ' + c + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    case 'lp': return 'Provide ' + c + ' of liquidity to ' + name + '\'s main pool on ' + chain + ' and keep the position open.';
    case 'stake': return 'Stake ' + c + ' of the chain\'s staking asset through ' + name + ' and keep the receipt.';
    case 'trade': return 'Deposit ' + c + ' of USDC as margin on ' + name + ' and open one small hedge.';
    case 'predict': return 'Fund ' + c + ' and place one market position on ' + name + '.';
    case 'vault': return 'Deposit ' + c + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    case 'mint': return 'Mint or deposit ' + c + ' of the stable asset through ' + name + ' on ' + chain + '.';
    case 'cover': return 'Buy ' + c + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    default: return 'Deposit ' + c + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
};
var farmSteps = function (r, ticket) {
  var f = farmOf(r, ticket, 0.1, 0.05);
  return [
    stepText('Use a fresh wallet holding only the $' + fmtInt(ticket) + ' you plan to farm with ' + r[NM] + '; keep its seed phrase offline.', 'under $3 of gas for the first transaction', '5 minutes'),
    stepText(actionSentence(f.id, r[NM], f.chain, ticket), '$' + f.fees.toFixed(2) + ' of gas across the setup', f.hours + ' hours to set up and check in'),
    stepText('Make one qualifying action each week — a deposit, swap, vote or borrow — so the activity spans more than one snapshot.', 'about $2 of gas a week', '10 minutes a week'),
    stepText('Hold the position at least ' + f.days + ' days; ' + r[NM] + ' has run ' + ageWords(r[AG]) + ' with no token, so a longer window counts in more snapshots.', 'the $' + fmtInt(ticket) + ' stays in the position', f.days + ' days'),
    stepText('Before you withdraw, open ' + r[NM] + '\'s own points or rewards page and claim only from the link it publishes; never pay to claim.', 'no fee to check', '10 minutes'),
    stepText('Log the wallet, dates and every transaction so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes')
  ];
};

var st = { tab: 'board', q: '', cat: '', chain: '', list: '', verdict: '', ticket: 1000, share: 0.1, hurdle: 0.05, sort: 'rank', dir: 1, sel: -1 };
var rows = R.r;
var bySlug = {};
rows.forEach(function (r) { bySlug[r[SL]] = r; });

var parity = (function () {
  var wl = rows.filter(function (r) { return r[WL] === 1; }).length;
  var sum = rows.reduce(function (n, r) { return n + r[IM]; }, 0);
  var ledger = R.l.reduce(function (n, e) { return n + e[1]; }, 0);
  var ok = wl === R.w && sum === R.ck && ledger === R.n && rows.length === R.r.length;
  return { wl: wl, sum: sum, ledger: ledger, ok: ok };
})();
$('parity').innerHTML = '<b class="' + (parity.wl === R.w ? '' : 'bad') + '">' + parity.wl + '/' + R.w + ' watchlist</b>' +
  '<b class="' + (parity.sum === R.ck ? '' : 'bad') + '">' + rows.length + '/' + rows.length + ' rows = board.json</b>' +
  '<b class="' + (parity.ledger === R.n ? '' : 'bad') + '">' + parity.ledger + '/' + R.n + ' accounted</b>';
$('asof').textContent = R.a;
$('footAsOf').textContent = R.a;
$('nBoard').textContent = '(' + rows.length + ')';
$('nLive').textContent = '(' + (R.l[1][1] + R.l[2][1]) + ')';
$('nAside').textContent = '(' + R.sa.length + ')';
// Expand the compact rows: names from slugs where stored null, money from $10K (TVL) / $100 (implied) units to dollars.
rows.forEach(function (r) { r[NM] = r[NM] || slugName(r[SL]); r[TV] *= 10000; r[IM] *= 100; });
R.lv.forEach(function (e) { e[1] = e[1] || slugName(e[0]); e[3] *= 100; e[4] *= 100; });

var COLORS = ['#3fb950', '#58a6ff', '#79c0ff', '#d29922', '#bc8cff', '#f778ba', '#8b98a9', '#6e7681', '#e3b341', '#30363d'];
$('ledgerBar').innerHTML = R.l.map(function (e, i) {
  return '<i style="width:' + (e[1] / R.n * 100).toFixed(2) + '%;background:' + COLORS[i] + '" title="' + esc(e[0]) + ': ' + e[1] + '"></i>';
}).join('');
$('ledgerList').innerHTML = R.l.map(function (e, i) {
  return '<li><span><span class="sw" style="background:' + COLORS[i] + '"></span>' + esc(e[0]) + '</span><b>' + e[1] + '</b></li>';
}).join('');

(function () {
  var b = R.m.b, names = ['const', 'logTVL', 'mom7d', 'logAge', 'logChains'].concat(R.m.s);
  var terms = names.map(function (n, i) {
    var v = b[i];
    if (i === 0) return v.toFixed(3);
    var sign = v >= 0 ? ' + ' : ' − ';
    return sign + Math.abs(v).toFixed(3) + '·<span class="k">' + esc(n) + '</span>';
  }).join('');
  $('equation').innerHTML = 'log<sub>10</sub>(FDV) = ' + terms + '<br><span class="mut">Implied value = token share × FDV.</span>';
  var v = R.v;
  $('validation').innerHTML =
    '<b>Leave-one-out median miss ×' + v.loo + '</b> (' + Math.round(v.loo2 * 100) + '% within 2×, ' + Math.round(v.loo3 * 100) + '% within 3×) vs flat ×' + v.flat + ' and power law ×' + v.pow + '. ' +
    'Date-ordered holdout ×' + v.ho + ' vs flat ×' + v.hof + ' (n=' + v.hon + '). ' +
    'P25–P75 covers ' + Math.round(v.c25 * 100) + '%, P10–P90 ' + Math.round(v.c90 * 100) + '% of out-of-fold residuals. ' +
    v.ntvl + '/' + rows.length + ' rows sit 5+ ranks off TVL order. ' +
    'Implied value is a heuristic prevalence-weighted score, not a forecast; validation covers Stage A only.';
  var labels = ['<6mo', '6–12mo', '1–2y', '2–3y', '3y+'];
  $('oddsTable').innerHTML = 'Token share by age: ' + R.o.map(function (o, i) { return '<span style="white-space:nowrap">' + labels[i] + ' <b>' + o[1] + '</b></span>'; }).join(' · ') + ' · <span style="white-space:nowrap">unknown <b>' + R.ov + '</b></span>';
})();

(function () {
  var W = 430, H = 205, L = 44, Bm = 26, T = 8, Rt = 8;
  var xs = R.s.map(function (p) { return p[0]; }).concat(rows.map(function (r) { return Math.log10(r[TV]); }));
  var ys = R.s.map(function (p) { return p[1]; }).concat(rows.map(function (r) { return Math.log10(r[IM]); }));
  var x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
  var y0 = Math.floor(Math.min.apply(null, ys)), y1 = Math.ceil(Math.max.apply(null, ys));
  var X = function (x) { return L + (x - x0) / (x1 - x0) * (W - L - Rt); };
  var Y = function (y) { return H - Bm - (y - y0) / (y1 - y0) * (H - T - Bm); };
  var fmtTick = function (e) { return e >= 9 ? '$1B' : e >= 8 ? '$100M' : e >= 7 ? '$10M' : e >= 6 ? '$1M' : '$100K'; };
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of TVL against value, log-log">';
  for (var gx = x0; gx <= x1; gx++) s += '<line x1="' + X(gx) + '" y1="' + T + '" x2="' + X(gx) + '" y2="' + (H - Bm) + '" stroke="#212b38"/><text x="' + X(gx) + '" y="' + (H - 8) + '" fill="#8b98a9" font-size="9" text-anchor="middle">' + fmtTick(gx) + '</text>';
  for (var gy = y0; gy <= y1; gy++) s += '<line x1="' + L + '" y1="' + Y(gy) + '" x2="' + (W - Rt) + '" y2="' + Y(gy) + '" stroke="#212b38"/><text x="' + (L - 4) + '" y="' + (Y(gy) + 3) + '" fill="#8b98a9" font-size="9" text-anchor="end">' + fmtTick(gy) + '</text>';
  var ln = R.ln, q25 = R.v.q25, q75 = R.v.q75;
  s += '<polygon points="' + X(ln[0][0]) + ',' + Y(ln[0][1] + q75) + ' ' + X(ln[1][0]) + ',' + Y(ln[1][1] + q75) + ' ' + X(ln[1][0]) + ',' + Y(ln[1][1] + q25) + ' ' + X(ln[0][0]) + ',' + Y(ln[0][1] + q25) + '" fill="#3fb950" opacity="0.12"/>';
  s += '<line x1="' + X(ln[0][0]) + '" y1="' + Y(ln[0][1]) + '" x2="' + X(ln[1][0]) + '" y2="' + Y(ln[1][1]) + '" stroke="#3fb950" stroke-width="1.5"/>';
  R.s.forEach(function (p) { s += '<circle cx="' + X(p[0]).toFixed(1) + '" cy="' + Y(p[1]).toFixed(1) + '" r="2.2" fill="#8b98a9" opacity="0.75"/>'; });
  rows.forEach(function (r) { s += '<circle cx="' + X(Math.log10(r[TV])).toFixed(1) + '" cy="' + Y(Math.log10(r[IM])).toFixed(1) + '" r="2.2" fill="#3fb950"/>'; });
  s += '</svg>';
  $('scatter').innerHTML = s;
})();

(function () {
  var cats = R.cats.slice().sort();
  $('cat').innerHTML = '<option value="">All categories</option>' + cats.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
  var chs = R.chs.slice().sort();
  $('chain').innerHTML = '<option value="">All chains</option>' + chs.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
  var seg = function (id, opts, cur, fn) {
    $(id).innerHTML = opts.map(function (o) { return '<button type="button" data-v="' + o[0] + '" class="' + (o[0] === cur ? 'on' : '') + '">' + o[1] + '</button>'; }).join('');
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      fn(b.getAttribute('data-v'));
      Array.prototype.forEach.call($(id).children, function (x) { x.classList.toggle('on', x === b); });
      render();
    });
  };
  seg('ticket', [[1000, '$1K'], [5000, '$5K'], [10000, '$10K']], 1000, function (v) { st.ticket = +v; });
  seg('share', [[0.05, '5%'], [0.1, '10%'], [0.2, '20%']], 0.1, function (v) { st.share = +v; });
  seg('hurdle', [[0, '0%'], [0.05, '5%']], 0.05, function (v) { st.hurdle = +v; });
  $('q').addEventListener('input', function () { st.q = $('q').value.trim().toLowerCase(); st.sel = -1; render(); });
  $('cat').addEventListener('change', function () { st.cat = $('cat').value; st.sel = -1; render(); });
  $('chain').addEventListener('change', function () { st.chain = $('chain').value; st.sel = -1; render(); });
  $('list').addEventListener('change', function () { st.list = $('list').value; st.sel = -1; render(); });
  $('csv').addEventListener('click', exportCsv);
  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      st.tab = b.getAttribute('data-tab');
      document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      ['board', 'live', 'aside', 'method'].forEach(function (t) { $('view-' + t).hidden = t !== st.tab; });
      closeDetail();
    });
  });
  document.querySelectorAll('#board thead th').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (st.sort === k) st.dir = -st.dir; else { st.sort = k; st.dir = k === 'name' ? 1 : -1; if (k === 'rank') st.dir = 1; }
      document.querySelectorAll('#board thead th').forEach(function (x) { x.classList.toggle('on', x === th); x.classList.toggle('asc', x === th && st.dir === 1); });
      render();
    });
  });
})();

function filtered() {
  return rows.filter(function (r) {
    if (st.q && r[NM].toLowerCase().indexOf(st.q) < 0 && r[SL].indexOf(st.q) < 0) return false;
    if (st.cat && R.cats[r[CT]] !== st.cat) return false;
    if (st.chain && r[CH].map(function (i) { return R.chs[i]; }).indexOf(st.chain) < 0) return false;
    if (st.list === 'wl' && r[WL] !== 1) return false;
    if (st.verdict && farmOf(r, st.ticket, st.share, st.hurdle).verdict !== st.verdict) return false;
    return true;
  });
}

function sorted(list) {
  var key = function (r) {
    switch (st.sort) {
      case 'rank': return r[RK];
      case 'name': return r[NM].toLowerCase();
      case 'tvl': return r[TV];
      case 'chg': return r[CG] === null ? -1e9 : r[CG];
      case 'age': return r[AG] === null ? -1e9 : r[AG];
      case 'impl': return r[IM];
      case 'net': return farmOf(r, st.ticket, st.share, st.hurdle).net;
      case 'verdict': return { FARM: 0, THIN: 1, SKIP: 2 }[farmOf(r, st.ticket, st.share, st.hurdle).verdict];
    }
    return r[RK];
  };
  return list.slice().sort(function (a, b) {
    var ka = key(a), kb = key(b);
    var c = typeof ka === 'string' ? (ka < kb ? -1 : ka > kb ? 1 : 0) : ka - kb;
    return (c === 0 ? a[RK] - b[RK] : c) * st.dir;
  });
}

function render() {
  var list = sorted(filtered());
  // Verdict pills with counts at the current What-if settings.
  var counts = { FARM: 0, THIN: 0, SKIP: 0 };
  rows.forEach(function (r) { counts[farmOf(r, st.ticket, st.share, st.hurdle).verdict]++; });
  $('verdicts').innerHTML = [['', 'All (' + rows.length + ')'], ['FARM', 'FARM ' + counts.FARM], ['THIN', 'THIN ' + counts.THIN], ['SKIP', 'SKIP ' + counts.SKIP]].map(function (p) {
    return '<button type="button" data-v="' + p[0] + '" class="' + (st.verdict === p[0] ? 'on' : '') + '">' + p[1] + '</button>';
  }).join('');
  $('verdicts').querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () { st.verdict = b.getAttribute('data-v'); st.sel = -1; render(); });
  });
  // Best farms at the current settings, by net per hour.
  var farms = rows.map(function (r) { return { r: r, f: farmOf(r, st.ticket, st.share, st.hurdle) }; })
    .filter(function (x) { return x.f.verdict === 'FARM'; })
    .sort(function (a, b) { return (b.f.net / b.f.hours) - (a.f.net / a.f.hours); }).slice(0, 2);
  var total = list.reduce(function (n, r) { return n + r[IM]; }, 0);
  $('bestFarms').innerHTML = '<span>Best:</span> ' + (farms.length ? farms.map(function (x) {
    return '<span class="farm" data-slug="' + esc(x.r[SL]) + '">#' + x.r[RK] + ' ' + esc(x.r[NM]) + ' <b>+$' + fmtInt(x.f.net / x.f.hours) + '/h</b></span>';
  }).join(' · ') : '<span>none clears the hurdle at these settings</span>');
  $('bestCount').innerHTML = '<b>' + list.length + '</b>/' + rows.length + ' · <b>' + money(total) + '</b> total';
  $('bestFarms').querySelectorAll('.farm').forEach(function (el) {
    el.addEventListener('click', function () { openDetail(bySlug[el.getAttribute('data-slug')]); });
  });
  // The table.
  $('empty').hidden = list.length > 0;
  $('rows').innerHTML = list.map(function (r, i) {
    var f = farmOf(r, st.ticket, st.share, st.hurdle);
    var chains = r[CH].map(function (ci) { return R.chs[ci]; });
    var rel = r[CG] === null ? null : r[CG] - R.m.medg;
    var need = f.slice > 0 ? (f.fees + f.hours * 75 + st.hurdle * st.ticket) / f.slice : 0;
    return '<tr data-slug="' + esc(r[SL]) + '" class="' + (st.sel === i ? 'sel' : '') + '">' +
      '<td class="num"><b>#' + r[RK] + '</b><span class="sub2">range ' + r[RL] + '–' + r[RH] + '</span></td>' +
      '<td><b>' + esc(r[NM]) + '</b>' + (r[WL] ? '<span class="wl">WATCHLIST</span>' : '') + '<span class="sub2">' + esc(R.cats[r[CT]]) + ' · ' + esc(chains.slice(0, 2).join(', ')) + (chains.length > 2 ? ' +' + (chains.length - 2) : '') + '</span></td>' +
      '<td class="num">' + money(r[TV]) + '</td>' +
      '<td class="num ' + (r[CG] === null ? '' : r[CG] >= 0 ? 'up' : 'dn') + '">' + chgStr(r[CG]) + '<span class="sub2">' + (rel === null ? 'mkt —' : 'mkt ' + (rel >= 0 ? '+' : '') + rel.toFixed(1) + 'pp') + '</span></td>' +
      '<td class="num">' + ageStr(r[AG]) + '<span class="sub2">' + (r[OD] < 0 ? 'unknown age' : ['<6mo', '6–12mo', '1–2y', '2–3y', '3y+'][r[OD]] + ' bucket') + '</span></td>' +
      '<td class="num"><b>' + money(r[IM]) + '</b><span class="sub2">' + money(bandOf(r, R.v.q25)) + '–' + money(bandOf(r, R.v.q75)) + ' P25–P75</span></td>' +
      '<td>' + esc(f.label) + '<span class="sub2">' + esc(f.chain) + ' · $' + (f.fees % 1 === 0 ? f.fees : f.fees.toFixed(2)) + ' · ' + f.hours + 'h · ' + f.days + 'd</span></td>' +
      '<td class="num ' + (f.net >= 0 ? 'up' : 'dn') + '"><b>' + (f.net >= 0 ? '+' : '−') + '$' + fmtInt(Math.abs(f.net)) + '</b> <span class="badge ' + f.verdict + '">' + f.verdict + '</span><span class="sub2">' +
      (f.verdict === 'SKIP' ? 'needs ×' + need.toFixed(1) + ' to FARM' : '+$' + fmtInt(f.net / f.hours) + '/h') + '</span></td></tr>';
  }).join('');
  $('rows').querySelectorAll('tr').forEach(function (tr) {
    tr.addEventListener('click', function () { openDetail(bySlug[tr.getAttribute('data-slug')]); });
  });
  st.list = list;
}

function openDetail(r) {
  var f = farmOf(r, st.ticket, st.share, st.hurdle);
  var fdv = fdvOf(r), odds = oddsOf(r);
  var chains = r[CH].map(function (ci) { return R.chs[ci]; });
  var bucket = r[OD] < 0 ? 'unknown age' : ['<6mo', '6–12mo', '1–2y', '2–3y', '3y+'][r[OD]];
  // The row's own feature values, plugged into the fitted equation.
  var b = R.m.b;
  var chg = r[CG] === null ? R.m.medg : Math.min(Math.max(r[CG], R.m.glo), R.m.ghi);
  var mom = (chg - R.m.medg) / 100;
  var logTvl = Math.log10(r[TV]), logAge = Math.log10(r[AG] === null || r[AG] <= 0 ? R.m.meda : r[AG]);
  var logCh = Math.log10(Math.max(r[CH].length, 1));
  var secIdx = R.m.s.indexOf(R.cats[r[CT]]);
  var terms = [[b[0], 'intercept'], [b[1] * logTvl, 'log10(TVL ' + money(r[TV]) + ')'], [b[2] * mom, 'momentum ' + mom.toFixed(2)], [b[3] * logAge, 'age ' + ageStr(r[AG])], [b[4] * logCh, chains.length + ' chain' + (chains.length === 1 ? '' : 's')]];
  if (secIdx >= 0) terms.push([b[5 + secIdx], 'sector ' + R.cats[r[CT]]]);
  var logSum = terms.reduce(function (n, t) { return n + t[0]; }, 0);
  var steps = farmSteps(r, st.ticket);
  $('detail').innerHTML =
    '<button type="button" class="close" aria-label="Close">✕</button>' +
    '<h2>#' + r[RK] + ' ' + esc(r[NM]) + (r[WL] ? ' <span class="wl">WATCHLIST</span>' : '') + '</h2>' +
    '<p class="mut">' + esc(r[SL]) + ' · ' + esc(R.cats[r[CT]]) + ' · ' + esc(chains.join(', ')) + '</p>' +
    '<h3>Snapshot inputs (sealed ' + R.a + ')</h3><dl class="kv">' +
    '<dt>TVL</dt><dd>' + money(r[TV]) + '</dd><dt>7d change</dt><dd>' + chgStr(r[CG]) + ' (market median ' + R.m.medg + '%)</dd>' +
    '<dt>No-token age</dt><dd>' + (r[AG] === null ? 'unknown' : r[AG] + ' days') + ' · ' + bucket + ' bucket</dd>' +
    '<dt>Chains</dt><dd>' + chains.length + '</dd><dt>Watchlist</dt><dd>' + (r[WL] ? 'yes — in the snapshot\'s 40' : 'no — not in the snapshot\'s 40') + '</dd></dl>' +
    '<h3>How the number was made</h3><div class="math">' +
    'log<sub>10</sub>(FDV) = ' + terms.map(function (t, i) { return (i === 0 ? '' : t[0] < 0 ? '− ' : '+ ') + Math.abs(t[0]).toFixed(3) + ' <span class="mut">(' + esc(t[1]) + ')</span>'; }).join(' ') + '<br>' +
    '= <b>' + logSum.toFixed(3) + '</b> → FDV ≈ <b>' + money(fdv) + '</b><br>' +
    'Token share = <b>' + odds + '</b> (' + bucket + (r[OD] < 0 ? ', overall share' : ', n=' + R.o[r[OD]][0]) + ')<br>' +
    'Implied value = <b>' + money(r[IM]) + '</b> · P25–P75 ' + money(bandOf(r, R.v.q25)) + '–' + money(bandOf(r, R.v.q75)) +
    ' · P10–P90 ' + money(bandOf(r, R.v.q10)) + '–' + money(bandOf(r, R.v.q90)) + '<br>' +
    'Bootstrap rank range (200 refits): <b>#' + r[RL] + '–#' + r[RH] + '</b></div>' +
    '<h3>Farm plan — ticket $' + fmtInt(st.ticket) + ', ' + Math.round(st.share * 100) + '% farmer share</h3>' +
    '<dl class="kv"><dt>Action</dt><dd>' + esc(f.label) + ' on ' + esc(f.chain) + '</dd>' +
    '<dt>Expected slice</dt><dd>' + money(f.slice) + '<br><span class="mut">' + money(r[IM]) + ' × ' + Math.round(st.share * 100) + '% share × $' + fmtInt(st.ticket) + ' ÷ ' + money(0.2 * r[TV]) + ' pool (20% of TVL)</span></dd>' +
    '<dt>Gas</dt><dd>$' + f.fees.toFixed(2) + '</dd><dt>Time</dt><dd>' + f.hours + 'h × $75 = $' + fmtInt(f.hours * 75) + '</dd>' +
    '<dt>Hold</dt><dd>' + f.days + ' days</dd><dt>Net</dt><dd><b>' + (f.net >= 0 ? '+' : '−') + '$' + fmtInt(Math.abs(f.net)) + '</b> <span class="badge ' + f.verdict + '">' + f.verdict + '</span></dd></dl>' +
    '<p class="mut">Assumptions, not snapshot facts: the farm pool is 20% of TVL, the farmer share is ' + Math.round(st.share * 100) + '% of implied value, time is $75/h, gas is the ' + esc(f.chain) + ' estimate. Change the ticket, share or hurdle above and this plan recomputes.</p>' +
    '<ol class="steps">' + steps.map(function (s) {
      var m = s.match(/^(.*?) Cost: (.*?)\. Time: (.*?)\.$/);
      return m ? '<li>' + esc(m[1]) + '<br><span class="c">Cost: ' + esc(m[2]) + ' · Time: ' + esc(m[3]) + '</span></li>' : '<li>' + esc(s) + '</li>';
    }).join('') + '</ol>';
  $('detail').hidden = false;
  $('detail').querySelector('.close').addEventListener('click', closeDetail);
}

function closeDetail() { $('detail').hidden = true; }

$('liveRows').innerHTML = R.lv.map(function (e) {
  return '<tr><td><b>' + esc(e[1]) + '</b><span class="sub2">' + esc(R.cats[e[2]]) + '</span></td>' +
    '<td class="num">' + money(e[3]) + '</td><td class="num">' + money(e[4]) + '</td>' +
    '<td class="num">' + (e[4] / e[3]).toFixed(2) + '×</td>' +
    '<td class="num ' + (e[5] === null ? '' : e[5] >= 0 ? 'up' : 'dn') + '">' + chgStr(e[5]) + '</td></tr>';
}).join('');
$('asideRows').innerHTML = R.sa.map(function (e) {
  return '<tr><td><b>' + esc(slugName(e[0])) + '</b><span class="sub2">' + esc(e[0]) + '</span></td>' +
    '<td>' + esc(R.cats[e[1]]) + '</td><td>' + esc(R.rs[e[2]]) + '</td></tr>';
}).join('');

(function () {
  var v = R.v, b = R.m.b;
  var ab = v.ab.map(function (a) { return '<tr><td>Drop ' + esc(a[0]) + '</td><td class="num">×' + a[1] + '</td><td class="num">' + (a[1] > v.loo ? '+' : '') + (a[1] - v.loo).toFixed(2) + '</td></tr>'; }).join('');
  var rules = ['no token, no set-aside rule', 'has a market cap; never ranked', 'ticker or CoinGecko id, no market cap', 'category Bridge or Canonical Bridge', 'Liquid Staking / Restaking / Restaked BTC', 'CEX, or an exchange name first', 'name ends in a version marker', 'name has wrapped, staked or staking', 'name stem matches a token protocol', 'unclassified (none here)'];
  var ledgerRows = R.l.map(function (e, i) { return '<tr><td>' + esc(e[0]) + '</td><td class="num">' + e[1] + '</td><td>' + rules[i] + '</td></tr>'; }).join('');
  $('methodText').innerHTML =
    '<h2>What this ranks</h2>' +
    '<p>Every protocol in the sealed snapshot (' + R.a + ', ' + R.n + ' protocols at TVL ≥ $5M) that records <b>no token</b> — no CoinGecko id, no symbol, no market cap — and that no stated rule sets aside. That is <b>' + rows.length + ' protocols</b>, including all <b>' + R.w + '</b> watchlist slugs. Each is ranked by its <b>implied value</b>: the fitted launch FDV times the share of same-age protocols that have a token — a heuristic prevalence-weighted score, not a forecast.</p>' +
    '<h2>Stage A — launch FDV, fitted on traded comps</h2>' +
    '<p>A ridge-shrunk log–log regression, log<sub>10</sub>(market cap) on log<sub>10</sub>(TVL) plus relative 7d momentum, log<sub>10</sub>(age), log<sub>10</sub>(chain count) and sector dummies, fitted on <b>' + R.m.n + ' of ' + R.l[1][1] + ' traded comps</b> (CoinGecko id, positive market cap, a listing date; CEX tokens excluded — they price exchange equity, not protocol TVL). The ridge (λ=' + R.m.lam + ', picked by leave-one-out) shrinks every coefficient except the intercept and the size curve. 7d change is winsorized to the comps’ 5th–95th percentiles [' + R.m.glo + '%, ' + R.m.ghi + '%] and measured <b>relative</b> to the median comp (' + R.m.medg + '%); no listing date means the median comp age (' + R.m.meda + 'd). Only categories with ≥8 comps earn a dummy: ' + R.m.s.join(', ') + '.</p>' +
    '<p>Fitted: log<sub>10</sub>(FDV) = ' + b[0].toFixed(3) + ' + ' + b[1].toFixed(3) + '·logTVL + ' + b[2].toFixed(3) + '·mom7d ' + (b[3] < 0 ? '−' : '+') + ' ' + Math.abs(b[3]).toFixed(3) + '·logAge ' + (b[4] < 0 ? '−' : '+') + ' ' + Math.abs(b[4]).toFixed(3) + '·logChains' + R.m.s.map(function (s, i) { return ' ' + (b[5 + i] < 0 ? '−' : '+') + ' ' + Math.abs(b[5 + i]).toFixed(3) + '·' + s; }).join('') + '.</p>' +
    '<p class="note">The momentum coefficient is near zero (' + b[2].toFixed(3) + ') — in a week the median comp fell ' + Math.abs(R.m.medg) + '%, 7d momentum carries no measurable signal. It stays in the model with its honest weight rather than being dropped to flatter the story.</p>' +
    '<h2>Stage B — token share by age, from the snapshot’s own cross-section</h2>' +
    '<p>The share of protocols that record a token, by age bucket (see the board view). Token share rises with age in this cross-section — older protocols have had longer to launch — a property of the snapshot, stated plainly, not a claim about any one protocol’s future. It is a descriptive base rate, not a validated forecast: the validation numbers below cover Stage A only.</p>' +
    '<h2>Validation — what the model gets wrong, measured</h2>' +
    '<p><b>Leave-one-out</b> (each refit reruns the whole pipeline: winsor bounds, median age, sector pooling, ridge fit): median miss <b>×' + v.loo + '</b>, ' + Math.round(v.loo2 * 100) + '% within 2×, ' + Math.round(v.loo3 * 100) + '% within 3×. Same folds: flat median multiple ×' + v.flat + ' (' + Math.round(v.flat3 * 100) + '% within 3×), TVL-only power law ×' + v.pow + ' (' + Math.round(v.pow3 * 100) + '% within 3×). <b>Date-ordered holdout</b> (fit on the older-listed half, test on the newer): ×' + v.ho + ' vs flat ×' + v.hof + ' (n=' + v.hon + '). Called a holdout, not a walk-forward: one sealed snapshot has no historical outcomes.</p>' +
    '<p><b>Bands</b> come from the out-of-fold residuals: P25–P75 covers ' + Math.round(v.c25 * 100) + '%, P10–P90 covers ' + Math.round(v.c90 * 100) + '%. <b>Rank ranges</b> come from 200 bootstrap refits (comps resampled with replacement, the board re-ranked each time). <b>' + v.ntvl + '</b> of ' + rows.length + ' rows sit 5+ ranks off pure TVL order — a model ranking, not a TVL sort.</p>' +
    '<h3>Ablation — drop one feature group, re-run leave-one-out</h3>' +
    '<table><thead><tr><th>Change</th><th class="num">LOO miss</th><th class="num">Δ vs full ×' + v.loo + '</th></tr></thead><tbody><tr><td>Full model</td><td class="num">×' + v.loo + '</td><td class="num">—</td></tr>' + ab + '</tbody></table>' +
    '<p>Dropping chain count moves LOO from ×' + v.loo + ' to ×' + v.ab[3][1] + ' — within noise on ' + R.m.n + ' comps. The feature is kept and the ablation shown rather than hidden; dropping it post-hoc would be overfitting to the validation set.</p>' +
    '<h2>Farm economics — assumptions, labelled as such</h2>' +
    '<p>Expected slice = implied value × farmer share × ticket / (farm pool), farm pool assumed at <b>20% of TVL</b>. Net = slice − gas − hours × <b>$75/h</b>. Gas by first chain (Ethereum $18, Bittensor $12, Bitcoin $10, Tron $6, Solana $1.40, Binance $1.60, Arbitrum/Base/Optimism $2.40, Polygon $2, Avalanche $3.20, other $5 — four transactions). Hours by action (trade 3h, LP 2.5h, lend/deposit/predict 2h, stake/vault/mint/cover 1.5h). Hold by age: &lt;180d → 90d, &lt;1y → 60d, else 30d. <b>FARM</b> needs net ≥ 5% of the ticket, <b>THIN</b> net &gt; 0, else <b>SKIP</b>. The What-if toggles recompute every verdict, slice and net. At the defaults ($1,000 / 10% / 5%) few rows are FARM — most farms do not pay at these assumptions, and the page says so.</p>' +
    '<h2>The ledger — all ' + R.n + ' protocols</h2>' +
    '<table><thead><tr><th>Status</th><th class="num">Count</th><th>Rule</th></tr></thead><tbody>' + ledgerRows + '</tbody></table>' +
    '<p>Priority order, first match wins. Watchlist slugs are never set aside as kin. The kin rule uses first-word name stems from the snapshot itself, never a hand-written list.</p>' +
    '<h2>Limits</h2>' +
    '<p>One sealed snapshot, no history: the model cannot know which protocols are <i>about</i> to launch, only which resemble ones that did. The token-share table is a cross-section, not a hazard rate. Estimates are wide (median miss ×' + v.loo + ') — read the bands, not the point. Real airdrops vary wildly. Nothing here is financial advice.</p>';
})();

function exportCsv() {
  var list = st.list || sorted(filtered());
  var head = 'rank,slug,name,category,chains,tvl_usd,chg_7d,age_days,implied_value_usd,fdv_usd,token_share,p25_usd,p75_usd,rank_lo,rank_hi,farm_action,farm_chain,fees_usd,hours,days,slice_usd,net_usd,verdict';
  var lines = list.map(function (r) {
    var f = farmOf(r, st.ticket, st.share, st.hurdle);
    var q = function (s) { return '"' + String(s).replace(/"/g, '""') + '"'; };
    return [r[RK], r[SL], q(r[NM]), q(R.cats[r[CT]]), q(r[CH].map(function (i) { return R.chs[i]; }).join(';')), r[TV], r[CG] === null ? '' : r[CG], r[AG] === null ? '' : r[AG], r[IM], Math.round(fdvOf(r)), oddsOf(r), Math.round(bandOf(r, R.v.q25)), Math.round(bandOf(r, R.v.q75)), r[RL], r[RH], q(f.label), q(f.chain), f.fees, f.hours, f.days, f.slice.toFixed(2), f.net.toFixed(2), f.verdict].join(',');
  });
  var blob = new Blob([head + '\n' + lines.join('\n') + '\n'], { type: 'text/csv' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'token-radar-' + R.a + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

document.addEventListener('keydown', function (e) {
  var typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === 'Escape') { if (!$('detail').hidden) closeDetail(); else if (typing) { document.activeElement.blur(); } return; }
  if (e.key === '/' && !typing) { e.preventDefault(); $('q').focus(); return; }
  if (typing || st.tab !== 'board') return;
  var list = st.list || [];
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    st.sel = Math.max(0, Math.min(list.length - 1, st.sel + (e.key === 'j' ? 1 : -1)));
    render();
    var tr = $('rows').querySelectorAll('tr')[st.sel];
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && st.sel >= 0 && list[st.sel]) {
    openDetail(list[st.sel]);
  }
});

render();
})();
