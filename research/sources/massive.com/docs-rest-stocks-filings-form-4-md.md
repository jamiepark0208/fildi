<!-- url: https://massive.com/docs/rest/stocks/filings/form-4.md
fetched_at: 2026-10-24T17:11:33+00:00
title:  -->


```
> For the full documentation index, see: https://massive.com/docs/llms.txt

# REST
## Stocks

### Insider Transactions (Form 4)

**Endpoint:** `GET /stocks/filings/vX/form-4`

**Description:**

Retrieve SEC Form 4 filings that disclose all changes in beneficial ownership by corporate insiders. These must be filed within two business days of any transaction (purchases, sales, option exercises, grants, gifts, etc.) and include detailed transaction data such as dates, prices, share amounts, and transaction codes.

Use Cases: Real-time insider trading monitoring, management confidence analysis, large trade detection, regulatory and Section 16 compliance tracking, and historical insider behavior studies.

## Query Parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `issuer_cik` | string | No | SEC Central Index Key of the issuer company (10 digits, zero-padded). |
| `issuer_cik.any_of` | string | No | Filter equal to any of the values. Multiple values can be specified by using a comma separated list. |
| `owner_cik` | string | No | SEC Central Index Key of the reporting owner (10 digits, zero-padded). |
| `owner_cik.any_of` | string | No | Filter equal to any of the values. Multiple values can be specified by using a comma separated list. |
| `tickers` | string | No | Filter for arrays that contain the value. |
| `tickers.all_of` | string | No | Filter for arrays that contain all of the values. Multiple values can be specified by using a comma separated list. |
| `tickers.any_of` | string | No | Filter for arrays that contain any of the values. Multiple values can be specified by using a comma separated list. |
| `form_type` | string | No | SEC form type ('4' for standard filing, '4/A' for amendments). |
| `filing_date` | string | No | Date when the filing was submitted to the SEC (formatted as YYYY-MM-DD). Value must be formatted 'yyyy-mm-dd'. |
| `filing_date.gt` | string | No | Filter greater than the value. Value must be formatted 'yyyy-mm-dd'. |
| `filing_date.gte` | string | No | Filter greater than or equal to the value. Value must be formatted 'yyyy-mm-dd'. |
| `filing_date.lt` | string | No | Filter less than the value. Value must be formatted 'yyyy-mm-dd'. |
| `filing_date.lte` | string | No | Filter less than or equal to the value. Value must be formatted 'yyyy-mm-dd'. |
| `transaction_code` | string | No | SEC transaction code indicating the type of transaction (e.g., 'P' for purchase, 'S' for sale, 'A' for grant/award, 'M' for exercise/conversion). |
| `limit` | integer | No | Limit the maximum number of results returned. Defaults to '100' if not specified. The maximum allowed limit is '10000'. |
| `sort` | string | No | A comma separated list of sort columns. For each column, append '.asc' or '.desc' to specify the sort direction. The sort column defaults to 'filing_date' if not specified. The sort order defaults to 'desc' if not specified. |

## Response Attributes

| Field | Type | Description |
| --- | --- | --- |
| `next_url` | string | If present, this value can be used to fetch the next page. |
| `request_id` | string | A request id assigned by the server. |
| `results` | array[object] | The results for this request. |
| `results[].accession_number` | string | Unique SEC accession number for the filing (e.g., '0001209191-25-012345'). |
| `results[].aff_10b5_one` | boolean | Whether the transaction was made pursuant to a Rule 10b5-1 trading plan. |
| `results[].date_of_original_submission` | string | Date of the original filing submission for amendment filings (4/A). Null for standard filings (formatted as YYYY-MM-DD). |
| `results[].deemed_execution_date` | string | Deemed execution date if different from transaction date (formatted as YYYY-MM-DD). |
| `results[].direct_or_indirect` | string | Whether ownership is direct ('D') or indirect ('I'). |
| `results[].equity_swap_involved` | boolean | Whether an equity swap was involved in the transaction. |
| `results[].exercise_date` | string | Date exercisable for derivative securities (formatted as YYYY-MM-DD). |
| `results[].exercise_price` | number | Exercise or conversion price of derivative securities in USD. |
| `results[].expiration_date` | string | Expiration date for derivative securities (formatted as YYYY-MM-DD). |
| `results[].filing_date` | string | Date when the filing was submitted to the SEC (formatted as YYYY-MM-DD). |
| `results[].filing_url` | string | Direct URL to the filing on the SEC EDGAR website. |
| `results[].footnotes` | array[object] | List of footnotes from the filing that are relevant to this row, each with an id and description. |
| `results[].form_type` | string | SEC form type ('4' for standard filing, '4/A' for amendments). |
| `results[].is_director` | boolean | Whether the reporting owner is a director of the issuer. |
| `results[].is_officer` | boolean | Whether the reporting owner is an officer of the issuer. |
| `results[].is_other` | boolean | Whether the reporting owner has another relationship with the issuer. |
| `results[].is_ten_percent_owner` | boolean | Whether the reporting owner holds 10% or more of a class of equity securities. |
| `results[].issuer_cik` | string | SEC Central Index Key of the issuer company (10 digits, zero-padded). |
| `results[].issuer_name` | string | Name of the issuer company as reported in the filing. |
| `results[].nature_of_ownership` | string | Nature of indirect ownership (e.g., 'By Trust', 'By Spouse'). |
| `results[].not_subject_to_section_16` | boolean | Whether the reporting owner is not subject to Section 16 of the Securities Exchange Act. |
| `results[].officer_title` | string | Title of the officer, if the reporting owner is an officer. |
| `results[].owner_cik` | string | SEC Central Index Key of the reporting owner (10 digits, zero-padded). |
| `results[].owner_name` | string | Name of the reporting owner (individual or entity). |
| `results[].period_of_report` | string | Date of the event triggering the filing (formatted as YYYY-MM-DD). |
| `results[].record_type` | string | Type of record in the filing (e.g., 'transaction', 'holding'). |
| `results[].remarks` | string | Additional remarks included in the filing. |
| `results[].security_title` | string | Title or description of the security (e.g., 'Common Stock', 'Stock Option'). |
| `results[].security_type` | string | Type of security ('non-derivative' or 'derivative'). |
| `results[].shares_owned_following_transaction` | number | Total shares beneficially owned after the transaction. |
| `results[].tickers` | array[string] | A list of ticker symbols for the issuer company. Multiple symbols may indicate different share classes. |
| `results[].transaction_acquired_disposed` | string | Whether shares were acquired ('A') or disposed of ('D'). |
| `results[].transaction_code` | string | SEC transaction code indicating the type of transaction (e.g., 'P' for purchase, 'S' for sale, 'A' for grant/award, 'M' for exercise/conversion). |
| `results[].transaction_date` | string | Date of the transaction (formatted as YYYY-MM-DD). |
| `results[].transaction_price_per_share` | number | Price per share of the transaction in USD. |
| `results[].transaction_shares` | number | Number of shares involved in the transaction. |
| `results[].transaction_timeliness` | string | Timeliness of the filing: 'O' (on time) or 'L' (late). |
| `results[].transaction_value` | number | Total value of the transaction in USD (transaction_shares x transaction_price_per_share). Null when shares or price is not reported. |
| `results[].underlying_security_shares` | number | Number of underlying shares for derivative transactions. |
| `results[].underlying_security_title` | string | Title of the underlying security for derivative transactions. |
| `status` | enum: OK | The status of this request's response. |

## Sample Response

```json
{
  "next_url": "https://api.massive.com/stocks/filings/vX/form-4?cursor=eyJsaW1pd...",
  "request_id": "047c7035a86042b1925118e5f68d81b0",
  "results": [
    {
      "accession_number": "0002123147-26-000002",
      "aff_10b5_one": false,
      "date_of_original_submission": null,
      "deemed_execution_date": "2026-03-27",
      "direct_or_indirect": "D",
      "equity_swap_involved": false,
      "exercise_date": "2026-03-27",
      "exercise_price": 88.167,
      "expiration_date": "2026-03-27",
      "filing_date": "2026-03-30",
      "filing_url": "https://www.sec.gov/Archives/edgar/data/1469395/0002123147-26-000002.txt",
      "footnotes": [
        {
          "description": "These shares were acquired at a price of 4955 argentine pesos per share. For reporting purposes, the exercise price has been converted to US dollars based on the exchange rate reported by Banco de la Nacion Argentina for the date of the acquisition, which was 1405 argentine pesos per US dollar. Then multiplied by 25, the Par value or rate of common shares to one ADR.",
          "id": "F1"
        }
      ],
      "form_type": "4",
      "is_director": false,
      "is_officer": true,
      "is_other": false,
      "is_ten_percent_owner": false,
      "issuer_cik": "0001469395",
      "issuer_name": "Pampa Energy Inc.",
      "not_subject_to_section_16": false,
      "officer_title": "Chief Financial Officer",
      "owner_cik": "0002123147",
      "owner_name": "Zuberbuhler Adolfo Fernando",
      "period_of_report": "2026-03-27",
      "record_type": "transaction",
      "security_title": "Common Stock, $25 Par Value",
      "security_type": "derivative",
      "shares_owned_following_transaction": 2759,
      "tickers": [
        "PAM"
      ],
      "transaction_acquired_disposed": "A",
      "transaction_code": "A",
      "transaction_date": "2026-03-27",
      "transaction_price_per_share": 88.167,
      "transaction_shares": 12923,
      "transaction_timeliness": "O",
      "transaction_value": 1139382.141,
      "underlying_security_shares": 12923,
      "underlying_security_title": "PAMP"
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

