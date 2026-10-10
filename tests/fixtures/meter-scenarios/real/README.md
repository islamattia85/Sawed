# Real homes

A place for real meter files, scored the same way as the made-up homes. The
made-up homes test the app against known answers; real ones test the
answers themselves, on homes nobody designed.

Two are planned:

| Home | Files | What can be scored |
|---|---|---|
| `owner`: the owner's home | ESB meter file and a Sigenergy export (generation, sales, home use) | use, bills, best plan, payback |
| `tester`: the tester's home | ESB meter file, MPRN removed | bills and best plan (use and payback need generation data) |

## Adding one

1. Make a folder `real/private/<id>/` (git ignores `real/private/`).
2. Put in it:
   - the ESB file: esbnetworks.ie, My Meter, Downloads, "30-minute readings in kW";
   - if there is one, the Sigenergy export: mySigen, the energy statistics for
     the same twelve months, at the finest interval it offers (five minutes,
     fifteen or an hour), CSV or Excel;
   - `home.json`, from `home.example.json`: the answers the person would give
     in setup, and the system as installed (each roof face as
     `[panels, direction in degrees, pitch]`, panel watts, battery kWh, price
     paid, grant).
3. Run `python3 tests/fixtures/meter-scenarios/real/add_home.py tests/fixtures/meter-scenarios/real/private/<id>`.

It prints what it found: the Sigenergy columns it read, how far apart the rows
are, whether they are stamped at the start or end of each interval (found by
lining the sales up with the meter file's), and the bought and sold totals from
both files side by side. If those totals are far apart, the two files are not
the same months or the same home: stop there.

It writes, inside `real/private/`: the meter file with its MPRN and meter
serial replaced (`files/<id>.csv.gz`), the home's true figures
(`truth.json`) and its scenario `R-<id>` (`scenarios.json`).

## Running and scoring

    SCENARIO_OUT=/tmp/real npx playwright test meter-scenarios --grep @real
    python3 tests/fixtures/meter-scenarios/score.py /tmp/real

The scenario is the same as every other: upload the file, answer setup as
`home.json` says, then compare what the app concludes with the truth.

## How the truth is worked out

- **Bills on every plan**: the meter file's last twelve months, priced half
  hour by half hour as the coming year, with the frozen plan list
  (`price.py`, as for the made-up homes). Exact for "the same year again".
- **The home's own use**: the Sigenergy home-use column over the same months,
  or, without one, bought + generated - sold - battery charge + battery
  discharge.
- **The solar saving and payback**: the cheapest plan for the home's own use
  with no panels, less the cheapest for what the meter bought and sold; the
  price after grant over that.

`add_home.py --selftest` runs all of this on a made-up home (the tester's case
rebuilt) with a Sigenergy-style file made from it, and checks the answers
against the stored truth. Run it after changing anything here.

## Real months against the app's

A home with only some months of its system at work (no full year yet) can still
be checked: list it in `real/private/actuals.json` with its meter file, its
answers, its system and the months its own system recorded (made, used, bought,
sold). Then

    SCENARIO_OUT=/tmp/real npx playwright test real-actuals

sets the app's months beside the real ones. Weather and habits differ from the
typical year the app plans for, so the months are reported, not held to a
tolerance. What is held: the plan the home is on is priced with the battery
filling in its cheap hours, as every figure says. Where the private file is not
there, the test skips itself.

## Privacy

Half-hourly readings show when a household is in, out and asleep, even with
the MPRN gone. So real homes stay in `real/private/` and out of git, and the
golden test in CI does not see them. To put one in the golden test, its owner
has to agree to the anonymised file being in the repository. Then move
`files/<id>.csv.gz` to `../files/`, its entries into `../truth.json` and
`../scenarios.json`, and add `R-<id>` to `make_golden.py`. The tester's file
needs the tester's say-so.
