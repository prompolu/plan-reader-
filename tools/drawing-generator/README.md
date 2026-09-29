# Drawing generator (development tool)

Generates synthetic residential drawing sets — plans, elevations, sections,
door/window schedules, title blocks, metric and imperial — together with ground
truth describing exactly which openings, tags and dimensions are on each sheet.
It produced the demo project (`app/e2e/fixtures/residential_plans.pdf`, shipped
as the in-app demo) and the benchmark drawings in `app/benchmark/`.

It is not part of the app. Requires Python 3.10+:

```bash
pip install -r requirements.txt
python generate.py --out ../../app/benchmark
python generate.py --demo ../../app/e2e/fixtures/residential_plans.pdf
```
