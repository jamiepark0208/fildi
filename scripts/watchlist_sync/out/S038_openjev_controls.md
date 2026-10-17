# S038 — OpenJev as a control layer: peers, data conflicts, macro voices, fair-value anchoring (A129, 2026-10-17)

**Question (Jamie 10-17):** forecasting failed (S037: no tradable edge). Can OpenJev check our data and assumptions instead?
Local openjev-latest (26B, MLX), $0. Re-run: `openjev_controls.py --peers / --peers-report / --divergence / --entities / --fv-placebo`
(cache `research/openjev/controls/`, gitignored). Timestamp convention: n/a (no forward returns; graded vs labels / placebo).

| Test | Labels | Result | Verdict |
|---|---|---|---|
| C1 peer groups (choice over 49 groups from the business description, 2 shuffled reads) | current mapping, 9 human fixes, FMP-industry majority baseline | 571 tickers: top-1 = current 82 % (top-3 91 %) vs baseline 68 %; reproduces 7/9 human fixes; 55 confident disagreements ≈ half real misfilings on Claude review | **pass → monthly peer audit + review queue** |
| C2 why sources disagree (357 `field_provenance.divergent`) | simple rules (×100/×1000, 2-of-3 agree) | agrees with rules 8/16; 176/357 "unclear"; never picks the odd source on outlier rows (0/12) | **fail** → rules + FactSet referee stay |
| C3 macro views by entity (1,279 entity-headline pairs from cached news) | Claude hand check of 40 | "own view" yes-sample ~60 % right (Fed rows noisiest), no-sample 15/15 right; stance sign right when the view is real | **partial** → usable as pre-filter + Claude/LLM summary, not alone |
| C4 fair-value placebo (80 names, 40 with ours vs street gap > 40 %) | placebo: our FV vs fake FV mirrored around price | answers track whatever target is shown: street-only corr 0.97 with street; with ours 0.96 with ours; with fake → follows fake (shift 2.9 of 4 buckets) | **fail** → anchors, cannot audit FV |

## Findings
- OpenJev is good at **classifying a thing from its description** (peer group, event type) and bad at **judging numbers** (FV, which vendor value is right).
- Without any target shown, its FV view runs opposite to ours (corr −0.49 with our FV/price): not graded (contamination; 60-day resolution).
- **Bugs found while building the tests (rules, not OpenJev):** 19 tickers are active in two peer groups — all 10 `peer_group_overrides`
  kept their old wrong membership (TER still in Enterprise Software, BP in Midstream…); Yahoo `dividendYield = 0` wins for dividend
  payers (NEE, DUK, D, AEP) → fund scores of utilities. Filed A147.
- Peer queue highlights (OpenJev ≥ 0.8, Claude agrees): CPB CAG GIS HRL HSY KHC MDLZ SJM → Packaged Goods; GE → Aerospace & Defense;
  TFC PNC → Regional Banks; GFS → Foundry; ATO → Gas utilities; CABA → Speculative Biotech; SG REBN → Restaurants; BB SOUN → Software;
  BULL → Digital Finance. Claude rejects: KGC SVM (gold/silver are precious metals), MSFT, SNDK (human fix), VNET (not a REIT),
  BNGO DDD (speculative on purpose). Filed A148 (peer moves change fund scores → Jamie OK + before/after).

## Raw output
```
C1 peers: 571 tickers. OpenJev top-1 = current group 466/571 (82%), top-3 91%; FMP-industry majority baseline 390/571 (68%)

Human fixes (peer_group_overrides): P(fixed group) vs P(old wrong group)
  BP    top=energy.integrated_oil_gas (1.00)  fixed=energy.integrated_oil_gas 1.00  old=energy.midstream_pipelines 0.00
  HIMS  top=healthcare.speculative_biotech (0.55)  fixed=technology.consumer_internet_digital_media 0.00  old=healthcare.large_pharma 0.00
  INGM  top=technology.it_hardware_networking (0.99)  fixed=technology.it_hardware_networking 0.99  old=technology.enterprise_software_cloud 0.00
  IOND  top=speculative_thematic.crypto_digital_assets (0.98)  fixed=speculative_thematic.crypto_digital_assets 0.98  old=financials.asset_management_alt_finance 0.00
  NBIS  top=technology.enterprise_software_cloud (0.92)  fixed=technology.enterprise_software_cloud 0.92  old=technology.consumer_internet_digital_media 0.01
  OKLO  top=energy.clean_energy_renewables (0.96)  fixed=energy.clean_energy_renewables 0.96  old=utilities.electric_utilities 0.00
  PBR   top=energy.integrated_oil_gas (1.00)  fixed=energy.integrated_oil_gas 1.00  old=energy.midstream_pipelines 0.00
  SKHY  top=technology.semiconductors_equipment_eda (0.72)  fixed=technology.semiconductors_design 0.10  old=speculative_thematic.speculative_small_cap 0.00
  SNDK  top=technology.it_hardware_networking (0.95)  fixed=technology.semiconductors_design 0.03  old=technology.it_hardware_networking 0.95
  TER   top=technology.semiconductors_equipment_eda (1.00)  fixed=technology.semiconductors_equipment_eda 1.00  old=technology.enterprise_software_cloud 0.00

Disagreements: 105 (≥ 0.8 confident: 55)
  1.00 CPB    Campbell Soup Company        cur=food_grocery_agriculture (0.00) → packaged_goods_beverages | fmp Packaged Foods
  1.00 SG     Sweetgreen, Inc.             cur=speculative_small_cap (0.00) → restaurants_food_service | fmp Restaurants
  1.00 GE     GE Aerospace                 cur=industrial_conglomerates_machinery (0.00) → aerospace_defense | fmp Aerospace & Defense
  1.00 MDLZ   Mondelez International, Inc. cur=food_grocery_agriculture (0.00) → packaged_goods_beverages | fmp Confectioners
  1.00 SHOP   Shopify Inc.                 cur=consumer_internet_digital_media (0.00) → enterprise_software_cloud | fmp Software - Application
  1.00 CAG    Conagra Brands, Inc.         cur=food_grocery_agriculture (0.00) → packaged_goods_beverages | fmp Packaged Foods
  1.00 TER    Teradyne, Inc.               cur=enterprise_software_cloud (0.00) → semiconductors_equipment_eda | fmp Semiconductor Equipment & Materials
  1.00 STT    State Street Corporation     cur=large_banks (0.00) → asset_management_alt_finance | fmp Asset Management
  1.00 BB     BlackBerry Limited           cur=speculative_small_cap (0.00) → enterprise_software_cloud | fmp Software - Infrastructure
  1.00 SOUN   SoundHound AI, Inc.          cur=speculative_small_cap (0.00) → enterprise_software_cloud | fmp Software - Application
  1.00 REBN   Reborn Coffee, Inc.          cur=speculative_small_cap (0.00) → restaurants_food_service | fmp Restaurants
  1.00 CABA   Cabaletta Bio, Inc.          cur=large_biotech (0.00) → speculative_biotech | fmp Biotechnology
  1.00 MSFT   Microsoft Corporation        cur=big_tech_platforms (0.00) → enterprise_software_cloud | fmp Software - Infrastructure
  0.99 TFC    Truist Financial Corporation cur=large_banks (0.00) → regional_banks | fmp Banks - Regional
  0.99 COST   Costco Wholesale Corporation cur=food_grocery_agriculture (0.00) → retail_home_general | fmp Discount Stores
  0.99 KGC    Kinross Gold Corporation     cur=precious_metals_mining (0.01) → base_metals_mining | fmp Gold
  0.99 MSCI   MSCI Inc.                    cur=professional_services (0.00) → asset_management_alt_finance | fmp Financial Data & Stock Exchanges
  0.99 KHC    The Kraft Heinz Company      cur=food_grocery_agriculture (0.00) → packaged_goods_beverages | fmp Packaged Foods
  0.99 PNC    The PNC Financial Services G cur=large_banks (0.00) → regional_banks | fmp Banks - Regional
  0.99 MCO    Moody's Corporation          cur=professional_services (0.00) → asset_management_alt_finance | fmp Financial Data & Stock Exchanges
  0.99 HSY    The Hershey Company          cur=food_grocery_agriculture (0.00) → packaged_goods_beverages | fmp Confectioners
  0.99 HRL    Hormel Foods Corporation     cur=food_grocery_agriculture (0.00) → packaged_goods_beverages | fmp Packaged Foods
  0.99 GIS    General Mills, Inc.          cur=food_grocery_agriculture (0.00) → packaged_goods_beverages | fmp Packaged Foods
  0.99 ZTO    ZTO Express (Cayman) Inc.    cur=chinese_tech (0.00) → transportation_logistics | fmp Integrated Freight & Logistics
  0.99 RUM    RUM Group Inc.               cur=speculative_small_cap (0.00) → consumer_internet_digital_media | fmp Internet Content & Information
  0.98 PN     PN Smart Energy Limited      cur=speculative_small_cap (0.00) → clean_energy_renewables | fmp Solar
  0.98 GILD   Gilead Sciences, Inc.        cur=large_biotech (0.00) → large_pharma | fmp Drug Manufacturers - General
  0.98 BILL   Bill.com Holdings, Inc.      cur=digital_finance_payments (0.02) → enterprise_software_cloud | fmp Software - Application
  0.98 VNET   VNET Group, Inc.             cur=chinese_tech (0.02) → reits_data_center_tower | fmp Information Technology Services
  0.98 BNGO   Bionano Genomics, Inc.       cur=speculative_biotech (0.00) → medical_devices_equipment | fmp Medical - Instruments & Supplies
  0.97 DDD    3D Systems Corporation       cur=speculative_small_cap (0.00) → it_hardware_networking | fmp Computer Hardware
  0.97 TCOM   Trip.com Group Limited       cur=chinese_tech (0.00) → travel_leisure_hospitality | fmp Travel Services
  0.97 NU     Nu Holdings Ltd.             cur=digital_finance_payments (0.03) → regional_banks | fmp Banks - Regional
  0.96 SVM    Silvercorp Metals Inc.       cur=precious_metals_mining (0.02) → base_metals_mining | fmp Silver
  0.95 BULL   Webull Corporation Class A O cur=speculative_small_cap (0.00) → digital_finance_payments | fmp Software - Application
  0.95 GFS    GLOBALFOUNDRIES Inc.         cur=semiconductors_design (0.00) → semiconductor_foundry_specialty | fmp Semiconductors
  0.95 SNDK   Sandisk Corporation          cur=semiconductors_design (0.03) → it_hardware_networking | fmp Computer Hardware
  0.95 SJM    The J. M. Smucker Company    cur=food_grocery_agriculture (0.05) → packaged_goods_beverages | fmp Packaged Foods
  0.94 SPGI   S&P Global Inc.              cur=professional_services (0.00) → asset_management_alt_finance | fmp Financial Data & Stock Exchanges
  0.94 ATO    Atmos Energy Corporation     cur=electric_utilities (0.03) → water_gas_multi_utilities | fmp Regulated Gas
  0.94 COTY   Coty Inc.                    cur=apparel_luxury (0.01) → packaged_goods_beverages | fmp Household & Personal Products
  0.93 BURL   Burlington Stores, Inc.      cur=retail_home_general (0.05) → apparel_luxury | fmp Apparel - Retail
  0.93 BK     The Bank of New York Mellon  cur=large_banks (0.02) → asset_management_alt_finance | fmp Investment - Banking & Investment Services
  0.92 ALOY   REalloys Inc.                cur=base_metals_mining (0.00) → precious_metals_mining | fmp Other Precious Metals
  0.92 NBIS   NBIS                         cur=consumer_internet_digital_media (0.01) → enterprise_software_cloud | fmp Internet Content & Information

  rule units: n=4  openjev agrees 4
  rule outlier: n=12  openjev agrees 4
  outlier rows: OpenJev picks the odd source 0/12 (should be 0)
  causes on rule-silent rows: [('unclear', 176), ('definition', 98), ('units', 46), ('outlier', 13), ('shares', 8)]
  OpenJev pick = current winning source on 50/357
   NI    grossProfit        unclear    pick=edgar    win=yahoo    edgar=1.211e+09
   ARES  sharesOutstanding  units      pick=edgar    win=yahoo    yahoo=2.22e+08 edgar=3.132e+08
   REBN  totalStockholdersEquity unclear    pick=fmp      win=fmp      fmp=4.646e+06
   CRWD  sharesOutstanding  units      pick=yahoo    win=yahoo    yahoo=1.024e+09 edgar=0
   NEE   dividendYield      outlier    pick=finnhub  win=yahoo    yahoo=0 finnhub=0.02945
   AAPL  roic               definition pick=none     win=yahoo    yahoo=0.8229 fmp=0.5197
   SPG   returnOnAssets     definition pick=yahoo    win=yahoo    yahoo=0.05562 finnhub=0.1276
   ARE   currentRatio       units      pick=none     win=yahoo    yahoo=2.35 finnhub=0.283
   FRSX  priceToBook        unclear    pick=none     win=yahoo    yahoo=0.655 finnhub=1.07
   SPCE  grossProfit        unclear    pick=edgar    win=yahoo    edgar=3.02e+06
   HOOD  roic               unclear    pick=none     win=yahoo    yahoo=0.1133 fmp=0.0755
   BR    grossProfit        unclear    pick=edgar    win=yahoo    edgar=1.423e+09
   COMP  priceToBook        unclear    pick=none     win=yahoo    yahoo=2.444 finnhub=7.599
   AMD   effectiveTaxRate   definition pick=yahoo    win=yahoo    yahoo=0.21 fmp=-0.02472
   CABA  currentRatio       unclear    pick=none     win=yahoo    yahoo=5.789 finnhub=2.769
   BRK.B currentRatio       definition pick=none     win=yahoo    yahoo=2.891 finnhub=1.344
   ETSY  roic               definition pick=fmp      win=yahoo    yahoo=0.359 fmp=0.1151
   LITE  sharesOutstanding  outlier    pick=edgar    win=yahoo    yahoo=8.97e+07 edgar=6.98e+07
   BAX   dividendYield      definition pick=yahoo    win=yahoo    yahoo=0.0017 finnhub=0.0322
   CDE   grossProfit        unclear    pick=edgar    win=yahoo    edgar=7.455e+07
   AMG   sharesOutstanding  unclear    pick=edgar    win=yahoo    yahoo=2.641e+07 edgar=5.85e+07
   AMG   currentRatio       units      pick=finnhub  win=yahoo    yahoo=65.55 finnhub=1.341
   AMGN  grossProfit        unclear    pick=edgar    win=yahoo    edgar=4.737e+09
   USAR  sharesOutstanding  outlier    pick=none     win=yahoo    yahoo=3.754e+08 edgar=1.481e+08
   USAR  returnOnEquity     unclear    pick=none     win=yahoo    yahoo=-0.2356 finnhub=-0.0775

  by entity: [('Burry', 58), ('Fed / Powell', 26), ('BofA / Hartnett', 15), ('Goldman Sachs', 12), ('Morgan Stanley', 9), ('JPMorgan / Dimon', 6), ('UBS', 6), ('Cathie Wood', 6), ('Bridgewater / Dalio', 5), ('Buffett / Berkshire', 3), ('Yardeni', 2), ('Citadel / Griffin', 2), ('BlackRock / Fink', 2)]

Sample for hand check (own-view yes):
  Burry                stocks    -1.00 | Michael Burry's Big Short Gets Broader: Nvidia-Heavy Chip ETF, Nasdaq Now in Focus
  Fed / Powell         rates     -0.01 | 3 US Dividend Stocks For Higher Rates Including Verizon Stock
  Burry                ai        -0.99 | Michael Burry reveals his verdict on the ongoing AI bubble
  Burry                ai        -1.00 | On Force Majeure And The Notable Insider Selling Across The AI Ecosystem
  Burry                stocks    -1.00 | ‘The Big Short’ Investor Michael Burry Says Stock Market’s Unusually Long Stretch Without a Broad Selloff Coul
  Burry                ai        -1.00 | Michael Burry Just Sent a New Warning to AI Investors
  Fed / Powell         inflation -0.06 | Why The Federal Reserve Might Hike Rates After The July CPI Report
  Morgan Stanley       ai        +1.00 | Here's What Morgan Stanley Says About Buying the AI Infrastructure Dip
  Burry                stocks    -1.00 | Michael Burry Buys NVDA Calls As A ‘Hedge,’ Adds To ORCL, PLTR, NBIS Shorts — Why He Thinks ‘Nvidia Will Not D
  UBS                  stocks    +1.00 | UBS Delivers Bullish Call on 10 Stocks With Up to 62% Upside
  Burry                ai        -1.00 | Michael Burry Warns Today's AI Boom Could Become Tomorrow's 'Ghost Towns' Despite Surging Demand
  UBS                  other     +0.99 | UBS projects the space economy’s TAM at $1.3TN by 2040
  Morgan Stanley       stocks    +1.00 | Nasdaq's Growth Outlook Supported by AI, Capital Markets Recovery, Morgan Stanley Says
  Burry                stocks    -1.00 | Michael Burry Sends Stark Warning on S&P 500 Crash
  Fed / Powell         fed       -0.00 | Alibaba, Walmart To Headline Earnings Next Week, FOMC Minutes Of Meeting In Focus
  Fed / Powell         rates     +0.85 | SoFi, WisdomTree, Ridgepost Capital, Ares, and S&P Global Shares Are Soaring, What You Need To Know
  Burry                stocks    +0.99 | Big Short Billionaire Goes Long: Michael Burry Avoids AI, Bets on Beaten own Stocks Instead
  Burry                ai        -1.00 | Michael Burry just named who can't afford an AI crash, and his bearish bets tell a different story
  Fed / Powell         rates     -0.94 | Nasdaq 100 Falls As Warsh Revives Rate Hike Bets: Stock Market Today
  BofA / Hartnett      stocks    +1.00 | Memory Chip Sales on Track to Top $2 Trillion By 2030: The Numbers Micron Bulls Need to Know
  Morgan Stanley       stocks    +1.00 | Morgan Stanley says software selloff has gone too far, names 8 winners
  Burry                ai        -1.00 | Michael Burry Said AI Bursts in 2028. One Weekend of Research Changed That
  BofA / Hartnett      growth    -0.24 | Wall Street Sells the AI-Pause Weekend as Brent Punches Through $106 and the Ten-Year Cracks 5% for the First 
  BlackRock / Fink     other     +0.00 | AI Debt Indigestion Forces Wall Street to Rethink Bond Sales
  Burry                stocks    -1.00 | 3 Stocks to Bet Against If You Want to Invest Like Michael Burry

Sample for hand check (own-view no):
  Morgan Stanley       own=0.04 | Morgan Stanley Destroys Bear Case Against Nebius. Proves The 35% Plunge Was a Huge Mistake
  Goldman Sachs        own=0.00 | Reweighting The Dow Jones Industrial Average
  UBS                  own=0.00 | Jim Cramer Says This Tech Stock Is Up 40% For The Year: It Is A ‘Great’ Company
  Burry                own=0.08 | Nebius Jumps 20% Days After Michael Burry Said His AI Shorts Were Like ‘Shooting Fish in a Barrel’
  Wells Fargo          own=0.00 | Wells Fargo Downgrades PG&E (PCG)
  BofA / Hartnett      own=0.00 | ON Semiconductor's revised Synaptics deal improves earnings outlook, says BofA
  Morgan Stanley       own=0.00 | Okta Stock Rises After Morgan Stanley Raises Price Target to $245
  Morgan Stanley       own=0.00 | Morgan Stanley Maintains Equal-Weight on Applied Materials, Lowers Price Target to $642
  BofA / Hartnett      own=0.00 | PG&E Facing California Wildfire Bill That Leaves Financing, Liability Concerns Unresolved, BofA Says
  Ackman               own=0.06 | Bill Ackman Sees an AI Bargain in the Company That Owns the New York Stock Exchange
  Morgan Stanley       own=0.00 | Morgan Stanley Maintains Equal-Weight on Waste Management, Lowers Price Target to $220
  Morgan Stanley       own=0.00 | Morgan Stanley Maintains Overweight on Halliburton, Lowers Price Target to $40
  Fed / Powell         own=0.29 | Dow Jones and S&P 500 set to notch new highs despite AMD and SpaceX falls
  Morgan Stanley       own=0.00 | Adobe, Salesforce and Intuit fall as Morgan Stanley begins cautious coverage
  BofA / Hartnett      own=0.06 | Apple Stock Falls After Bank of America Flags a New AI Threat

C4: 80 names (40 with |log(FV/PT)| > log 1.4). Answer = expected bucket 0 (well below) … 4 (well above price)
  nopt   mean 2.15  corr with street PT/price +0.14  with our FV/price -0.49  with fake FV/price +0.21
  public mean 2.94  corr with street PT/price +0.97  with our FV/price +0.08  with fake FV/price +0.06
  ours   mean 1.72  corr with street PT/price +0.08  with our FV/price +0.96  with fake FV/price -0.63
  fake   mean 2.29  corr with street PT/price -0.07  with our FV/price -0.98  with fake FV/price +0.61
  shift ours − fake (names where our FV > price, so fake < price): mean +2.87 buckets (0 = ignores the number)
```
