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
  savingsLadder, rateStrip, scoreRing, monthBars, paybackCurve, dayProfile, eur,
} from './charts.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsq = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
/** A string safe inside a single-quoted JS literal inside a double-quoted attribute. */
const jsAttr = (s) => esc(jsq(s));

/** Which surface a screen belongs to, so the right tab stays lit. */
export const V7_SURFACES = [
  // v8: Solar is no longer a tab. Its answer is a card on Home (the 'solar'
  // screen opens from it and keeps Home lit); its depth lives in Analytics.
  { id: 'result', icon: 'home', label: 'Home', screens: ['result'] },
  { id: 'plans', icon: 'plans', label: 'Plans', screens: ['plans', 'plan-detail', 'compare'] },
  // The full solar analysis (the payback curve) is depth, so it sits under
  // Analytics: the lit tab always says where you are, and Home is only Home.
  { id: 'analytics', icon: 'chart', label: 'Analytics', screens: ['analytics', 'csv-import', 'solar'] },
  { id: 'me', icon: 'user', label: 'Me',
    screens: ['me', 'monitor', 'more', 'refine', 'auditor', 'quotes', 'methodology', 'independence', 'how-to-switch', 'privacy', 'installer'] },
];

export function createV7(api) {
  const S = () => api.state();

  /* ------------------------------------------------------------ chrome */

  function topbar(title, { back = false, home = false } = {}) {
    const root = V7_SURFACES.some((x) => x.id === S().current_screen);
    if (root) back = false;
    // A screen opened from Home (Solar) says where it came from and goes back there.
    if (home) return `<header class="topbar v7-top v7-top-sub" role="banner">
      <h1 class="sr-only">${esc(title)}</h1>
      ${S()._solar_from === 'result'
        ? `<button class="v7-home-back" onclick="state._solar_from=null;setScreen('result')" aria-label="Back to Home">${api.ic('chevL', 18)} Home</button>`
        : `<span class="v7-brand v7-brand-static">${api.ic('chart', 18)}</span>`}
      <div class="v7-top-title">${esc(title)}</div>
      <div class="v7-top-end">${api.renderProfileNavBtn()}</div>
    </header>`;
    return `<header class="topbar v7-top" role="banner">
      <h1 class="sr-only">${esc(title || api.brand)}</h1>
      ${back
        ? `<button class="icb" onclick="goBack()" aria-label="Back">${api.ic('chevL', 20)}</button>`
        : `<button class="v7-brand" onclick="setScreen('result')" aria-label="Home">
            <span class="v7-brand-mark">${api.ic('logo', 22, 'stroke-width:1.6')}</span>
          </button>`}
      ${title ? `<div class="v7-top-title">${esc(title)}</div>` : `<div class="v7-top-title">${api.wordmark('pk-word-top')}</div>`}
      <div class="v7-top-end">${api.renderProfileNavBtn()}</div>
    </header>`;
  }

  function nav() {
    const cur = S().current_screen;
    const active = (V7_SURFACES.find((s) => s.screens.includes(cur)) || {}).id;
    return `${api.renderConsentBar()}<nav class="bottom-nav v7-nav" role="navigation" aria-label="Sections">
      ${V7_SURFACES.map((s) => `
        <button class="bottom-nav-item v7-nav-item ${active === s.id ? 'active' : ''}"
          onclick="${active === s.id ? 'window.scrollTo({top:0,behavior:\'smooth\'})' : `setScreen('${s.id}')`}" aria-current="${active === s.id ? 'page' : 'false'}">
          <span class="nav-ico">${api.ic(s.icon, 22)}${s.id === 'me' && api.alertCount() ? `<i class="nav-badge" aria-label="${api.alertCount()} new alerts">${api.alertCount()}</i>` : ''}</span>
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
      withSolar ? (st.has_solar ? `${api.totalPanels()} solar panels${st.solar_planned ? ' (planned)' : ''}` : 'no solar') : '',
      withSolar && st.battery_kwh > 0 ? `${st.battery_kwh} kWh battery` : '',
      st.ev_active ? 'EV' : '',
    ].filter(Boolean);
    return `<button class="v7-home-chips" onclick="v7Sheet('home')" aria-label="My home — change">
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
        ? `${api.totalPanels()} panels${S().battery_kwh > 0 ? ` and a ${S().battery_kwh} kWh battery` : ''}`
        : api.hasModelledSystem() ? 'Left out — your system is kept' : 'Not modelled — switch on to see if it pays off'}</small></span>
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
  /** Where the home is now, by name, so the comparison says what it compares. */
  function nowLabel() {
    const st = S();
    const p = api.getPlanById(st.baseline);
    return st.baseline_known && p ? `Now, ${p.supplier}` : 'Now, a standard plan';
  }

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
          { label: nowLabel(), value: today, token: '--ink-dim' },
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
        { label: `${nowLabel()}, with ${solarWord}`, value: mineWithSolar, token: '--v7-mid' },
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
    const chosen = st.chosen_plan === best.plan.id;
    const lad = ladderData(rec);
    const { fromSwitch, fromSolar } = lad;
    // v8: with solar on its own Home card, the plan card is about switching
    // only — the same home, panels on both sides, as the Plans tab ranks it.
    const withSolar = lad.rungs.length === 3;
    // Planned solar: one staircase, worst to best. Now; the best plan without
    // panels; now with the panels; the best plan with them. The big figure is
    // the whole of it, and each step says what it is worth and what it takes.
    const plannedSolar = withSolar && (st.solar_planned || st.solar_is_estimate);
    const pl = plannedSolar ? api.plannedLadder() : null;
    const stair = pl ? [
      { label: `${nowLabel()}, no solar`, value: pl.today, token: '--ink-dim' },
      { label: `On ${pl.noSolar.plan.supplier}, no solar`, value: pl.noSolar.net, token: '--v7-mid' },
      { label: `${nowLabel()}, with the planned solar`, value: pl.mine, token: '--v7-mid' },
      { label: `On ${pl.best.plan.supplier}, with the planned solar`, value: pl.best.net, token: '--accent' },
    ] : null;
    const rungs = stair || (withSolar ? lad.rungs.slice(1) : lad.rungs);
    const saving = pl ? pl.today - pl.best.net : withSolar ? fromSwitch : rec.annualSavings;
    const mineNow = rungs[0].value;
    const switchName = jsAttr(`${best.plan.supplier} ${best.plan.plan}`);
    const split = fromSolar > 1
      ? `<div class="v7-split">
          <span><i class="v7-dot" style="background:var(--v7-mid)"></i>${eur(fromSolar)} from ${st.solar_planned ? 'the planned solar' : 'your solar'}</span>
          <span><i class="v7-dot" style="background:var(--accent)"></i>${eur(fromSwitch)} from switching</span>
        </div>` : '';

    // When nothing on the market beats the plan this home is on, the answer
    // is "stay" — not a €0 saving with a button to switch to something dearer.
    const stay = saving <= 10 && !chosen;
    const hero = stay ? `
        <div class="v7-eyebrow">Your plan is already the best value</div>
        <div class="qr-value v7-figure"><span>${api.fmtCurrency(mineNow)}</span><span class="v7-figure-unit">a year where you are</span></div>
        <div class="v7-headline">No plan on the market costs less for this home. The closest is <b>${esc(best.plan.supplier)}</b> ${esc(best.plan.plan)}, ${eur(Math.max(0, -saving))} a year more.</div>`
      : `
        <div class="v7-eyebrow">${pl ? 'The most you could save: switch plan and add the planned solar' : saving > 10 ? (withSolar ? 'Switching plan saves, with your solar' : 'You could pay less') : 'Your best plan'}</div>
        <div class="qr-value v7-figure ${saving > 10 ? 'is-saving' : ''}" data-countup="${Math.round(Math.max(0, saving))}" data-prefix="€"><span data-countup-num>${api.fmtCurrency(Math.max(0, saving))}</span><span class="v7-figure-unit">${saving > 10 ? 'less a year' : 'a year'}</span></div>
        ${pl ? '' : `<div class="v7-headline">${chosen ? 'On the plan you picked — ' : 'Best for your home: '}<b>${esc(best.plan.supplier)}</b> ${esc(best.plan.plan)}</div>`}`;
    let steps = '';
    if (pl) {
      let d = null; try { d = api.solarData(); } catch (e) {}
      const pb = d && d.cur.payback < 50 ? d.cur.payback : null;
      steps = `<div class="v7-steps">
        <div class="v7-step"><b>${eur(Math.max(0, pl.today - pl.noSolar.net))} less</b><span>a year from switching to <b>${esc(pl.noSolar.plan.supplier)}</b> ${esc(pl.noSolar.plan.plan)}. Free, and you can do it today.</span></div>
        <div class="v7-step"><b>${eur(Math.max(0, pl.noSolar.net - pl.best.net))} less</b><span>again, a year, once the panels are in${pl.best.plan.id !== pl.noSolar.plan.id ? `, on <b>${esc(pl.best.plan.supplier)}</b> ${esc(pl.best.plan.plan)}` : ''}. ${d ? `${eur(d.sysCost)} after the grant${pb ? `, paid back in ${pb.toFixed(1)} years` : ''}.` : ''}</span></div>
        <div class="v7-solar-ctl">${api.ic('sun', 16)}<span><b>Planned solar</b> · ${api.totalPanels()} panels${st.battery_kwh > 0 ? ` · ${st.battery_kwh} kWh battery` : ''}</span>
          <button onclick="toggleSolarModel()">Leave out</button></div>
        <button class="hc-go" onclick="state._solar_from='result';setScreen('solar')">Solar analysis ${api.ic('chevR', 14)}</button>
      </div>`;
    }

    /*
     * Simple first, deep on request.
     *
     * The first screen answers one question: what should I do, and what is it
     * worth. Everything that shows the working — the ladder, the year and the
     * day, the tiles, the sums — is one tap away under "Your analysis", which
     * leads with what makes the answer trustworthy (every hour of the year
     * modelled, every plan compared, how accurate it is). Nothing is removed;
     * it is ordered. Price changes and contract ends stay up front: they are
     * things to act on, not detail.
     */
    const deep = !!st._home_deep;
    const acc = api.modelAccuracy ? api.modelAccuracy().pct : null;
    const kwh = Math.round(api.annualKwh()).toLocaleString('en-IE');
    const basis = st._csv_imported ? `your smart-meter data · ${kwh} kWh a year`
      : st.usage_input_mode === 'kwh' ? `${kwh} kWh a year` : `your €${st.bimonthly_bill_eur} bill`;
    return `${topbar('')}
    <div class="screen v7 v7-home ${deep ? 'is-deep' : 'is-simple'}">
      <section class="v7-hero qr-hero">
        ${hero}
        <div class="v7-ladder-k">What you’d pay a year</div>
        ${savingsLadder({ rungs })}
        ${steps}
      </section>

      ${stay
        ? `<button class="switch-cta v7-cta" onclick="setScreen('plans')">See every plan compared ${api.ic('chevR', 18)}</button>`
        : switchButton(pl ? pl.noSolar.plan : best.plan, '')}

      <button class="v7-basis-line" onclick="openMyHome()">
        Based on ${esc(basis)}${st.has_solar && api.totalPanels() > 0 ? ` · ${api.totalPanels()} solar panels` : ''}${st.ev_active ? ' · an electric car' : ''}
        <span>Change</span>
      </button>

      <div class="v7-notices">
        ${api.priceChangeChip(best.plan)}
        ${api.renderContractAlert()}
        ${st.chosen_plan ? api.renderChoiceStrip() : ''}
      </div>

      ${homeCards(rec)}

      <button class="v7-deep ${deep ? 'open' : ''}" aria-expanded="${deep}" onclick="state._home_deep=!state._home_deep;renderApp()">
        <span class="v7-deep-top"><b>${api.ic('chart', 18)} Your analysis</b><span>${deep ? 'Hide' : 'Show'} ${api.ic(deep ? 'chevU' : 'chevD', 16)}</span></span>
        <span class="v7-deep-stats">
          <span><b>8,760</b><small>hours of your year modelled</small></span>
          <span><b>${rec.ranked.length}</b><small>plans priced on your home</small></span>
          ${acc ? `<span><b>±${acc}%</b><small>estimate accuracy</small></span>` : ''}
        </span>
      </button>

      ${deep && acc ? (() => { const a = api.modelAccuracy(); return `<div class="v7-acc-why">${api.ic('info', 16)}<span><b>Why ±${acc}%?</b> ${a.tip ? `It allows for: ${esc(a.parts.filter((x) => x.err >= 2).map((x) => x.label.toLowerCase()).join('; '))}.` : 'This is as close as a model gets: it’s built on your real meter readings, and only the weather is left to vary.'}
        ${a.tip ? `<button onclick="${a.tip.go}">${esc(a.tip.tip)} to tighten it ${api.ic('chevR', 14)}</button>` : ''}</span></div>`; })() : ''}
      ${deep ? `
      ${withSolar && !pl ? `<section class="v7-card v7-full-ladder"><div class="v7-card-title">The whole saving, step by step</div>${savingsLadder({ rungs: lad.rungs })}${split}</section>` : ''}
      <div class="qr-actions v7-links">
        <a href="#" onclick="event.preventDefault();setScreen('plans')">See all ${rec.ranked.length} plans ranked for you</a>
        ${saving > 10 ? `<a href="#" onclick="event.preventDefault();setScreen('how-to-switch')">How switching works</a>` : ''}
      </div>
      <div class="v7-basis" aria-label="What these figures are worked out for">${homeChips({ withSolar: false })}</div>
      <div class="v7-notices">${api.freshnessChip(best.plan)}</div>
      <div class="v7-carousel" role="region" aria-label="Your year and your day">
        ${api.renderBillShape(best)}
        ${api.renderDayShape(best)}
      </div>
      ${tiles(rec)}
      ${working(rec)}
      <div class="v7-actions">
        <button class="v7-action" onclick="reRunOnboarding()">${api.ic('rotate', 18)}<b>Re-run setup</b></button>
        <button class="v7-action" onclick="copyShareUrl()">${api.ic('link', 18)}<b>Share analysis</b></button>
      </div>` : ''}

    </div>
    ${nav()}`;
  }

  /**
   * The rest of the household, a card per part it has.
   *
   * A home with panels gets a solar card (installed: what they bring back;
   * planned: the payback), a home with a car an EV card, and a home with
   * neither two quiet invitations. The cards carry one figure each and open
   * the detail; the depth is in Analytics.
   */
  function homeCards(rec) {
    const st = S();
    const sys = st.has_solar && api.totalPanels() > 0;
    const planned = sys && (st.solar_planned || st.solar_is_estimate);
    let out = '';
    if (sys && !planned) {
      let d = null; try { d = api.solarData(); } catch (e) {}
      const pb = d && d.cur.payback < 50 ? d.cur.payback : null;
      out += `<section class="hc">
        <span class="hc-k"><span>${api.ic('sun', 16)} ${planned ? 'If you add solar' : 'Your solar panels'}</span><i class="hc-tag ${planned ? 'is-plan' : ''}">${planned ? 'planned' : 'installed'}</i></span>
        <span class="hc-line">${planned ? 'Separate from switching: what panels would do, if you buy them' : 'What your panels bring back, on top of switching'}</span>
        <span class="hc-fig">${planned ? `${pb ? pb.toFixed(1) : '—'}<small>years to pay for itself</small>` : `${eur(d ? d.cur.solarBenefit : 0)}<small>a year from your panels</small>`}</span>
        <span class="hc-facts">
          ${planned ? `<span><b>${eur(d ? d.cur.solarBenefit : 0)}</b>back a year</span>` : `<span><b>${pb ? pb.toFixed(1) : '—'} yrs</b>to pay back</span>`}
          <span><b>${eur(d ? d.sysCost : 0)}</b>after grant</span>
          <span><b>${eur(d ? d.npv : 0)}</b>over 20 years</span>
        </span>
        <span class="hc-sub">${api.totalPanels()} panels${st.battery_kwh > 0 ? ` · ${st.battery_kwh} kWh battery` : ''}</span>
        <button class="hc-go" onclick="state._solar_from='result';setScreen('solar')">Solar analysis ${api.ic('chevR', 14)}</button>
      </section>`;
    }
    if (st.ev_active) {
      let ev = null; try { ev = api.evEconomics(rec.best.plan.id); } catch (e) {}
      const w = rec.best.plan.windows || {};
      const win = w.ev || w.night;
      out += `<section class="hc">
        <span class="hc-k"><span>${api.ic('car', 16)} Your EV</span><i class="hc-tag ${st.ev_in_bill ? '' : 'is-plan'}">${st.ev_in_bill ? 'yours' : 'planned'}</i></span>
        <span class="hc-fig">${eur(ev ? ev.evElectricityCost : 0)}<small>a year to charge</small></span>
        <span class="hc-sub">${ev ? `${eur(ev.evVsPetrolNet)} less than petrol` : ''}${win ? ` · charge ${hhmm(win[0])}–${hhmm(win[1])}` : ''}</span>
        <button class="hc-go" onclick="v7Sheet('ev')">Your EV in detail ${api.ic('chevR', 14)}</button>
      </section>`;
    }
    const invites = [];
    if (!sys) invites.push(api.hasModelledSystem()
      ? `<button class="hc-invite" onclick="toggleSolarModel()">${api.ic('sun', 18)}<span><b>Your ${st.solar_planned ? 'planned ' : ''}solar is left out</b>${api.totalPanels()} panels${st._kept_battery ? ` and a ${st._kept_battery} kWh battery` : ''}, kept for you. Tap to include it again</span>${api.ic('chevR', 18)}</button>`
      : `<button class="hc-invite" onclick="startSolarGuide()">${api.ic('sun', 18)}<span><b>Thinking about solar?</b>See if it pays off, in a few taps</span>${api.ic('chevR', 18)}</button>`);
    if (!st.ev_active) invites.push(`<button class="hc-invite" onclick="startEvGuide()">${api.ic('car', 18)}<span><b>Thinking about an EV?</b>What it would cost to charge here</span>${api.ic('chevR', 18)}</button>`);
    return out + invites.join('');
  }

  /** Doors to the other two questions, each carrying its own answer. */
  function tiles(rec) {
    const st = S();
    const n = rec.ranked.length;
    const rank = rec.ranked.findIndex((r) => r.plan.id === st.baseline) + 1;
    let solar = { big: 'Solar', sub: 'not modelled' };
    if (st.has_solar && api.totalPanels() > 0) {
      try {
        const scen = api.computeSolarPaybackScenarios();
        const s = st.ev_active ? scen.withEv : scen.withoutEv;
        solar = { big: s.payback < 50 ? `${s.payback.toFixed(1)} yr` : '—', sub: 'payback' };
      } catch (e) { /* the tile is a door; a failed estimate must not block the answer */ }
    }
    let health = null;
    try { health = api.computeEnergyScore(rec.best, rec.baseCost); } catch (e) { health = null; }
    let ev = null;
    if (st.ev_active) { try { ev = api.evEconomics(rec.best.plan.id); } catch (e) { ev = null; } }
    if (ev && !(ev.evKwh > 0)) ev = null;  // an EV with no driving set has nothing to say
    return `<div class="v7-tiles ${ev ? 'v7-tiles-4' : 'v7-tiles-3'}">
      <button class="v7-tile" onclick="setScreen('plans')">
        <span class="v7-tile-ico">${api.ic('plans', 18)}</span>
        <span class="v7-tile-big">${n} plans</span>
        <span class="v7-tile-sub">${rank > 0 ? `yours is #${rank}` : 'ranked for you'}</span>
      </button>
      <button class="v7-tile" onclick="setScreen('solar')">
        <span class="v7-tile-ico">${api.ic('sun', 18)}</span>
        <span class="v7-tile-big">${solar.big}</span>
        <span class="v7-tile-sub">${solar.sub}</span>
      </button>
      ${health ? `<button class="v7-tile v7-tile-score" onclick="v7Sheet('score')" aria-label="Energy health score ${health.overall} of 100">
        ${scoreRing({ value: health.overall, size: 44 })}
        <span class="v7-tile-big">Health</span>
        <span class="v7-tile-sub">score, and fixes</span>
      </button>` : ''}
      ${ev ? `<button class="v7-tile v7-tile-ev" onclick="v7Sheet('ev')">
        <span class="v7-tile-ico">${api.ic('car', 18)}</span>
        <span class="v7-tile-big">${eur(ev.evVsPetrolNet)}/yr</span>
        <span class="v7-tile-sub">EV saves vs petrol</span>
      </button>` : ''}
    </div>
    <div class="report-promo v7-report" onclick="openPdfReportModal()">
      <div class="v7-report-ico">${api.ic('doc', 20)}</div>
      <div>
        <div class="v7-report-title">Your full report, as a PDF</div>
        <div class="v7-report-sub">Ten typeset pages — your year, hour by hour</div>
      </div>
      <span class="v7-chev">${api.ic('chevR', 18)}</span>
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
          ${[['cost', 'Cheapest for you'], ['standing', 'Lowest daily fee'], ['export', 'Best for selling solar']].map(([k, lbl]) => `
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
        <button class="v7-system" onclick="openMySystem()">
          <span class="v7-chip">${api.totalPanels()} panels</span>
          <span class="v7-chip">${st.battery_kwh > 0 ? `${st.battery_kwh} kWh battery` : 'no battery'}</span>
          <span class="v7-chip">${st.ev_active ? 'with EV' : 'no EV'}</span>
          <span class="v7-chip v7-chip-edit">${api.ic('tune', 14)} Change</span>
        </button>
        <button class="v7-acc-chip" onclick="openMySystem()">Estimate accuracy <b>±${api.modelAccuracy().pct}%</b>${api.modelAccuracy().tip ? ' · tighten it' : ''}</button>
        <button class="v7-link" onclick="v7Sheet('quote')">${api.ic('clip', 14)} Model an installer's quote instead</button>
      </section>`
      : `<section class="v7-hero v7-solar-hero">
        <div class="v7-eyebrow">${api.ic('sun', 16)} Solar is switched off</div>
        <div class="v7-headline">${api.hasModelledSystem()
          ? `Your system (${api.totalPanels()} panels${st.battery_kwh > 0 ? `, ${st.battery_kwh} kWh battery` : ''}) is kept, but left out of every figure.`
          : 'No solar is modelled for this home, so every figure is without panels.'}</div>
        ${api.hasModelledSystem()
          ? `<button class="switch-cta v7-cta" onclick="toggleSolarModel()">Switch solar back on ${api.ic('sun', 18)}</button>`
          : `<button class="switch-cta v7-cta" onclick="startSolarGuide()">Would solar pay off here? ${api.ic('chevR', 18)}</button>`}
      </section>`;

    const months = hasSystem ? (() => {
      const m = api.monthlyTotals(best);
      return `<section class="v7-card v7-months-card" role="button" tabindex="0" onclick="v7OpenMonth(event)"
          aria-label="Month by month — tap to go through each month">
        <div class="v7-card-title">What the panels make, against what the home uses</div>
        ${monthBars({ a: m.gen, b: m.cons })}
        <div class="v7-legend"><span><i class="v7-dot" style="background:var(--accent)"></i>solar ${Math.round(m.gen.reduce((a, b) => a + b, 0)).toLocaleString('en-IE')} kWh</span>
          <span><i class="v7-dot" style="background:var(--ink-dim)"></i>use ${Math.round(m.cons.reduce((a, b) => a + b, 0)).toLocaleString('en-IE')} kWh</span></div>
        <div class="v7-tap-hint">Tap a month to go through the year ${api.ic('chevR', 14)}</div>
      </section>`;
    })() : '';

    // Without a system this tab is only about solar: the switch, the offer to
    // model one, and a way to check a quote already in hand. The health score,
    // the market and the plan choice are about the whole home and live there.
    if (!hasSystem) {
      // No system yet: an invitation, not a settings screen. Someone who only
      // wants a cheaper plan never has to read about panels.
      if (api.hasModelledSystem()) {
        return `${topbar('Solar', { home: true })}${api.analyticsHub('solar')}
        <div class="screen v7 v7-solar">${solarSwitch()}${hero}</div>${nav()}`;
      }
      return `${topbar('Solar', { home: true })}${api.analyticsHub('solar')}
      <div class="screen v7 v7-solar">
        <section class="v7-invite">
          <div class="v7-eyebrow">Thinking about solar?</div>
          <h2 class="v7-h">See if it pays off for your home, before anyone sells you a system.</h2>
          <ul class="v7-invite-list">
            <li>${api.ic('sun', 18)} Sized for your roof and your real usage</li>
            <li>${api.ic('chart', 18)} Years to pay back, with the SEAI grant counted</li>
            <li>${api.ic('battery', 18)} With or without a battery, on the plan that suits it</li>
          </ul>
          <button class="switch-cta v7-cta" onclick="startSolarGuide()">Estimate it for my roof ${api.ic('chevR', 18)}</button>
          <button class="v7-cta-2 v7-cta-alt v7-quote-tile" onclick="v7Sheet('quote')">${api.ic('clip', 16)} I already have a quote</button>
        </section>
        <div class="v7-fine" style="text-align:center">Free, and nothing is shared with installers unless you ask for quotes.</div>
      </div>
      ${nav()}`;
    }

    return `${topbar('Solar', { home: true })}${api.analyticsHub('solar')}
    <div class="screen v7 v7-solar">
      ${solarSwitch()}
      ${hero}
      ${api.renderSolarBody('top')}
      <button class="v7-deep ${st._solar_deep ? 'open' : ''}" aria-expanded="${!!st._solar_deep}" onclick="state._solar_deep=!state._solar_deep;renderApp()">
        <span class="v7-deep-top"><b>${api.ic('chart', 18)} Your solar analysis</b><span>${st._solar_deep ? 'Hide' : 'Show'} ${api.ic(st._solar_deep ? 'chevU' : 'chevD', 16)}</span></span>
        <span class="v7-deep-stats">
          <span><b>12</b><small>months of panels against use</small></span>
          <span><b>24h</b><small>summer and winter days</small></span>
          <span><b>${pb < 50 ? pb.toFixed(1) : '—'}</b><small>years to pay back</small></span>
        </span>
      </button>
      ${st._solar_deep ? `
      ${months}
      ${api.renderSolarComparison()}
      ${api.renderDayInspector()}
      <button class="v7-tile v7-tile-wide" onclick="setScreen('analytics')">
        <span class="v7-tile-ico">${api.ic('chart', 18)}</span>
        <span class="v7-tile-big">Hour by hour</span>
        <span class="v7-tile-sub">what the panels and battery do on any day of the year</span>
      </button>
      ${api.renderSolarBody('rest')}` : ''}
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
    else if (sh.kind === 'score') body = scoreSheet();
    else if (sh.kind === 'months') body = monthsSheet();
    else if (sh.kind === 'ev') body = evSheet();
    else if (sh.kind === 'quote') body = quoteSheet();
    else if (sh.kind === 'switch') body = switchSheet(sh.id);
    else if (sh.kind === 'switched') body = switchedSheet(sh.id);
    else if (sh.kind === 'system') body = api.renderSystemSheet();
    else if (sh.kind === 'home') body = api.renderHomeSheet();
    else if (sh.kind === 'handover') body = api.renderHandoverSheet();
    else if (sh.kind === 'journey') body = api.renderJourneySheet(sh.id);
    else if (sh.kind === 'quest') body = api.renderQuestSheet(sh.id);
    else if (sh.kind === 'meter') body = api.renderMeterSheet();
    else if (sh.kind === 'habits') body = api.renderHabitsSheet();
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
      ${api.isPartnerPlan(plan.id) ? `<div class="v7-fine">We may earn a commission if you switch to this plan. It never changes the order plans are ranked in.</div>` : ''}
      ${weekendLine(plan, label)}
      ${batteryLine(s, plan)}
      <div class="v7-fine">Every plan also carries the €19.10 PSO levy, set by the regulator; it is in the yearly figure above.</div>
      ${sourceLine(plan)}
      ${pc ? `<div class="v7-note is-rise">${api.ic('trendUp', 16)}<div><b>Prices rise ${fmtDate(pc.effective_date)}.</b> ${esc(pc.note || '')} The year above already includes it for the months it applies.</div></div>` : ''}
      ${api.planDataFlag(plan) ? `<div class="v7-note is-check">${api.ic('warn', 16)}<div>These rates have not been re-checked recently. Confirm them with ${esc(plan.supplier)} before switching.</div></div>` : ''}
      ${switchButton(plan, '', 'v7-cta-2')}
      <div class="v7-sheet-links">
        ${plan.id !== st.baseline ? `<a href="#" onclick="event.preventDefault();recordSwitch('${plan.id}')">I've switched to this plan</a>` : ''}
        ${st.chosen_plan === plan.id || (api.getRecommendation().cheapest || {}).plan?.id === plan.id ? '' : `<a href="#" onclick="event.preventDefault();v7Choose('${plan.id}')">Compare my home on this plan</a>`}
        <a href="#" onclick="event.preventDefault();v7Sheet(null);showPlanDetail('${plan.id}')">Full rate card</a>
      </div>`;
  }

  /** What changes at the weekend, in words — the strip above shows a weekday. */
  function weekendLine(plan, label) {
    const we = plan.weekend;
    if (!we) return '';
    const DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;
    let when;
    if (we.span) when = `${DAY[we.span[0][0]]} ${hh(we.span[0][1])} to ${DAY[we.span[1][0]]} ${hh(we.span[1][1])}`;
    else when = `${(we.days || []).map((d) => DAY[d]).join(' and ')}${we.window ? `, ${hh(we.window[0])}–${hh(we.window[1])}` : ''}`;
    const parts = Object.entries(we.rates || {})
      .filter(([b, v]) => plan.rates[b] != null && v !== plan.rates[b])
      .map(([b, v]) => `${(label[b] || b).toLowerCase()} ${v === 0 ? 'free' : api.fmtCent(v)}`);
    if (!parts.length) return '';
    return `<div class="v7-note is-check">${api.ic('calendar', 16)}<div><b>Weekends.</b> ${esc(when)}: ${esc(parts.join(', '))}. Included in the yearly figure.</div></div>`;
  }

  /**
   * How the battery is run on this plan. In Automatic each plan is costed with
   * the setting that suits it, so the reader is told which one that is — it is
   * a setting to make in their inverter app if they switch.
   */
  function batteryLine(s, plan) {
    const st = S();
    if (!(st.battery_kwh > 0) || !st.has_solar || !s?.strategy_used) return '';
    const auto = (st.strategy_mode || 'auto') === 'auto';
    const arb = s.strategy_used === 'arbitrage';
    const what = arb
      ? 'charge the battery from the grid in the cheap overnight window and use it at peak'
      : 'fill the battery from your solar only (grid charging would not pay on this plan)';
    return `<div class="v7-note is-check">${api.ic('battery', 16)}<div><b>Battery.</b> ${auto ? 'Costed to' : 'Set to'} ${what}.${auto && arb ? ' Set this in your inverter app when you switch.' : ''}</div></div>`;
  }

  /**
   * The switch button, in one of two voices. A partner supplier (one that pays
   * us for a switch) gets "Switch with <app name>"; any other gets "Switch on their
   * website". Both are the same size and colour: the best plan must always be
   * the most prominent, whether or not it pays us. Both open the same
   * "before you switch" sheet.
   */
  function switchButton(plan, extra = '', cls = 'switch-cta v7-cta') {
    const partner = api.isPartnerPlan(plan.id);
    return `<button class="${cls} v7-switch-btn" data-partner="${partner}" onclick="v7Sheet('switch','${plan.id}')">
      ${partner ? `${api.ic('logo', 18)} Switch with ${api.brand}` : `Switch on ${esc(plan.supplier)}'s website`}${extra} ${api.ic(partner ? 'chevR' : 'external', 18)}
    </button>`;
  }

  function switchSheet(id) {
    const plan = api.getPlanById(id);
    if (!plan) return '';
    const st = S();
    const partner = api.isPartnerPlan(id);
    const saving = api.sameHomeCost(st.baseline) - api.annualCost(api.sim(id), plan).net;
    const switchName = jsAttr(`${plan.supplier} ${plan.plan}`);
    const meter = plan.type === 'flat' ? 'any meter' : 'a smart meter (most homes have one now)';
    return `<div class="v7-sheet-head">
        <div class="v7-eyebrow">${partner ? `Switch with ${api.brand}` : 'Before you switch'}</div>
        <h2 class="v7-h">${esc(plan.supplier)} — ${esc(plan.plan)}</h2>
        ${saving > 1 ? `<div class="v7-muted">About ${eur(saving)} a year less than you pay now.</div>` : ''}
      </div>
      <ol class="v7-steps">
        <li><b>Pick exactly this plan:</b> “${esc(plan.plan)}”. Suppliers list several; the figures here are for this one.</li>
        <li><b>Have to hand:</b> your MPRN (11 digits starting 10, on any electricity bill), a recent meter reading if asked, and your bank details for direct debit.</li>
        <li><b>Meter:</b> this plan needs ${meter}.</li>
        <li><b>Nothing to cancel:</b> your new supplier tells your old one. There's no break in supply, and you have 14 days to change your mind.</li>
        ${plan.exit ? `<li><b>Contract:</b> ${plan.length || 12} months; leaving early costs €${plan.exit}.</li>` : ''}
      </ol>
      <button class="switch-cta v7-cta" onclick="handleSwitchClick('${plan.id}', '${switchName}', ${Math.round(saving)});v7Sheet('switched','${plan.id}')">
        ${partner ? `Continue with ${api.brand} ${api.ic('chevR', 18)}` : `Open ${esc(plan.supplier)}'s website ${api.ic('external', 18)}`}
      </button>
      <div class="v7-fine">${partner
        ? `${esc(plan.supplier)} pays ${esc(api.brand)} when you switch through us. You pay the same price, and it never changes how plans are ranked.`
        : `${esc(api.brand)} earns nothing from this switch. We show it because it's the right plan for your home.`}</div>
      ${plan.id !== S().baseline ? `<div class="v7-sheet-links"><a href="#" onclick="event.preventDefault();recordSwitch('${plan.id}')">Already switched? Update my home</a></div>` : ''}`;
  }

  /** Back from the supplier's site: did the switch happen? One tap records it. */
  function switchedSheet(id) {
    const plan = api.getPlanById(id);
    if (!plan) return '';
    return `<div class="v7-sheet-head"><div class="v7-eyebrow">Back from ${esc(plan.supplier)}</div>
        <h2 class="v7-h">Did you switch to ${esc(plan.plan)}?</h2></div>
      <p class="v7-muted">We'll make it your plan here, start counting what it saves, and remind you before its contract ends.</p>
      <button class="switch-cta v7-cta" onclick="recordSwitch('${plan.id}')">Yes, I switched ${api.ic('checkC', 18)}</button>
      <button class="v7-cta-2 v7-cta-alt" onclick="v7Sheet(null)">Not yet</button>`;
  }

  /** Where the figures were read, and when. */
  function sourceLine(plan) {
    const src = plan.source;
    if (!src?.url) return '';
    let host = src.url;
    try { host = new URL(src.url).hostname.replace(/^www\./, ''); } catch (e) { /* keep the raw url */ }
    const when = src.read || plan.verified_date;
    return `<div class="v7-fine">Rates read from <a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(host)}</a>${when ? ` on ${fmtDate(when)}` : ''}, inc VAT.</div>`;
  }

  /**
   * The health score and what would raise it. The night-rate prompt and the
   * EV sum are its "how to improve" — they were cards on the Solar tab, where
   * a home without panels found advice that had nothing to do with panels.
   */
  function scoreSheet() {
    const rec = api.getRecommendation();
    const best = rec.best;
    const score = api.computeEnergyScore(best, rec.baseCost);
    const weakest = score.parts.slice().sort((a, b) => a.score - b.score)[0];
    return `<div class="v7-sheet-head">
        <div class="v7-eyebrow">Your home</div>
        <h2 class="v7-h">Energy health score</h2>
      </div>
      <section class="v7-score">
        ${scoreRing({ value: score.overall })}
        <div class="v7-score-body">
          <div class="v7-score-weak">${weakest && weakest.score < 90 ? `Weakest: <b>${esc(weakest.label)}</b> — ${esc(weakest.why)}` : 'Little left on the table.'}</div>
          <div class="v7-score-parts">${score.parts.map((p) => `
            <div class="v7-part"><span>${esc(p.label)}</span><span class="v7-part-bar"><i style="width:${p.score}%"></i></span><b>${p.score}</b></div>`).join('')}</div>
        </div>
      </section>
      ${api.renderNightRateCard(best, rec.baseCost)}
      ${S().ev_active ? `<button class="v7-cta-2" onclick="v7Sheet('ev')">${api.ic('car', 16)} Your EV: charging and petrol ${api.ic('chevR', 16)}</button>`
        : `<button class="v7-link" onclick="startEvGuide()">${api.ic('car', 14)} Thinking about an EV? See what it would change</button>`}`;
  }

  /**
   * The car, on its own. Petrol against electricity is true with or without
   * panels, so it lives here rather than on the Solar tab. Leads with the net
   * figure; the petrol and charging figures below are its working.
   */
  function evSheet() {
    const st = S();
    const rec = api.getRecommendation();
    const best = rec.best;
    const ev = api.evEconomics(best.plan.id);
    if (!ev) return '';
    const plan = best.plan;
    const cheapRate = plan.rates.ev ?? plan.rates.night ?? plan.rates.day;
    const cheapName = plan.windows?.ev ? `its EV window (${hhmm(plan.windows.ev[0])}–${hhmm(plan.windows.ev[1])})`
      : plan.windows?.night ? `its night rate (${hhmm(plan.windows.night[0])}–${hhmm(plan.windows.night[1])})` : 'its flat rate';
    const at6 = plan.rates[api.bandAt(18, plan)] ?? plan.rates.day;
    const lost = ev.evKwh * (at6 - cheapRate);
    // Charging alone, on every plan on sale: the cheapest place to plug in.
    const byCharging = rec.ranked.map((r) => {
      const p = r.plan;
      const rate = p.windows?.ev ? p.rates.ev : p.windows?.night ? p.rates.night : p.rates.day;
      return { p, rate, cost: ev.evKwh * rate };
    }).sort((a, b) => a.cost - b.cost).slice(0, 3);
    return `<div class="v7-sheet-head">
        <div class="v7-eyebrow">Your EV · ${Math.round(ev.km).toLocaleString('en-IE')} km a year</div>
        <h2 class="v7-h">${ev.evVsPetrolNet >= 0 ? `${eur(ev.evVsPetrolNet)} a year less than petrol` : `${eur(-ev.evVsPetrolNet)} a year more than petrol`}</h2>
      </div>
      <div class="v7-sheet-figs">
        <div><div class="v7-fig">${eur(ev.petrolCost)}</div><div class="v7-fig-sub">petrol you don't buy · ${Math.round(ev.litres).toLocaleString('en-IE')} L at €${(st.fuel_price || 1.83).toFixed(2)}</div></div>
        <div><div class="v7-fig">${eur(ev.evElectricityCost)}</div><div class="v7-fig-sub">to charge it · ${kwh(ev.evKwh)} on ${esc(plan.supplier)}</div></div>
      </div>
      <div class="v7-card-title">When you plug in</div>
      <div class="v7-rates v7-rates-1">
        <div class="v7-rate"><i class="v7-dot" style="background:var(--bandink-ev)"></i>Overnight, on ${esc(cheapName)}<b>${api.fmtCent(cheapRate)}</b></div>
        <div class="v7-rate"><i class="v7-dot" style="background:var(--bandink-peak)"></i>Straight home at 6pm<b>${api.fmtCent(at6)}</b></div>
      </div>
      ${lost > 1 ? `<div class="v7-note is-check">${api.ic('bolt', 16)}<div>Charging at 6pm instead would cost <b>${eur(lost)} more a year</b>. A charger timer or the car's own schedule does it for you.</div></div>` : ''}
      <div class="v7-card-title">Cheapest plans to charge on</div>
      <div class="v7-rates v7-rates-1">
        ${byCharging.map((x) => `<div class="v7-rate"><i class="v7-dot" style="background:var(--bandink-ev)"></i>${esc(x.p.supplier)} ${esc(x.p.plan)}<b>${eur(x.cost)}/yr</b></div>`).join('')}
      </div>
      <div class="v7-fine">Charging alone. The plan ranked best for your home, ${esc(plan.supplier)} ${esc(plan.plan)}, already weighs charging together with everything else you use.</div>`;
  }

  /**
   * Upload a quote, see what was read and where on the page it came from,
   * correct anything, then model it. Nothing is modelled until the person has
   * looked at the figures: a misread price would become a payback someone
   * signs a contract on.
   */
  function quoteSheet() {
    const q = api.quoteRead();
    const head = `<div class="v7-sheet-head">
        <div class="v7-eyebrow">Installer quote</div>
        <h2 class="v7-h">${q.status === 'review' ? 'Check what we read' : 'Model your home with a real quote'}</h2>
      </div>`;
    if (q.status === 'reading') {
      return `${head}<div class="v7-quote-wait" role="status"><span class="v7-spin" aria-hidden="true"></span>Reading ${esc(q.name || 'your quote')}… this takes up to half a minute.</div>`;
    }
    if (q.status === 'review') {
      const x = q.quote;
      const field = (id, label, val, unit, ev, step) => `<label class="v7-qf">
          <span class="v7-qf-label">${label}</span>
          <span class="v7-qf-input"><input id="${id}" type="number" inputmode="decimal" min="0" step="${step}" value="${val ?? ''}" placeholder="not on the quote">${unit ? `<i>${unit}</i>` : ''}</span>
          ${ev ? `<span class="v7-qf-ev">“${esc(ev)}”</span>` : val == null ? '<span class="v7-qf-ev is-missing">Not found on the quote — fill it in</span>' : ''}
        </label>`;
      return `${head}
        ${x.installer ? `<div class="v7-muted">${esc(x.installer)}${x.quote_date ? ` · ${esc(x.quote_date)}` : ''}</div>` : ''}
        ${(x.warnings || []).length ? `<div class="v7-note is-rise">${api.ic('warn', 16)}<div>${x.warnings.map((w) => esc(w)).join('<br>')}</div></div>` : ''}
        <div class="v7-qf-grid">
          ${field('qf-panels', 'Panels', x.panel_count, '', x.evidence?.panel_count, 1)}
          ${field('qf-watts', 'Each panel', x.panel_watts, 'W', x.evidence?.panel_watts, 5)}
          ${field('qf-batt', 'Battery', x.battery_kwh, 'kWh', x.evidence?.battery_kwh, 0.1)}
          ${field('qf-price', 'Price inc VAT, before grant', x.price_total_eur, '€', x.evidence?.price_total_eur, 50)}
          ${field('qf-grant', 'SEAI grant', x.grant_eur, '€', x.evidence?.grant_eur, 50)}
        </div>
        ${[x.panel_model, x.inverter_model, x.battery_model, x.orientation, ...(x.extras || [])].filter(Boolean).length
          ? `<div class="v7-fine">Also on the quote: ${esc([x.panel_model, x.inverter_model, x.battery_model, x.orientation && `facing ${x.orientation}`, ...(x.extras || [])].filter(Boolean).join(' · '))}</div>` : ''}
        <button class="switch-cta v7-cta" onclick="v7ApplyQuote('save')">${api.ic('checkC', 18)} Save to my quotes</button>
        <button class="v7-cta-2 v7-cta-alt" onclick="v7ApplyQuote('model')">Model my home with this quote</button>
        <div class="v7-fine">${api.hasModelledSystem()
          ? `Saving keeps your current system as it is. Modelling switches to this quote and keeps ${S().solar_planned || S().solar_is_estimate ? 'your current plan' : 'your installed system'} in My quotes, so you can switch back.`
          : 'Saving keeps it for later. Modelling makes it the system every figure is built on.'}</div>
        <div class="v7-sheet-links">
          <a href="#" onclick="event.preventDefault();v7QuoteReset()">Upload a different file</a>
        </div>
        <div class="v7-fine">Read automatically — check each figure against your quote. We use these figures for this home only; the file is not kept.</div>`;
    }
    return `${head}
      ${q.status === 'error' ? `<div class="v7-note is-rise">${api.ic('warn', 16)}<div>${esc(q.error)}</div></div>` : ''}
      <label class="v7-drop">
        <input type="file" accept="application/pdf,image/*" onchange="v7QuoteFile(this)">
        ${api.ic('clip', 22)}
        <b>Choose the quote</b>
        <span>A PDF, or a photo of each page</span>
      </label>
      <div class="v7-fine">We read the panels, battery, price and grant, show you the exact words each came from, and you confirm them before anything is modelled. The file is sent to our AI reader (Anthropic's Claude) to be read and is not stored.</div>
      <div class="v7-sheet-links"><a href="#" onclick="event.preventDefault();v7Sheet(null);setScreen('auditor')">Type the figures in instead</a></div>`;
  }

  const hhmm = (h) => `${String(h % 24).padStart(2, '0')}:00`;

  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const kwh = (v) => `${Math.round(v).toLocaleString('en-IE')} kWh`;

  /**
   * The year a month at a time, one swipe per month.
   *
   * The twelve-bar chart shows the shape of the year; this is what each bar
   * means for the home — what came off the grid, what went back, how much of
   * its own power it used, what the month cost, and an average day of that
   * month drawn hour by hour. Every figure is summed from the same simulation
   * as the chart, so the twelve cards add up to the year.
   */
  function monthsSheet() {
    const best = api.getBestPlan();
    const months = api.monthDetail(best);
    const peak = Math.max(1, ...months.map((m) => Math.max(m.gen, m.cons)));
    const cards = months.map((m, i) => {
      const selfUse = m.gen > 0 ? Math.max(0, Math.min(1, (m.gen - m.exp) / m.gen)) : 0;
      const net = m.cost - m.revenue;
      return `<article class="v7-month" data-month="${i}" aria-label="${MONTH[i]}">
        <div class="v7-month-head">
          <h3 class="v7-h">${MONTH[i]}</h3>
          <span class="v7-month-cost ${net <= 0 ? 'is-gain' : ''}">${net <= 0 ? `${eur(-net)} credit` : eur(net)}</span>
        </div>
        <div class="v7-month-bars">
          <div class="v7-month-bar"><span>Solar</span><i style="width:${(m.gen / peak * 100).toFixed(1)}%;background:var(--accent)"></i><b>${kwh(m.gen)}</b></div>
          <div class="v7-month-bar"><span>Use</span><i style="width:${(m.cons / peak * 100).toFixed(1)}%;background:var(--ink-dim)"></i><b>${kwh(m.cons)}</b></div>
        </div>
        <div class="v7-month-stats">
          <div><b>${kwh(m.imp)}</b><span>bought from the grid</span></div>
          <div><b>${kwh(m.exp)}</b><span>sold back</span></div>
          <div><b>${Math.round(selfUse * 100)}%</b><span>of your solar used at home</span></div>
          <div><b>${kwh(m.cons / m.days)}</b><span>used on an average day</span></div>
        </div>
        <div class="v7-card-title">An average ${MONTH[i]} day</div>
        ${dayProfile({ hours: m.hours, height: 110 })}
      </article>`;
    }).join('');
    const dots = MONTH.map((n, i) => `<button class="v7-month-dot" onclick="v7GoMonth(${i})" aria-label="${n}">${n[0]}</button>`).join('');
    return `<div class="v7-sheet-head">
        <div class="v7-eyebrow">Month by month · swipe</div>
        <h2 class="v7-h">Your year on ${esc(best.plan.supplier)}</h2>
      </div>
      <div class="v7-month-dots" role="tablist">${dots}</div>
      <div class="v7-months-track" onscroll="v7MonthScrolled(this)">${cards}</div>`;
  }

  function assumeSheet() {
    const st = S();
    return `<div class="v7-sheet-head">
        <div class="v7-eyebrow">Your home</div>
        <h2 class="v7-h">What every figure is built on</h2>
      </div>
      ${api.renderAssumptions(api.setupLabel())}
      <button class="v7-cta-2" onclick="v7Sheet('home')">Change any of it ${api.ic('chevR', 16)}</button>
      ${!st.ev_active ? `<div class="v7-sheet-links"><a href="#" onclick="event.preventDefault();startEvGuide()">Thinking about an EV? See what it would change</a></div>` : ''}
      <div class="v7-sheet-links">
        <a href="#" onclick="event.preventDefault();v7Sheet(null);setScreen('csv-import')">Import smart-meter data for exact figures</a>
        ${st.has_solar ? `<a href="#" onclick="event.preventDefault();openMySystem()">Change the solar system</a>` : ''}
      </div>`;
  }

  return { topbar, nav, home, plans, solar, sheet };
}
