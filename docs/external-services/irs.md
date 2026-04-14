# IRS Income Verification

IRS income data is used by SNAP (7 CFR § 272.8), Medicaid (42 CFR § 435.950), and TANF agencies to verify reported income. Blueprint service type: `income_verification`.

## Services

### IEVS — Income and Eligibility Verification System

The federal framework mandating quarterly income verification for active SNAP cases. States submit queries to IRS through the IEVS channel; IRS returns wage and income data.

**Call mode:** Async (batch-oriented; responses can take hours)

**Inputs:**

| Field | Type | Notes |
|---|---|---|
| `ssn` | string | Primary identifier |
| `firstName` | string | As on SSA/IRS records |
| `lastName` | string | As on SSA/IRS records |
| `dateOfBirth` | date | Used to resolve ambiguous SSN matches |

**Result fields:**

| Field | Type | Notes |
|---|---|---|
| `matchStatus` | enum | See status codes below |
| `matchConfidence` | enum | `exact`, `partial`, `none` |
| `incomeRecords` | array | One entry per income source/year |
| `incomeRecords[].taxYear` | integer | |
| `incomeRecords[].incomeType` | enum | `wages`, `self_employment`, `interest`, `dividends`, `capital_gains`, `farm`, `rental`, `other` |
| `incomeRecords[].grossAmount` | number | |
| `incomeRecords[].sourceCode` | string | IRS source indicator |
| `nonFilerIndicator` | boolean | Person did not file a return for the queried year |

**Match status codes:**

| Code | Meaning |
|---|---|
| `matched` | SSN, name, DOB all matched; income records returned |
| `no_match` | No record found for this SSN |
| `inconclusive` | Partial match — name or DOB discrepancy; may need manual review |
| `pending_manual_review` | Match flagged for caseworker adjudication |

---

### IVES — Income Verification Express Service

Used to obtain IRS tax transcripts for specific tax years. More direct than IEVS — returns detailed return data rather than the quarterly IEVS income summary. Can be used synchronously for real-time intake processing.

**Call mode:** Sync or async depending on transcript type and state configuration

**Inputs:**

| Field | Type | Notes |
|---|---|---|
| `ssn` | string | |
| `firstName` | string | As on filed return |
| `lastName` | string | As on filed return |
| `dateOfBirth` | date | |
| `taxYears` | array[integer] | Years to retrieve |
| `transcriptType` | enum | `account`, `record_of_account`, `non_filing_verification` |

**Result fields:**

| Field | Type | Notes |
|---|---|---|
| `matchStatus` | enum | See status codes below |
| `transcripts` | array | One entry per requested tax year |
| `transcripts[].taxYear` | integer | |
| `transcripts[].filingStatus` | enum | `single`, `married_joint`, `married_separate`, `head_of_household`, `qualifying_widow` |
| `transcripts[].adjustedGrossIncome` | number | AGI |
| `transcripts[].wages` | number | W-2 wages |
| `transcripts[].selfEmploymentIncome` | number | Schedule C |
| `transcripts[].interestIncome` | number | |
| `transcripts[].dividendIncome` | number | |
| `transcripts[].capitalGains` | number | |
| `transcripts[].farmIncome` | number | Schedule F |
| `transcripts[].rentalIncome` | number | |
| `transcripts[].nonFiler` | boolean | Did not file for this year |

**Match status codes:** Same as IEVS above.

---

## Regulatory and access notes

- All IRS data is Federal Tax Information (FTI) governed by IRS Publication 1075. Agencies must implement IRS Publication 1075 safeguarding controls before accessing IEVS or IVES.
- Computer Matching Agreements (5 U.S.C. § 552a) are required for IEVS access.
- Authority for IRS to share FTI with SNAP/TANF agencies: 26 U.S.C. § 6103(l)(7). For Medicaid: IRC § 6103(l)(19).
- IRS imposes query volume limits; rate tracking is a state infrastructure concern (see [data-exchange.md Known gaps](../architecture/domains/data-exchange.md#known-gaps)).

> **Verification needed:** Specific field names and response envelope formats vary by state IEVS integration and may differ from the field names above. Confirm with your state's IRS IEVS liaison or USDA FNS technical guidance before finalizing schemas.
