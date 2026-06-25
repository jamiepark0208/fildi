import { db, peerGroups, peerGroupMembers, tickerRegistry } from "@workspace/db";

// ── ETF exclusions — never seeded as members ──────────────────────────────────
const ETF_EXCLUSIONS = new Set([
  "SMH","SOXX","IWM","QQQ","SPY","BIZD","JBBB","NVDY","SPCK","PSUS","HOOY","ARKG","CANE",
]);

// ── Dual-membership primary overrides ─────────────────────────────────────────
// For tickers that appear in multiple groups, this sets the canonical scoring group.
const DUAL_PRIMARY: Record<string, string> = {
  NVDA:  "technology.semiconductors_design",
  TSLA:  "consumer_discretionary.autos_evs",
  AMZN:  "technology.big_tech_platforms",
  SHOP:  "technology.consumer_internet_digital_media",
  BKNG:  "consumer_discretionary.travel_leisure_hospitality",
  COIN:  "fintech.digital_finance_payments",
  COST:  "consumer_discretionary.retail_home_general",
  WMT:   "consumer_discretionary.retail_home_general",
  LI:    "technology.chinese_tech",
  NIO:   "technology.chinese_tech",
  XPEV:  "technology.chinese_tech",
};

type GroupDef = {
  id:               string;
  name:             string;
  scoringMode:      string;
  metricExclusions: string[];
  lowConfidence:    boolean;
  tickers:          string[];
};

// ── Peer group definitions ────────────────────────────────────────────────────
const GROUPS: GroupDef[] = [
  { id: "technology.big_tech_platforms",               name: "Big Tech Platforms",                  scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["AAPL","MSFT","GOOGL","AMZN","META","NVDA","TSLA"] },
  { id: "technology.enterprise_software_cloud",        name: "Enterprise Software & Cloud",          scoringMode: "pre_revenue_ok",          metricExclusions: ["pe_ratio","peg","earningsYield"],                        lowConfidence: false, tickers: ["CRM","ORCL","SAP","NOW","ADBE","PLTR","HUBS","SNOW","DDOG","PANW","ZS","BOX","CRWD","WDAY","INTU","VEEV","TEAM","DOCU","MDB","NET","FTNT","MNDY","PATH","S","QLYS","RPD","TENB","CYBR"] },
  { id: "technology.consumer_internet_digital_media",  name: "Consumer Internet & Digital Media",    scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["NFLX","SPOT","PINS","SNAP","RDDT","ROKU","TTD","DUOL","SHOP","ETSY","WBD","DIS","UBER","LYFT","DASH","BKNG","YELP","MTCH","BMBL","GRAB","SE","MELI"] },
  { id: "technology.semiconductors_design",            name: "Semiconductors — Design",              scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["NVDA","AMD","INTC","AVGO","QCOM","ARM","MRVL","MU","ON","TXN","ADI","NXPI","SWKS","MCHP","MPWR","GFS","WOLF"] },
  { id: "technology.semiconductors_equipment_eda",     name: "Semiconductors — Equipment & EDA",     scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["ASML","AMAT","LRCX","KLAC","CDNS","SNPS","MKSI","AEIS","ENTG","ONTO","ACLS","CAMT","FORM","COHU"] },
  { id: "technology.semiconductor_foundry_specialty",  name: "Semiconductor Foundry & Specialty",    scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: true,  tickers: ["TSM","AAOI","KOPN","LITE","UMC","CEVA","SITM"] },
  { id: "technology.it_hardware_networking",           name: "IT Hardware & Networking",             scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["DELL","SMCI","CSCO","ANET","HPE","HPQ","NTAP","PSTG","JNPR","ZBRA"] },
  { id: "technology.chinese_tech",                     name: "Chinese Tech",                         scoringMode: "chinese",                 metricExclusions: ["roe"],                                                  lowConfidence: false, tickers: ["BABA","PDD","JD","BIDU","NIO","XPEV","LI","NTES","BILI","TME","ZTO","FUTU","VNET","TCOM"] },
  { id: "fintech.digital_finance_payments",            name: "Digital Finance & Payments",           scoringMode: "financial_mixed",         metricExclusions: ["pb_ratio"],                                             lowConfidence: false, tickers: ["PYPL","SQ","SOFI","COIN","AFRM","HOOD","UPST","TOST","BILL","FIS","FISV","GPN","FOUR","RELY","ADYEN","NU","PAGS"] },
  { id: "financials.large_banks",                      name: "Large Banks",                          scoringMode: "financial",               metricExclusions: ["ev_ebitda","grossMargin","ps_ratio","ev_revenue"],       lowConfidence: false, tickers: ["JPM","BAC","C","WFC","GS","MS","USB","PNC","SCHW","TFC","BK","STT"] },
  { id: "financials.regional_banks",                   name: "Regional Banks",                       scoringMode: "financial",               metricExclusions: ["ev_ebitda","grossMargin","ps_ratio","ev_revenue"],       lowConfidence: false, tickers: ["RF","FITB","KEY","CFG","HBAN","MTB","ZION","CMA","FHN","EWBC","WAL"] },
  { id: "financials.asset_management_alt_finance",     name: "Asset Management & Alt Finance",       scoringMode: "financial",               metricExclusions: ["ev_ebitda","grossMargin"],                               lowConfidence: false, tickers: ["BLK","BX","OWL","KKR","APO","ARES","CG","TPG","BAM","TROW","IVZ","BEN","AMG"] },
  { id: "financials.payment_networks_credit",          name: "Payment Networks & Credit",            scoringMode: "standard",                metricExclusions: ["pb_ratio"],                                             lowConfidence: false, tickers: ["V","MA","AXP","COF","DFS","SYF"] },
  { id: "financials.insurance",                        name: "Insurance",                            scoringMode: "insurance",               metricExclusions: ["ev_ebitda","grossMargin","ps_ratio"],                    lowConfidence: false, tickers: ["BRK.B","PGR","TRV","ALL","MET","AIG","AFL","CB","HIG","CINF","GL","AJG","MMC","AON","WTW"] },
  { id: "consumer_discretionary.restaurants_food_service", name: "Restaurants & Food Service",      scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["MCD","SBUX","CMG","CAVA","YUM","DPZ","WING","DRI","TXRH","SHAK","QSR"] },
  { id: "consumer_discretionary.retail_home_general",  name: "Retail — Home & General",             scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["HD","LOW","TGT","W","WMT","COST","DLTR","DG","ROST","TJX","FIVE","BURL","OLLI"] },
  { id: "consumer_discretionary.travel_leisure_hospitality", name: "Travel, Leisure & Hospitality", scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["AAL","DAL","UAL","LUV","RCL","CCL","NCLH","HLT","MAR","WYNN","LVS","MGM","ABNB","BKNG","EXPE"] },
  { id: "consumer_discretionary.autos_evs",            name: "Autos & EVs",                         scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["TSLA","F","GM","LCID","RIVN","TM","HMC","STLA","XPEV","LI","NIO"] },
  { id: "consumer_discretionary.apparel_luxury",        name: "Apparel & Luxury",                   scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["NKE","UAA","COTY","LULU","PVH","TPR","RL","DECK","ONON","CROX","SKX","VFC","HBI"] },
  { id: "consumer_discretionary.real_estate_platforms", name: "Real Estate Platforms",              scoringMode: "pre_revenue_ok",          metricExclusions: ["pe_ratio","peg","earningsYield"],                        lowConfidence: true,  tickers: ["OPEN","ZG","RDFN","RKT","COMP"] },
  { id: "consumer_staples.packaged_goods_beverages",    name: "Packaged Goods & Beverages",         scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["PG","KO","PEP","CL","KMB","CHD","MO","PM","STZ","BF.B","TAP","SAM","MNST","CELH"] },
  { id: "consumer_staples.food_grocery_agriculture",    name: "Food, Grocery & Agriculture",        scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["WMT","COST","KR","KHC","GIS","K","CPB","SJM","MDLZ","HSY","TSN","HRL","CAG","ADM","BG"] },
  { id: "healthcare.large_pharma",                      name: "Large Pharma",                       scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["LLY","MRK","ABBV","JNJ","PFE","BMY","AZN","NVO","GSK","SNY","RHHBY","ZTS"] },
  { id: "healthcare.large_biotech",                     name: "Large Biotech",                      scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["AMGN","GILD","REGN","VRTX","MRNA","BIIB","ALNY","BMRN","IONS"] },
  { id: "healthcare.health_insurance_managed_care",     name: "Health Insurance & Managed Care",    scoringMode: "healthcare_services",     metricExclusions: ["grossMargin"],                                          lowConfidence: false, tickers: ["UNH","ELV","CI","HUM","CNC","MOH","CVS"] },
  { id: "healthcare.medical_devices_equipment",         name: "Medical Devices & Equipment",        scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["BAX","ABT","MDT","SYK","ISRG","BSX","EW","DXCM","BDX","ZBH","HOLX","IDXX","A","TMO","DHR"] },
  { id: "healthcare.speculative_biotech",               name: "Speculative Biotech",                scoringMode: "speculative_pre_revenue", metricExclusions: ["pe_ratio","peg","earningsYield","roe","ev_ebitda","pb_ratio"], lowConfidence: false, tickers: ["DNA","NTLA","RXRX","CMPS","BNGO","GOSS","CRSP","BEAM","EDIT"] },
  { id: "industrials.aerospace_defense",                name: "Aerospace & Defense",                scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["BA","LMT","RTX","GD","NOC","HII","TDG","HWM","AXON","LHX","HEI"] },
  { id: "industrials.industrial_conglomerates_machinery", name: "Industrial Conglomerates & Machinery", scoringMode: "standard",            metricExclusions: [],                                                       lowConfidence: false, tickers: ["GE","CAT","HON","DE","MMM","EMR","ETN","ITW","ROK","PH","IR","DOV","OTIS","CMI","PCAR"] },
  { id: "industrials.waste_management_services",        name: "Waste Management & Services",        scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: true,  tickers: ["WM","RSG","WCN","CLH","ECOL"] },
  { id: "industrials.transportation_logistics",         name: "Transportation & Logistics",         scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["UNP","CSX","NSC","UPS","FDX","ODFL","SAIA","JBHT","XPO","CHRW"] },
  { id: "industrials.professional_services",            name: "Professional Services",              scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["ACN","SPGI","MCO","ICE","CME","NDAQ","MSCI","VRSK","FDS","BR"] },
  { id: "energy.integrated_oil_gas",                   name: "Integrated Oil & Gas",               scoringMode: "energy",                  metricExclusions: ["ps_ratio","grossMargin"],                               lowConfidence: false, tickers: ["XOM","CVX","COP","EOG","PXD","DVN","MPC","VLO","PSX","OXY","FANG","HES","APA","CTRA"] },
  { id: "energy.oilfield_services",                    name: "Oilfield Services",                  scoringMode: "energy",                  metricExclusions: ["ps_ratio","grossMargin"],                               lowConfidence: false, tickers: ["SLB","HAL","BKR","FTI","NOV","CHX","HP","RIG"] },
  { id: "energy.midstream_pipelines",                  name: "Midstream & Pipelines",              scoringMode: "energy",                  metricExclusions: ["pe_ratio","ps_ratio"],                                  lowConfidence: false, tickers: ["WMB","KMI","ET","EPD","MPLX","OKE","TRGP","AM","PAA"] },
  { id: "energy.clean_energy_renewables",              name: "Clean Energy & Renewables",          scoringMode: "speculative_ok",          metricExclusions: ["pe_ratio","peg"],                                       lowConfidence: false, tickers: ["CLNE","ENPH","FSLR","RUN","SEDG","PLUG","BE","NOVA","SHLS","ARRY"] },
  { id: "materials.precious_metals_mining",            name: "Precious Metals & Mining",           scoringMode: "mining",                  metricExclusions: [],                                                       lowConfidence: false, tickers: ["AU","SVM","NEM","GOLD","WPM","FNV","RGLD","AEM","KGC","AGI","PAAS","HL","CDE"] },
  { id: "materials.base_metals_mining",                name: "Base Metals & Mining",               scoringMode: "mining",                  metricExclusions: [],                                                       lowConfidence: false, tickers: ["FCX","BHP","RIO","VALE","TECK","SCCO","AA"] },
  { id: "materials.chemicals",                         name: "Chemicals",                          scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["LIN","APD","SHW","DD","DOW","ECL","PPG","RPM","CE","EMN","HUN","OLN","AXTA"] },
  { id: "materials.steel_industrial_metals",           name: "Steel & Industrial Metals",          scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["NUE","STLD","CLF","X","RS","ATI"] },
  { id: "real_estate.reits_data_center_tower",         name: "REITs — Data Center & Tower",        scoringMode: "reit",                    metricExclusions: ["pe_ratio","roe","grossMargin"],                         lowConfidence: false, tickers: ["AMT","EQIX","DLR","CCI","SBAC"] },
  { id: "real_estate.reits_diversified",               name: "REITs — Diversified",                scoringMode: "reit",                    metricExclusions: ["pe_ratio","roe","grossMargin"],                         lowConfidence: false, tickers: ["O","PLD","SPG","PSA","WELL","AVB","EQR","VTR","ARE","MAA","UDR","ESS","PEAK","NNN","STOR","SUI","ELS"] },
  { id: "utilities.electric_utilities",                name: "Electric Utilities",                 scoringMode: "utility",                 metricExclusions: ["revenue_growth"],                                       lowConfidence: false, tickers: ["PCG","NEE","DUK","SO","D","AEP","EXC","SRE","XEL","WEC","ED","ES","FE","PPL","CMS","DTE","AES","ATO","NI"] },
  { id: "utilities.water_gas_multi_utilities",         name: "Water, Gas & Multi-Utilities",       scoringMode: "utility",                 metricExclusions: ["revenue_growth"],                                       lowConfidence: false, tickers: ["AWK","WTR","WTRG","SWX","NJR","OGS","SR"] },
  { id: "telecom.telecommunications",                  name: "Telecommunications",                 scoringMode: "standard",                metricExclusions: [],                                                       lowConfidence: false, tickers: ["VZ","TMUS","LUMN","T","CHTR","CMCSA","DISH"] },
  { id: "speculative_thematic.space_aerospace_tech",   name: "Space & Aerospace Tech",             scoringMode: "speculative_pre_revenue", metricExclusions: ["pe_ratio","peg","earningsYield","roe","ev_ebitda","pb_ratio"], lowConfidence: false, tickers: ["RKLB","JOBY","ACHR","LUNR","ASTS","RDW","SPCE","SPCX"] },
  { id: "speculative_thematic.crypto_digital_assets",  name: "Crypto & Digital Assets",            scoringMode: "speculative_crypto",      metricExclusions: ["pe_ratio","peg","roe"],                                 lowConfidence: false, tickers: ["MARA","RIOT","CLSK","MSTR","COIN","HUT","BITF","IREN"] },
  { id: "speculative_thematic.speculative_small_cap",  name: "Speculative Small Cap",              scoringMode: "speculative_pre_revenue", metricExclusions: ["pe_ratio","peg","earningsYield","roe","ev_ebitda","pb_ratio"], lowConfidence: true,  tickers: ["DDD","BB","RUM","SOUN","POET","QSI","TEM","REBN","BULL","ONDS","LDI","SG","PN","LQDA","SUPX"] },
];

async function main() {
  // 1. Upsert peer groups
  for (const g of GROUPS) {
    await db.insert(peerGroups).values({
      id:               g.id,
      name:             g.name,
      scoringMode:      g.scoringMode,
      metricExclusions: g.metricExclusions.length ? g.metricExclusions : null,
      benchmarks:       null,
      lowConfidence:    g.lowConfidence,
    }).onConflictDoUpdate({
      target: peerGroups.id,
      set: {
        name:             g.name,
        scoringMode:      g.scoringMode,
        metricExclusions: g.metricExclusions.length ? g.metricExclusions : null,
        lowConfidence:    g.lowConfidence,
      },
    });
  }
  console.log(`✓ ${GROUPS.length} groups upserted`);

  // 2. Upsert members (skip ETFs)
  let memberCount = 0;
  for (const g of GROUPS) {
    const eligible = g.tickers.filter(t => !ETF_EXCLUSIONS.has(t));
    for (const ticker of eligible) {
      await db.insert(peerGroupMembers).values({ groupId: g.id, ticker }).onConflictDoNothing();
      memberCount++;
    }
  }
  console.log(`✓ ${memberCount} member rows upserted`);

  // 3. Upsert ticker_registry with primary_peer_group_id
  // Collect all unique tickers and their primary group
  const primaryMap = new Map<string, string>();
  for (const g of GROUPS) {
    for (const ticker of g.tickers) {
      if (ETF_EXCLUSIONS.has(ticker)) continue;
      // Override with DUAL_PRIMARY if set; otherwise first-seen group wins
      if (DUAL_PRIMARY[ticker]) {
        primaryMap.set(ticker, DUAL_PRIMARY[ticker]);
      } else if (!primaryMap.has(ticker)) {
        primaryMap.set(ticker, g.id);
      }
    }
  }

  for (const [ticker, groupId] of primaryMap) {
    await db.insert(tickerRegistry).values({
      ticker,
      primaryPeerGroupId: groupId,
    }).onConflictDoUpdate({
      target: tickerRegistry.ticker,
      set: { primaryPeerGroupId: groupId },
    });
  }

  const uniqueTickers = primaryMap.size;
  console.log(`✓ ${uniqueTickers} unique tickers in registry`);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
