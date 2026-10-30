/**
 * When a cheaper plan is worth the switch (30 Oct 2026). Below €20 a year,
 * changing supplier isn't worth the bother, and every screen says so in the
 * same words. The answer at the end of setup said "€17 less a year by
 * switching" while Home, one tap later, said the plan was already the best
 * value; the report and the share card said to switch.
 */
export const SWITCH_WORTH = 20;

export const worthSwitching = (saving: number): boolean => saving >= SWITCH_WORTH;
