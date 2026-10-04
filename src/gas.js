/**
 * Gas, for dual-fuel homes.
 *
 * Peakless ranks electricity hour by hour. Gas is simpler: one unit rate, a
 * standing charge and the carbon tax, with no time of day. It is here for one
 * reason: a home with both fuels at one supplier has a choice electricity
 * alone cannot show. Stay; move only the electricity (and lose the dual-fuel
 * discount on gas while it lasts); or move both to another supplier.
 *
 * Pure functions: state and tariffs come in, numbers go out.
 */

/** Natural Gas Carbon Tax, € per kWh incl. VAT (Bord Gáis tariff page, from 1 May 2025). */
export const GAS_CARBON_TAX = 0.0125132;

/** The same supplier, however its name is written ("Bord Gáis" / "Bord Gáis Energy"). */
export const supplierKey = (name) => String(name || '').toLowerCase()
  .replace(/energy|airtricity/g, '').replace(/[^a-z]/g, '');

export function gasPlanFor(supplier, gasTariffs) {
  const k = supplierKey(supplier);
  return (gasTariffs || []).find((g) => supplierKey(g.supplier) === k) || null;
}

/** Unit rate (before the carbon tax) and standing charge once an announced rise applies. */
export function gasRates(g, asOf = new Date()) {
  const pc = g.price_change;
  const risen = pc && pc.effective_date && Date.parse(pc.effective_date) <= asOf.getTime();
  return {
    unit: g.unit * (risen ? 1 + (pc.pct || 0) : 1),
    standing: g.standing * (risen ? 1 + (pc.standing_pct || 0) : 1),
  };
}

/**
 * A year of gas on a plan, € incl. VAT, with a discount off the unit rate.
 * An announced rise counts for the part of the year after it starts, as it
 * does for electricity.
 */
export function gasYear(g, kwh, discount = 0, asOf = new Date()) {
  if (!g || !(kwh > 0)) return 0;
  const now = gasRates(g, asOf);
  const pc = g.price_change;
  let w = 0;
  if (pc && pc.effective_date) {
    const days = (Date.parse(pc.effective_date) - asOf.getTime()) / 86400000;
    if (days > 0 && days < 365) w = (365 - days) / 365;
  }
  const unit = now.unit * (1 + w * (pc ? pc.pct || 0 : 0));
  const standing = now.standing * (1 + w * (pc ? pc.standing_pct || 0 : 0));
  return kwh * (unit * (1 - discount) + GAS_CARBON_TAX) + standing;
}

/** kWh a year from a two-monthly gas bill, on the plan and discount the home pays now. */
export function gasKwhFromBill(bill2m, g, discount = 0, asOf = new Date()) {
  if (!g || !(bill2m > 0)) return 0;
  const r = gasRates(g, asOf);
  const perKwh = r.unit * (1 - discount) + GAS_CARBON_TAX;
  return Math.max(0, Math.round((bill2m * 6 - r.standing) / perKwh));
}

/** Still in the discounted first year? Taken from the contract end date, when there is one. */
export function inFirstYear(contractEnd, asOf = new Date()) {
  const t = Date.parse(contractEnd || '');
  return Number.isFinite(t) && t > asOf.getTime();
}

/**
 * The three choices for a dual-fuel home, each a year of both fuels.
 *
 *   elec   — { baseline, cheapest: {supplier, net}, bestBySupplier: Map(supplierKey → {plan, net}) }
 *   home   — { supplier, kwh, firstYear }
 *
 * Returns { stay, moveElec, moveBoth } (moveBoth null when no other gas
 * supplier is known), each { elec, gas, credit, total, supplier }.
 */
export function dualFuelChoices(elec, home, gasTariffs, asOf = new Date()) {
  const cur = gasPlanFor(home.supplier, gasTariffs);
  if (!cur || !(home.kwh > 0)) return null;
  // In the first year the answer turns on the dual-fuel discount; without it, no figures.
  if (home.firstYear && cur.dual_discount == null) return null;
  const curDisc = home.firstYear ? cur.dual_discount : 0;
  const stayGas = gasYear(cur, home.kwh, curDisc, asOf);
  const stay = { supplier: home.supplier, elec: elec.baseline, gas: stayGas, credit: 0, total: elec.baseline + stayGas };

  // Electricity moves; the gas stays but its dual-fuel discount ends (if one is running).
  const sameAsNow = supplierKey(elec.cheapest.supplier) === supplierKey(home.supplier);
  const lostGas = gasYear(cur, home.kwh, 0, asOf);
  const moveElec = sameAsNow ? null : {
    supplier: elec.cheapest.supplier, elec: elec.cheapest.net, gas: lostGas, credit: 0,
    total: elec.cheapest.net + lostGas, lost: lostGas - stayGas,
  };

  // Both fuels to another supplier: its best electricity plan for this home,
  // its gas at the dual-fuel discount; its dual-fuel welcome credit rides alongside.
  let moveBoth = null;
  for (const g of gasTariffs || []) {
    if (g.dual_discount == null || supplierKey(g.supplier) === supplierKey(home.supplier)) continue;
    const e = elec.bestBySupplier.get(supplierKey(g.supplier));
    if (!e) continue;
    const gas = gasYear(g, home.kwh, g.dual_discount, asOf);
    const credit = g.dual_welcome || 0;
    // The welcome credit is shown beside the yearly figure, never inside it, as for electricity.
    const opt = { supplier: g.supplier, plan: e.plan, elec: e.net, gas, credit, total: e.net + gas };
    if (!moveBoth || opt.total < moveBoth.total) moveBoth = opt;
  }
  return { stay, moveElec, moveBoth };
}
