// @ts-check
// Every meter-file scenario, run as a person would, for the meter-file report.
// Not part of the normal suite (tagged @scenarios): run it with
//   SCENARIO_OUT=/some/dir npx playwright test meter-scenarios --grep @scenarios
// and score the results with tests/fixtures/meter-scenarios/score.py.
import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SCENARIOS, runScenario } from './run-scenario.js';

const OUT = process.env.SCENARIO_OUT;

for (const sc of SCENARIOS) {
  test(`${sc.id}: ${sc.title} @scenarios`, async ({ page }) => {
    test.setTimeout(180_000);
    if (!OUT) test.skip(true, 'set SCENARIO_OUT to run the scenarios');
    mkdirSync(`${OUT}/shots`, { recursive: true });
    const r = await runScenario(page, sc, `${OUT}/shots`);
    writeFileSync(`${OUT}/${sc.id}.json`, JSON.stringify(r, null, 1));
  });
}
