<!-- url: https://massive.com/docs/llms.txt
fetched_at: 2026-10-24T17:11:11+00:00
title:  -->


```
# Massive

> Massive provides financial market data for stocks, options, indices, futures, forex, and crypto through a REST API, WebSocket streams, and S3 flat files.

## Getting started

Massive needs an API key. If the user doesn't have one (or you get a 401),
give them the signup link to register themselves:
https://massive.com/dashboard/signup

Their key is at https://massive.com/dashboard/keys. Have the user put it in the
MASSIVE_API_KEY env var and read it from there; don't ask them to paste
the key into chat or hardcode it.

## AI Tools

Connect AI agents and assistants to Massive data.

- [Massive MCP server](https://mcp.massive.com/): Remote server for MCP clients. The user signs in over OAuth, with nothing to install
- [ChatGPT Setup](https://massive.com/docs/ai-tools/clients/chatgpt.md): Connect Massive to ChatGPT
- [Claude Code Setup](https://massive.com/docs/ai-tools/clients/claude-code.md): Connect Massive to Claude Code
- [Claude Desktop Setup](https://massive.com/docs/ai-tools/clients/claude-desktop.md): Connect Massive to Claude Desktop
- [Codex Setup](https://massive.com/docs/ai-tools/clients/codex.md): Connect Massive to Codex
- [Cursor Setup](https://massive.com/docs/ai-tools/clients/cursor.md): Connect Massive to Cursor
- [Gemini CLI Setup](https://massive.com/docs/ai-tools/clients/gemini-cli.md): Connect Massive to Gemini CLI
- [GitHub Copilot Setup](https://massive.com/docs/ai-tools/clients/github-copilot.md): Connect Massive to GitHub Copilot
- [Grok Setup](https://massive.com/docs/ai-tools/clients/grok.md): Connect Massive to Grok
- [AI Tools Quickstart](https://massive.com/docs/ai-tools/quickstart.md): AI Tools Quickstart Guide
- [x402 Payments](https://massive.com/docs/ai-tools/x402.md): Buy US stock data per request over the x402 protocol, with no Massive account

## Flat Files

Bulk historical market data, delivered as daily files over S3.

- [Day Aggregates](https://massive.com/docs/flat-files/crypto/day-aggregates.md): Candlesticks with open, high, low, close, and volume at per day granularity across an expansive set of crypto pairings as a daily downloadable S3 file
- [Minute Aggregates](https://massive.com/docs/flat-files/crypto/minute-aggregates.md): Candlesticks with open, high, low, close, and volume at per minute granularity across an expansive set of crypto pairings as a daily downloadable S3 file
- [Crypto Overview](https://massive.com/docs/flat-files/crypto/overview.md): Massive provides comprehensive historical cryptocurrency market data through downloadable CSV Flat Files
- [Trades](https://massive.com/docs/flat-files/crypto/trades.md): Tick-level trades with nanosecond timestamps across an expansive set of crypto pairings, made available as a daily downloadable S3 file
- [Day Aggregates](https://massive.com/docs/flat-files/forex/day-aggregates.md): Candlesticks with open, high, low, close, and volume at per day granularity for over 1,750+ currency pairs, made available as a daily downloadable S3 file
- [Minute Aggregates](https://massive.com/docs/flat-files/forex/minute-aggregates.md): Candlesticks with open, high, low, close, and volume at per minute granularity for over 1,750+ currency pairs, made available as a daily downloadable S3 file
- [Forex Overview](https://massive.com/docs/flat-files/forex/overview.md): Massive provides extensive historical forex market data via downloadable CSV Flat Files
- [Quotes](https://massive.com/docs/flat-files/forex/quotes.md): Global foreign exchange rate quotes from major institutions for over 1,750+ currency pairs, made available as a daily downloadable S3 file
- [Minute Aggregates - CBOT](https://massive.com/docs/flat-files/futures/minute-aggregates/cbot.md): Candlestick data for CBOT futures with minute-by-minute open, high, low, close, and volume aggregated from all trades
- [Minute Aggregates - CME](https://massive.com/docs/flat-files/futures/minute-aggregates/cme.md): Candlestick data for CME futures with minute-by-minute open, high, low, close, and volume aggregated from all trades
- [Minute Aggregates - COMEX](https://massive.com/docs/flat-files/futures/minute-aggregates/comex.md): Candlestick data for COMEX futures with minute-by-minute open, high, low, close, and volume aggregated from all trades
- [Minute Aggregates - NYMEX](https://massive.com/docs/flat-files/futures/minute-aggregates/nymex.md): Candlestick data for NYMEX futures with minute-by-minute open, high, low, close, and volume aggregated from all trades
- [Futures Overview](https://massive.com/docs/flat-files/futures/overview.md): Massive provides comprehensive historical U.S. futures market data through downloadable CSV Flat Files
- [Quotes Aggregates - CBOT](https://massive.com/docs/flat-files/futures/quotes/cbot.md): Top-of-book quotes with nanosecond timestamps for CBOT futures, delivered as a daily downloadable S3 file
- [Quotes Aggregates - CME](https://massive.com/docs/flat-files/futures/quotes/cme.md): Top-of-book quotes with nanosecond timestamps for CME futures, delivered as a daily downloadable S3 file
- [Quotes Aggregates - COMEX](https://massive.com/docs/flat-files/futures/quotes/comex.md): Top-of-book quotes with nanosecond timestamps for COMEX futures, delivered as a daily downloadable S3 file
- [Quotes Aggregates - NYMEX](https://massive.com/docs/flat-files/futures/quotes/nymex.md): Top-of-book quotes with nanosecond timestamps for NYMEX futures, delivered as a daily downloadable S3 file
- [Session Aggregates - CBOT](https://massive.com/docs/flat-files/futures/session-aggregates/cbot.md): Candlestick data for CBOT futures with open, high, low, close, and volume aggregated from all trades during each trading session
- [Session Aggregates - CME](https://massive.com/docs/flat-files/futures/session-aggregates/cme.md): Candlestick data for CME futures with open, high, low, close, and volume aggregated from all trades during each trading session
- [Session Aggregates - COMEX](https://massive.com/docs/flat-files/futures/session-aggregates/comex.md): Candlestick data for COMEX futures with open, high, low, close, and volume aggregated from all trades during each trading session
- [Session Aggregates - NYMEX](https://massive.com/docs/flat-files/futures/session-aggregates/nymex.md): Candlestick data for NYMEX futures with open, high, low, close, and volume aggregated from all trades during each trading session
- [Trades Aggregates - CBOT](https://massive.com/docs/flat-files/futures/trades/cbot.md): Tick-level trades with nanosecond timestamps for CBOT futures, delivered as a daily downloadable S3 file
- [Trades Aggregates - CME](https://massive.com/docs/flat-files/futures/trades/cme.md): Tick-level trades with nanosecond timestamps for CME futures, delivered as a daily downloadable S3 file
- [Trades Aggregates - COMEX](https://massive.com/docs/flat-files/futures/trades/comex.md): Tick-level trades with nanosecond timestamps for COMEX futures, delivered as a daily downloadable S3 file
- [Trades Aggregates - NYMEX](https://massive.com/docs/flat-files/futures/trades/nymex.md): Tick-level trades with nanosecond timestamps for NYMEX futures, delivered as a daily downloadable S3 file
- [Day Aggregates](https://massive.com/docs/flat-files/indices/day-aggregates.md): Candlestick data for a diverse set indices with daily open, high, low, and close values aggregated from all ticks throughout the day
- [Minute Aggregates](https://massive.com/docs/flat-files/indices/minute-aggregates.md): Candlestick data for a diverse set indices with minute-by-minute open, high, low, and close values aggregated from all ticks throughout the day
- [Indices Overview](https://massive.com/docs/flat-files/indices/overview.md): Massive provides extensive historical index market data through downloadable CSV Flat Files
- [Values](https://massive.com/docs/flat-files/indices/values.md): A daily record of tick-by-tick values for a comprehensive set of indices including S&P, Nasdaq, Dow Jones, and more as a daily downloadable S3 file
- [Day Aggregates](https://massive.com/docs/flat-files/options/day-aggregates.md): Candlesticks with open, high, low, close, and volume at per day granularity from all U.S. options markets, made available as a daily downloadable S3 file
- [Minute Aggregates](https://massive.com/docs/flat-files/options/minute-aggregates.md): Candlesticks with open, high, low, close, and volume at per minute granularity from all U.S. options markets, made available as a daily downloadable S3 file
- [Options Overview](https://massive.com/docs/flat-files/options/overview.md): Massive provides extensive historical U.S. options market data through downloadable CSV Flat Files
- [Quotes](https://massive.com/docs/flat-files/options/quotes.md): Top of book quotes with nanosecond timestamps from all U.S. options markets including CBOE, NYSE, and NASDAQ, made available as a daily downloadable S3 file
- [Trades](https://massive.com/docs/flat-files/options/trades.md): Tick-level trades with nanosecond timestamps from all U.S. options markets including CBOE, NYSE, and NASDAQ, made available as a daily downloadable S3 file
- [Flat Files Quickstart](https://massive.com/docs/flat-files/quickstart.md): Flat Files Quickstart Guide
- [Day Aggregates](https://massive.com/docs/flat-files/stocks/day-aggregates.md): Candlesticks with open, high, low, close, and volume at per-day granularity across all U.S. equities, made available as a daily downloadable S3 file
- [Minute Aggregates](https://massive.com/docs/flat-files/stocks/minute-aggregates.md): Candlesticks with open, high, low, close, and volume at per minute granularity across all U.S. equities, made available as a daily downloadable S3 file
- [Stocks Overview](https://massive.com/docs/flat-files/stocks/overview.md): Massive provides comprehensive historical U.S. stock market data through downloadable CSV flat files
- [Quotes](https://massive.com/docs/flat-files/stocks/quotes.md): Top of book quotes with nanosecond timestamps from all major U.S. exchanges and darkpools, including NYSE, Nasdaq, Cboe, Finra, and more, made available as a daily downloadable S3 file
- [Trades](https://massive.com/docs/flat-files/stocks/trades.md): Tick level nanosecond timestamped trade data from all major U.S. exchanges and darkpools including NYSE, Nasdaq, Cboe, Finra, and more, made available as a daily downloadable S3 file

## REST API

REST endpoints for market data, reference data and other financial data sets.

- [Merchant Aggregates](https://massive.com/docs/rest/alternative/consumer-spending/merchant-aggregates.md): Aggregated European consumer spending data powered by [Fable Data](https://www.fabledata.com/)
- [Merchant Hierarchy](https://massive.com/docs/rest/alternative/consumer-spending/merchant-hierarchy.md): Reference data mapping merchants to parent companies, tickers, sectors, and industries across Fable's European consumer transaction panel
- [Alternative Data Overview](https://massive.com/docs/rest/alternative/overview.md): Access alternative datasets through our REST API
- [Custom Bars (OHLC)](https://massive.com/docs/rest/crypto/aggregates/custom-bars.md): Retrieve aggregated historical OHLC (Open, High, Low, Close) and volume data for a specified cryptocurrency pair over a custom date range and time interval in Coordinated Universal Time (UTC)
- [Daily Market Summary (OHLC)](https://massive.com/docs/rest/crypto/aggregates/daily-market-summary.md): Retrieve daily OHLC (open, high, low, close), volume, and volume-weighted average price (VWAP) data for all crypto tickers on a specified trading date
- [Daily Ticker Summary (OHLC)](https://massive.com/docs/rest/crypto/aggregates/daily-ticker-summary.md): Retrieve the opening and closing trades for a specific crypto pair on a given date
- [Previous Day Bar (OHLC)](https://massive.com/docs/rest/crypto/aggregates/previous-day-bar.md): Retrieve the previous trading day's open, high, low, and close (OHLC) data for a specified cryptocurrency pair
- [Condition Codes](https://massive.com/docs/rest/crypto/market-operations/condition-codes.md): Retrieve a unified and comprehensive list of trade and quote conditions from various upstream market data providers (e.g., CTA, UTP, OPRA, FINRA)
- [Exchanges](https://massive.com/docs/rest/crypto/market-operations/exchanges.md): Retrieve a list of known exchanges, including their identifiers, names, market types, and other relevant attributes
- [Market Holidays](https://massive.com/docs/rest/crypto/market-operations/market-holidays.md): Retrieve upcoming market holidays and their corresponding open/close times
- [Market Status](https://massive.com/docs/rest/crypto/market-operations/market-status.md): Retrieve the current trading status for various exchanges and overall financial markets
- [Crypto Overview](https://massive.com/docs/rest/crypto/overview.md): At Massive, we provide a comprehensive suite of cryptocurrency market data through standardized and intuitive APIs, offering extensive coverage of the global digital asset landscape
- [Full Market Snapshot](https://massive.com/docs/rest/crypto/snapshots/full-market-snapshot.md): Retrieve a comprehensive snapshot of the crypto market in a single response
- [Single Ticker Snapshot](https://massive.com/docs/rest/crypto/snapshots/single-ticker-snapshot.md): Retrieve the most recent market data snapshot for a single ticker
- [Top Market Movers](https://massive.com/docs/rest/crypto/snapshots/top-market-movers.md): Retrieve snapshot data highlighting the top 20 gainers or losers in the crypto market
- [Unified Snapshot](https://massive.com/docs/rest/crypto/snapshots/unified-snapshot.md): Retrieve unified snapshots of market data for multiple asset classes including stocks, options, forex, and cryptocurrencies in a single request
- [Exponential Moving Average (EMA)](https://massive.com/docs/rest/crypto/technical-indicators/exponential-moving-average.md): Retrieve the Exponential Moving Average (EMA) for a specified ticker over a defined time range
- [Moving Average Convergence/Divergence (MACD)](https://massive.com/docs/rest/crypto/technical-indicators/moving-average-convergence-divergence.md): Retrieve the Moving Average Convergence/Divergence (MACD) for a specified ticker over a defined time range
- [Relative Strength Index (RSI)](https://massive.com/docs/rest/crypto/technical-indicators/relative-strength-index.md): Retrieve the Relative Strength Index (RSI) for a specified ticker over a defined time range
- [Simple Moving Average (SMA)](https://massive.com/docs/rest/crypto/technical-indicators/simple-moving-average.md): Retrieve the Simple Moving Average (SMA) for a specified ticker over a defined time range
- [All Tickers](https://massive.com/docs/rest/crypto/tickers/all-tickers.md): Retrieve a comprehensive list of ticker symbols supported by Massive across various asset classes (e.g., stocks, indices, forex, crypto)
- [Ticker Overview](https://massive.com/docs/rest/crypto/tickers/ticker-overview.md): Retrieve comprehensive details for a single ticker supported by Massive that is active as-of a given date
- [Last Trade](https://massive.com/docs/rest/crypto/trades/last-trade.md): Retrieve the most recent trade details for a specified cryptocurrency pair, including price, size, timestamp, exchange, and conditions
- [Trades](https://massive.com/docs/rest/crypto/trades/trades.md): Retrieve comprehensive, tick-level trade data for a specified crypto ticker within a defined time range
- [Funding Conditions](https://massive.com/docs/rest/economy/funding-conditions.md): Daily U.S. overnight funding snapshot — one row per day showing how cheap or tight it is for banks and dealers to borrow cash overnight
- [Inflation](https://massive.com/docs/rest/economy/inflation.md): Retrieve key indicators of realized inflation, reflecting actual changes in consumer prices and spending behavior in the U.S. economy
- [Inflation Expectations](https://massive.com/docs/rest/economy/inflation-expectations.md): Retrieve a broad view of how inflation is expected to evolve over time in the U.S. economy
- [Labor Market](https://massive.com/docs/rest/economy/labor-market.md): Retrieve key labor market indicators from the Federal Reserve, including unemployment rate, labor force participation, average hourly earnings, and job openings data
- [Economy Overview](https://massive.com/docs/rest/economy/overview.md): Access macroeconomic data from the Federal Reserve and other official sources through our REST API
- [Treasury Yields](https://massive.com/docs/rest/economy/treasury-yields.md): Retrieve historical U.S. Treasury yield data for standard timeframes ranging from 1-month to 30-years, with daily historical records back to 1962
- [Custom Bars (OHLC)](https://massive.com/docs/rest/forex/aggregates/custom-bars.md): Retrieve aggregated historical OHLC (Open, High, Low, Close) and volume data for a specified Forex currency pair over a custom date range and time interval in Coordinated Universal Time (UTC)
- [Daily Market Summary (OHLC)](https://massive.com/docs/rest/forex/aggregates/daily-market-summary.md): Retrieve daily OHLC (open, high, low, close), volume, and volume-weighted average price (VWAP) data for all forex tickers on a specified trading date
- [Previous Day Bar (OHLC)](https://massive.com/docs/rest/forex/aggregates/previous-day-bar.md): Retrieve the previous trading day's open, high, low, and close (OHLC) data for a specified forex pair
- [Currency Conversion](https://massive.com/docs/rest/forex/currency-conversion.md): Retrieve real-time currency conversion rates between any two supported currencies
- [Exchanges](https://massive.com/docs/rest/forex/market-operations/exchanges.md): Retrieve a list of known exchanges, including their identifiers, names, market types, and other relevant attributes
- [Market Holidays](https://massive.com/docs/rest/forex/market-operations/market-holidays.md): Retrieve upcoming market holidays and their corresponding open/close times
- [Market Status](https://massive.com/docs/rest/forex/market-operations/market-status.md): Retrieve the current trading status for various exchanges and overall financial markets
- [Forex Overview](https://massive.com/docs/rest/forex/overview.md): At Massive, we offer a comprehensive suite of foreign exchange (forex) market data through standardized and intuitive APIs
- [Last Quote](https://massive.com/docs/rest/forex/quotes/last-quote.md): Retrieve the most recent quote for a specified forex currency pair, including bid, ask, exchange, and timestamp
- [Quotes](https://massive.com/docs/rest/forex/quotes/quotes.md): Retrieve historical Best Bid and Offer (BBO) quotes for a specified forex currency pair over a defined time range
- [Full Market Snapshot](https://massive.com/docs/rest/forex/snapshots/full-market-snapshot.md): Retrieve a comprehensive snapshot of the forex market in a single response
- [Single Ticker Snapshot](https://massive.com/docs/rest/forex/snapshots/single-ticker-snapshot.md): Retrieve the most recent market data snapshot for a single ticker
- [Top Market Movers](https://massive.com/docs/rest/forex/snapshots/top-market-movers.md): Retrieve snapshot data highlighting the top 20 gainers or losers in the forex market
- [Unified Snapshot](https://massive.com/docs/rest/forex/snapshots/unified-snapshot.md): Retrieve unified snapshots of market data for multiple asset classes including stocks, options, forex, and cryptocurrencies in a single request
- [Exponential Moving Average (EMA)](https://massive.com/docs/rest/forex/technical-indicators/exponential-moving-average.md): Retrieve the Exponential Moving Average (EMA) for a specified ticker over a defined time range
- [Moving Average Convergence/Divergence (MACD)](https://massive.com/docs/rest/forex/technical-indicators/moving-average-convergence-divergence.md): Retrieve the Moving Average Convergence/Divergence (MACD) for a specified ticker over a defined time range
- [Relative Strength Index (RSI)](https://massive.com/docs/rest/forex/technical-indicators/relative-strength-index.md): Retrieve the Relative Strength Index (RSI) for a specified ticker over a defined time range
- [Simple Moving Average (SMA)](https://massive.com/docs/rest/forex/technical-indicators/simple-moving-average.md): Retrieve the Simple Moving Average (SMA) for a specified ticker over a defined time range
- [All Tickers](https://massive.com/docs/rest/forex/tickers/all-tickers.md): Retrieve a comprehensive list of ticker symbols supported by Massive across various asset classes (e.g., stocks, indices, forex, crypto)
- [Ticker Overview](https://massive.com/docs/rest/forex/tickers/ticker-overview.md): Retrieve comprehensive details for a single ticker supported by Massive that is active as-of a given date
- [Ticker Types](https://massive.com/docs/rest/forex/tickers/ticker-types.md): Retrieve a list of all ticker types supported by Massive
- [Aggregate Bars (OHLC)](https://massive.com/docs/rest/futures/aggregates.md): Retrieve historical OHLC (open, high, low, close) and volume bars for a futures contract over a date range
- [Contracts](https://massive.com/docs/rest/futures/contracts.md)
- [Exchanges](https://massive.com/docs/rest/futures/market-operations/exchanges.md): Retrieve a list of supported futures exchanges, including their unique exchange codes, names, and other important details
- [Market Status](https://massive.com/docs/rest/futures/market-operations/market-status.md)
- [Futures Overview](https://massive.com/docs/rest/futures/overview.md): Explore comprehensive U.S. futures market data through Massive's REST APIs.
- [Products](https://massive.com/docs/rest/futures/products.md)
- [Schedules](https://massive.com/docs/rest/futures/schedules.md): The Schedules API provides a unified way to retrieve trading schedules for futures markets, returning precise session open and close times, intraday breaks, and any adjustments for holidays or special events
- [Futures Contracts Snapshot](https://massive.com/docs/rest/futures/snapshots/contracts-snapshot.md): Retrieve real-time snapshots for a set of futures contracts, including key market data such as the latest trade, quote, session metrics (open, high, low, close, volume), and settlement prices
- [Quotes](https://massive.com/docs/rest/futures/trades-quotes/quotes.md): Retrieve quote data for a specified futures contract ticker
- [Trades](https://massive.com/docs/rest/futures/trades-quotes/trades.md): Retrieve comprehensive, tick-level trade data for a specified futures contract ticker over a defined time range
- [Custom Bars (OHLC)](https://massive.com/docs/rest/indices/aggregates/custom-bars.md): Retrieve aggregated historical OHLC (Open, High, Low, Close) and value data for a specified index over a custom date range and time interval in Eastern Time (ET)
- [Daily Ticker Summary (OHLC)](https://massive.com/docs/rest/indices/aggregates/daily-ticker-summary.md): Retrieve the opening and closing prices for a specific index on a given date, along with any pre-market and after-hours trade prices
- [Previous Day Bar (OHLC)](https://massive.com/docs/rest/indices/aggregates/previous-day-bar.md): Retrieve the previous trading day's open, high, low, and close (OHLC) data for a specified index ticker
- [Market Holidays](https://massive.com/docs/rest/indices/market-operations/market-holidays.md): Retrieve upcoming market holidays and their corresponding open/close times
- [Market Status](https://massive.com/docs/rest/indices/market-operations/market-status.md): Retrieve the current trading status for various exchanges and overall financial markets
- [Indices Overview](https://massive.com/docs/rest/indices/overview.md): At Massive, we provide a comprehensive suite of market data for over 10,000+ indices from multiple index families, including S&P, Nasdaq, Dow Jones, and more
- [Indices Snapshot](https://massive.com/docs/rest/indices/snapshots/indices-snapshot.md): Retrieve snapshot data for one or more indices, including their current value, recent performance metrics, and trading session details
- [Unified Snapshot](https://massive.com/docs/rest/indices/snapshots/unified-snapshot.md): Retrieve unified snapshots of market data for multiple asset classes including stocks, options, forex, and cryptocurrencies in a single request
- [Exponential Moving Average (EMA)](https://massive.com/docs/rest/indices/technical-indicators/exponential-moving-average.md): Retrieve the Exponential Moving Average (EMA) for a specified ticker over a defined time range
- [Moving Average Convergence/Divergence (MACD)](https://massive.com/docs/rest/indices/technical-indicators/moving-average-convergence-divergence.md): Retrieve the Moving Average Convergence/Divergence (MACD) for a specified ticker over a defined time range
- [Relative Strength Index (RSI)](https://massive.com/docs/rest/indices/technical-indicators/relative-strength-index.md): Retrieve the Relative Strength Index (RSI) for a specified ticker over a defined time range
- [Simple Moving Average (SMA)](https://massive.com/docs/rest/indices/technical-indicators/simple-moving-average.md): Retrieve the Simple Moving Average (SMA) for a specified ticker over a defined time range
- [All Tickers](https://massive.com/docs/rest/indices/tickers/all-tickers.md): Retrieve a comprehensive list of ticker symbols supported by Massive across various asset classes (e.g., stocks, indices, forex, crypto)
- [Ticker Overview](https://massive.com/docs/rest/indices/tickers/ticker-overview.md): Retrieve comprehensive details for a single ticker supported by Massive that is active as-of a given date
- [Custom Bars (OHLC)](https://massive.com/docs/rest/options/aggregates/custom-bars.md): Retrieve aggregated historical OHLC (Open, High, Low, Close) and volume data for a specified options contract over a custom date range and time interval in Eastern Time (ET)
- [Daily Ticker Summary (OHLC)](https://massive.com/docs/rest/options/aggregates/daily-ticker-summary.md): Retrieve the opening and closing prices for a specific options contract on a given date, along with any pre-market and after-hours trade prices
- [Previous Day Bar (OHLC)](https://massive.com/docs/rest/options/aggregates/previous-day-bar.md): Retrieve the previous trading day's open, high, low, and close (OHLC) data for a specified option contract
- [All Contracts](https://massive.com/docs/rest/options/contracts/all-contracts.md): Retrieve a comprehensive index of options contracts, encompassing both active and expired listings
- [Contract Overview](https://massive.com/docs/rest/options/contracts/contract-overview.md): Retrieve detailed information about a specific options contract, including its contract type (call or put), exercise style, expiration date, strike price, shares per contract, underlying ticker, and primary exchange
- [Condition Codes](https://massive.com/docs/rest/options/market-operations/condition-codes.md): Retrieve a unified and comprehensive list of trade and quote conditions from various upstream market data providers (e.g., CTA, UTP, OPRA, FINRA)
- [Exchanges](https://massive.com/docs/rest/options/market-operations/exchanges.md): Retrieve a list of known exchanges, including their identifiers, names, market types, and other relevant attributes
- [Market Holidays](https://massive.com/docs/rest/options/market-operations/market-holidays.md): Retrieve upcoming market holidays and their corresponding open/close times
- [Market Status](https://massive.com/docs/rest/options/market-operations/market-status.md): Retrieve the current trading status for various exchanges and overall financial markets
- [Options Overview](https://massive.com/docs/rest/options/overview.md): At Massive, we offer a comprehensive suite of U.S. options market data through standardized and intuitive APIs
- [Option Chain Snapshot](https://massive.com/docs/rest/options/snapshots/option-chain-snapshot.md): Retrieve a comprehensive snapshot of all options contracts associated with a specified underlying ticker
- [Option Contract Snapshot](https://massive.com/docs/rest/options/snapshots/option-contract-snapshot.md): Retrieve a comprehensive snapshot of a specified options contract, consolidating vital metrics and market data into a single response
- [Unified Snapshot](https://massive.com/docs/rest/options/snapshots/unified-snapshot.md): Retrieve unified snapshots of market data for multiple asset classes including stocks, options, forex, and cryptocurrencies in a single request
- [Exponential Moving Average (EMA)](https://massive.com/docs/rest/options/technical-indicators/exponential-moving-average.md): Retrieve the Exponential Moving Average (EMA) for a specified ticker over a defined time range
- [Moving Average Convergence/Divergence (MACD)](https://massive.com/docs/rest/options/technical-indicators/moving-average-convergence-divergence.md): Retrieve the Moving Average Convergence/Divergence (MACD) for a specified ticker over a defined time range
- [Relative Strength Index (RSI)](https://massive.com/docs/rest/options/technical-indicators/relative-strength-index.md): Retrieve the Relative Strength Index (RSI) for a specified ticker over a defined time range
- [Simple Moving Average (SMA)](https://massive.com/docs/rest/options/technical-indicators/simple-moving-average.md): Retrieve the Simple Moving Average (SMA) for a specified ticker over a defined time range
- [Last Trade](https://massive.com/docs/rest/options/trades-quotes/last-trade.md): Retrieve the latest available trade for a specified options contact, including details such as price, size, exchange, and timestamp
- [Quotes](https://massive.com/docs/rest/options/trades-quotes/quotes.md): Retrieve historical quotes for a specified options contract over a defined time range
- [Trades](https://massive.com/docs/rest/options/trades-quotes/trades.md): Retrieve comprehensive, tick-level trade data for a specified options ticker within a defined time range
- [Analyst Details](https://massive.com/docs/rest/partners/benzinga/analyst-details.md): Retrieve structured data on financial analysts, including names, affiliated firms, and historical rating activity
- [Analyst Insights](https://massive.com/docs/rest/partners/benzinga/analyst-insights.md): Retrieve insights from financial analysts, including ratings, price targets, and the rationale behind their recommendations
- [Analyst Ratings](https://massive.com/docs/rest/partners/benzinga/analyst-ratings.md): Retrieve structured historical analyst ratings, including rating actions, price target changes, and firm names for publicly traded companies
- [Bulls Bears Say](https://massive.com/docs/rest/partners/benzinga/bulls-bears-say.md): A comprehensive database of analyst bull and bear case summaries for publicly traded companies, providing concise summaries of both bullish and bearish investment arguments to help investors see both sides of the story before making investment decisions
- [Consensus Ratings](https://massive.com/docs/rest/partners/benzinga/consensus-ratings.md): Retrieve consensus ratings from financial analysts, including aggregated rating distributions and price target ranges
- [Corporate Guidance](https://massive.com/docs/rest/partners/benzinga/corporate-guidance.md): Retrieve structured earnings guidance data, including projected EPS and revenue figures, from public company disclosures
- [Earnings](https://massive.com/docs/rest/partners/benzinga/earnings.md): Retrieve structured historical and upcoming earnings announcements for publicly traded companies, including key metrics such as earnings per share (EPS), revenue, and analyst estimates
- [Firm Details](https://massive.com/docs/rest/partners/benzinga/firm-details.md): Retrieve structured data on analyst firms, including firm names and identifiers
- [Real-time Benzinga News](https://massive.com/docs/rest/partners/benzinga/news.md): Retrieve real-time structured, timestamped news articles from Benzinga, including headlines, full-text content, tickers, categories, and more
- [ETF Analytics](https://massive.com/docs/rest/partners/etf-global/analytics.md): Retrieve analytical metrics and calculated insights for U.S. listed ETFs including performance data, risk measures, and derived analytics
- [ETF Constituents](https://massive.com/docs/rest/partners/etf-global/constituents.md): Retrieve the underlying holdings and constituents of U.S. listed ETFs
- [ETF Fund Flows](https://massive.com/docs/rest/partners/etf-global/fundflows.md): Retrieve capital movement and investor activity data across U.S. listed ETFs
- [ETF Profiles & Exposure](https://massive.com/docs/rest/partners/etf-global/profiles.md): Retrieve industry classification data for U.S. listed ETFs including sector mappings and standardized categorizations across industry frameworks
- [ETF Taxonomies](https://massive.com/docs/rest/partners/etf-global/taxonomies.md): Retrieve standardized taxonomy systems used to categorize and organize U.S. listed ETFs
- [Partners Overview](https://massive.com/docs/rest/partners/overview.md): Access premium third-party data through our Partner integrations
- [Corporate Events](https://massive.com/docs/rest/partners/tmx/corporate-events.md): Retrieve structured corporate event data from Wall Street Horizon's comprehensive global events calendar, including earnings announcements, dividend dates, investor conferences, and stock splits
- [REST Quickstart](https://massive.com/docs/rest/quickstart.md): REST API Quickstart Guide
- [Custom Bars (OHLC)](https://massive.com/docs/rest/stocks/aggregates/custom-bars.md): Retrieve aggregated historical OHLC (Open, High, Low, Close) and volume data for a specified stock ticker over a custom date range and time interval in Eastern Time (ET)
- [Daily Market Summary (OHLC)](https://massive.com/docs/rest/stocks/aggregates/daily-market-summary.md): Retrieve daily OHLC (open, high, low, close), volume, and volume-weighted average price (VWAP) data for all U.S. stocks on a specified trading date
- [Daily Ticker Summary (OHLC)](https://massive.com/docs/rest/stocks/aggregates/daily-ticker-summary.md): Retrieve the opening and closing prices for a specific stock ticker on a given date, along with any pre-market and after-hours trade prices
- [Previous Day Bar (OHLC)](https://massive.com/docs/rest/stocks/aggregates/previous-day-bar.md): Retrieve the previous trading day's open, high, low, and close (OHLC) data for a specified stock ticker
- [Dividends](https://massive.com/docs/rest/stocks/corporate-actions/dividends.md): Retrieve a historical record of cash dividend distributions for a given ticker, including declaration, ex-dividend, record, and pay dates, as well as payout amounts and adjustment factors for normalizing historical data to offset the effects of dividends
- [Initial Public Offerings (IPOs)](https://massive.com/docs/rest/stocks/corporate-actions/ipos.md): Retrieve comprehensive information on Initial Public Offerings (IPOs), including upcoming and historical events, starting from the year 2008
- [Dividends (Deprecated)](https://massive.com/docs/rest/stocks/corporate-actions/reference-dividends.md): Retrieve a historical record of cash dividend distributions for a given ticker, including declaration, ex-dividend, record, and pay dates, as well as payout amounts and frequency
- [Splits (Deprecated)](https://massive.com/docs/rest/stocks/corporate-actions/reference-splits.md): Retrieve historical stock split events, including execution dates and ratio factors, to understand changes in a company’s share structure over time
- [Splits](https://massive.com/docs/rest/stocks/corporate-actions/splits.md): Retrieve historical stock split events, including execution dates and ratio factors, to understand changes in a company’s share structure over time
- [Ticker Events](https://massive.com/docs/rest/stocks/corporate-actions/ticker-events.md): Retrieve a timeline of key events associated with a given ticker, CUSIP, or Composite FIGI
- [Annual Report Sections (10-K)](https://massive.com/docs/rest/stocks/filings/10-k-sections.md): Retrieve clean plain-text extracts of key narrative sections from annual 10-K filings, including Business and Risk Factors
- [Institutional Holdings (13-F)](https://massive.com/docs/rest/stocks/filings/13-f-filings.md): Retrieve quarterly holdings data from SEC Form 13-F filings submitted by institutional investment managers with at least $100 million in assets
- [Material Event Disclosures (8-K)](https://massive.com/docs/rest/stocks/filings/8-k-disclosures.md): SEC 8-K filing disclosure categorization
- [Material Event Text (8-K)](https://massive.com/docs/rest/stocks/filings/8-k-text.md): Retrieve parsed plain-text content from the core Items sections of Form 8-K current reports
- [Disclosure Categories](https://massive.com/docs/rest/stocks/filings/disclosure-categories.md): Access the full standardized hierarchical taxonomy used to classify disclosures in SEC Form 8-K filings
- [Initial Insider Ownership (Form 3)](https://massive.com/docs/rest/stocks/filings/form-3.md): Retrieve SEC Form 3 filings that report the initial beneficial ownership of securities by corporate insiders (directors, officers, and 10%+ shareholders)
- [Insider Transactions (Form 4)](https://massive.com/docs/rest/stocks/filings/form-4.md): Retrieve SEC Form 4 filings that disclose all changes in beneficial ownership by corporate insiders
- [SEC EDGAR Index](https://massive.com/docs/rest/stocks/filings/index.md): Retrieve the master index of all SEC EDGAR filings, including form types, filing dates, CIKs, tickers, issuer names, accession numbers, and direct links to original documents on SEC.gov
- [Risk Categories](https://massive.com/docs/rest/stocks/filings/risk-categories.md): Access the full standardized hierarchical taxonomy used to classify risk factors in SEC filings
- [Risk Factors](https://massive.com/docs/rest/stocks/filings/risk-factors.md): Standardized, machine-readable risk factor disclosures from SEC filings
- [Balance Sheets](https://massive.com/docs/rest/stocks/fundamentals/balance-sheets.md): Retrieve comprehensive balance sheet data for public companies, containing quarterly and annual financial positions
- [Cash Flow Statements](https://massive.com/docs/rest/stocks/fundamentals/cash-flow-statements.md): Retrieve comprehensive cash flow statement data for public companies, including quarterly, annual, and trailing twelve-month cash flows
- [Float](https://massive.com/docs/rest/stocks/fundamentals/float.md): Retrieve the latest free float for a specified stock ticker
- [Income Statements](https://massive.com/docs/rest/stocks/fundamentals/income-statements.md): Retrieve comprehensive income statement data for public companies, including key metrics such as revenue, expenses, and net income for various reporting periods
- [Ratios](https://massive.com/docs/rest/stocks/fundamentals/ratios.md): Retrieve comprehensive financial ratios data providing key valuation, profitability, liquidity, and leverage metrics for public companies
- [Short Interest](https://massive.com/docs/rest/stocks/fundamentals/short-interest.md): Retrieve aggregated short interest data reported to FINRA by broker-dealers for a specified stock ticker on a two-week cadence
- [Short Volume](https://massive.com/docs/rest/stocks/fundamentals/short-volume.md): Retrieve daily aggregated short sale volume data reported to FINRA from off-exchange trading venues and alternative trading systems (ATS) for a specified stock ticker
- [Condition Codes](https://massive.com/docs/rest/stocks/market-operations/condition-codes.md): Retrieve a unified and comprehensive list of trade and quote conditions from various upstream market data providers (e.g., CTA, UTP, OPRA, FINRA)
- [Exchanges](https://massive.com/docs/rest/stocks/market-operations/exchanges.md): Retrieve a list of known exchanges, including their identifiers, names, market types, and other relevant attributes
- [Market Holidays](https://massive.com/docs/rest/stocks/market-operations/market-holidays.md): Retrieve upcoming market holidays and their corresponding open/close times
- [Market Status](https://massive.com/docs/rest/stocks/market-operations/market-status.md): Retrieve the current trading status for various exchanges and overall financial markets
- [News](https://massive.com/docs/rest/stocks/news.md): Retrieve the most recent news articles related to a specified ticker, along with summaries, source details, and sentiment analysis
- [Stocks Overview](https://massive.com/docs/rest/stocks/overview.md): At Massive, we provide a comprehensive suite of U.S. stock market data through a standardized and intuitive API, offering unparalleled coverage of the U.S. stock market landscape
- [Full Market Snapshot](https://massive.com/docs/rest/stocks/snapshots/full-market-snapshot.md): Retrieve a comprehensive snapshot of the entire U.S. stock market, covering over 10,000+ actively traded tickers in a single response
- [Single Ticker Snapshot](https://massive.com/docs/rest/stocks/snapshots/single-ticker-snapshot.md): Retrieve the most recent market data snapshot for a single ticker
- [Top Market Movers](https://massive.com/docs/rest/stocks/snapshots/top-market-movers.md): Retrieve snapshot data highlighting the top 20 gainers or losers in the U.S. stock market
- [Unified Snapshot](https://massive.com/docs/rest/stocks/snapshots/unified-snapshot.md): Retrieve unified snapshots of market data for multiple asset classes including stocks, options, forex, and cryptocurrencies in a single request
- [Exponential Moving Average (EMA)](https://massive.com/docs/rest/stocks/technical-indicators/exponential-moving-average.md): Retrieve the Exponential Moving Average (EMA) for a specified ticker over a defined time range
- [Moving Average Convergence/Divergence (MACD)](https://massive.com/docs/rest/stocks/technical-indicators/moving-average-convergence-divergence.md): Retrieve the Moving Average Convergence/Divergence (MACD) for a specified ticker over a defined time range
- [Relative Strength Index (RSI)](https://massive.com/docs/rest/stocks/technical-indicators/relative-strength-index.md): Retrieve the Relative Strength Index (RSI) for a specified ticker over a defined time range
- [Simple Moving Average (SMA)](https://massive.com/docs/rest/stocks/technical-indicators/simple-moving-average.md): Retrieve the Simple Moving Average (SMA) for a specified ticker over a defined time range
- [All Tickers](https://massive.com/docs/rest/stocks/tickers/all-tickers.md): Retrieve a comprehensive list of ticker symbols supported by Massive across various asset classes (e.g., stocks, indices, forex, crypto)
- [Related Tickers](https://massive.com/docs/rest/stocks/tickers/related-tickers.md): Retrieve a list of tickers related to a specified ticker, identified through an analysis of news coverage and returns data
- [Ticker Overview](https://massive.com/docs/rest/stocks/tickers/ticker-overview.md): Retrieve comprehensive details for a single ticker supported by Massive that is active as-of a given date
- [Ticker Types](https://massive.com/docs/rest/stocks/tickers/ticker-types.md): Retrieve a list of all ticker types supported by Massive
- [Last Quote](https://massive.com/docs/rest/stocks/trades-quotes/last-quote.md): Retrieve the most recent National Best Bid and Offer (NBBO) quote for a specified stock ticker, including the latest bid/ask prices, sizes, exchange details, and timestamp
- [Last Trade](https://massive.com/docs/rest/stocks/trades-quotes/last-trade.md): Retrieve the latest available trade for a specified stock ticker, including details such as price, size, exchange, and timestamp
- [Quotes](https://massive.com/docs/rest/stocks/trades-quotes/quotes.md): Retrieve National Best Bid and Offer (NBBO) quotes for a specified stock ticker over a defined time range
- [Trades](https://massive.com/docs/rest/stocks/trades-quotes/trades.md): Retrieve comprehensive, tick-level trade data for a specified stock ticker within a defined time range

## WebSocket

Streaming market data over WebSocket, pushed to the client as events arrive.

- [Aggregates (Per Minute)](https://massive.com/docs/websocket/crypto/aggregates-per-minute.md): Stream minute-by-minute aggregated OHLC (Open, High, Low, Close) and volume data for a specified cryptocurrency pair via WebSocket
- [Aggregates (Per Second)](https://massive.com/docs/websocket/crypto/aggregates-per-second.md): Stream second-by-second aggregated OHLC (Open, High, Low, Close) and volume data for a specified cryptocurrency pair via WebSocket
- [Fair Market Value](https://massive.com/docs/websocket/crypto/fair-market-value.md): Stream real-time Fair Market Value (FMV) data for a specified cryptocurrency pair via WebSocket
- [Crypto Overview](https://massive.com/docs/websocket/crypto/overview.md): At Massive, we provide real-time streaming access to the global cryptocurrency market through WebSockets
- [Quotes](https://massive.com/docs/websocket/crypto/quotes.md): Stream quote data for specified cryptocurrency pairs via WebSocket
- [Trades](https://massive.com/docs/websocket/crypto/trades.md): Stream trade data for crypto pairs via WebSocket
- [Aggregates (Per Minute)](https://massive.com/docs/websocket/forex/aggregates-per-minute.md): Stream minute-by-minute aggregated OHLC (Open, High, Low, Close) and volume data for a specified Forex currency pair via WebSocket
- [Aggregates (Per Second)](https://massive.com/docs/websocket/forex/aggregates-per-second.md): Stream second-by-second aggregated OHLC (Open, High, Low, Close) and volume data for a specified Forex currency pair via WebSocket
- [Fair Market Value](https://massive.com/docs/websocket/forex/fair-market-value.md): Stream real-time Fair Market Value (FMV) data for a specified Forex currency pair via WebSocket
- [Forex Overview](https://massive.com/docs/websocket/forex/overview.md): At Massive, we provide real-time streaming access to global foreign exchange (forex) market data through WebSockets
- [Quotes](https://massive.com/docs/websocket/forex/quotes.md): Stream real-time Best Bid and Offer (BBO) quote data for specified Forex currency pairs via WebSocket
- [Aggregates (Per Minute)](https://massive.com/docs/websocket/futures/aggregates-per-minute.md): Stream minute-by-minute aggregated OHLC (Open, High, Low, Close) and volume data for a specified futures contract ticker via WebSocket
- [Aggregates (Per Second)](https://massive.com/docs/websocket/futures/aggregates-per-second.md): Stream second-by-second aggregated OHLC (Open, High, Low, Close) and volume data for a specified futures contract ticker via WebSocket
- [Futures Overview](https://massive.com/docs/websocket/futures/overview.md): Explore comprehensive U.S. futures market data through Massive's WebSocket streams.
- [Quotes](https://massive.com/docs/websocket/futures/quotes.md): Stream BBO (Best Bid and Offer) quote data for futures tickers via WebSocket
- [Trades](https://massive.com/docs/websocket/futures/trades.md): Stream tick-level trade data for futures tickers via WebSocket
- [Aggregates (Per Minute)](https://massive.com/docs/websocket/indices/aggregates-per-minute.md): Stream minute-by-minute aggregated OHLC (Open, High, Low, Close) for a specified index via WebSocket
- [Aggregates (Per Second)](https://massive.com/docs/websocket/indices/aggregates-per-second.md): Stream second-by-second aggregated OHLC (Open, High, Low, Close) for a specified index via WebSocket
- [Indices Overview](https://massive.com/docs/websocket/indices/overview.md): At Massive, we provide real-time streaming access to index values and aggregates through WebSockets, enabling your applications to receive continuous updates directly as market conditions evolve
- [Value](https://massive.com/docs/websocket/indices/value.md): Stream real-time index value updates for specified index tickers via WebSocket
- [Aggregates (Per Minute)](https://massive.com/docs/websocket/options/aggregates-per-minute.md): Stream minute-by-minute aggregated OHLC (Open, High, Low, Close) and volume data for a specified options contract via WebSocket
- [Aggregates (Per Second)](https://massive.com/docs/websocket/options/aggregates-per-second.md): Stream second-by-second aggregated OHLC (Open, High, Low, Close) and volume data for a specified options contract via WebSocket
- [Fair Market Value](https://massive.com/docs/websocket/options/fair-market-value.md): Stream real-time Fair Market Value (FMV) data for a specified options contract via WebSocket
- [Options Overview](https://massive.com/docs/websocket/options/overview.md): At Massive, we provide real-time streaming access to U.S. options market data through WebSockets, allowing you to receive a continuous flow of updates directly into your applications
- [Quotes](https://massive.com/docs/websocket/options/quotes.md): Stream quote data for specified options contracts via WebSocket
- [Trades](https://massive.com/docs/websocket/options/trades.md): Stream tick-level trade data for option contracts via WebSocket
- [WebSocket Quickstart](https://massive.com/docs/websocket/quickstart.md): WebSocket API Quickstart Guide
- [Aggregates (Per Minute)](https://massive.com/docs/websocket/stocks/aggregates-per-minute.md): Stream minute-by-minute aggregated OHLC (Open, High, Low, Close) and volume data for specified tickers via WebSocket
- [Aggregates (Per Second)](https://massive.com/docs/websocket/stocks/aggregates-per-second.md): Stream second-by-second aggregated OHLC (Open, High, Low, Close) and volume data for specified tickers via WebSocket
- [Fair Market Value](https://massive.com/docs/websocket/stocks/fair-market-value.md): Stream real-time Fair Market Value (FMV) data for a specified stock ticker via WebSocket
- [Net Order Imbalance (NOI)](https://massive.com/docs/websocket/stocks/imbalances.md): Stream real-time Net Order Imbalance (NOI) events for specified stock tickers via WebSocket
- [Limit Up - Limit Down (LULD)](https://massive.com/docs/websocket/stocks/luld.md): Stream real-time Limit Up - Limit Down (LULD) events for specified stock tickers via WebSocket across multiple U.S. exchanges (including NYSE, Nasdaq, Cboe BZX, NYSE Arca, and NYSE American)
- [Stocks Overview](https://massive.com/docs/websocket/stocks/overview.md): At Massive, we provide real-time streaming access to U.S. stock market data through WebSockets, delivering a continuous flow of updates directly to your applications
- [Quotes](https://massive.com/docs/websocket/stocks/quotes.md): Stream NBBO (National Best Bid and Offer) quote data for stock tickers via WebSocket
- [Trades](https://massive.com/docs/websocket/stocks/trades.md): Stream tick-level trade data for stock tickers via WebSocket

```

