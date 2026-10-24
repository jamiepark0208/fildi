<!-- url: https://massive.com/docs/rest/stocks/filings/13-f-filings.md
fetched_at: 2026-10-24T17:11:34+00:00
title:  -->


```
> For the full documentation index, see: https://massive.com/docs/llms.txt

# REST
## Stocks

### Institutional Holdings (13-F)

**Endpoint:** `GET /stocks/filings/vX/13-F`

**Description:**

Retrieve quarterly holdings data from SEC Form 13-F filings submitted by institutional investment managers with at least $100 million in assets. Reports show equity positions, share counts, market values, investment discretion, and voting authority as of quarter-end.

Use Cases: Tracking institutional ownership trends, replicating hedge fund strategies, portfolio overlap analysis, activist monitoring, and idea generation from smart-money flows.

## Query Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filer_cik` | string | No | SEC Central Index Key (10 digits, zero-padded) of the filing entity. |
| `filer_cik.any_of` | string | No | Filter equal to any of the values. Multiple values can be specified by using a comma separated list. |
| `filing_date` | string | No | Date when the filing was submitted to the SEC (formatted as YYYY-MM-DD). Value must be formatted 'yyyy-mm-dd'. |
| `filing_date.gt` | string | No | Filter greater than the value. Value must be formatted 'yyyy-mm-dd'. |
| `filing_date.gte` | string | No | Filter greater than or equal to the value. Value must be formatted 'yyyy-mm-dd'. |
| `filing_date.lt` | string | No | Filter less than the value. Value must be formatted 'yyyy-mm-dd'. |
| `filing_date.lte` | string | No | Filter less than or equal to the value. Value must be formatted 'yyyy-mm-dd'. |
| `limit` | integer | No | Limit the maximum number of results returned. Defaults to '100' if not specified. The maximum allowed limit is '1000'. |
| `sort` | string | No | A comma separated list of sort columns. For each column, append '.asc' or '.desc' to specify the sort direction. The sort column defaults to 'filing_date' if not specified. The sort order defaults to 'desc' if not specified. |

## Response Attributes

| Field | Type | Description |
| --- | --- | --- |
| `next_url` | string | If present, this value can be used to fetch the next page. |
| `request_id` | string | A request id assigned by the server. |
| `results` | array[object] | The results for this request. |
| `results[].accession_number` | string | Unique SEC accession number for the filing (e.g., '0000950123-24-011775'). |
| `results[].cusip` | string | The CUSIP identifier for the held security. |
| `results[].file_number` | string | The 13F-specific file number assigned to the filer. |
| `results[].filer_cik` | string | SEC Central Index Key (10 digits, zero-padded) of the filing entity. |
| `results[].filing_date` | string | Date when the filing was submitted to the SEC (formatted as YYYY-MM-DD). |
| `results[].filing_url` | string | Direct URL to the filing on the SEC EDGAR website. |
| `results[].film_number` | string | SEC EDGAR film number for the filing. |
| `results[].form_type` | string | SEC form type (e.g., '13F-HR' for holdings report, '13F-HR/A' for amended report). |
| `results[].investment_discretion` | string | Type of investment discretion. Possible values: SOLE, SHARED, DFND (defined). |
| `results[].issuer_name` | string | Name of the company whose securities are held. |
| `results[].market_value` | integer | Market value of the holding in USD. |
| `results[].other_managers` | array[string] | List of names of other manager(s) sharing investment discretion over the reported holdings, if applicable. |
| `results[].period` | string | The quarter end date that the filing covers (formatted as YYYY-MM-DD). |
| `results[].put_call` | string | Indicates if the holding is a put or call option. Possible values: PUT, CALL, or empty for common stock. |
| `results[].shares_or_principal_amount` | integer | Number of shares or principal amount held. |
| `results[].shares_or_principal_type` | string | Type of amount reported. Possible values: SH (shares), PRN (principal amount). |
| `results[].title_of_class` | string | Description of the class of securities held (e.g., 'COM', 'CL A'). |
| `results[].voting_authority_none` | integer | Number of shares with no voting authority. |
| `results[].voting_authority_shared` | integer | Number of shares with shared voting authority. |
| `results[].voting_authority_sole` | integer | Number of shares with sole voting authority. |
| `status` | enum: OK | The status of this request's response. |

## Sample Response

```json
{
  "next_url": "https://api.massive.com/stocks/filings/vX/13-F?cursor=eyJsaW1pd...",
  "request_id": "a3f8b2c1d4e5f6g7",
  "results": [
    {
      "accession_number": "0000950123-24-011775",
      "cusip": "023135106",
      "file_number": "028-04545",
      "filer_cik": "0001067983",
      "filing_date": "2024-11-14",
      "filing_url": "https://www.sec.gov/Archives/edgar/data/1067983/0000950123-24-011775.txt",
      "film_number": "241461756",
      "form_type": "13F-HR",
      "investment_discretion": "DFND",
      "issuer_name": "AMAZON COM INC",
      "market_value": 1439212920,
      "other_managers": [
        "Buffett Warren E"
      ],
      "period": "2024-09-30",
      "put_call": null,
      "shares_or_principal_amount": 7724000,
      "shares_or_principal_type": "SH",
      "title_of_class": "COM",
      "voting_authority_none": 0,
      "voting_authority_shared": 0,
      "voting_authority_sole": 7724000
    },
    {
      "accession_number": "0000950123-24-011775",
      "cusip": "025816109",
      "file_number": "028-04545",
      "filer_cik": "0001067983",
      "filing_date": "2024-11-14",
      "filing_url": "https://www.sec.gov/Archives/edgar/data/1067983/0000950123-24-011775.txt",
      "film_number": "241461756",
      "form_type": "13F-HR",
      "investment_discretion": "DFND",
      "issuer_name": "AMERICAN EXPRESS CO",
      "market_value": 311864270,
      "other_managers": [
        "Buffett Warren E"
      ],
      "period": "2024-09-30",
      "put_call": null,
      "shares_or_principal_amount": 1149942,
      "shares_or_principal_type": "SH",
      "title_of_class": "COM",
      "voting_authority_none": 0,
      "voting_authority_shared": 0,
      "voting_authority_sole": 1149942
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

