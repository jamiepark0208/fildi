<!-- url: https://massive.com/docs/rest/stocks/filings/8-k-disclosures.md
fetched_at: 2026-10-24T17:11:35+00:00
title:  -->


```
> For the full documentation index, see: https://massive.com/docs/llms.txt

# REST
## Stocks

### Material Event Disclosures (8-K)

**Endpoint:** `GET /stocks/filings/8-K/vX/disclosures`

**Description:**

SEC 8-K filing disclosure categorization. Each material event in a filing (leadership changes, acquisitions, material agreements, regulatory actions, etc.) is classified into a consistent three-tier taxonomy (primary, secondary, tertiary) with a supporting text excerpt directly from the filing.

A single filing can produce multiple records when it contains multiple disclosures. Each record represents one tagged disclosure within the filing. The full taxonomy is available at `/stocks/taxonomies/vX/disclosures`.

Use Cases: Event detection and alerts, event-driven trading strategies, M&A tracking, leadership-change monitoring, and corporate-action timelines.

## Query Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `cik` | string | No | SEC Central Index Key of the filer (10 digits, zero-padded). |
| `cik.any_of` | string | No | Filter equal to any of the values. Multiple values can be specified by using a comma separated list. |
| `tickers` | string | No | Filter for arrays that contain the value. |
| `tickers.all_of` | string | No | Filter for arrays that contain all of the values. Multiple values can be specified by using a comma separated list. |
| `tickers.any_of` | string | No | Filter for arrays that contain any of the values. Multiple values can be specified by using a comma separated list. |
| `filing_date` | string | No | Date when the filing was submitted to the SEC (formatted as YYYY-MM-DD). |
| `filing_date.any_of` | string | No | Filter equal to any of the values. Multiple values can be specified by using a comma separated list. |
| `filing_date.gt` | string | No | Filter greater than the value. |
| `filing_date.gte` | string | No | Filter greater than or equal to the value. |
| `filing_date.lt` | string | No | Filter less than the value. |
| `filing_date.lte` | string | No | Filter less than or equal to the value. |
| `tertiary_category` | string | No | Most specific disclosure category (e.g., 'quarterly_results'). Filtering on this column must use an exact match. See the full taxonomy at /stocks/taxonomies/vX/disclosures. |
| `limit` | integer | No | Limit the maximum number of results returned. Defaults to '100' if not specified. The maximum allowed limit is '1000'. |
| `sort` | string | No | A comma separated list of sort columns. For each column, append '.asc' or '.desc' to specify the sort direction. The sort column defaults to 'filing_date' if not specified. The sort order defaults to 'desc' if not specified. |

## Response Attributes

| Field | Type | Description |
| --- | --- | --- |
| `next_url` | string | If present, this value can be used to fetch the next page. |
| `request_id` | string | A request id assigned by the server. |
| `results` | array[object] | The results for this request. |
| `results[].accession_number` | string | Unique SEC accession number for the filing (e.g., '0000320193-25-000010'). |
| `results[].cik` | string | SEC Central Index Key of the filer (10 digits, zero-padded). |
| `results[].filing_date` | string | Date when the filing was submitted to the SEC (formatted as YYYY-MM-DD). |
| `results[].filing_url` | string | Direct URL to the full submission text file for the filing on SEC EDGAR. |
| `results[].primary_category` | string | Top-level disclosure category (e.g., 'financial_results'). See the full taxonomy at /stocks/taxonomies/vX/disclosures. |
| `results[].secondary_category` | string | Mid-level disclosure category (e.g., 'earnings_announcement'). See the full taxonomy at /stocks/taxonomies/vX/disclosures. |
| `results[].supporting_text` | string | A verbatim excerpt from the filing text supporting the assigned categories. |
| `results[].tertiary_category` | string | Most specific disclosure category (e.g., 'quarterly_results'). Filtering on this column must use an exact match. See the full taxonomy at /stocks/taxonomies/vX/disclosures. |
| `results[].tickers` | array[string] | A list of ticker symbols for the filing company. Multiple symbols may indicate different share classes; empty if no ticker is currently mapped to the filer. |
| `status` | enum: OK | The status of this request's response. |

## Sample Response

```json
{
  "count": 2,
  "next_url": "https://api.massive.com/stocks/filings/8-K/vX/disclosures?cursor=eyJsaW1pd...",
  "request_id": "b4e7c2a1f3d8e9g0",
  "results": [
    {
      "accession_number": "0000320193-25-000010",
      "cik": "0000320193",
      "filing_date": "2025-01-14",
      "filing_url": "https://www.sec.gov/Archives/edgar/data/320193/0000320193-25-000010.txt",
      "primary_category": "financial_results",
      "secondary_category": "earnings_announcement",
      "supporting_text": "On January 14, 2025, Apple Inc. announced financial results for the fiscal quarter ended December 28, 2024.",
      "tertiary_category": "quarterly_results",
      "tickers": [
        "AAPL"
      ]
    },
    {
      "accession_number": "0000004962-25-000002",
      "cik": "0000004962",
      "filing_date": "2025-01-15",
      "filing_url": "https://www.sec.gov/Archives/edgar/data/4962/0000004962-25-000002.txt",
      "primary_category": "regulatory_compliance",
      "secondary_category": "regulation_fd",
      "supporting_text": "American Express Company is hereby furnishing below delinquency and write-off statistics for its U.S. Consumer and Small Business portfolios.",
      "tertiary_category": "financial_data_disclosure",
      "tickers": [
        "AXP"
      ]
    }
  ],
  "status": "OK"
}
```


## Plan Access

**Plan Access:** Included in all Stocks plans

#### Individual Plans

| Plan | Access |
| --- | --- |
| Stocks Basic | Included |
| Stocks Starter | Included |
| Stocks Developer | Included |
| Stocks Advanced | Included |

#### Business Plans

| Plan | Access |
| --- | --- |
| Stocks Business | Included |

## Plan Recency

**Plan Recency:** Updated daily

#### Individual Plans

| Plan | Recency |
| --- | --- |
| Stocks Basic | Updated daily |
| Stocks Starter | Updated daily |
| Stocks Developer | Updated daily |
| Stocks Advanced | Updated daily |

#### Business Plans

| Plan | Recency |
| --- | --- |
| Stocks Business | Updated daily |

## Plan History

**Plan History:** Not applicable to this endpoint

```

