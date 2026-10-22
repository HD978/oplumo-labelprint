# OPLUMO Label Studio — phase 1 design

Open `#/studio`. This is an interactive synthetic-data preview, not a production order importer. Search filters the inbox, review includes all valid sample rows regardless of search, and approval is session-only and cannot send a print job. Existing template designer and single-template print workflows remain available. No customer data is seeded.

## Ownership and boundary

The ordering system owns orders, revisions, outlet identity, delivery dates, quantities, cancellations and amendment approval. Studio owns SKU mapping, confirmed unit conversions, approved immutable template versions, expiry policies, batch snapshots, dispatch and reprint audit. Google Sheets is the initial adapter; the website will later implement the same ingestion contract. Do not infer conversions or expiry from product names. The sample sizes 40x20, 70x50 and 100x150 are illustrative, not changes to any existing ordering site's stock settings.

## Proposed ingestion contract (not implemented)

```json
{
  "schemaVersion": 1,
  "companyId": "resolved-by-authenticated-server",
  "source": "ordering-web",
  "orderId": "external-stable-id",
  "revision": 2,
  "status": "confirmed",
  "outletId": "outlet-id",
  "deliveryDate": "2026-12-01",
  "updatedAt": "2026-11-28T03:00:00Z",
  "lines": [{"lineId": "line-1", "sku": "SKU-001", "quantity": "12", "unit": "PKT"}]
}
```

Company identity must be established from authentication, never trusted from a submitted payload. Namespace external IDs by company and source. Same order/revision/payload is an idempotent replay; changed payload with same revision is a conflict. Older revisions must not overwrite newer ones. Require explicit cancellation events, preserve prior revisions, and invalidate unprinted snapshots on source changes. After dispatch, amendments require reconciliation and explicit operator-approved delta/reprint decisions. No automatic full-order reprint.

Validate complete payloads before acceptance: ISO dates, monotonic positive revisions, unique nonempty line IDs, known outlet and SKU, allowed units, positive decimal quantities with defined precision and maximums. Cancelled events identify the order/revision and need no positive lines. Persist transactionally with tenant isolation and atomic unique keys.

## Batch and printing states (planned)

Validated → generated → awaiting approval → approved → queued → sending → sent → operator-confirmed output. Separate blocked, stale, cancelled, failed and uncertain delivery states. A transport acknowledgement proves sending only. A timeout after dispatch is uncertain, requiring reconciliation before retry. Use immutable snapshots including order, SKU-rule and template versions; approval and dispatch each recheck source versions. Idempotency must include tenant, source revision, line and label purpose. Reprints require reason, operator and bounded selected quantities linked to the original job. Confirmation must record actual output and discrepancies.

## Delivery sequence

1. Validate existing Apps Script outputs with actual orders and approved templates.
2. Add authenticated tenant-aware persistence and adapter contract tests.
3. Read-only Sheets adapter; compare batch counts/content with the existing system.
4. Add reviewed product/outlet rules and versioned template management.
5. Connect local print bridge; validate physical stock, quality, failure and restart behavior.
6. Connect ordering website adapter, then consider automatic dispatch for approved exception-free rules.

This repository currently assumes a trusted local network and has no tenant authentication. Do not expose its API publicly or claim multi-company readiness before authorization and isolation are implemented. PDF template ingestion is also future work; the existing editor uses its native template documents.

## Verification of this preview

Lint, production build (including Vue type checking), shared/server type checking,
and all 25 existing tests pass. Browser QA was attempted but the environment has
no installed Chromium executable; desktop/mobile visual and interaction checks
remain pending. The approval preview is not a tested production batch service.
