# S039 — Making OpenJev better + new framings: calibration, trained head, prompt, scenarios, chart lows (A129, 2026-10-17)

**Question (Jamie 10-17):** S037/S038 said "mostly no". Can OpenJev be trained/improved, and does it help with scenario analysis or
spotting lows/highs? Local 26B, $0. Timestamp convention: L1 time split (train Jul–Aug, test Sep–Oct, S037 conventions);
C5 realized betas Jul 2025–Oct 2026 (descriptive, same-window); L4 anonymous charts, outcomes = next 10 sessions, time split.
Re-run: `analysis/s039_openjev_train.py`, `openjev_controls.py --scenarios / --peers-v2`, `analysis/s039_chart_lows.py --prep/--ask/--report`.

| Lever / framing | Result | Verdict |
|---|---|---|
| L1 calibration (Platt on our labels) | materiality Brier 0.063 → 0.040; direction 0.355 → 0.249 (raw answers are overconfident; calibrated ones are honest) | **adopt for any OpenJev probability shown** |
| L1 trained head on OpenJev answers (frozen model, logistic head) | big-move day AUC 0.66 vs non-LLM baseline 0.63 (test: 873 ticker-days, ~35 big moves); direction AUC 0.50–0.53 | small gain on materiality; needs more labels |
| L3 better prompt for peers (+ financials + 3 example members per option) | hard cases 27 → 32 / 39; random names unchanged (128–129/150; sector level 91 %) | **adopt in the peer audit (A148)** |
| L3 think mode (reasoning before the read) | ~40 s vs 1.5 s per company; stopped (impractical for batch) | only for a handful of hard cases |
| C5 scenario exposure (10 scenarios × 553 companies vs realized factor beta beyond SPY) | oil +0.35, housing +0.37, AI +0.29, consumer +0.20 rank corr; within peer group +0.10…+0.18 (adds info); peer-group average beta stronger (+0.53…+0.78); gold/crypto: answers "little effect" for ~all | **use with realized betas** (scenario panel, A149) |
| L4 lows/highs from anonymous 60-day candle charts (600) | OpenJev AUC 0.46–0.48; price-rule model 0.47–0.52; neither beats base-rate Brier | **no** — the signal is not in price shape (matches S004), not an OpenJev limit |

**Training options left:** fine-tuning the 26B is not practical on the Mac; fine-tuning OpenJev's small encoders (Laya 421M / Verdict 151M)
on our labels is (torch install; labels from S037/S038 + a one-off Claude-labelled set ~500 items ≈ $1 — the jev-align / JevForge pattern).

## Raw output
```
S039 L1: 1698 pre-open ticker-days (825 train Jul–Aug, 873 test Sep–Oct); big-move base rate test 0.040

## Materiality (|z| > 2): test-period AUC / Brier
  raw OpenJev P(material) alone      AUC 0.619  Brier 0.063  (uncalibrated)
  Platt-calibrated P(material)                       AUC 0.619  Brier 0.0398
  trained head on OpenJev answers                    AUC 0.660  Brier 0.0391
  non-LLM baseline (news count, size, kw, 'earnings') AUC 0.632  Brier 0.0398
  both                                               AUC 0.641  Brier 0.0400
  (always base rate Brier 0.0402)

## Direction (abnormal return > 0 on the ticker-day): test AUC / Brier
  raw OpenJev (P(good) + 1 − P(bad)) / 2    AUC 0.532  Brier 0.3553
  Platt-calibrated OpenJev direction                 AUC 0.530  Brier 0.2493
  trained head on OpenJev answers                    AUC 0.500  Brier 0.2543
  keyword baseline                                   AUC 0.528  Brier 0.2488
  both                                               AUC 0.502  Brier 0.2538
  (always 50/50 Brier 0.2500)

C5: 553 companies × 10 scenarios. Rank corr of OpenJev exposure (helped − hurt) with realized factor beta (beyond the market), all names / within peer group; baseline = peer-group average beta (leave-one-out)
  oil       (USO    ) all +0.35  within-group +0.18  peer-group baseline +0.53  top-10% vs bottom-10% beta +0.14 vs -0.11  | spread of answers: 253/553 non-neutral
  rates     (TLT    ) all +0.05  within-group +0.11  peer-group baseline +0.59  top-10% vs bottom-10% beta -0.16 vs -0.37  | spread of answers: 547/553 non-neutral
  dollar    (UUP    ) all -0.06  within-group +0.15  peer-group baseline +0.57  top-10% vs bottom-10% beta -0.37 vs -0.16  | spread of answers: 446/553 non-neutral
  china     (FXI    ) all +0.04  within-group +0.10  peer-group baseline +0.54  top-10% vs bottom-10% beta +0.34 vs +0.08  | spread of answers: 296/553 non-neutral
  gold      (GLD    ) all -0.04  within-group +0.00  peer-group baseline +0.69  top-10% vs bottom-10% beta +0.40 vs +0.15  | spread of answers: 18/553 non-neutral
  ai        (SMH    ) all +0.29  within-group +0.18  peer-group baseline +0.75  top-10% vs bottom-10% beta +0.61 vs -0.22  | spread of answers: 198/553 non-neutral
  crypto    (IBIT   ) all -0.07  within-group +0.04  peer-group baseline +0.59  top-10% vs bottom-10% beta +0.15 vs +0.06  | spread of answers: 14/553 non-neutral
  consumer  (XLY-XLP) all +0.20  within-group +0.04  peer-group baseline +0.78  top-10% vs bottom-10% beta +0.09 vs -0.15  | spread of answers: 310/553 non-neutral
  housing   (XHB    ) all +0.37  within-group +0.18  peer-group baseline +0.74  top-10% vs bottom-10% beta +0.40 vs +0.02  | spread of answers: 135/553 non-neutral
  credit    (HYG    ) all -0.13  within-group +0.02  peer-group baseline +0.68  top-10% vs bottom-10% beta -1.85 vs -1.26  | spread of answers: 480/553 non-neutral

  v1 (description only)                      hard cases right 27/39   random names = current group 129/150 (sector level 136/150)
  v2 (+ financials + example members)        hard cases right 32/39   random names = current group 128/150 (sector level 137/150)
  hard-case misses: DDD→it_hardware_networking, HIMS→health_insurance_managed_care, MSCI→asset_management_alt_finance, MSFT→enterprise_software_cloud, SNDK→it_hardware_networking, SVM→base_metals_mining, VNET→reits_data_center_tower

S039 L4: 600 anonymous charts; train < 2026-04-06 (300), test ≥ 2026-04-06 (300)
  low_holds  base 0.17 | OpenJev raw AUC 0.460 Brier 0.535 · calibrated Brier 0.146 | price-rule model AUC 0.515 Brier 0.145 | both AUC 0.474 Brier 0.147 | always-base Brier 0.143
  high_holds base 0.18 | OpenJev raw AUC 0.484 Brier 0.212 · calibrated Brier 0.156 | price-rule model AUC 0.485 Brier 0.159 | both AUC 0.480 Brier 0.159 | always-base Brier 0.153
  up10       base 0.47 | OpenJev raw AUC 0.472 Brier 0.421 · calibrated Brier 0.255 | price-rule model AUC 0.466 Brier 0.255 | both AUC 0.453 Brier 0.260 | always-base Brier 0.249
```
