// Types for the parts of the model the unit tests import. The model itself
// is plain JavaScript; without these the type check stopped at the first
// test that imported it, and CI never reached the tests.
export let state: Record<string, any>;
export function setState(v: Record<string, any>): void;
export function exportTax(revenue: number): number;
export function calcSeaiGrant(kwp: number, batteryKwh: number): { panels: number; battery: number; total: number };
export function batterySwapYear(): number;
export function batteryReplacement(batteryKwh: number, r?: number): number;
export function meterYearDays(): (number[] | undefined)[] | null;
export function goalPanels(): number[];
export function pathValue(b0: number, b1: number, years: number, cost: number, batteryKwh: number): { value: number; saved: number; payback: number | null };
export function inverterFor(kwp: number): number;
