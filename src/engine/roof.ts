/**
 * How much roof is there?
 *
 * This turned out to be the single biggest lever in a recommendation, and
 * until now it was a constant I invented. The design search kept returning
 * "as many panels as will fit", which means the answer was being decided by an
 * assumption rather than by the economics — and the reader was never told.
 *
 * Asking directly does not work. Almost nobody knows their roof area in square
 * metres, and the ones who think they do are usually quoting the floor area of
 * the house. But everybody knows what kind of house they live in and how many
 * bedrooms it has, and that is enough to get within a panel or two: Irish
 * housing stock is unusually consistent, and floor area follows type and
 * bedroom count closely.
 *
 * The chain is: house type and bedrooms give floor area; storeys turn that
 * into a ground-floor footprint; the pitch turns the footprint into two roof
 * planes; obstructions and setbacks take a share; and a panel is 1.95 m².
 *
 * Every step is an estimate and the result says so — `confidence` and the
 * assumptions are returned alongside the number, because a figure this
 * load-bearing must be correctable by anyone who knows better.
 */

/** The house. Not the roof — nobody knows their roof. */
export type Dwelling =
  | 'apartment'
  | 'terraced'
  | 'semi-detached'
  | 'detached'
  | 'bungalow';

export interface RoofInputs {
  dwelling: Dwelling;
  /** Bedrooms, 1–6. The usual proxy for size. */
  bedrooms: number;
  /**
   * Roof planes usable for panels. A roof running east–west has two faces that
   * both work; one running north–south has one, because nobody puts panels on
   * the north side in Ireland. Defaults to 1, the conservative case.
   */
  usablePlanes?: 1 | 2;
  /** Roof pitch in degrees. Irish stock is mostly 30–35°. */
  pitchDeg?: number;
  /** Panel footprint in m². A 440 W panel is about 1.72 m x 1.13 m. */
  panelAreaM2?: number;
}

export interface RoofEstimate {
  /** Total internal floor area, m². */
  floorAreaM2: number;
  /** Ground-floor footprint, m². */
  footprintM2: number;
  /** Area of the usable roof plane(s) before obstructions, m². */
  roofPlaneM2: number;
  /** What is left after chimneys, vents, dormers, edge setbacks, m². */
  usableM2: number;
  /** Panels that fit. The number the search is limited by. */
  maxPanels: number;
  /** Those panels at the given wattage, kWp. */
  maxKwp: number;
  /** How much to trust it, 0–1. */
  confidence: number;
  /** Plain statements of every assumption, for the reader to check. */
  assumptions: string[];
}

/**
 * Typical total floor area in m², by dwelling type and bedroom count.
 *
 * Irish new-build and mid-century stock, rounded to the nearest 5 m². These
 * are medians, not minima: Part F minimum floor areas are considerably
 * smaller than what people actually live in.
 */
const FLOOR_AREA: Record<Dwelling, Record<number, number>> = {
  apartment:       { 1: 45,  2: 73,  3: 90,  4: 105, 5: 120, 6: 135 },
  terraced:        { 1: 55,  2: 75,  3: 92,  4: 110, 5: 125, 6: 140 },
  'semi-detached': { 1: 65,  2: 85,  3: 105, 4: 130, 5: 150, 6: 170 },
  detached:        { 1: 80,  2: 105, 3: 140, 4: 175, 5: 210, 6: 240 },
  bungalow:        { 1: 65,  2: 85,  3: 110, 4: 135, 5: 160, 6: 180 },
};

/** How that floor area is stacked. A bungalow puts all of it under one roof. */
const STOREYS: Record<Dwelling, number> = {
  apartment: 1,
  terraced: 2,
  'semi-detached': 2,
  detached: 2,
  bungalow: 1,
};

/**
 * Share of a roof plane that can actually carry panels.
 *
 * Chimneys, vents, soil pipes, roof windows, dormers, and the setback an
 * installer leaves at every edge. Terraced and semi-detached roofs lose
 * proportionally more because they are narrower, so the fixed edge losses are
 * a larger fraction, and party-wall chimney stacks land on them.
 */
const USABLE_FRACTION: Record<Dwelling, number> = {
  apartment: 0,
  terraced: 0.60,
  'semi-detached': 0.65,
  detached: 0.70,
  bungalow: 0.70,
};

export const DEFAULT_PANEL_AREA_M2 = 1.95;
export const DEFAULT_PITCH_DEG = 32;

/**
 * Bedrooms, made safe.
 *
 * Missing, zero or nonsense falls back to three — the modal Irish home — not
 * to one. A shared `?s=` link or a hand-edited store can arrive with anything
 * in it, and quietly sizing someone's roof for a bedsit is a worse failure
 * than quietly sizing it for an average house.
 */
const clampBeds = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return 3;
  return Math.min(6, Math.max(1, Math.round(n)));
};

export function estimateRoof(inputs: RoofInputs): RoofEstimate {
  const dwelling = inputs.dwelling;
  const bedrooms = clampBeds(inputs.bedrooms);
  const planes = inputs.usablePlanes ?? 1;
  const pitch = inputs.pitchDeg ?? DEFAULT_PITCH_DEG;
  const panelArea = inputs.panelAreaM2 ?? DEFAULT_PANEL_AREA_M2;

  const floorAreaM2 = FLOOR_AREA[dwelling]?.[bedrooms] ?? 105;
  const storeys = STOREYS[dwelling] ?? 2;
  const footprintM2 = floorAreaM2 / storeys;

  // A pitched roof is two planes over the footprint; each is half the
  // footprint stretched by the pitch.
  const onePlaneM2 = (footprintM2 / 2) / Math.cos((pitch * Math.PI) / 180);
  const roofPlaneM2 = onePlaneM2 * planes;

  const fraction = USABLE_FRACTION[dwelling] ?? 0.65;
  const usableM2 = roofPlaneM2 * fraction;
  const maxPanels = Math.max(0, Math.floor(usableM2 / panelArea));

  const assumptions: string[] = [];
  if (dwelling === 'apartment') {
    assumptions.push('An apartment has no roof of its own to use.');
  } else {
    assumptions.push(`A ${bedrooms}-bedroom ${dwelling.replace('-', ' ')} is typically about ${floorAreaM2} m² over ${storeys} storey${storeys > 1 ? 's' : ''}.`);
    assumptions.push(`Roof pitched at ${pitch}°, with ${planes === 2 ? 'both faces usable — an east–west roof' : 'one usable face'}.`);
    assumptions.push(`${Math.round(fraction * 100)}% of that face is clear of chimneys, vents and edge setbacks.`);
    assumptions.push(`Panels ${panelArea} m² each.`);
  }

  // Bedroom count predicts a detached house's size much less well than a
  // terrace's: detached homes vary enormously at the same bedroom count.
  const spread: Record<Dwelling, number> = {
    apartment: 1, terraced: 0.85, 'semi-detached': 0.8, detached: 0.6, bungalow: 0.65,
  };

  return {
    floorAreaM2,
    footprintM2: +footprintM2.toFixed(1),
    roofPlaneM2: +roofPlaneM2.toFixed(1),
    usableM2: +usableM2.toFixed(1),
    maxPanels,
    maxKwp: 0,          // filled by the caller, which knows the panel wattage
    confidence: spread[dwelling] ?? 0.7,
    assumptions,
  };
}

/** The same estimate, with kWp filled in for a given panel wattage. */
export function estimateRoofCapacity(inputs: RoofInputs, panelWatts: number): RoofEstimate {
  const est = estimateRoof(inputs);
  return { ...est, maxKwp: +((est.maxPanels * panelWatts) / 1000).toFixed(2) };
}

/**
 * Does this azimuth mean one usable roof face or two?
 *
 * A roof ridge running east–west presents a south face and a north face: one
 * is useful. A ridge running north–south presents east and west faces: both
 * work, and together they flatten the generation curve, which for a home that
 * uses power morning and evening is often better than a single south array.
 */
export function usablePlanesFor(azimuthDeg: number): 1 | 2 {
  const a = ((azimuthDeg % 360) + 360) % 360;
  const offSouth = Math.abs(a - 180);
  return offSouth > 60 ? 2 : 1;
}
