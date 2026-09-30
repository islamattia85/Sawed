/**
 * V7 — the presentation layer.
 *
 * Everything the app knows is computed by the engine and the main module:
 * 8,760-hour simulations, the ranked catalogue, announced price changes, the
 * solar scenarios. None of that moves. What this module replaces is how it is
 * shown — three surfaces that each answer one question with a picture first,
 * and sheets that open over the surface instead of sending the reader
 * somewhere else.
 *
 * The module owns no state and computes no money. It receives an API object
 * from main.js and only ever reads from it, so every figure on a V7 screen is
 * the same figure the engine tests already hold.
 */
import {
  savingsLadder, rateStrip, scoreRing, monthBars, paybackCurve, eur,
} from './charts.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsq = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
/** A string safe inside a single-quoted JS literal inside a double-quoted attribute. */
const jsAttr = (s) => esc(jsq(s));

/** Which surface a screen belongs to, so the right tab stays lit. */
export const V7_SURFACES = [
  { id: 'result', icon: 'home', label: 'Home', screens: ['result'] },
  { id: 'plans', icon: 'plans', label: 'Plans', screens: ['plans', 'plan-detail', 'compare'] },
  { id: 'solar', icon: 'sun', label: 'Solar', screens: ['solar', 'analytics', 'monitor'] },
  { id: 'more', icon: 'grid', label: 'More',
    screens: ['more', 'refine', 'csv-import', 'auditor', 'quotes', 'methodology', 'independence', 'how-to-switch'] },
];

export function createV7(api) {
  const S = () => api.state();

  /* ------------------------------------------------------------ chrome */

  function topbar(title, { back = false } = {}) {
    const root = V7_SURFACES.some((x) => x.id === S().current_screen);
    if (root) back = false;
    return `<header class="topbar v7-top" role="banner">
      <h1 class="sr-only">${esc(title || 'Solar Optimiser')}</h1>
      ${back
        ? `<button class="icb" onclick="goBack()" aria-label="Back">${api.ic('chevL', 20)}</button>`
        : `<button class="v7-brand" onclick="setScreen('result')" aria-label="Home">
            <span class="v7-brand-mark">${api.ic('sun', 15, 'stroke-width:2')}</span>
          </button>`}
      <div class="v7-top-title">${esc(title || '')}</div>
      <div class="v7-top-end">${api.renderProfileNavBtn()}</div>
    </header>`;
  }

  function nav() {
    const cur = S().current_screen;
    const active = (V7_SURFACES.find((s) => s.screens.includes(cur)) || {}).id;
    return `<nav class="bottom-nav v7-nav" role="navigation" aria-label="Sections">
      ${V7_SURFACES.map((s) => `
        <button class="bottom-nav-item v7-nav-item ${active === s.id ? 'active' : ''}"
          onclick="setScreen('${s.id}')" aria-current="${active === s.id ? 'page' : 'false'}">
          <span class="nav-ico">${api.ic(s.icon, 22)}</span>
          <span class="nav-label">${s.label}</span>
        </button>`).join('')}
    </nav>`;
  }

  /** The home's own inputs, as one tappable line. Opens the assumptions sheet. */
  function homeChips({ withSolar = true } = {}) {
    const st = S();
    const region = api.IRISH_REGIONS[st.region || 'east'];
    const kwh = api.annualKwh();
    const chips = [
      `${Math.round(kwh).toLocaleString('en-IE')} kWh`,
      `${esc(st.heating_type || 'gas')} heating`,
      region ? esc(region.name) : '',
      // Where the solar switch sits beside the chips, it already names the
      // system, so the chips leave it out rather than say it twice.
      withSolar ? (st.has_solar ? `${api.totalKwp().toFixed(1)} kWp${st.solar_planned ? ' planned' : ''}` : 'no solar') : '',
      withSolar && st.battery_kwh > 0 ? `${st.battery_kwh} kWh battery` : '',
      st.ev_active ? 'EV' : '',
    ].filter(Boolean);
    return `<button class="v7-home-chips" onclick="v7Sheet('assume')" aria-label="Your home — change">
      ${chips.map((c) => `<span class="v7-chip">${c}</span>`).join('')}
      <span class="v7-chip v7-chip-edit">${api.ic('tune', 14)} Edit</span>
    </button>`;
  }

  /**
   * The solar switch. Lives beside the inputs it changes — under the answer on
   * Home, and at the top of Solar — so leaving solar out never means a trip
   * back through setup.
   */
  function solarSwitch() {
    const on = !!S().has_solar;
    return `<button class="v7-switch-row" role="switch" aria-checked="${on}" onclick="toggleSolarModel()">
      <span class="v7-switch-ico">${api.ic('sun', 18)}</span>
      <span class="v7-switch-text"><b>Include solar</b><small>${on
        ? `${api.totalPanels()} panels · ${api.totalKwp().toFixed(1)} kWp${S().battery_kwh > 0 ? ` · ${S().battery_kwh} kWh battery` : ''}`
        : 'Left out — your system is kept'}</small></span>
      <span class="v7-switch ${on ? 'on' : ''}" aria-hidden="true"><i></i></span>
    </button>`;
  }

  /* ------------------------------------------------------------- HOME */

  /**
   * The three rungs of the answer.
   *
   * A single "you could save" figure merged two decisions of very different
   * size: switching supplier is free and takes ten minutes, solar is a
   * five-figure purchase. The ladder separates them using the scenario runs
   * the engine already makes — the best plan for the same home without panels,
   * then with them — so the reader can see which part of the saving comes from
   * which decision before acting on either.
   */
  function ladderData(rec) {
    const st = S();
    const today = rec.baseCost;
    const best = rec.best;
    // Switching is measured on the home as it is — with its solar — because
    // that is the home the switch happens to. Solar is the step before it.
    // Measured the other way round, a plan's export rate was being counted as
    // the panels' earnings, and the panels' earnings as the switch's.
    const withSolar = st.has_solar && api.totalPanels() > 0;
    if (!withSolar) {
      return {
        rungs: [
          { label: 'Your bill today', value: today, token: '--ink-dim' },
          { label: `On ${best.plan.supplier}`, value: best.net, token: '--accent' },
        ],
        fromSwitch: today - best.net, fromSolar: 0,
      };
    }
    const mineWithSolar = api.sameHomeCost(st.baseline);
    const solarWord = st.solar_planned ? 'the planned solar' : 'your solar';
    return {
      rungs: [
        { label: 'Your plan, without solar', value: today, token: '--ink-dim' },
        { label: `Your plan, with ${solarWord}`, value: mineWithSolar, token: '--v7-mid' },
        { label: `On ${best.plan.supplier}, with ${solarWord}`, value: best.net, token: '--accent' },
      ],
      fromSolar: today - mineWithSolar,
      fromSwitch: mineWithSolar - best.net,
    };
  }

  function home() {
    const rec = api.getRecommendation();
    const best = rec.best;
    if (!best || best._noPlan || !best.plan) return api.renderResultEmpty();
    const st = S();
    const saving = rec.annualSavings;
    const chosen = st.chosen_plan === best.plan.id;
    const { rungs, fromSwitch, fromSolar } = ladderData(rec);
    const switchName = jsAttr(`${best.plan.supplier} ${best.plan.plan}`);
    const split = fromSolar > 1
      ? `<div class="v7-split">
          <span><i class="v7-dot" style="background:var(--v7-mid)"></i>${eur(fromSolar)} from ${st.solar_planned ? 'the planned solar' : 'your solar'}</span>
          <span><i class="v7-dot" style="background:var(--accent)"></i>${eur(fromSwitch)} from switching</span>
        </div>` : '';

    return `${topbar('')}
    <div class="screen v7 v7-home">
      <section class="v7-hero qr-hero">
        <div class="v7-eyebrow">${saving > 10 ? 'You could pay less' : 'Your best plan'}</div>
        <div class="qr-value v7-figure" data-countup="${Math.round(Math.max(0, saving))}" data-prefix="€"><span data-countup-num>${api.fmtCurrency(Math.max(0, saving))}</span><span class="v7-figure-unit">a year</span></div>
        <div class="v7-headline">${chosen ? 'On the plan you picked — ' : 'Best for your home: '}<b>${esc(best.plan.supplier)}</b> ${esc(best.plan.plan)}</div>
        ${savingsLadder({ rungs })}
        ${split}
      </section>

      <button class="switch-cta v7-cta" onclick="handleSwitchClick('${best.plan.id}', '${switchName}', ${saving.toFixed(0)})">
        Switch to ${esc(best.plan.supplier)}${fromSolar > 1 && fromSwitch > 0 ? ` · ${eur(fromSwitch)}/yr` : ''} ${api.ic('chevR', 18)}
      </button>
      <div class="qr-actions v7-links">
        <a href="#" onclick="event.preventDefault();openPlanPicker()">${st.chosen_plan ? 'Change plan' : 'Pick a different plan'}</a>
        ${saving > 10 ? `<span class="qr-actions-dot">·</span>
        <a href="#" onclick="event.preventDefault();setScreen('how-to-switch')">How switching works</a>` : ''}
      </div>

      <div class="v7-basis" aria-label="What these figures are worked out for">${homeChips({ withSolar: false })}${solarSwitch()}</div>

      <div class="v7-notices">
        ${api.freshnessChip(best.plan)}
        ${api.priceChangeChip(best.plan)}
        ${api.renderContractAlert()}
        ${st.chosen_plan ? api.renderChoiceStrip() : ''}
      </div>

      <div class="v7-carousel" role="region" aria-label="Your year and your day">
        ${api.renderBillShape(best)}
        ${api.renderDayShape(best)}
      </div>

      ${tiles(rec)}

      ${working(rec)}

      <!-- Carried over from V6's home, where they were two small actions under
           the report. V7's first cut dropped them, which removed the only way
           back into the guided setup from the answer. -->
      <div class="v7-actions">
        <button class="v7-action" onclick="reRunOnboarding()">
          ${api.ic('rotate', 18)}<b>Re-run setup</b>
        </button>
        <button class="v7-action" onclick="copyShareUrl()">
          ${api.ic('link', 18)}<b>Share analysis</b>
        </button>
      </div>

      <div class="report-promo v7-report" onclick="openPdfReportModal()">
        <div class="v7-report-ico">${api.ic('doc', 22)}</div>
        <div>
          <div class="v7-report-title">Your full report, as a PDF</div>
          <div class="v7-report-sub">Ten typeset pages — your year, hour by hour, and the twenty-year position.</div>
        </div>
        <span class="v7-chev">${api.ic('chevR', 18)}</span>
      </div>
    </div>
    ${nav()}`;
  }

  /** Doors to the other two questions, each carrying its own answer. */
  function tiles(rec) {
    const st = S();
    const n = rec.ranked.length;
    const rank = rec.ranked.findIndex((r) => r.plan.id === st.baseline) + 1;
    let solar = { big: 'Model it', sub: 'What panels would do for this home' };
    if (st.has_solar && api.totalPanels() > 0) {
      try {
        const scen = api.computeSolarPaybackScenarios();
        const s = st.ev_active ? scen.withEv : scen.withoutEv;
        solar = { big: s.payback < 50 ? `${s.payback.toFixed(1)} yr` : '—', sub: 'solar payback' };
      } catch (e) { /* the tile is a door; a failed estimate must not block the answer */ }
    }
    return `<div class="v7-tiles">
      <button class="v7-tile" onclick="setScreen('plans')">
        <span class="v7-tile-ico">${api.ic('plans', 18)}</span>
        <span class="v7-tile-big">${n} plans</span>
        <span class="v7-tile-sub">${rank > 0 ? `yours ranks #${rank}` : 'ranked on your usage'}</span>
      </button>
      <button class="v7-tile" onclick="setScreen('solar')">
        <span class="v7-tile-ico">${api.ic('sun', 18)}</span>
        <span class="v7-tile-big">${solar.big}</span>
        <span class="v7-tile-sub">${solar.sub}</span>
      </button>
    </div>`;
  }

  /**
   * The working — every figure behind the answer, one tap away. It holds the
   * text; the shapes above it are open by default because they are the fast
   * way to read the same numbers.
   */
  function working(rec) {
    const st = S();
    const open = !!st._home_detail_open;
    const best = rec.best;
    const base = api.getPlanById(st.baseline);
    const body = open ? `<div class="working-body">
        <div class="plan-compare v7-compare">
          <div class="plan-row current">
            <div>
              <div class="plan-label">${st.baseline_known ? 'Your current plan' : 'Estimated baseline'}</div>
              <div class="plan-value">${esc(base.supplier)} — ${esc(base.plan)}${st.baseline_known ? '' : ' <span class="v7-muted">(not confirmed)</span>'}</div>
            </div>
            <div class="plan-amount">${api.fmtCurrency(rec.baseCost)}/yr</div>
          </div>
          <div class="plan-row best">
            <div>
              <div class="plan-label">${st.chosen_plan === best.plan.id ? 'Your chosen plan' : 'Switch to'}</div>
              <div class="plan-value">${esc(best.plan.supplier)} — ${esc(best.plan.plan)}</div>
            </div>
            <div class="plan-amount">${best.net <= 0 ? 'Net earner' : api.fmtCurrency(best.net) + '/yr'}</div>
          </div>
        </div>
        ${api.renderSavingsBreakdown(best, rec.baseCost)}
        ${api.renderAssumptions(api.setupLabel())}
        ${api.renderTrustPanel()}
        ${api.renderLogicBreakdown()}
      </div>` : '';
    return `<div class="working v7-working">
      <button class="working-toggle" aria-expanded="${open}" onclick="state._home_detail_open=!state._home_detail_open;saveState();renderApp()">
        <span class="working-toggle-label">${api.ic('flask', 18)} Show me the working</span>
        <span class="working-toggle-hint">${open ? 'Hide' : 'Both plans, the sum, and every assumption'}</span>
        <span class="working-toggle-chev" style="transform:rotate(${open ? '90' : '0'}deg)">›</span>
      </button>
      ${body}
    </div>`;
  }

  /* ------------------------------------------------------------ PLANS */

  const BANDS24 = (plan) => Array.from({ length: 24 }, (_, h) => api.bandAt(h, plan));

  /**
   * Every plan, drawn as what it would cost this home.
   *
   * The old list was a stack of text cards, each carrying nine facts at equal
   * weight, so twenty-five of them looked alike. Here each plan is one bar:
   * its length is the year's cost on this home, the strip under it is the
   * shape of its day, and the flags say what is uncertain about it. The
   * ranking is legible without reading a single row.
   */
  function plans() {
    const st = S();
    const d = api.plansData();
    const { ranked, filtered, visible, hidden, counts, baseCost, sortBy, f, cmpSel } = d;
    // Every bar is measured against the same ruler: today's bill, or the dearest
    // plan if one costs more. Scaling to the visible shortlist made six plans
    // within €60 of each other look identical and full.
    const ruler = Math.max(1, baseCost, ...ranked.filter((r) => !r.onHold).map((r) => r.cost));
    // Each row's difference is what switching to it would change on this home,
    // solar included — the same measure as the switch step on the home screen.
    const mine = api.sameHomeCost(st.baseline);

    const rows = filtered.length === 0
      ? `<div class="v7-empty">No plans in this category. Try another filter.</div>`
      : visible.map((r) => {
        const rank = ranked.indexOf(r) + 1;
        const isBest = rank === 1 && f === 'all';
        const isCurrent = r.plan.id === st.baseline;
        const isChosen = r.plan.id === st.chosen_plan;
        const saving = mine - r.cost;
        const w = Math.max(2, (Math.max(0, r.cost) / ruler) * 100);
        // One quiet line of provenance per plan: when it was checked, and what
        // is uncertain about it. Each of these used to be its own row.
        const meta = [
          r.plan.verified_date ? `<span class="plan-verified">Verified ${api.fmtVerifiedDate(r.plan.verified_date)}</span>` : '',
          api.planDataFlag(r.plan) ? `<span class="v7-flag is-check">${api.ic('warn', 12)} confirm rates</span>` : '',
          r.plan.price_change ? `<span class="v7-flag is-rise">${api.ic('trendUp', 12)} rising ${fmtDate(r.plan.price_change.effective_date)}</span>` : '',
          r.onHold ? `<span class="v7-flag">wholesale-linked, not ranked</span>` : '',
        ].filter(Boolean).join('');
        return `<div class="plan-card v7-plan ${isChosen ? 'chosen' : isBest ? 'best' : isCurrent ? 'current' : ''}"
            onclick="v7Sheet('plan','${r.plan.id}')" role="button" tabindex="0">
          <div class="v7-plan-head">
            <span class="v7-rank">${r.onHold ? '—' : isChosen ? '✓' : rank}</span>
            <div class="v7-plan-names">
              <div class="plan-supplier">${esc(r.plan.supplier)}${isCurrent ? ' <span class="v7-tag">yours now</span>' : ''}${isBest ? ' <span class="v7-tag is-best">best</span>' : ''}</div>
              <div class="plan-name">${esc(r.plan.plan)}</div>
            </div>
            <div class="v7-plan-cost">
              <div class="plan-cost">${api.fmtCurrency(r.cost)}</div>
              ${isCurrent ? '<div class="v7-plan-delta">today</div>' : `<div class="v7-plan-delta ${saving > 0 ? 'is-gain' : 'is-loss'}">${saving > 0 ? '−' : '+'}${api.fmtCurrency(Math.abs(saving))}</div>`}
            </div>
          </div>
          <div class="v7-bar" title="${api.fmtCurrency(r.cost)} of ${api.fmtCurrency(ruler)}"><span style="width:${w.toFixed(1)}%"></span></div>
          <div class="v7-plan-strip">${rateStrip({ bands: BANDS24(r.plan), rates: r.plan.rates, height: 6 })}</div>
          <div class="v7-plan-foot">
            <div class="v7-meta">${meta}</div>
            <button class="cmp-btn v7-cmp ${cmpSel.includes(r.plan.id) ? 'on' : ''}"
              onclick="event.stopPropagation(); toggleCompare('${r.plan.id}')"
              aria-pressed="${cmpSel.includes(r.plan.id)}">${cmpSel.includes(r.plan.id) ? '✓ Comparing' : 'Compare'}</button>
          </div>
        </div>`;
      }).join('');

    return `${topbar('Plans')}
    <div class="screen v7 v7-plans">
      <div class="v7-page-head">
        <h2 class="v7-h">Every plan, priced on your home</h2>
        <div class="v7-muted">Differences are against your current plan on the same home${st.has_solar ? ', solar included' : ''}.</div>
        ${homeChips()}
      </div>
      ${api.renderStalenessBanner()}
      ${st.chosen_plan ? api.renderChoiceStrip() : ''}

      <div class="v7-controls">
        <div class="v7-seg plans-filters" role="tablist">
          ${['all', 'flat', 'tou', 'ev', 'dynamic'].map((cat) => `
            <button class="plan-filter-pill v7-seg-btn ${cat === f ? 'active' : ''}" onclick="setPlansFilter('${cat}')">
              ${api.planCategoryLabel(cat)}<span class="count">${counts[cat]}</span>
            </button>`).join('')}
        </div>
        <div class="plans-sort v7-sort">
          <span class="plans-sort-label">Sort by</span>
          ${[['cost', 'Year cost'], ['standing', 'Standing charge'], ['export', 'Export rate']].map(([k, lbl]) => `
            <button class="plans-sort-btn ${sortBy === k ? 'on' : ''}" onclick="setPlansSort('${k}')">${lbl}</button>`).join('')}
        </div>
        <div class="v7-legend">
          <span><i class="v7-dot" style="background:var(--bandink-night)"></i>night</span>
          <span><i class="v7-dot" style="background:var(--bandink-day)"></i>day</span>
          <span><i class="v7-dot" style="background:var(--bandink-peak)"></i>peak</span>
          <span><i class="v7-dot" style="background:var(--bandink-ev)"></i>EV</span>
          ${api.latestVerifiedLabel() ? `<span class="plan-verified">Rates verified ${api.latestVerifiedLabel()} · ${ranked.length} active plans</span>` : ''}
        </div>
      </div>

      <div class="v7-plan-list">${rows}</div>

      ${hidden > 0 ? `<button class="plans-more v7-more" onclick="state._plans_all=true;renderApp()">
        Show the other ${hidden} plan${hidden > 1 ? 's' : ''}</button>` : ''}

      ${cmpSel.length ? `<div class="cmp-tray">
        <div class="cmp-tray-text">${cmpSel.length} selected${cmpSel.length === 1 ? ' — pick one more' : ''}</div>
        <button class="cmp-tray-clear" onclick="clearCompare()">Clear</button>
        <button class="cmp-tray-go" ${cmpSel.length < 2 ? 'disabled' : ''} onclick="openCompare()">Compare →</button>
      </div>` : ''}
    </div>
    ${nav()}`;
  }

  function fmtDate(iso) {
    try { return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' }); } catch (e) { return iso; }
  }

  /* ------------------------------------------------------------ SOLAR */

  /**
   * Solar answers one question — is it worth it — with the one shape that
   * answers it: money over twenty years, crossing zero. The figures that used
   * to stand in front of the curve now annotate it.
   */
  function solar() {
    const st = S();
    const hasSystem = st.has_solar && api.totalPanels() > 0;
    const d = api.solarData();
    const { scen, cur, sysCost, npv, range, view, best, baseCost } = d;
    const pb = view === 'realistic'
      ? cur.payback
      : (range && range[view] ? range[view].payback : cur.payback);
    const benefit = view === 'realistic' ? cur.solarBenefit : (range && range[view] ? range[view].solarBenefit : cur.solarBenefit);
    const curve = [-sysCost];
    const deg = st.panel_degradation || 0.005;
    for (let y = 1; y <= 20; y++) {
      const disc = benefit * Math.pow(1 - deg, y - 1) / Math.pow(1.03, y);
      const batt = st.battery_kwh > 0 && y === 12 ? -400 * st.battery_kwh / Math.pow(1.03, 12) : 0;
      curve.push(curve[y - 1] + disc + batt);
    }

    const hero = hasSystem ? `<section class="v7-hero v7-solar-hero">
        <div class="v7-eyebrow">${st.solar_planned ? 'The system you are planning' : st.solar_is_estimate ? 'An estimated system for your home' : 'Your system'}</div>
        <div class="v7-figure qr-value">${pb < 50 ? pb.toFixed(1) : '—'}<span class="v7-figure-unit">yr payback</span></div>
        <div class="v7-headline">${eur(benefit)} a year back on ${eur(sysCost)} after the grant · 20-year value <b class="${npv >= 0 ? 'is-gain' : 'is-loss'}">${eur(npv)}</b></div>
        ${paybackCurve({ cumulative: curve })}
        <div class="v7-seg v7-wx wx-range" role="tablist" aria-label="Weather year">
          ${[['pessimist', 'Poor year'], ['realistic', 'Typical'], ['optimist', 'Good year']].map(([k, l]) => `
            <button class="v7-seg-btn wx-range-btn ${view === k ? 'active on' : ''}" onclick="state._scenario_view='${k}';renderApp()">${l}</button>`).join('')}
        </div>
        <button class="v7-system" onclick="goRefineSolar()">
          <span class="v7-chip">${api.totalPanels()} panels · ${api.totalKwp().toFixed(1)} kWp</span>
          <span class="v7-chip">${st.battery_kwh > 0 ? `${st.battery_kwh} kWh battery` : 'no battery'}</span>
          <span class="v7-chip">${st.ev_active ? 'with EV' : 'no EV'}</span>
          <span class="v7-chip v7-chip-edit">${api.ic('tune', 14)} Change</span>
        </button>
      </section>`
      : `<section class="v7-hero v7-solar-hero">
        <div class="v7-eyebrow">Solar</div>
        <div class="v7-headline">${api.totalPanels() ? 'Solar is left out of every figure. Switch it back on above — your system is kept.' : 'No panels are in the model yet.'}</div>
        ${api.totalPanels() ? '' : `<button class="switch-cta v7-cta" onclick="exploreSolar()">Model a system for this roof ${api.ic('chevR', 18)}</button>`}
      </section>`;

    const score = api.computeEnergyScore(best, baseCost);
    const weakest = score.parts.slice().sort((a, b) => a.score - b.score)[0];
    const scoreCard = `<section class="v7-card v7-score">
      ${scoreRing({ value: score.overall })}
      <div class="v7-score-body">
        <div class="v7-card-title">Energy health score</div>
        <div class="v7-score-weak">${weakest && weakest.score < 90 ? `Weakest: <b>${esc(weakest.label)}</b> — ${esc(weakest.why)}` : 'Little left on the table.'}</div>
        <div class="v7-score-parts">${score.parts.map((p) => `
          <div class="v7-part"><span>${esc(p.label)}</span><span class="v7-part-bar"><i style="width:${p.score}%"></i></span><b>${p.score}</b></div>`).join('')}</div>
      </div>
    </section>`;

    const months = hasSystem ? (() => {
      const m = api.monthlyTotals(best);
      return `<section class="v7-card">
        <div class="v7-card-title">What the panels make, against what the home uses</div>
        ${monthBars({ a: m.gen, b: m.cons })}
        <div class="v7-legend"><span><i class="v7-dot" style="background:var(--accent)"></i>solar ${Math.round(m.gen.reduce((a, b) => a + b, 0)).toLocaleString('en-IE')} kWh</span>
          <span><i class="v7-dot" style="background:var(--ink-dim)"></i>use ${Math.round(m.cons.reduce((a, b) => a + b, 0)).toLocaleString('en-IE')} kWh</span></div>
      </section>`;
    })() : '';

    return `${topbar('Solar')}
    <div class="screen v7 v7-solar">
      ${solarSwitch()}
      ${hero}
      ${hasSystem ? api.renderSolarBody('top') : ''}
      ${scoreCard}
      ${months}
      <div class="v7-tiles">
        <button class="v7-tile" onclick="setScreen('analytics')">
          <span class="v7-tile-ico">${api.ic('chart', 18)}</span>
          <span class="v7-tile-big">Hour by hour</span>
          <span class="v7-tile-sub">any day of the year</span>
        </button>
        <button class="v7-tile" onclick="setScreen('monitor')">
          <span class="v7-tile-ico">${api.ic('radar', 18)}</span>
          <span class="v7-tile-big">Market</span>
          <span class="v7-tile-sub">price moves & alerts</span>
        </button>
      </div>
      ${api.renderNightRateCard(best, baseCost)}
      ${api.renderEvSavingsCard(best)}
      ${api.renderSolarBody(hasSystem ? 'rest' : true)}
    </div>
    ${nav()}`;
  }

  /* ------------------------------------------------------------ SHEETS */

  /**
   * Sheets open over the surface the reader is on. A plan's detail, or the
   * home's assumptions, used to be a separate screen — every question cost a
   * round trip and the context behind it disappeared.
   */
  function sheet() {
    const sh = S()._sheet;
    if (!sh) return '';
    let body = '';
    if (sh.kind === 'plan') body = planSheet(sh.id);
    else if (sh.kind === 'assume') body = assumeSheet();
    if (!body) return '';
    return `<div class="v7-sheet-root" id="v7-sheet">
      <div class="v7-sheet-backdrop" onclick="v7Sheet(null)"></div>
      <div class="v7-sheet" role="dialog" aria-modal="true">
        <div class="v7-grip" aria-hidden="true"></div>
        <button class="v7-sheet-x" onclick="v7Sheet(null)" aria-label="Close">${api.ic('x', 18)}</button>
        ${body}
      </div>
    </div>`;
  }

  function planSheet(id) {
    const plan = api.getPlanById(id);
    if (!plan) return '';
    const st = S();
    const rec = api.getRecommendation();
    const row = rec.ranked.find((r) => r.plan.id === id);
    const s = api.sim(id);
    const c = api.annualCost(s, plan);
    const saving = api.sameHomeCost(st.baseline) - c.net;
    const rank = row ? rec.ranked.indexOf(row) + 1 : null;
    const bands = [...new Set(BANDS24(plan))];
    const label = { day: 'Day', night: 'Night', peak: 'Peak', ev: 'EV window', wfh: 'Work from home' };
    const pc = plan.price_change;
    const switchName = jsAttr(`${plan.supplier} ${plan.plan}`);
    return `<div class="v7-sheet-head">
        <div class="v7-eyebrow">${rank ? `#${rank} of ${rec.ranked.length} for your home` : 'Not ranked'}</div>
        <h2 class="v7-h">${esc(plan.supplier)}</h2>
        <div class="v7-muted">${esc(plan.plan)}</div>
      </div>
      <div class="v7-sheet-figs">
        <div><div class="v7-fig">${api.fmtCurrency(c.net)}</div><div class="v7-fig-sub">a year on your home</div></div>
        <div><div class="v7-fig ${saving > 0 ? 'is-gain' : 'is-loss'}">${saving > 0 ? '−' : '+'}${api.fmtCurrency(Math.abs(saving))}</div><div class="v7-fig-sub">vs your plan now</div></div>
      </div>
      <div class="v7-card-title">Its day</div>
      ${rateStrip({ bands: BANDS24(plan), rates: plan.rates, height: 22 })}
      <div class="v7-hours"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      <div class="v7-rates">
        ${bands.map((b) => `<div class="v7-rate"><i class="v7-dot" style="background:var(--bandink-${b})"></i>${label[b] || b}<b>${api.fmtCent(plan.rates[b] ?? plan.rates.day)}</b></div>`).join('')}
        <div class="v7-rate"><i class="v7-dot" style="background:var(--ink-dim)"></i>Standing<b>${api.fmtCurrency(plan.standing)}/yr</b></div>
        ${plan.export_rate ? `<div class="v7-rate"><i class="v7-dot" style="background:var(--accent)"></i>Export<b>${api.fmtCent(plan.export_rate)}</b></div>` : ''}
      </div>
      ${pc ? `<div class="v7-note is-rise">${api.ic('trendUp', 16)}<div><b>Prices rise ${fmtDate(pc.effective_date)}.</b> ${esc(pc.note || '')} The year above already includes it for the months it applies.</div></div>` : ''}
      ${api.planDataFlag(plan) ? `<div class="v7-note is-check">${api.ic('warn', 16)}<div>These rates have not been re-checked recently. Confirm them with ${esc(plan.supplier)} before switching.</div></div>` : ''}
      <button class="v7-cta-2" onclick="handleSwitchClick('${plan.id}', '${switchName}', ${saving.toFixed(0)})">Go to ${esc(plan.supplier)} ${api.ic('chevR', 16)}</button>
      <div class="v7-sheet-links">
        ${st.chosen_plan === plan.id ? '' : `<a href="#" onclick="event.preventDefault();v7Choose('${plan.id}')">Use this plan for my figures</a>`}
        <a href="#" onclick="event.preventDefault();v7Sheet(null);showPlanDetail('${plan.id}')">Full rate card</a>
      </div>`;
  }

  function assumeSheet() {
    const st = S();
    return `<div class="v7-sheet-head">
        <div class="v7-eyebrow">Your home</div>
        <h2 class="v7-h">What every figure is built on</h2>
      </div>
      ${api.renderAssumptions(api.setupLabel())}
      <button class="v7-cta-2" onclick="v7Sheet(null);setScreen('refine')">Change any of it ${api.ic('chevR', 16)}</button>
      <div class="v7-sheet-links">
        <a href="#" onclick="event.preventDefault();v7Sheet(null);setScreen('csv-import')">Import smart-meter data for exact figures</a>
        ${st.has_solar ? `<a href="#" onclick="event.preventDefault();v7Sheet(null);goRefineSolar()">Change the solar system</a>` : ''}
      </div>`;
  }

  return { topbar, nav, home, plans, solar, sheet };
}
