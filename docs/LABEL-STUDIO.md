# OPLUMO Label Studio — local workspace

Open `#/studio`. This branch adds a working **single-process, single-factory local development workspace** to the existing label designer. It starts empty; it never imports customer data or changes any Google Sheet, Apps Script or ordering website. Keep the existing trusted-network deployment boundary. No employee authentication or company isolation has been added.

## Available now

- Save outlet IDs and explicit SKU/unit conversion rules using the configuration editor.
- Match rules to real native template IDs, listed from the existing template library.
- Import order arrays manually with strict validation and positive integer quantities.
- Namespace order IDs by source; accept higher revisions, reject older/conflicting revisions, and make identical replays idempotent. Preserve received order revisions, including cancellations.
- Select a delivery date, calculate quantity and stock-size totals, and list blocking unknown outlets, missing rules/templates, invalid dimensions and quantity limits.
- Prepare an immutable quantity-plan snapshot only when every selected-date line passes. The search box filters display, never batch membership. Counts exclude separator paper.
- Record confirmation separately from printing. Concurrent creation returns the same batch for identical sources; repeated approval preserves its original confirmation time.
- Detect stale snapshots when a selected-date order, configuration or used template changes. Recheck at approval; stale batches remain visible and cannot be approved.
- Preserve actual source orders, rules and native template documents in each batch snapshot; download a plan as JSON. This download is not a printable label PDF.
- Save in `LABELPRINT_DATA_DIR/studio.json` using serialized writes and temporary-file rename. A restart reopens the workspace. Invalid JSON is not silently replaced.

The UI deliberately exposes JSON editors in this developer phase. A dedicated SKU/outlet form, granular operator roles and production approval identity remain future work. Confirmations currently have a server timestamp but **no authenticated operator identity**.

## Local setup

1. Build and start the app as described in README.
2. Open `#/studio`, then Product rules. Copy an actual template ID from the displayed library.
3. Save configuration:

```json
{
  "outlets": ["SAMPLE-OUTLET"],
  "rules": [
    {"sku": "SAMPLE-SKU", "unit": "PKT", "labelsPerUnit": 1, "templateId": "REPLACE_WITH_EXISTING_TEMPLATE_ID"}
  ]
}
```

4. Choose a delivery date. In Order inbox, expand Order JSON, insert the sample order and import it. The sample button only edits text; import requires a separate explicit action.
5. Review all validation issues, create a snapshot, then approve it. Inspect Batch records. Nothing is sent to a printer by this Studio flow.

## Implemented local ingestion shape

```json
[
  {
    "source": "manual",
    "orderId": "SAMPLE-001",
    "revision": 1,
    "status": "confirmed",
    "outletId": "SAMPLE-OUTLET",
    "deliveryDate": "2026-12-01",
    "lines": [{"lineId": "1", "sku": "SAMPLE-SKU", "quantity": 12, "unit": "PKT"}]
  }
]
```

Cancellation uses a higher revision, `status: "cancelled"` and `lines: []`. Identical revisions compare normalized recognized fields, with sorted line IDs. A whole import fails atomically on conflict. Decimal quantities are intentionally rejected until unit precision and rounding policies are defined. Field IDs are trimmed, bounded to 128 characters, and reject control characters. Dates must be real ISO calendar dates. Unknown outlet or SKU/unit values can be received but block batch preparation until mapped; they are never guessed.

Limits: 1,000 orders per import, 1,000 lines per order, 5,000 current orders / 20,000 current lines / 20,000 received revisions / 1,000 batches per local workspace, 100,000 labels per line and 250,000 labels per batch. These are guardrails, not load-tested throughput claims. The parent HTTP server retains its 16 MiB body limit. JSON-file storage is not designed for unbounded retained history; archive/database migration is needed before these limits.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/studio` | Current configuration, orders, revisions and batches with derived stale state |
| PUT | `/api/studio/settings` | Validate and replace outlet/SKU rule configuration |
| POST | `/api/studio/orders` | Atomically import/replay/amend/cancel orders |
| POST | `/api/studio/preview` | Calculate selected-date plan (`deliveryDate` body) |
| POST | `/api/studio/batches` | Prepare or return existing current-source snapshot (`deliveryDate` body) |
| POST | `/api/studio/batches/:id/approve` | Recheck sources and record local confirmation |

The separate **Excel bulk labels** tab now supports multiple XLSX files, field mapping and size-separated label PDF generation. See [Excel workflow](EXCEL-BULK-LABELS.md). That path does not render order-inbox batches or reuse their approval state.

No Studio dispatch or reprint endpoint exists. Existing single-template editor/printing APIs remain independent and do **not** enforce Studio batch approval. Do not interpret this prototype as a production print permission gate.

## Production boundary and remaining work

The ordering website must own order identity, amendments, cutoff and delivery commitments. Studio owns explicit label mappings, quantity/EXP policies, template versions, immutable batch approvals and print/reprint audit. Initial Sheets and future website adapters should normalize into one contract, with schema version, authenticated server-resolved tenant identity and stable external IDs. They are not connected yet.

Before production, add authenticated tenant/role enforcement, a transactional database with cross-process uniqueness, API credentials and adapter retries, dedicated master-data forms, production date/expiry/storage policy, placeholder/field mapping, approved artwork/PDF template ingestion, order-batch-to-label rendering, production PDF/physical-stock validation and backups. Current local template reads and Studio file writes are not one transaction; approval can become stale immediately after an external template edit. A dispatch worker must recheck transactional/versioned sources at send time.

Printing state design: generated → awaiting approval → approved → queued → sending → sent → operator-confirmed output. Preserve blocked, stale, cancelled, failed and uncertain delivery states. A timeout after sending requires reconciliation before retry. Reprints need selected bounded quantities, reason, authenticated operator and links to the original job. None of the dispatch, output-confirmation or reprint stages are implemented in Studio yet.

## Verification

Meaningful service and HTTP tests cover restart persistence, concurrent replay/creation/approval, immutable source snapshots, revision conflict rollback, cancellation, rules/template invalidation, invalid input, line/batch limits, corrupt-file failure and missing Studio print routes. Existing rendering/transport tests remain intact. See PR validation for current counts.

Desktop/mobile browser QA remains pending: Playwright is installed but Chromium download fails in this environment. No successful visual or physical-printer validation is claimed.
