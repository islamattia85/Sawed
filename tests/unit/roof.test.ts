/**
 * Roof capacity was the biggest lever in a recommendation and, until this
 * existed, a constant I invented. The search kept returning "as many panels as
 * will fit", which means the answer was being decided by my assumption rather
 * than by the economics — and nobody was told.
 *
 * These tests are mostly about staying inside the bounds of what an installer
 * would actually put on these houses. An estimate that is roughly right is
 * worth a great deal here; one that is confidently wrong is worse than the
 * constant, because it looks like knowledge.
 */

import { describe, it, expect } from 'vitest';
import {
  estimateRoof, estimateRoofCapacity, usablePlanesFor,
  DEFAULT_PANEL_AREA_M2, type Dwelling,
} from '../../src/engine/roof.js';

describe('roof capacity from the kind of house', () => {
  it('puts a typical Irish home in the range installers actually fit', () => {
    // A 3-bed semi is the modal Irish house and the modal domestic install is
    // around 4 kWp. If this bracket ever breaks, the estimate has drifted away
    // from the market rather than the market from the estimate.
    const semi = estimateRoofCapacity({ dwelling: 'semi-detached', bedrooms: 3 }, 440);
    expect(semi.maxPanels).toBeGreaterThanOrEqual(8);
    expect(semi.maxPanels).toBeLessThanOrEqual(13);
    expect(semi.maxKwp).toBeGreaterThan(3);
    expect(semi.maxKwp).toBeLessThan(6);
  });

  it('gives a bungalow far more roof than a two-storey house of the same size', () => {
    // Same floor area, one storey instead of two: twice the footprint, twice
    // the roof. This is the single biggest differentiator and it is why the
    // question is asked at all.
    const bungalow = estimateRoof({ dwelling: 'bungalow', bedrooms: 3 });
    const semi = estimateRoof({ dwelling: 'semi-detached', bedrooms: 3 });
    expect(bungalow.footprintM2).toBeGreaterThan(semi.footprintM2 * 1.8);
    expect(bungalow.maxPanels).toBeGreaterThan(semi.maxPanels * 1.8);
  });

  it('gives an apartment no roof, rather than a small one', () => {
    const flat = estimateRoofCapacity({ dwelling: 'apartment', bedrooms: 2 }, 440);
    expect(flat.maxPanels).toBe(0);
    expect(flat.maxKwp).toBe(0);
    expect(flat.assumptions.join(' ')).toMatch(/no roof of its own/i);
  });

  it('grows with bedrooms, and orders the house types the way reality does', () => {
    for (const d of ['terraced', 'semi-detached', 'detached', 'bungalow'] as Dwelling[]) {
      let prev = 0;
      for (const beds of [1, 2, 3, 4, 5, 6]) {
        const n = estimateRoof({ dwelling: d, bedrooms: beds }).maxPanels;
        expect(n, `${d} ${beds}-bed did not grow`).toBeGreaterThanOrEqual(prev);
        prev = n;
      }
    }
    const at = (d: Dwelling) => estimateRoof({ dwelling: d, bedrooms: 3 }).maxPanels;
    expect(at('terraced')).toBeLessThan(at('semi-detached'));
    expect(at('semi-detached')).toBeLessThan(at('detached'));
    expect(at('detached')).toBeLessThan(at('bungalow'));
  });

  it('counts both faces of an east–west roof and one of a north–south one', () => {
    const one = estimateRoof({ dwelling: 'semi-detached', bedrooms: 3, usablePlanes: 1 });
    const two = estimateRoof({ dwelling: 'semi-detached', bedrooms: 3, usablePlanes: 2 });
    expect(two.maxPanels).toBe(one.maxPanels * 2);

    // A ridge running east–west shows a south face and a north face: one is
    // useful. A ridge running north–south shows east and west: both are.
    expect(usablePlanesFor(180)).toBe(1);   // due south
    expect(usablePlanesFor(150)).toBe(1);
    expect(usablePlanesFor(90)).toBe(2);    // due east
    expect(usablePlanesFor(270)).toBe(2);   // due west
    expect(usablePlanesFor(0)).toBe(2);     // due north — the ridge runs E–W
    expect(usablePlanesFor(-90)).toBe(2);   // negative angles normalise
    expect(usablePlanesFor(540)).toBe(1);   // and so do angles over 360
  });

  it('gives a steeper roof more area than a flatter one', () => {
    const flat = estimateRoof({ dwelling: 'detached', bedrooms: 4, pitchDeg: 15 });
    const steep = estimateRoof({ dwelling: 'detached', bedrooms: 4, pitchDeg: 45 });
    expect(steep.roofPlaneM2).toBeGreaterThan(flat.roofPlaneM2);
  });

  it('never claims the whole roof', () => {
    for (const d of ['terraced', 'semi-detached', 'detached', 'bungalow'] as Dwelling[]) {
      const r = estimateRoof({ dwelling: d, bedrooms: 4 });
      // Chimneys, vents, roof windows and the setback at every edge.
      expect(r.usableM2).toBeLessThan(r.roofPlaneM2 * 0.75);
      expect(r.maxPanels * DEFAULT_PANEL_AREA_M2).toBeLessThanOrEqual(r.usableM2);
    }
  });

  it('says how it got there, and how sure it is', () => {
    const r = estimateRoof({ dwelling: 'detached', bedrooms: 4 });
    expect(r.assumptions.length).toBeGreaterThan(2);
    expect(r.assumptions.join(' ')).toMatch(/4-bedroom detached/);
    expect(r.assumptions.join(' ')).toMatch(/\d+°/);

    // A detached house of a given bedroom count varies far more in size than a
    // terrace of the same count, and the confidence has to admit that.
    expect(estimateRoof({ dwelling: 'detached', bedrooms: 4 }).confidence)
      .toBeLessThan(estimateRoof({ dwelling: 'terraced', bedrooms: 4 }).confidence);
  });

  it('survives nonsense without inventing a roof', () => {
    // Missing or nonsense falls back to the modal Irish home, not to the
    // smallest one: sizing someone's roof for a bedsit because a shared link
    // arrived malformed is a worse failure than sizing it for an average house.
    expect(estimateRoof({ dwelling: 'semi-detached', bedrooms: 0 }).maxPanels)
      .toBe(estimateRoof({ dwelling: 'semi-detached', bedrooms: 3 }).maxPanels);
    expect(estimateRoof({ dwelling: 'semi-detached', bedrooms: 99 }).maxPanels)
      .toBe(estimateRoof({ dwelling: 'semi-detached', bedrooms: 6 }).maxPanels);
    expect(estimateRoof({ dwelling: 'semi-detached', bedrooms: NaN }).maxPanels)
      .toBe(estimateRoof({ dwelling: 'semi-detached', bedrooms: 3 }).maxPanels);
  });
});
