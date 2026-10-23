# OPLUMO Label Studio V2

This independent Cloudflare target preserves the existing Node service and the currently published private Sites demo. `packages/studio-web` contains the latest Sites editor improvements plus an authenticated V2 console; `packages/cloudflare-api` is the new Workers API. Private label artwork is deliberately not copied to this public GitHub repository. `scripts/v2/migrate-sites.mjs` imports operator-supplied local originals into an authenticated workspace.

## Architecture and scope

Vue on Pages → same-origin `/api/*` Worker → D1 business records and R2 private objects; one SQLite Durable Object per workspace/job coordinates resumable 100-label parts. KV is unnecessary for the current implementation. Core tables extend the supplied proposal with users, memberships, hashed sessions, Mapping versions, imports, audit, per-line immutable snapshots and idempotent part commits. Foreign keys for templates, rules and task items include workspace identity. At least ten workspaces are supported; the integration suite provisions ten and verifies separation. There is no shared tenant password or hard-coded workspace.

QA manages the tenant's people and all business features. Manager manages business features but cannot create or change people. Workers can read published material, start/cancel reviewed jobs, download completed outputs and record physical output; they cannot create production plans, change system dates, upload masters or edit templates. Platform administrators create workspaces and receive an explicit QA membership; platform status does not bypass tenant-bound API checks. Existing users are not silently enrolled into another tenant.

Passwords use salted PBKDF2-SHA256 (100,000 iterations); opaque session tokens are stored hashed, expire in 12 hours and use HttpOnly/SameSite cookies. Mutation origins must equal APP_ORIGIN. Login attempts are limited by email/IP. Role and membership status are checked from D1 on every authenticated request. This is demo authentication, not a replacement for an enterprise identity provider, password recovery, MFA or a full account lifecycle.

## Master data and dates

SKU master XLSX or DOCX table headers: `sku_code`, `name` (required), `name_en`, `category`, `spec`, `barcode`, `weight`, `size_code`, `expiry_days` (optional). First visible Excel sheet / first Word table is used. XLSX formulas and merged cells are rejected. DOCX is a tabular master-data import, not arbitrary Word layout conversion; legacy `.doc` is unsupported. Keep identifiers as text. Imports are full-row upserts: omitted optional columns become blank/null; missing SKU rows are not deleted. Preview shows new/updated/unchanged rows; confirm applies all changed rows transactionally, with optimistic guards. Existing task snapshots remain unchanged. Per-import 500-row/2-MB safeguards apply.

Mappings choose a SKU field, explicit batch field, fixed text or production/expiry date calculation. Expiry is **production date plus expiry_days**; it does not use the current clock and does not apply an inclusive-day subtraction. Confirm that policy with factory QA before production. Dates use ISO calendar days, never elapsed-hour arithmetic. No best-before values are inferred from artwork. Each mapping has a draft/published lifecycle and history. Templates have a draft/published lifecycle, optimistic edits and a restore-previous-version action. Matching order: explicit SKU template → priority/category/size/prefix rule → explicitly configured default → block. No guessed default artwork.

PDF/BTW source uploads are private original assets. Native design JSON is editable; PDF-derived originals remain flattened artwork plus independent overlay fields. Fully decomposing an original PDF/Word/BTW into editable content is not implemented. Fonts must be uploaded/provisioned to R2 and FONT_KEY set. The renderer uses that font consistently; use an appropriately licensed font covering all required glyphs (the integration proof uses DejaVu Sans for English).

## Jobs and printing

POST preview resolves live SKU/template/Mapping versions and computes a fingerprint/counts. Creating a job with that fingerprint freezes complete per-line documents, SKU data, mapped values, batch dates and Mapping versions. Stale data requires review again. Starting a reviewed job checks that referenced versions are still published/current; after start, the frozen snapshot is the job's source of truth. Retrying a failed job uses the same snapshot, including original dates. Reprints download the same completed outputs.

The old 2,000/5,000-total-label cap is removed: counts must be safe positive integers, while each request has at most 5,000 SKU rows. Quantity = supplied production units × explicit Mapping multiplier; this is not automatic CTN/PKT conversion. Production connectors and SKU-specific conversion adapters are separate future work. Jobs partition work into at most 100 label pages per alarm, with exact-size 300-dpi PDF files per size/part, 300-dpi ZPL bitmap files, and per-part ZIP downloads. Large jobs intentionally yield multiple files rather than combining an unbounded PDF in Workers memory. The coordinator stores progress in D1 and deterministic R2 keys; retries overwrite identical part keys and never double-add committed counts. Cancellation waits for the current bounded part. A crash that precedes scheduling the next alarm can be recovered through job retry/start; failed jobs show an explicit error. No unlimited throughput or hardware guarantee is implied.

Generated files stay unavailable for download until job completion. R2 keys are never accepted directly from a caller: downloads look up an asset by workspace and authenticated user. Template image references are immutable asset IDs; renderer assets cannot fetch external URLs.

Generated count, manual original-print confirmation, reprint, test and waste are separate metrics. Idempotency keys prevent retry duplication; a DB trigger prevents original confirmations exceeding the job's generated count. Physical-output confirmations are staff assertions, not printer acknowledgements. These are inputs to future forecasting, not a demand forecast model or a sales proxy. Browser single-label output is a design/testing path; it is audited but does not increment production totals.

## Full export

QA/Manager can start a workspace export job. Download **all ZIP volumes**; the first contains `master.json`, and each volume includes its own file manifest and original R2-key paths. Export contains tenant master data, template/Mapping histories, rules, task snapshots, print records, audit and every asset captured at export start. Password hashes and sessions are excluded. Each ZIP has a bounded ~15-MB payload; individual files are capped at 20 MB. This is a portable snapshot, not an automatic restore installer, a transactionally consistent point-in-time database backup or a substitute for D1 backup plus R2 retention. Concurrent edits during multi-table export should be paused if a coordinated snapshot is required.

## Local setup and verification

```
npm ci
npm run build:v2
npm run test:v2
npm run test:integration -w @oplumo/cloudflare-api
```

`build:v2` is a strictly local esbuild/WASM bundle plus Vue build and typechecks; it never deploys. `wrangler dev` uses the bindings in `packages/cloudflare-api/wrangler.jsonc`. Apply the SQL migration to local D1, provision a licensed font in local R2, copy `.dev.vars.example` and initialize once through POST `/api/bootstrap` with a matching bootstrap Bearer token and explicit account/workspace details. The integration test provides a fully automatic disposable Miniflare environment, and tests real authentication, D1, R2, Durable Object alarms, rendering and PDF page dimensions without touching Cloudflare.

For interactive local development, run the API and `npm run dev -w @oplumo/studio-web`; the Vite proxy uses port 8787. Do not use demonstration passwords in a real account.

## Cloudflare deployment preparation

1. Create a new, dedicated D1 database and R2 bucket for this project. Replace the placeholder `database_id` in `wrangler.jsonc`. Keep the existing ordering/payment deployments untouched.
2. Set APP_ORIGIN to the exact Pages custom-domain origin. Set LOCAL_DEV to `false` in production, set BOOTSTRAP_TOKEN as a Worker secret, and configure FONT_KEY. Deploy API with D1/R2/JOBS bindings and its Durable Object migration; apply the D1 SQL migration.
3. Upload a licensed font to the selected FONT_KEY. Use the one-time bootstrap endpoint to create the first platform administrator and workspace. Remove BOOTSTRAP_TOKEN afterwards.
4. Build Pages from `packages/studio-web`, output `packages/studio-web/dist`, with root install/workspace build. Route the **same custom domain's `/api/*`** to the Worker. Do not use cross-site cookies across pages.dev and workers.dev; the app intentionally uses same-origin URLs.
5. Sign in, add workspaces/users, import originals/master data, inspect dates and sizes, publish mappings/templates, then trial print. Cloudflare account provisioning/deployment and physical output must be separately verified before declaring production.

Review endpoints: `/api/auth/*`, `/api/platform/workspaces`, `/api/users`, `/api/skus`, `/api/sizes`, `/api/templates`, `/api/mappings`, `/api/rules`, `/api/imports`, `/api/assets`, `/api/jobs`, `/api/print`, `/api/forecast`, `/api/audit`, `/api/export`.

## Remaining production work

Enterprise authentication/account recovery and password changes; production order/Sheets/Lark connectors; full PDF/Word artwork conversion; per-SKU unit conversions; actual printer dispatch/acknowledgements; fully coordinated export/restore; retention/quota governance; real-cloud load testing and mobile/hardware acceptance. Existing private Sites deployment remains the prior browser-local demo until Cloudflare credentials/resources and deployment are explicitly available.
