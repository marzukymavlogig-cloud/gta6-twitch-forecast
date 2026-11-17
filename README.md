# GTA VI Twitch CCU forecaster

Forecasts, hour by hour, how many people watch Grand Theft Auto VI live on
Twitch over the 24 UTC hours of its release day (2026-11-19), as five
quantiles an hour, from the first hour's print. Entry for make.fun
`gta6-twitch-ccu-forecast-01`. Node 22, standard library only, no network.

## How it works

`main.ts` reads every `*.in` case in `$MAKEFUN_INPUT_DIR` (else `/input`)
and writes `/output/<id>.out` (`$MAKEFUN_OUTPUT_DIR` when set): 23 rows,
hours 2..24, each five quantiles at levels 0.05 / 0.25 / 0.5 / 0.75 / 0.95.

The forecast is anchored on the case's hour-1 print and shaped by the
launch-day curves of past big launches — the `comparables` in the case file
(38 in a practice case, all 42 in the final). For each hour h, the model fits

    ln(viewers_h / viewers_1) ~ local-linear in ln(viewers_1)

by kernel-weighted local linear regression (Gaussian kernel, bandwidth 1.5
in log units) over the comparables, and takes the five quantiles from the
kernel-weighted residuals, widened 15% for honest coverage. The fitted
centre is clamped to the log-ratios actually observed that hour, so a first
hour far outside the reference range cannot extrapolate past anything any
launch ever did. With fewer than 5 usable reference launches for an hour,
that hour falls back to the house persistence shape. The program is a pure
function of the case file — no clock, no randomness — so two runs write
byte-identical output.

## Why this shape

The dominant empirical fact in the kit's data is that the day curve depends
on the size of the first hour. Across the 37 comparable launches with a full
release day, the correlation between ln(hour-1 viewers) and ln(viewers_h /
viewers_1) is −0.42 at hour 8, −0.76 at hour 12, −0.91 at hour 18 and −0.93
at hour 24. A small first hour means the unlock is still ahead (a
simultaneous global unlock later in the day), so the audience surges
10–100×; a large first hour means rolling midnight unlocks are already live
in many regions, so the day stays comparatively flat and peaks around
hours 19–20 (US evening) at roughly 2–2.4× the first hour. The median
ratio-to-hour-1 curve across all comparables dips to ~0.73 at hour 4, then
rises to ~2.4 at hours 19–20. Conditioning on ln(hour-1) captures this;
adding the pre-midnight hour's level or tier weights did not improve
leave-one-out loss, so the shipped model uses ln(hour-1) alone.

## Validation (leave-one-out over the kit's comparables)

Each comparable launch was forecast from its own hour-1 print using the
other 36 launches, and scored with the contest's pinball loss on the log
scale (lower is better):

| model | all 37 launches | launches with hour 1 in 20k..300k |
|---|---:|---:|
| house persistence baseline | 0.930 | 0.349 |
| this forecaster | **0.385** | **0.295** |

Typical median miss 74.8% (baseline 213%), 90% coverage 0.879 (baseline
0.624; an honest forecast covers ~0.90). The 20k..300k band is the regime
GTA VI's first hour is expected in: the four practice launches printed
23k (Wolverine), 117k (Red Dead Redemption 2), 270k (God of War Ragnarök)
and 119k (Spider-Man 2) in hour 1. Note the practice grade itself is scored
on those four launches, whose answers are not in the kit, so the numbers
above are the honest out-of-sample check available locally.

## Assumptions about GTA VI

- Releases 19 November 2026 on PlayStation 5 and Xbox Series X|S only
  (no PC at launch), single-player, rolling midnight-local unlock (New
  Zealand first at 2026-11-18 11:00 UTC; UK 00:00 UTC; US Eastern 05:00
  UTC; US Pacific 08:00 UTC). No early access. Source: the competition
  brief and the case files.
- The Twitch category already draws a pre-release audience: probed
  2026-11-17 at 1,240 viewers / 181 channels, and press trackers show a
  24-hour peak around 14k viewers in launch week.
- Scale sanity: the August 2026 gameplay reveal drew 3.97M peak viewers
  across platforms (Streams Charts), Twitch taking ~44% of hours watched;
  press estimates put launch-day peak Twitch viewership at roughly
  1.5–2.5M, against past launch peaks of ~1.14M (Cyberpunk 2077) and
  ~0.91M (Elden Ring). The model does not hard-code any of this — the
  hour-1 print sets the scale, and the comparables set the shape — but if
  hour 1 prints above ~1M, the model expects a comparatively flat day
  (peak ~1–2× hour 1), as the biggest first hours in the reference set
  behaved.
- Caveat: the final is a single draw. A launch of GTA VI's size has no
  exact precedent; the spread is widened 15% for that reason, and the
  forecast will still miss if the US unlock surge or the evening peak
  behaves unlike every prior launch.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out \
  node main.ts   # Node 22; --experimental-strip-types on older Node
```
