export const GAS_CARBON_TAX: number;
export function supplierKey(name: string): string;
export function gasPlanFor(supplier: string, gasTariffs: any[]): any;
export function gasRates(g: any, asOf?: Date): { unit: number; standing: number };
export function gasYear(g: any, kwh: number, discount?: number, asOf?: Date): number;
export function gasKwhFromBill(bill2m: number, g: any, discount?: number, asOf?: Date): number;
export function inFirstYear(contractEnd: string, asOf?: Date): boolean;
export function dualFuelChoices(elec: any, home: any, gasTariffs: any[], asOf?: Date): any;
