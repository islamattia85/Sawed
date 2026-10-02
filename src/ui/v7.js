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

  function topbar(title, { back = false } = {}) {
    const root = V7_SURFACES.some((x) => x.id === S().current_screen);
    if (root) back = false;
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

  /** What a bottom-bar tap does: scroll up on the page you're on, else go there. */
  function navGo(id, cur) {
    const up = "window.scrollTo({top:0,behavior:'smooth'})";
    if (id === 'analytics') return cur === 'analytics' || cur === 'solar' ? up : "state._an_from=null;anTab(state._an_tab||'bill')";
    return cur === id ? up : `setScreen('${id}')`;
  }

  function nav() {
    const cur = S().current_screen;
    const active = (V7_SURFACES.find((s) => s.screens.includes(cur)) || {}).id;
    return `${api.renderConsentBar()}<nav class="bottom-nav v7-nav" role="navigation" aria-label="Sections">
      ${V7_SURFACES.map((s) => {
        const go = navGo(s.id, cur);
        return `
        <button class="bottom-nav-item v7-nav-item ${active === s.id ? 'active' : ''}"
          onclick="${go}" aria-current="${active === s.id ? 'page' : 'false'}">
          <span class="nav-ico">${api.ic(s.icon, 22)}${s.id === 'me' && api.alertCount() ? `<i class="nav-badge" aria-label="${api.alertCount()} new alerts">${api.alertCount()}</i>` : ''}</span>
          <span class="nav-label">${s.label}</span>
        </button>`;
      }).join('')}
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
        ${pl ? '' : `<div class="v7-headline">${chosen ? 'On the plan you picked — ' : 'Best for your home: '}<b>${esc(best.plan.supplier)}</b> ${esc(best.plan.plan)}</div>`}
        ${!pl && best.plan.type === 'ev' && !st.ev_active ? `<div class="v7-evnote">${api.ic('info', 14)} You don’t need an electric car for this plan. It’s named for cars, but its cheap night hours suit ${st.battery_kwh > 0 ? 'your battery' : 'your home'} too.</div>` : ''}`;
    let steps = '';
    if (pl) {
      let d = null; try { d = api.solarData(); } catch (e) {}
      const pb = d && d.cur.payback < 50 ? d.cur.payback : null;
      steps = `<div class="v7-steps">
        ${pl.noSolar.plan.id === st.baseline ? `<div class="v7-step"><b>${api.ic('checkC', 16)}</b><span>You’re already on the cheapest plan until the panels are in.</span></div>` : ''}
        ${(() => { let d = null; try { d = api.solarData(); } catch (e) {} const pb = d && d.cur.payback < 50 ? d.cur.payback : null;
          return `<div class="v7-solar-ctl">${api.ic('sun', 18)}<span><b>Planned solar</b><small>${api.totalPanels()} panels${st.battery_kwh > 0 ? ` · ${st.battery_kwh} kWh battery` : ''}${d ? ` · ${eur(d.sysCost)} after grant` : ''}${pb ? ` · pays back in ${pb.toFixed(1)} yrs` : ''}</small></span>
          <button onclick="toggleSolarModel()">Leave out</button></div>`; })()}
        <button class="hc-go" onclick="anTab('solar','result')">Solar analysis ${api.ic('chevR', 14)}</button>
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
    const kwh = Math.round(api.annualKwh()).toLocaleString('en-IE');
    const basis = st._csv_imported ? `your smart-meter data · ${kwh} kWh a year`
      : st.usage_input_mode === 'kwh' ? `${kwh} kWh a year` : `your €${st.bimonthly_bill_eur} bill`;
    return `${topbar('')}
    <div class="screen v7 v7-home">
      <section class="v7-hero qr-hero">
        ${hero}
        <div class="v7-ladder-k">What you’d pay a year</div>
        ${savingsLadder({ rungs })}
        ${steps}
      </section>

      ${stay
        ? `<button class="switch-cta v7-cta" onclick="setScreen('plans')">See every plan compared ${api.ic('chevR', 18)}</button>`
        : pl && pl.noSolar.plan.id === st.baseline
          ? `<button class="switch-cta v7-cta" onclick="setScreen('plans')">See every plan compared ${api.ic('chevR', 18)}</button>`
          : switchButton(pl ? pl.noSolar.plan : best.plan, '')}

      <button class="v7-basis-line" onclick="openMyHome()">
        Based on ${esc(basis)}${st.has_solar && api.totalPanels() > 0 ? ` · ${api.totalPanels()} solar panels` : ''}${st.ev_active ? ' · an electric car' : ''}
        <span>Change</span>
      </button>

      <div class="v7-notices">
        ${/is-stale/.test(api.freshnessChip(best.plan)) ? api.freshnessChip(best.plan) : ''}
        ${api.priceChangeChip(best.plan)}
        ${api.renderContractAlert()}
        ${st.chosen_plan ? api.renderChoiceStrip() : ''}
      </div>

      ${homeCards(rec)}

      ${doors(rec)}
      ${withSolar && !pl ? `<div class="v7-full-ladder" hidden aria-hidden="true">${savingsLadder({ rungs: lad.rungs })}</div>` : ''}
    </div>
    ${nav()}`;
  }

  /**
   * Why these figures? Four doors into Analytics, each carrying its own
   * answer. "Your analysis" used to unfold a second page under the first;
   * the depth now lives in Analytics, a tab per question, one tap away.
   */
  function doors(rec) {
    const st = S();
    let d = null;
    try { d = api.analyticsData(); } catch (e) { d = null; }
    const T = d && d.today;
    let hours = 'your day';
    if (T) {
      if (api.isFlatPlan(d.plan)) hours = 'one price';
      else if ((T.byBand.peak || 0) > 0) hours = `${pct(T.byBand.peak, T.energy)}% at peak`;
      else hours = `${pct((T.kwhBand.night || 0) + (T.kwhBand.ev || 0), sum(Object.values(T.kwhBand)))}% at night`;
    }
    let solar = 'pay off?';
    if (st.has_solar && api.totalPanels() > 0) {
      try { const p = api.solarData().cur.payback; solar = p < 50 ? `${p.toFixed(1)} yrs` : 'no payback'; } catch (e) { solar = 'payback'; }
    } else if (api.hasModelledSystem()) solar = 'left out';
    const door = (t, icon, label, sub, aria) => `<button class="ax-door" onclick="anTab('${t}','result')" aria-label="${aria}">
        <b>${api.ic(icon, 18)}${label}</b><small>${sub}</small></button>`;
    const acc = api.modelAccuracy().pct;
    return `<section class="ax-doors-wrap" aria-label="Why these figures?">
      <div class="ax-doors-h"><b>Why these figures?</b><small>Every hour of your year, on all ${rec.ranked.length} plans</small></div>
      <div class="ax-doors">
        ${door('bill', 'euro', 'Bill', T ? eur(T.total) : 'in parts', `Bill: where the money goes${T ? `, ${eur(T.total)} a year` : ''}`)}
        ${door('hours', 'clock', 'Hours', hours, `Hours: when you use it, ${hours}`)}
        ${door('solar', 'sun', 'Solar', solar, `Solar: ${solar}`)}
        ${door('accuracy', 'shield', 'Accuracy', `±${acc}%`, `Accuracy: within ±${acc}%`)}
      </div>
    </section>`;
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
        <button class="hc-go" onclick="anTab('solar','result')">Solar analysis ${api.ic('chevR', 14)}</button>
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
        <button class="hc-go" onclick="anTab('car','result')">Your EV in detail ${api.ic('chevR', 14)}</button>
      </section>`;
    }
    const invites = [];
    if (!sys) invites.push(api.hasModelledSystem()
      ? `<button class="hc-invite" onclick="toggleSolarModel()">${api.ic('sun', 18)}<span><b>Your ${st.solar_planned ? 'planned ' : ''}solar is left out</b>${api.totalPanels()} panels${st._kept_battery ? ` and a ${st._kept_battery} kWh battery` : ''}, kept for you. Tap to include it again</span>${api.ic('chevR', 18)}</button>`
      : `<button class="hc-invite" onclick="startSolarGuide()">${api.ic('sun', 18)}<span><b>Thinking about solar?</b>See if it pays off, in a few taps</span>${api.ic('chevR', 18)}</button>`);
    if (!st.ev_active) invites.push(`<button class="hc-invite" onclick="startEvGuide()">${api.ic('car', 18)}<span><b>Thinking about an EV?</b>What it would cost to charge here</span>${api.ic('chevR', 18)}</button>`);
    return out + invites.join('');
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
          ${[['cost', 'Cheapest for you'], ['standing', 'Lowest daily fee'], ...(S().has_solar && api.totalPanels() > 0 ? [['export', 'Best for selling solar']] : [])].map(([k, lbl]) => `
            <button class="plans-sort-btn ${sortBy === k ? 'on' : ''}" onclick="setPlansSort('${k}')">${lbl}</button>`).join('')}
        </div>
        <div class="v7-legend">
          <span><i class="v7-dot" style="background:var(--bandink-night)"></i>night</span>
          <span><i class="v7-dot" style="background:var(--bandink-day)"></i>day</span>
          <span><i class="v7-dot" style="background:var(--bandink-peak)"></i>peak</span>
          <span><i class="v7-dot" style="background:var(--bandink-ev)"></i>EV</span>
          ${api.latestVerifiedLabel() ? `<span class="plan-verified">Rates verified ${api.latestVerifiedLabel()} · ${ranked.length} active plans</span>` : ''}
          <div class="v7-notices">${ranked[0] ? api.freshnessChip(ranked[0].plan) : ""}</div>
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

  /* -------------------------------------------------------- ANALYTICS */

  /**
   * Analytics: five questions, a tab each.
   *
   * The single long page this replaces carried eighteen headings and two day
   * inspectors; a reader scrolled eight screens and still could not say what
   * it was for. Each tab now asks one question at its head, answers it with
   * one figure, and backs the figure with a few cards whose titles say what
   * they found. Detail is folded, not dropped. Every figure is the engine's
   * own: the tabs only choose which ones belong together.
   */
  const AN_TABS = [
    { id: 'bill', label: 'Bill', icon: 'euro', q: 'Where does your money go?',
      sub: 'What you pay in a year, what it is made of, and what would change it.' },
    { id: 'hours', label: 'Hours', icon: 'clock', q: 'When do you use it, and what does each hour cost?',
      sub: 'Your typical day, the price of every hour, and any day of the year.' },
    { id: 'solar', label: 'Solar', icon: 'sun', q: 'Would the panels pay off, and how?', sub: '' },
    { id: 'car', label: 'Car', icon: 'car', q: 'What does the car cost to run here?',
      sub: 'Charging, the hours that make it cheap, and the plans that suit it.' },
    { id: 'accuracy', label: 'Accuracy', icon: 'shield', q: 'How sure are these figures?',
      sub: 'What every figure is built on, what is assumed, and how to make it sharper.' },
  ];
  /** Cheapest to dearest, so a stacked bar reads like the rates do. */
  const BAND_ORDER = ['ev', 'night', 'wfh', 'day', 'peak'];
  const BAND_NAME = { ev: 'EV window', night: 'Night', wfh: 'Work from home', day: 'Day', peak: 'Peak' };
  const RATE_NAME = { ev: 'the EV rate', night: 'the night rate', wfh: 'the work-from-home rate', day: 'the day rate', peak: 'the peak rate' };
  const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  /** A day's money, to the cent; a day the panels earn more than it buys says so. */
  const dayMoney = (v) => (v < 0 ? `€${(-v).toFixed(2)} earned` : `€${v.toFixed(2)}`);

  /** "21 December", for a day of the model's year. */
  function dayName(idx) {
    let d = Math.max(0, Math.min(364, Math.round(idx || 0)));
    let m = 0;
    while (d >= DIM[m]) { d -= DIM[m]; m += 1; }
    return `${d + 1} ${MONTH[m]}`;
  }

  /** The weekday hours a band covers, as "08:00–17:00, 19:00–23:00". */
  function bandHours(plan, band) {
    const on = Array.from({ length: 24 }, (_, h) => api.bandAt(h, plan) === band);
    if (on.every(Boolean)) return 'all day';
    const runs = [];
    for (let h = 0; h < 24; h++) {
      if (!on[h] || on[(h + 23) % 24]) continue;
      let k = 1;
      while (k < 24 && on[(h + k) % 24]) k += 1;
      runs.push(`${hhmm(h)}–${hhmm((h + k) % 24)}`);
    }
    return runs.join(', ');
  }

  /** The bands in a breakdown, cheapest first, then anything unexpected. */
  const bandKeys = (o) => [...BAND_ORDER.filter((b) => (o[b] || 0) > 0.5),
    ...Object.keys(o).filter((b) => !BAND_ORDER.includes(b) && (o[b] || 0) > 0.5)];
  const bandToken = (b) => (BAND_ORDER.includes(b) ? `--bandink-${b}` : '--bandink-day');

  /** The header: where you came from, and the five questions, sticky together. */
  function anTop(tab) {
    const st = S();
    const tabs = AN_TABS.filter((t) => t.id !== 'car' || st.ev_active);
    return `<header class="topbar v7-top v7-top-sub ax-top" role="banner">
      ${st._an_from === 'result'
        ? `<button class="v7-home-back" onclick="state._an_from=null;setScreen('result')" aria-label="Back to Home">${api.ic('chevL', 18)} Home</button>`
        : `<span class="v7-brand v7-brand-static" aria-hidden="true">${api.ic('chart', 18)}</span>`}
      <div class="v7-top-title">Analytics</div>
      <div class="v7-top-end">${api.renderProfileNavBtn()}</div>
      <nav class="ax-tabs" aria-label="Analytics">
        ${tabs.map((t) => `<button class="ax-tab ${t.id === tab ? 'on' : ''}" ${t.id === tab ? 'aria-current="page"' : ''} onclick="anTab('${t.id}')">${api.ic(t.icon, 18)}<span>${t.label}</span></button>`).join('')}
      </nav>
    </header>`;
  }

  function anHead(tab, sub, q) {
    const t = AN_TABS.find((x) => x.id === tab);
    const s = sub ?? t.sub;
    return `<div class="ax-q"><h1 class="ax-h">${esc(q || t.q)}</h1>${s ? `<p class="ax-sub">${s}</p>` : ''}</div>`;
  }

  function anAnswer({ k, big, unit = '', line = '', extra = '' }) {
    return `<section class="ax-ans">
      <div class="ax-ans-k">${k}</div>
      <div class="ax-big qr-value"><span>${big}</span>${unit ? `<span class="ax-unit">${unit}</span>` : ''}</div>
      ${line ? `<div class="ax-line">${line}</div>` : ''}
      ${extra}
    </section>`;
  }

  const anCard = (title, body, cls = '') => `<section class="ax-card ${cls}"><h2 class="ax-t">${title}</h2>${body}</section>`;
  const note = (t) => (t ? `<p class="ax-note">${t}</p>` : '');

  /** One bar split into parts: a share of a whole. */
  function stack(parts, label) {
    const tot = sum(parts.map((p) => Math.max(0, p.v))) || 1;
    return `<div class="ax-stack" role="img" aria-label="${esc(label)}">${parts.filter((p) => p.v > 0).map((p) =>
      `<i style="flex-grow:${(p.v / tot).toFixed(4)};background:var(${p.token})" title="${esc(p.tip || p.label)}"></i>`).join('')}</div>`;
  }
  function rows(parts) {
    return `<div class="ax-rows">${parts.map((p) => `<div class="ax-row">
        <i class="ax-sw" style="background:var(${p.token})"></i>
        <span class="ax-row-l"><b>${p.label}</b>${p.sub ? `<small>${p.sub}</small>` : ''}</span>
        <span class="ax-row-v"><b>${p.val}</b>${p.p ? `<small>${p.p}</small>` : ''}</span>
      </div>`).join('')}</div>`;
  }
  /** Columns from a baseline: a month, or an hour. */
  function vbars(items, { height = 110, label = '' } = {}) {
    const max = Math.max(0.0001, ...items.map((x) => x.v));
    return `<div class="ax-vbars" style="height:${height}px" role="img" aria-label="${esc(label)}">${items.map((x) =>
      `<i style="height:${(x.v > 0 ? Math.max(3, (x.v / max) * 100) : 0).toFixed(1)}%;background:var(${x.token})" title="${esc(x.tip)}"></i>`).join('')}</div>`;
  }
  const axis = (labels) => `<div class="ax-axis" aria-hidden="true">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;
  const hourAxis = () => axis(Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? String(h).padStart(2, '0') : '')));
  /** Two or three things side by side, longest bar = most. */
  function hbars(list) {
    const max = Math.max(0.0001, ...list.map((r) => r.v));
    return list.map((r) => `<div class="ax-hbar">
        <div class="ax-hbar-k"><span>${r.name}</span><b>${r.val}</b></div>
        <div class="ax-hbar-t"><i style="width:${Math.max(2, (r.v / max) * 100).toFixed(1)}%;background:var(${r.token})"></i></div>
      </div>`).join('');
  }
  const cta = (label, go, cls = 'switch-cta v7-cta') => `<button class="${cls} ax-cta" onclick="${go}">${label} ${api.ic('chevR', 18)}</button>`;
  const cta2 = (label, go, icon = '') => `<button class="v7-cta-2 v7-cta-alt ax-cta2" onclick="${go}">${icon ? `${api.ic(icon, 16)} ` : ''}${label}</button>`;

  function analytics(tab) {
    const st = S();
    let t = tab || st._an_tab || 'bill';
    if (!tab && t === 'solar') t = 'bill';
    if (t === 'car' && !st.ev_active) t = 'bill';
    if (!AN_TABS.some((x) => x.id === t)) t = 'bill';
    let body;
    try {
      const d = t === 'car' ? null : api.analyticsData();
      body = t === 'bill' ? anBill(d) : t === 'hours' ? anHours(d) : t === 'solar' ? anSolar(d)
        : t === 'car' ? anCar() : anAccuracy(d);
    } catch (e) {
      console.error('[analytics]', e);
      body = `${anHead(t)}${note('This part could not be worked out just now. Try again in a moment.')}`;
    }
    return `${anTop(t)}
    <div class="screen v7 ax ax-${t}${t === 'solar' ? ' v7-solar' : ''}" data-tab="${t}">${body}</div>
    ${nav()}`;
  }

  /* --- Bill: where does your money go? --- */
  function anBill(d) {
    const st = S();
    const T = d.today;
    const plan = d.plan;
    const planned = d.sys && !d.installed;
    const flat = api.isFlatPlan(plan);
    const fixed = T.standing + T.pso;
    const gross = T.energy + T.outlook + fixed;
    const bands = flat
      ? [{ key: 'day', label: 'Electricity', sub: `${api.fmtCent(plan.rates.day)} a kWh, every hour`, v: T.energy, token: '--bandink-day' }]
      : bandKeys(T.byBand).map((b) => ({ key: b, label: BAND_NAME[b] || b,
        sub: [bandHours(plan, b), `${api.fmtCent(plan.rates[b] ?? plan.rates.day)} a kWh`].filter(Boolean).join(' · '),
        v: T.byBand[b], token: bandToken(b) }));
    if (T.outlook > 0.5) bands.push({ key: 'rise', label: 'Price rise already announced', sub: 'For the months it applies', v: T.outlook, token: '--amber' });
    const parts = [...bands, { key: 'fixed', label: 'Fixed charges', sub: `Standing charge ${eur(T.standing)}, PSO levy ${eur(T.pso)}`, v: fixed, token: '--ax-fixed' }]
      .map((p) => ({ ...p, val: eur(p.v), p: `${pct(p.v, gross)}%`, tip: `${p.label}: ${eur(p.v)} a year` }));
    const big = parts.slice().sort((a, b) => b.v - a.v)[0];
    const partsTitle = big.key === 'fixed' ? `Fixed charges are the biggest part: ${big.p}`
      : flat || big.key === 'rise' ? `Electricity is ${pct(T.energy, gross)}% of it; fixed charges the rest`
        : `Electricity at ${RATE_NAME[big.key] || big.label} is the biggest part: ${big.p}`;
    const credit = d.installed && T.credit > 0.5 ? `<div class="ax-row ax-row-credit"><i class="ax-sw" style="background:var(--ax-sold)"></i>
        <span class="ax-row-l"><b>Paid for what you sell back</b><small>Export payments, taken off the bill</small></span>
        <span class="ax-row-v"><b class="is-gain">−${eur(T.credit)}</b></span></div>` : '';

    const mo = T.month;
    const hiI = mo.indexOf(Math.max(...mo));
    const loI = mo.indexOf(Math.min(...mo));
    const r = mo[loI] > 0 ? mo[hiI] / mo[loI] : Infinity;
    const monthTitle = mo[loI] <= 0 ? `${MONTH[hiI]} costs the most; in ${MONTH[loI]} the panels earn more than you buy`
      : r >= 1.5 ? `${MONTH[hiI]} costs ${r.toFixed(1)} times what ${MONTH[loI]} does`
        : r >= 1.1 ? `${MONTH[hiI]} costs ${Math.round((r - 1) * 100)}% more than ${MONTH[loI]}` : 'Every month costs about the same';

    const ch = d.cheaper;
    const n = api.getRecommendation().ranked.length;
    const diff = T.total - ch.net;
    const as = planned ? 'as it is today, before the panels' : d.installed ? 'with its panels' : 'as it is';
    let cheap;
    if (ch.plan.id === plan.id) {
      cheap = anCard('You’re already on the cheapest plan for this home', note(`Checked against all ${n} plans, for this home ${as}.`));
    } else if (diff < 0) {
      // A withdrawn rate can beat everything on sale. Say so, or it reads as a bug.
      cheap = anCard('Nothing on sale today beats your plan',
        note(`It costs ${eur(-diff)} a year less than the cheapest plan on sale, ${esc(ch.plan.supplier)} ${esc(ch.plan.plan)}. If it is a rate no longer offered, keep it while you can.`));
    } else if (diff < 5) {
      cheap = anCard('Nothing on the market costs much less', note(`The cheapest of ${n} plans, ${esc(ch.plan.supplier)} ${esc(ch.plan.plan)}, saves under €5 a year for this home ${as}.`));
    } else {
      const dE = T.energy - ch.energy;
      const dS = ch.standing - T.standing;
      const dC = ch.credit - T.credit;
      cheap = anCard(`${esc(ch.plan.supplier)} would cost ${eur(diff)} less a year`,
        hbars([
          { name: `You now: ${esc(plan.supplier)}`, val: eur(T.total), v: T.total, token: '--bandink-day' },
          { name: `${esc(ch.plan.supplier)} ${esc(ch.plan.plan)}`, val: eur(ch.net), v: ch.net, token: '--accent' },
        ])
        + note(`Its electricity costs ${eur(Math.abs(dE))} ${dE >= 0 ? 'less' : 'more'}; its standing charge is ${eur(Math.abs(dS))} ${dS >= 0 ? 'more' : 'less'}.${d.installed && Math.abs(dC) >= 5 ? ` It pays ${eur(Math.abs(dC))} ${dC >= 0 ? 'more' : 'less'} for what you sell.` : ''}${ch.outlook > 5 ? ' That includes a price rise it has already announced.' : ''} The cheapest of ${n} plans for this home ${as}.`));
    }

    let health = null;
    try { const rec = api.getRecommendation(); health = api.computeEnergyScore(rec.best, rec.baseCost); } catch (e) { health = null; }
    return `${anHead('bill')}
      ${anAnswer({
        k: planned ? 'You pay today, before the planned panels' : d.installed ? 'You pay, with your panels' : 'You pay',
        big: eur(T.total), unit: 'a year',
        line: `On ${esc(plan.supplier)} ${esc(plan.plan)}${st.baseline_known ? '' : ' (our guess at your plan)'}, for ${kwh(T.kwh)}. That is ${api.fmtCent(T.total / Math.max(1, T.kwh))} for every kWh you use, fixed charges included.`,
      })}
      ${anCard(partsTitle, `${stack(parts, parts.map((p) => `${p.label} ${p.val}`).join(', '))}${rows(parts)}${credit}`)}
      ${anCard(monthTitle, `${vbars(mo.map((v, i) => ({ v: Math.max(0, v), token: '--accent', tip: `${MONTH[i]}: ${v < 0 ? `${eur(-v)} credit` : eur(v)}` })),
        { label: `Electricity cost by month, from ${eur(mo[loI])} to ${eur(mo[hiI])}` })}${axis(MONTH.map((m) => m[0]))}
        ${note(`Electricity${d.installed ? ', less export payments' : ''}, month by month. Fixed charges add ${eur(fixed / 12)} a month on top.`)}`)}
      ${cheap}
      ${health ? `<button class="ax-link-row ax-health" onclick="v7Sheet('score')" aria-label="Plan health ${health.overall} of 100">
        ${scoreRing({ value: health.overall, size: 44 })}
        <span><b>Plan health: ${health.overall} of 100</b><small>How well your plan fits this home, and what would raise it</small></span>
        ${api.ic('chevR', 18)}
      </button>` : ''}
      ${cta('Compare every plan, priced for your home', "setScreen('plans')")}`;
  }

  /* --- Hours: when do you use it, and what does each hour cost? --- */
  function anHours(d) {
    const st = S();
    const T = d.today;
    const plan = d.plan;
    const flat = api.isFlatPlan(plan);
    const bought = d.installed;  // with panels, the bill follows what is bought, not what is used
    const hrs = bought ? T.hourImp : T.hourUse;
    const bands24 = Array.from({ length: 24 }, (_, h) => api.bandAt(h, plan));
    const rate = (b) => plan.rates[b] ?? plan.rates.day;
    const present = [...new Set(bands24)];
    const cheapB = present.slice().sort((a, b) => rate(a) - rate(b))[0];
    const dearB = present.slice().sort((a, b) => rate(b) - rate(a))[0];
    const kTot = sum(Object.values(T.kwhBand));
    const nightShare = pct(sum([23, 0, 1, 2, 3, 4, 5, 6, 7].map((h) => hrs[h])), sum(hrs));

    let ans;
    if (flat) {
      ans = { k: 'One price, every hour', big: api.fmtCent(plan.rates.day), unit: 'a kWh, all day',
        line: `On a flat plan, when you use it does not change the bill. ${nightShare}% of your use already falls between 23:00 and 08:00, the hours night-rate plans sell cheaper.` };
    } else if (dearB === 'peak' && (T.byBand.peak || 0) > 0) {
      ans = { k: `At peak, ${bandHours(plan, 'peak')}`, big: `${pct(T.byBand.peak, T.energy)}%`, unit: 'of your electricity spend',
        line: `Peak costs ${api.fmtCent(rate('peak'))} a kWh, ${BAND_NAME[cheapB].toLowerCase()} ${api.fmtCent(rate(cheapB))}. Each kWh moved from peak to ${cheapB === 'ev' ? 'the EV window' : BAND_NAME[cheapB].toLowerCase()} saves ${api.fmtCent(rate('peak') - rate(cheapB))}.` };
    } else {
      ans = { k: `At ${RATE_NAME[cheapB] || 'the cheap rate'}, ${bandHours(plan, cheapB)}`, big: `${pct(T.kwhBand[cheapB] || 0, kTot)}%`, unit: `of what you ${bought ? 'buy' : 'use'}`,
        line: `${BAND_NAME[cheapB]} costs ${api.fmtCent(rate(cheapB))} a kWh, ${BAND_NAME[dearB].toLowerCase()} ${api.fmtCent(rate(dearB))}. Each kWh moved into the cheap hours saves ${api.fmtCent(rate(dearB) - rate(cheapB))}.` };
    }
    ans.extra = st._csv_imported ? '' : `<div class="ax-est">${api.ic('info', 14)} Estimated from your ${st.usage_input_mode === 'kwh' ? 'yearly kWh' : 'bill'}: the hours of a typical home like yours</div>`;

    // The average day.
    const max = Math.max(...hrs);
    const top = hrs.indexOf(max);
    let a = top, b = top;
    while (a > 0 && hrs[a - 1] >= max * 0.8) a -= 1;
    while (b < 23 && hrs[b + 1] >= max * 0.8) b += 1;
    const span = `${hhmm(a)}–${hhmm(b + 1)}`;
    const dayTitle = `${bought ? 'You buy most' : a === b ? 'Your biggest hour is' : 'Your biggest hours are'} ${bought ? 'at ' : ''}${span}${flat ? '' : `, at ${RATE_NAME[bands24[top]] || 'its rate'}`}`;
    const why = [];
    if (st.ev_active && (bands24[top] === 'night' || bands24[top] === 'ev')) why.push('the car charging');
    if (st.hot_water_strategy === 'smart' && top >= 2 && top <= 4) why.push('the water heating in the cheap hours (smart hot-water timing is on)');
    const legend = present.sort((x, y) => BAND_ORDER.indexOf(x) - BAND_ORDER.indexOf(y))
      .map((x) => `<span><i class="v7-dot" style="background:var(${flat ? '--bandink-day' : bandToken(x)})"></i>${flat ? 'Every hour' : BAND_NAME[x] || x} ${api.fmtCent(rate(x))}</span>`).join('');
    const avg = anCard(dayTitle, `${vbars(hrs.map((v, h) => ({ v, token: flat ? '--bandink-day' : bandToken(bands24[h]),
      tip: `${hhmm(h)} · ${v.toFixed(2)} kWh on an average day · ${BAND_NAME[bands24[h]] || bands24[h]} rate` })),
    { label: `${bought ? 'Bought' : 'Used'} by hour on an average day, most at ${hhmm(top)}` })}${hourAxis()}
      <div class="v7-legend">${legend}</div>${why.length ? note(`That is ${why.join(', and ')}.`) : ''}`);

    // The rates it is bought at.
    let ratesCard = '';
    if (!flat && kTot > 0) {
      const ks = bandKeys(T.kwhBand);
      const list = ks.map((x) => ({ label: BAND_NAME[x] || x, sub: `${api.fmtCent(rate(x))} a kWh`, v: T.kwhBand[x], token: bandToken(x),
        val: kwh(T.kwhBand[x]), p: `${pct(T.kwhBand[x], kTot)}%`, tip: `${BAND_NAME[x] || x}: ${pct(T.kwhBand[x], kTot)}%` }));
      const cs = pct(T.kwhBand[cheapB] || 0, kTot);
      ratesCard = anCard(`${cs}% of what you ${bought ? 'buy' : 'use'} is ${cs >= 30 ? 'already ' : ''}at ${RATE_NAME[cheapB] || 'the cheapest rate'}`,
        `${stack(list, list.map((x) => `${x.label} ${x.p}`).join(', '))}${rows(list)}`);
    }

    // Any day of the year.
    const day = st._an_day ?? 354;
    const one = api.analyticsDay(day);
    const oh = one.hours.map((x) => (bought ? x.imp : x.use));
    const dCost = sum(one.hours.map((x) => x.cost));
    const chip = (label, idx) => `<button class="ax-chip ${idx === one.day ? 'on' : ''}" aria-pressed="${idx === one.day}" onclick="setAnalyticsDay(${idx})">${label}</button>`;
    const open = !!st._an_day_open;
    const anyDay = anCard('Any day of the year', `
      <div class="ax-chips">${chip('21 June', 171)}${chip('21 December', 354)}</div>
      <label class="ax-range"><span>Or pick a day: <b>${dayName(one.day)}</b></span>
        <input type="range" min="0" max="364" value="${one.day}" onchange="setAnalyticsDay(+this.value)" aria-label="Day of the year"></label>
      ${vbars(oh.map((v, h) => ({ v, token: flat ? '--bandink-day' : bandToken(one.hours[h].band),
        tip: `${hhmm(h)} · ${v.toFixed(2)} kWh · ${api.fmtCent(one.hours[h].rate)}` })), { height: 96, label: `${bought ? 'Bought' : 'Used'} by hour on ${dayName(one.day)}` })}${hourAxis()}
      <div class="ax-fact">${dayName(one.day)}: ${sum(oh).toFixed(1)} kWh ${bought ? 'bought' : 'used'}, ${dCost >= 0 ? `${dayMoney(dCost)} of electricity` : dayMoney(dCost)}</div>
      <p class="ax-note">Dearest day: <button class="ax-inline" onclick="setAnalyticsDay(${T.dearest.day})">${dayName(T.dearest.day)}, ${dayMoney(T.dearest.cost)}</button>.
        Cheapest: <button class="ax-inline" onclick="setAnalyticsDay(${T.cheapest.day})">${dayName(T.cheapest.day)}, ${dayMoney(T.cheapest.cost)}</button>. ${bought ? 'Electricity less export payments.' : 'Electricity only.'}</p>
      <button class="ax-more ax-more-in ${open ? 'open' : ''}" aria-expanded="${open}" onclick="state._an_day_open=!state._an_day_open;saveState();renderApp()">
        <span><b>Every hour of ${dayName(one.day)}</b><small>The rate, the cost${bought ? ', and the solar and battery' : ''}, hour by hour</small></span>
        <span class="ax-more-s">${open ? 'Hide' : 'Show'} ${api.ic(open ? 'chevU' : 'chevD', 16)}</span>
      </button>
      ${open ? dayDetail(one, bought) : ''}`);

    return `${anHead('hours')}
      ${anAnswer(ans)}
      ${avg}
      ${ratesCard}
      ${anyDay}
      ${st._csv_imported ? cta('Plans that suit these hours', "setScreen('plans')") : cta('Upload your meter file for your real hours', "v7Sheet('meter')")}`;
  }

  /** One day, every hour: the rate it was bought at and what it cost, and with panels what they did. */
  function dayDetail(one, bought) {
    const H = one.hours;
    const maxC = Math.max(0.0001, ...H.map((x) => Math.abs(x.cost)));
    const solar = bought && sum(H.map((x) => x.gen)) > 0.05;
    const ch = sum(H.map((x) => x.ch));
    const dis = sum(H.map((x) => x.dis));
    const runs = (key) => {
      const on = H.map((x) => x[key] > 0.05);
      const out = [];
      for (let h = 0; h < 24; h++) {
        if (!on[h] || (h > 0 && on[h - 1])) continue;
        let k = h;
        while (k < 23 && on[k + 1]) k += 1;
        out.push(`${hhmm(h)}–${hhmm(k + 1)}`);
      }
      return out.slice(0, 3).join(', ');
    };
    return `<div class="ax-day">
      <div class="ax-day-k">The rate, hour by hour</div>
      ${rateStrip({ bands: H.map((x) => x.band), rates: H.reduce((o, x) => ({ ...o, [x.band]: x.rate }), {}), height: 18 })}
      ${hourAxis()}
      <div class="ax-day-k">What each hour cost</div>
      <div class="ax-vbars ax-cost" style="height:72px" role="img" aria-label="Cost by hour on ${dayName(one.day)}">${H.map((x) =>
        `<i class="${x.cost < 0 ? 'is-credit' : ''}" style="height:${Math.max(x.cost ? 3 : 0, (Math.abs(x.cost) / maxC) * 100).toFixed(1)}%" title="${hhmm(x.h)} · ${x.cost < 0 ? 'earned' : 'cost'} €${Math.abs(x.cost).toFixed(2)}"></i>`).join('')}</div>
      ${hourAxis()}
      ${solar ? `<div class="ax-day-k">Made by the panels, used by the home</div>
        ${dayProfile({ hours: H.map((x) => ({ cons: x.use, gen: x.gen, imp: x.imp, band: x.band })), height: 110 })}
        <p class="ax-note">Made ${sum(H.map((x) => x.gen)).toFixed(1)} kWh, sold ${sum(H.map((x) => x.exp)).toFixed(1)} kWh, bought ${sum(H.map((x) => x.imp)).toFixed(1)} kWh.</p>` : ''}
      ${bought && (ch > 0.05 || dis > 0.05) ? `<p class="ax-note">${api.ic('battery', 14)} The battery took in ${ch.toFixed(1)} kWh${runs('ch') ? ` (${runs('ch')})` : ''} and gave back ${dis.toFixed(1)} kWh${runs('dis') ? ` (${runs('dis')})` : ''}.</p>` : ''}
    </div>`;
  }

  /* --- Solar: would the panels pay off, and how? --- */
  function anSolar(d) {
    const st = S();
    if (!d.sys) {
      if (api.hasModelledSystem()) {
        return `${anHead('solar', '')}
        <section class="ax-ans v7-solar-hero">
          <div class="ax-ans-k">${api.ic('sun', 16)} Solar is switched off</div>
          <div class="ax-line">Your ${st.solar_planned ? 'planned ' : ''}system (${api.totalPanels()} panels${st._kept_battery ? `, ${st._kept_battery} kWh battery` : ''}) is kept, but left out of every figure.</div>
        </section>
        ${cta(`Switch solar back on`, 'toggleSolarModel()')}`;
      }
      return `<div class="ax-q"><h1 class="ax-h">Would solar pay off here?</h1>
          <p class="ax-sub">Four quick questions, about a minute. Nothing changes on your Home unless you keep the answer.</p></div>
        <section class="ax-card v7-invite">
          <h2 class="ax-t">What you’ll see</h2>
          <ol class="ax-steps">
            <li>Years to pay for itself, with the SEAI grant counted</li>
            <li>Month by month: what the panels make against what you use</li>
            <li>Where the solar goes: used at home or sold</li>
            <li>A summer and a winter day, every hour of it</li>
            <li>The best plan once the panels are in</li>
          </ol>
        </section>
        ${cta('Estimate it for my roof', 'startSolarGuide()')}
        <button class="v7-cta-2 v7-cta-alt ax-cta2 v7-quote-tile" onclick="v7Sheet('quote')">${api.ic('clip', 16)} I already have a quote</button>`;
    }
    const planned = st.solar_planned || st.solar_is_estimate;
    const sd = api.solarData();
    const { cur, sysCost, view, best } = sd;
    const range = api.solarRange();
    const pick = (v) => (v === 'realistic' ? cur : (range && range[v]) || (sd.range && sd.range[v]) || null);
    const shown = pick(view) || cur;
    const pb = shown.payback;
    const benefit = shown.solarBenefit;
    const wx = [['pessimist', 'Poor year'], ['realistic', 'Typical'], ['optimist', 'Good year']].map(([k, l]) => {
      const s = pick(k);
      return `<button class="ax-wx-b wx-range-btn ${view === k ? 'on active' : ''}" aria-pressed="${view === k}" ${s ? '' : 'aria-busy="true"'} onclick="state._scenario_view='${k}';renderApp()">
        <span>${l}</span><b>${s ? (s.payback < 50 ? `${s.payback.toFixed(1)} yrs` : 'never') : '…'}</b></button>`;
    }).join('');
    const sys = `${api.totalPanels()} panels${st.battery_kwh > 0 ? ` and a ${st.battery_kwh} kWh battery` : ''}`;
    const sub = st.solar_is_estimate ? `An estimated system for your home: ${sys}.` : st.solar_planned ? `The system you are planning: ${sys}.` : `Your system: ${sys}.`;

    // Money over twenty years, in today's euros.
    const curve = [-sysCost];
    const deg = st.panel_degradation || 0.005;
    for (let y = 1; y <= 20; y++) {
      const disc = (benefit * Math.pow(1 - deg, y - 1)) / Math.pow(1.03, y);
      const batt = st.battery_kwh > 0 && y === 12 ? (-400 * st.battery_kwh) / Math.pow(1.03, 12) : 0;
      curve.push(curve[y - 1] + disc + batt);
    }
    const clear = curve.findIndex((v) => v >= 0);
    const end = curve[20];
    const curveTitle = clear > 0 && end >= 0 ? `In today’s money, clear in year ${clear} and ${eur(end)} ahead after 20 years`
      : `In today’s money, still ${eur(-end)} short after 20 years`;

    const m = api.monthlyTotals(best);
    const over = m.gen.map((g, i) => (g > m.cons[i] ? i : -1)).filter((i) => i >= 0);
    const run = over.length && over[over.length - 1] - over[0] === over.length - 1;
    const monthsTitle = !over.length ? 'The home uses more than the panels make, every month'
      : over.length === 1 ? `Only in ${MONTH[over[0]]} do the panels make more than the home uses`
        : run ? `${MONTH[over[0]]} to ${MONTH[over[over.length - 1]]}, the panels make more than the home uses`
          : `In ${over.length} months, the panels make more than the home uses`;

    const so = d.solar;
    const goes = [
      { label: `Used at home · ${pct(so.kept, so.gen)}%`, v: so.kept, token: '--ax-kept', val: kwh(so.kept), sub: `${pct(so.kept, so.cons)}% of what the home uses` },
      { label: `Sold to the grid · ${pct(so.exp, so.gen)}%`, v: so.exp, token: '--ax-sold', val: kwh(so.exp), sub: `${eur(so.revenue)} a year in export payments` },
    ];
    if (so.curt > so.gen * 0.01) goes.push({ label: `Turned away · ${pct(so.curt, so.gen)}%`, v: so.curt, token: '--ax-fixed', val: kwh(so.curt), sub: 'More than the inverter or the export limit can pass' });
    const battLine = so.battOut > 1 ? note(`${api.ic('battery', 14)} The battery hands back ${kwh(so.battOut)} a year${so.arbitrage ? ': afternoon solar, and cheap night power in winter' : ' of solar, in the evening'}.`) : '';
    const more = !!st._solar_more;
    const planName = `${esc(best.plan.supplier)} ${esc(best.plan.plan)}`;
    const planLine = best.isChosen ? `Worked out on ${planName}, the plan you picked.`
      : `Worked out on ${planName}, the best plan ${planned ? 'once the panels are in' : 'with your panels'}.`;

    return `${anHead('solar', sub, planned ? '' : 'Are the panels paying off, and how?')}
      ${anAnswer({
        k: 'Pays for itself in',
        big: pb < 50 ? pb.toFixed(1) : '—', unit: pb < 50 ? 'years' : 'never pays back',
        extra: `<div class="ax-wx wx-range" role="group" aria-label="Weather year">${wx}</div>
          <div class="ax-line">${eur(benefit)} a year back on ${eur(sysCost)} after grant (${eur(st.install_cost)} less a ${eur(st.grant_seai)} SEAI grant).</div>
          <div class="ax-line ax-line-2">${planLine} <button class="ax-inline" onclick="openPlanPicker()">Use a different plan</button></div>
          ${st.chosen_plan ? api.renderChoiceStrip() : ''}
          <button class="v7-system" onclick="openMySystem()">
            <span class="v7-chip">${api.totalPanels()} panels</span>
            <span class="v7-chip">${st.battery_kwh > 0 ? `${st.battery_kwh} kWh battery` : 'no battery'}</span>
            <span class="v7-chip v7-chip-edit">${api.ic('tune', 14)} Change</span>
          </button>
          ${st.solar_is_estimate ? `<p class="ax-note solar-correct">Sized from your usage. Already have panels, or a quote for a specific system? <button class="ax-inline" onclick="openMySystem()">Set the exact system</button></p>` : ''}`,
      })}
      ${anCard(curveTitle, `${paybackCurve({ cumulative: curve })}
        ${note(`The ${pb < 50 ? pb.toFixed(1) : ''} years above count euros as they come in. This line counts them in today’s money, each later year worth 3% less, with the panels slowly wearing${st.battery_kwh > 0 ? ' and the battery replaced around year 12' : ''}.`)}`)}
      <section class="ax-card v7-months-card" role="button" tabindex="0" onclick="v7OpenMonth(event)" aria-label="Month by month: tap to go through each month">
        <h2 class="ax-t">${monthsTitle}</h2>
        ${monthBars({ a: m.gen, b: m.cons, tokenA: '--ax-made', tokenB: '--bandink-day' })}
        <div class="v7-legend"><span><i class="v7-dot" style="background:var(--ax-made)"></i>Made by the panels · ${kwh(sum(m.gen))}</span>
          <span><i class="v7-dot" style="background:var(--bandink-day)"></i>Used by the home · ${kwh(sum(m.cons))}</span></div>
        <div class="v7-tap-hint">Tap a month to go through the year ${api.ic('chevR', 14)}</div>
      </section>
      ${anCard(`${pct(so.kept, so.gen)}% used at home, ${pct(so.exp, so.gen)}% sold`, `${stack(goes, goes.map((g) => g.label).join(', '))}${rows(goes)}${battLine}`)}
      <button class="ax-more ${more ? 'open' : ''}" aria-expanded="${more}" onclick="state._solar_more=!state._solar_more;saveState();renderApp()">
        <span><b>More detail</b><small>A summer and a winter day · make it pay back faster</small></span>
        <span class="ax-more-s">${more ? 'Hide' : 'Show'} ${api.ic(more ? 'chevU' : 'chevD', 16)}</span>
      </button>
      ${more ? `<div class="ax-fold">${api.renderDayInspector()}${api.renderSolarImprove()}</div>` : ''}
      ${planned
        ? `${cta('Get 3 quotes for this system', 'openLeadForm()')}${cta2('Check a quote you already have', "v7Sheet('quote')", 'clip')}`
        : cta('Compare plans with your panels', "setScreen('plans')")}`;
  }

  /* --- Car: what does it cost to run here? --- */
  function anCar() {
    const st = S();
    const rec = api.getRecommendation();
    const plan = rec.best.plan;
    let ev = null;
    try { ev = api.evEconomics(plan.id); } catch (e) { ev = null; }
    if (!ev || !(ev.evKwh > 0)) {
      return `${anHead('car')}${note('Tell us how far the car goes in a year to see what it costs to charge.')}${cta('Set up the car', 'startEvGuide()')}`;
    }
    const cheapRate = plan.rates.ev ?? plan.rates.night ?? plan.rates.day;
    const win = plan.windows?.ev || plan.windows?.night;
    const cheapName = plan.windows?.ev ? `${hhmm(win[0])}–${hhmm(win[1])}, its EV window`
      : plan.windows?.night ? `${hhmm(win[0])}–${hhmm(win[1])}, its night rate` : 'Any hour, on its flat rate';
    const at6 = plan.rates[api.bandAt(18, plan)] ?? plan.rates.day;
    const lost = ev.evKwh * (at6 - cheapRate);
    const byCharging = rec.ranked.map((r) => {
      const p = r.plan;
      const rate = p.windows?.ev ? p.rates.ev : p.windows?.night ? p.rates.night : p.rates.day;
      return { p, cost: ev.evKwh * rate };
    }).sort((a, b) => a.cost - b.cost).slice(0, 3);
    const net = ev.evVsPetrolNet;
    return `${anHead('car')}
      ${anAnswer({
        k: st.ev_in_bill ? 'To charge it' : 'To charge it, once you have it',
        big: eur(ev.evElectricityCost), unit: 'a year',
        line: `${eur(Math.abs(net))} ${net >= 0 ? 'less' : 'more'} than petrol: the ${Math.round(ev.litres).toLocaleString('en-IE')} litres you no longer buy would cost ${eur(ev.petrolCost)} at €${(st.fuel_price || 1.83).toFixed(2)}. ${Math.round(ev.km).toLocaleString('en-IE')} km a year, ${kwh(ev.evKwh)}.`,
      })}
      ${lost > 1
        ? anCard(`Charging at 6 pm would cost ${eur(lost)} more a year`, `${hbars([
          { name: cheapName, val: `${api.fmtCent(cheapRate)} a kWh`, v: cheapRate, token: plan.windows?.ev ? '--bandink-ev' : '--bandink-night' },
          { name: 'Straight home at 6 pm', val: `${api.fmtCent(at6)} a kWh`, v: at6, token: '--bandink-peak' },
        ])}${note('A charger timer, or the car’s own schedule, does it for you.')}`)
        : anCard('This plan charges the same at any hour', note(`${api.fmtCent(cheapRate)} a kWh whenever you plug in. Plans with a cheap night or EV window would charge it for less.`))}
      ${anCard('Cheapest plans to charge on', `${hbars(byCharging.map((x, i) => ({ name: `${esc(x.p.supplier)} ${esc(x.p.plan)}`, val: eur(x.cost), v: x.cost, token: i === 0 ? '--accent' : '--bandink-day' })))}
        ${note(`Charging alone. Your best plan overall, ${esc(plan.supplier)} ${esc(plan.plan)}, weighs the car with everything else you use.`)}`)}
      ${cta('Compare EV plans', "state._plans_filter='ev';setScreen('plans')")}`;
  }

  /* --- Accuracy: how sure are these figures? --- */
  function accRow(p) {
    const L = p.label;
    const conf = /confirmed/.test(L);
    if (/^Weather/.test(L)) return { name: 'Weather and the model', how: 'A typical Irish year; real years vary', state: 'Always' };
    if (/smart-meter/.test(L)) return { name: 'Your usage', how: 'From your smart-meter data', state: 'Measured' };
    if (/yearly kWh/.test(L)) return { name: 'Your usage', how: 'Your yearly kWh, spread over a typical day', state: 'Estimated' };
    if (/from your bill/.test(L)) return { name: 'Your usage', how: 'Worked out from your bill', state: 'Estimated' };
    if (/^Roof/.test(L)) return { name: 'Roof direction and tilt', how: conf ? 'You confirmed it' : 'A typical roof assumed', state: conf ? 'Confirmed' : 'Assumed' };
    if (/panel spec/i.test(L)) return { name: 'Panel spec', how: conf ? 'You confirmed it' : 'Typical panels assumed', state: conf ? 'Confirmed' : 'Assumed' };
    if (/battery spec/i.test(L)) return { name: 'Battery spec', how: conf ? 'You confirmed it' : 'A typical battery assumed', state: conf ? 'Confirmed' : 'Assumed' };
    return { name: L, how: '', state: 'Assumed' };
  }

  function anAccuracy(d) {
    const st = S();
    const a = api.modelAccuracy();
    const meter = st._csv_imported ? null : api.accuracyWithMeter();
    const fill = Math.max(8, Math.min(100, Math.round(100 - (a.pct - 2) * 6)));
    const sorted = a.parts.slice().sort((x, y) => y.err - x.err);
    const worst = accRow(sorted[0]);
    const line = /^Weather/.test(sorted[0].label)
      ? 'Built on your real meter readings: only the weather is left to vary.'
      : `The biggest unknown is ${worst.name.toLowerCase()}: ${worst.how.toLowerCase()}.${meter && meter < a.pct ? ` Your meter file would bring it to ±${meter}%.` : ''}`;
    const list = sorted.map((p) => {
      const r = accRow(p);
      return `<div class="ax-acc">
        <div class="ax-acc-top"><b>${esc(r.name)}</b><span class="ax-pill is-${r.state.toLowerCase()}">${r.state}</span><b class="ax-acc-err">±${p.err}%</b></div>
        ${r.how ? `<small>${esc(r.how)}</small>` : ''}
        ${p.tip ? `<button class="ax-act" onclick="${p.go}">${esc(p.tip)}</button>` : ''}
      </div>`;
    }).join('');
    const price = a.priceTypical ? `<div class="ax-acc">
        <div class="ax-acc-top"><b>System price</b><span class="ax-pill is-assumed">Assumed</span><b class="ax-acc-err"></b></div>
        <small>A typical price for this size. It moves the payback, not the bills</small>
        <button class="ax-act" onclick="openMySystem()">Add the price from your quote</button>
      </div>` : '';

    const tc = api.tariffCounts();
    const when = api.latestVerifiedLabel();
    const T = d.today;
    const ch = d.cheaper;
    const line2 = (x, credit) => `${eur(x.energy)} electricity + ${eur(x.standing)} standing + ${eur(x.pso)} levy${x.outlook > 0.5 ? ` + ${eur(x.outlook)} announced rise` : ''}${credit > 0.5 ? ` − ${eur(credit)} export` : ''}`;
    const sums = [{ name: `${esc(d.plan.supplier)} ${esc(d.plan.plan)}, now`, line: line2(T, T.credit), total: eur(T.total) }];
    if (ch.plan.id !== d.plan.id) sums.push({ name: `${esc(ch.plan.supplier)} ${esc(ch.plan.plan)}`, line: line2(ch, ch.credit), total: eur(ch.net) });
    const rec = api.getRecommendation();
    return `${anHead('accuracy')}
      ${anAnswer({ k: 'Yearly figures, within', big: `±${a.pct}%`, unit: 'either way',
        extra: `<div class="ax-meter" aria-hidden="true"><i style="width:${fill}%"></i></div>`, line })}
      ${anCard('Measured, confirmed, assumed', `${list}${price}`)}
      ${anCard(`${tc.live} plans, checked against suppliers’ own rates`, `<p class="ax-p">Each plan’s rates are read from its supplier’s published price list${when ? `, ${/–/.test(when) ? 'between' : 'on'} ${esc(when)}` : ''}. ${tc.dynamicLeftOut ? `${tc.live - tc.dynamicLeftOut} are ranked; ${tc.dynamicLeftOut} dynamic plans are left out unless you turn them on in Settings.` : 'All of them are ranked.'}</p>
        <button class="ax-inline ax-go" onclick="setScreen('plans')">Every plan’s date, in Plans ${api.ic('chevR', 14)}</button>`)}
      ${anCard('The sum behind your answer', `${sums.map((x) => `<div class="ax-sum"><b>${x.name}</b><div><span>${x.line}</span><b>${x.total}</b></div></div>`).join('')}
        ${sums.length > 1 ? `<div class="ax-sum-d">Difference: ${eur(T.total - ch.net)} a year, the figure on the Bill tab.</div>` : ''}
        ${working(rec)}${api.renderSolarWorking()}`)}
      ${anCard('Take it with you', `<div class="ax-two">
          <button class="ax-tile" onclick="openPdfReportModal()">${api.ic('doc', 18)}<b>Full report, PDF</b></button>
          <button class="ax-tile" onclick="copyShareUrl()">${api.ic('link', 18)}<b>Share this analysis</b></button>
        </div>`)}
      ${st._csv_imported ? (a.tip ? cta(esc(a.tip.tip), a.tip.go) : '') : cta('Upload your ESB meter file', "v7Sheet('meter')")}`;
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
        <h2 class="v7-h">Plan health</h2>
        <p class="v7-muted">How well your plan and habits fit this home, scored on the figures here. Your ${api.brand} score (in Me) is separate: it tracks what you've done.</p>
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
      ${S().ev_active ? `<button class="v7-cta-2" onclick="v7Sheet(null);anTab('car')">${api.ic('car', 16)} Your EV: charging and petrol ${api.ic('chevR', 16)}</button>`
        : `<button class="v7-link" onclick="startEvGuide()">${api.ic('car', 14)} Thinking about an EV? See what it would change</button>`}`;
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

  return { topbar, nav, home, plans, analytics, sheet };
}
