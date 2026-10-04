/**
 * Gas, one entry per supplier, for dual-fuel homes (src/gas-tariffs.json).
 * All € incl. 9% VAT; `unit` is the standard unit rate before any discount and
 * before the carbon tax (added in gas.js). Kept up to date by the daily check
 * (scraper/gas_check.py), which reads each supplier's own page and opens a
 * pull request when a figure changes.
 *
 * dual_discount: off the gas unit rate while a dual-fuel plan's first year
 *   runs. null when the supplier's page does not say: such a supplier is not
 *   offered as "move both", and a home with it in its first year gets the
 *   plain warning instead of figures.
 * dual_welcome: only where the supplier's own page states it; 0 otherwise.
 */
import data from './gas-tariffs.json';
export const GAS_TARIFFS = data;
