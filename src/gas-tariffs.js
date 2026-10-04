/**
 * Gas, one entry per supplier, for dual-fuel homes. All € incl. 9% VAT;
 * `unit` is the standard unit rate before any discount and before the carbon
 * tax (added in gas.js). Read from each supplier's own pages on 4 Oct 2026
 * (scraper/probe_gas.py --full).
 *
 * dual_discount: off the gas unit rate while a dual-fuel plan's first year
 *   runs. null when the supplier's page did not say: such a supplier is not
 *   offered as "move both", and a home with it in its first year gets the
 *   plain warning instead of figures.
 * dual_welcome: only where the supplier's own page states it; 0 otherwise.
 */
export const GAS_TARIFFS = [
  {
    supplier: 'Bord Gáis Energy', unit: 0.1117, standing: 131.69,
    gas_discount: 0.09, dual_discount: 0.17, dual_welcome: 0,
    price_change: { effective_date: '2026-10-09', pct: 0.1065, standing_pct: 0.0701,
      note: 'Gas 11.17c → 12.36c, standing €131.69 → €140.92 from 9 Oct 2026.' },
    source: ['https://www.bordgaisenergy.ie/home/our-tariffs', 'https://www.bordgaisenergy.ie/home/compare-dual-fuel-price-plans'],
    verified_date: '2026-10-04',
  },
  {
    supplier: 'Electric Ireland', unit: 0.1224, standing: 149.71,
    gas_discount: 0.10, dual_discount: 0.16, dual_welcome: 0,
    notes: 'Standard rate from the discounted prices shown (11.016c at 10% off; 10.281c at 16% off). Standing charge worked out from the published €1,499 estimated annual bill for 11,000 kWh; not printed on the page.',
    source: ['https://www.electricireland.ie/residential/electricity-and-gas/gas-price-plans', 'https://www.electricireland.ie/residential/electricity-and-gas/dual-fuel-price-plans'],
    verified_date: '2026-10-04',
  },
  {
    supplier: 'Energia', unit: 0.1256, standing: 141.60,
    gas_discount: 0.10, dual_discount: null, dual_welcome: 0,
    notes: 'Standard rate from 12 Oct 2026: 11.52c and €129.91 ex VAT. The dual-fuel discount is behind a tab the read did not open.',
    source: ['https://www.energia.ie/about-energia/our-tariffs', 'https://www.energia.ie/energy-plans/gas'],
    verified_date: '2026-10-04',
  },
  {
    supplier: 'SSE Airtricity', unit: 0.1138, standing: 152.31,
    gas_discount: 0.16, dual_discount: null, dual_welcome: 0,
    notes: 'Gas only: 16% off the 11.38c standard rate (9.56c). No dual-fuel page found.',
    source: ['https://www.sseairtricity.com/ie/home/products/gas/'],
    verified_date: '2026-10-04',
  },
  {
    supplier: 'Flogas', unit: 0.1269, standing: 170.84,
    gas_discount: null, dual_discount: 0.28, dual_welcome: 0,
    notes: 'Dual Fuel 28% Loyalty Discount: gas 9.14c and standing €170.84 as shown; the standard rate is worked back from the 28%.',
    source: ['https://www.flogas.ie/price-plans/'],
    verified_date: '2026-10-04',
  },
];
