# A129 — what OpenJev says it needs (local 26B, 2026-10-16)
Self-report only: a hint. The ablation pass (`openjev_local.py --ablate`, table `watchlist_sync.openjev_ablation`) decides which field groups stay.

## advisory_fv (sample ticker COP)
To determine if fildi's fair value for COP is optimistic, here is the analysis:

*   **Most Helpful:** `[fair_value]` (for range, growth, and confidence), `[street]` (to compare vs. consensus), and `[earnings]` (to assess historical price reliability).*   **Noise to Drop:** `[weights]` and `[versions]` (these describe internal model mechanics/versioning, which don't validate the external accuracy of the valuation itself).*   **Missing Data:** Macro-commodity price forecasts (Oil/Brent/WTI) asofia (COP) is highly cyclical and specific political risk metrics for Colombia.

## advisory_weights (sample ticker RUN)
*   **Most Helpful Data:** `[weights]` (defines the model logic), `[market]` (shows extreme momentum/vol), `[tech]` (confirms bearish falling knife), and `[options]` (provides risk/reward metrics).*   **Noise to Drop:** `[model_list]` (redundant with scores) and `[street]` (single analyst PT update is too narrow for de-weighting).*   **Critical Missing Data:** LSEG data (to resolve the "falling-knife" flag), short interest (to check for a squeeze potential), and historical guidance (to validate the high EPS-growth metrics).

## direction_20d (sample ticker RUN)
*   **Most helpful data:** `[tech]` (bearish regime/falling MACD), `[market]` (negative momentum/volatility), `[options]` (put delta/support), and `[earnings]` (upcoming report catalyst).*   **Noise to drop:** `[weights]` (internal model mechanics), `[model_list]` (generic ranking), and `[fair_value]` (speculative classification).*   **Missing data:** LSEG synced data (to resolve the "falling knife" flag), short interest levels, and specific guidance for the Nov 4 earnings report.

## direction_5d (sample ticker RUN)
*   **Most helpful data:** `[market]` (trend/volatility), `[tech]` (bearish regime/RSI), and `[options]` (put support/delta). *   **Noise to drop:** `[weights]` (internal model logic), `[versions]`, and `[fair_value]` (long-term for a 5-day view). *   **Missing data:** Immediate technical support/resistance levels, order flow debalance, and specific macro-economic catalysts for the sector.

## drop_2sigma (sample ticker RUN)
*   **Most Helpful Data:** `[market]` (volatility/sigma), `[options]` (IV/delta/strike support), and `[tech]` (bearish regime/falling knife flag).*   **Noise to Drop:** `[scores]` (internal ranking logic), `[weights]` (model allocation parameters), and `[fair_value]` (speculative mode).*   **Critical Missing Data:** Historical tail risk (skew/fatness), short interest/short squeeze potential, and specific guidance trends for the Nov 4 earnings report.

## fv_vs_pt (sample ticker COP)
* **Most helpful data groups:** `[fair_value]` (provides the target and range), `[market]` (provides current price and momentum), `[street]` (provides consensus), and `[model_list]` (the overall verdict).* **Noise to drop:** `[weights]` (internal model mechanics) and `[options]` (specific trade data that doesn't shift fundamental valuation).* **Missing data that would help most:** Upcoming earnings dates/macro-guidance specific oil price forecasts, as COP is noted as a "cyclical" energy stock.* **Conclusion:** fildi's fair value is **too low** (the price of $141.73 is already 14% above the fair value of $124.82).

## model_pick_otm (sample ticker RUN)
* **Most Helpful Data:** `[options]` (delta, OTM %, IV), `[market]` (recent price action/volatility), and `[tech]` (bearish regime, RSI/MACD).* **Noise to Drop:** `[weights]` (internal model logic), `[fair_value]` (general classification), and `[model_list]` (generic ranking).* **Critical Missing Data:** LSEG data (to resolve the "falling knife" flag), short interest levels, and specific macro-economic catalysts for the sector.

## put_otm (sample ticker RGTI)
*   **Most helpful data:** `[options]` (delta, IV vs. RV), `[market]` (recent trend, volatility), and `[scores]` (bearish regime, RSI, "falling-knife" flag).*   **Noise to drop:** `[street]` (mean PT is disconnected from current price), `[fair_value]` (speculative mode), and `[weights]` (internal model-building logic).*   **Critical missing data:** Current order flow pressure at $11.50, short interest/cover, and specific news catalysts regarding the "CHIPS LOI."

## strike_touch (sample ticker RUN)
* **Most helpful data:** `[options]` (delta, premium, OTM distance), `[market]` (volatility and price trend), and `[tech]` (bearish regime and falling-knife flag).* **Noise to drop:** `[scores]` (general fund metrics), `[weights]` (internal model logic), and `[fair_value]` (speculative classification).* **Missing data needed most:** Historical support levels near $7.00, upcoming macro-economic catalysts, and specific sector-wide volatility trends.
