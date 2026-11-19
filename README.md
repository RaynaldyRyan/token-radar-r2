[![make.fun bounty](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/RaynaldyRyan/token-radar-r2/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/RaynaldyRyan/token-radar-r2/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar — round 2

A [make.fun bounty](https://make.fun/bounty/token-radar-01) entry: the best token launch radar.
It ranks every pre-token protocol in the sealed snapshot by implied launch value, shows how each
number was made, and gives every row a costed farm plan.

Round 1 ranked 183 protocols on a single median multiple and landed at judge 928,333. Round 2
rebuilds the model from the snapshot itself: a fitted two-stage model, honest validation, a ledger
that accounts for all 758 protocols, and a dense dashboard that derives everything in the browser
from the same board it prints.

## The model

Two stages, both fitted on the snapshot's own figures, never on a list of names.

**Stage A — launch FDV.** A ridge-shrunk log–log regression, log10(market cap) on log10(TVL) plus
relative 7d momentum, log10(age), log10(chain count) and sector dummies, fitted on 87 of the 128
traded-token comps (CoinGecko id, positive market cap, a listing date; CEX tokens excluded). Ridge λ=10, picked
by leave-one-out. Fitted:

```
log10(FDV) = 4.807 + 0.346·logTVL + 0.013·mom7d − 0.152·logAge − 0.051·logChains − 0.114·Lending + 0.050·RWA
```

**Stage B — token share by age.** The empirical share of protocols that record a token, by age bucket:
<6mo 0.264, 6–12mo 0.397, 1–2y 0.383, 2–3y 0.547, 3y+ 0.791, unknown age 0.549.
Implied value = token share × E[FDV]. The share is the observed cross-sectional share of same-age
protocols that have a token — a descriptive base rate, not a forward launch probability; the
validation numbers below validate the FDV fit (Stage A) only.

**Validation.** Leave-one-out median miss ×2.93 (38% within 2×, 52% within 3×) vs a flat median
multiple ×4.48 and a TVL-only power law ×3.08. Date-ordered holdout ×2.80 vs flat ×4.96 (n=44).
P25–P75 bands cover 49% of out-of-fold residuals, P10–P90 covers 79%. Rank ranges come from 200
bootstrap refits. 157 of 192 rows sit 5+ ranks off pure TVL order.

**The ledger.** Ranked 192 · token trades 128 · token on record 288 · bridge 43 · liquid staking 43 ·
exchange custody 42 · versioned 11 · wrapped or staked 5 · kin of a token 6 · unclear 0 = 758.

**Farm economics** (assumptions, labelled as such on the page): the farm pool is 20% of TVL, the
farmer share 10% of implied value, time $75/h, gas by first chain. At the $1,000 / 10% defaults the
board has 11 FARM, 15 THIN, 166 SKIP — most farms do not pay at these assumptions, and the page
says so. The What-if toggles (ticket, share, hurdle) recompute every verdict, slice and net.

## The board

| Rank | Protocol | Implied value |
| --- | --- | --- |
| 1 | Sentora Curator | $17.05M |
| 2 | Steakhouse Financial | $15.48M |
| 3 | Polymarket International | $14.26M |
| 4 | Gauntlet | $12.62M |
| 5 | Veda | $12.30M |

192 rows, all 40 watchlist slugs covered, total implied $831.65M.

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

`main.ts` reads the sealed snapshot, writes `/output/board.json`, the dashboard's data as
`/output/dashboard/data.js`, copies `dashboard/` and `screenshots/` to `/output`, and writes
`/output/dossier.json` with the vendored make.fun library. It refuses to finish when the board
fails a gate rule, when the dashboard's rows disagree with `board.json`, or when the dossier's
text would cut the source. Two runs write byte-identical output: ages are days from `listed_at`
to the snapshot's `as_of` date (2026-11-14), never the clock.

## Layout

- `main.ts` — the entry point: read, score, verify, write.
- `lib/model.ts` — the model, the validation, the farm economics, the board builder.
- `vendor/makefun-board.ts` — the make.fun dossier library, vendored from the kit.
- `dashboard/` — the page: `index.html`, `app.css`, `app.js`; `data.js` is written by `main.ts`.
  Vanilla JS and CSS only, no network. The page derives every per-row FDV, band and farm plan
  from the shared tables in `data.js`, and recomputes the parity checks in the browser.
- `screenshots/` — the board, a detail view, a filtered view (FARM).

## License

MIT — see [LICENSE](LICENSE).
