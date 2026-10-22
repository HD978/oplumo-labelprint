# Excel bulk die-cut labels

In `#/studio`, choose **Excel bulk labels**. This is a separate bulk-label workflow, alongside the existing order inbox and immutable order-batch prototype. It uses native designer templates, not imported PDFs or BarTender files. No production integration is changed.

## Operator workflow

1. Create label templates in the designer with actual stock width/height in millimetres, e.g. 40x20, 70x50 or 100x150. Put named placeholders such as `{{name}}` and `{{outlet}}` in text/barcode/QR elements.
2. Select up to 10 `.xlsx` files together. A new file selection replaces the previous selection. Each workbook must be no larger than 2 MiB. Legacy `.xls`, `.xlsm`, CSV and matrix order layouts are not supported in this version.
3. Choose **one visible worksheet per workbook**. The first row must contain unique, nonempty headers; data starts on row 2. Blank rows are skipped. Other nonblank rows, including hidden rows, are included. Hidden worksheets are not offered. Merged tables and invalid sheets produce explicit errors instead of partial output.
4. Choose one default template, or select a template-ID column for mixed templates/sizes. IDs must match actual native template IDs. There is no SKU-to-template inference in this workflow.
5. Choose the label-copies column or explicitly keep **one label per row**. Copies are actual label counts, not packet/carton conversion factors. Zero, negative, decimal, blank or malformed counts are errors. The order inbox's SKU conversion rules are not automatically applied here.
6. Map each used placeholder to an Excel column or fixed text. Exact header/key matches are suggested; all used values must be nonempty. No field is silently filled from unrelated columns or calculated defaults. Successful mappings are remembered on the same browser when local storage is available; source workbook data is not saved to browser preferences.
7. Check source preview, totals, stock sizes and first-label preview. Every row is checked for binding/count errors. Only the first row is visually previewed, not the entire dataset. This does not prove that every possible text length fits the template.
8. Confirm generation. One size returns one PDF. Multiple sizes return a ZIP containing a separate PDF for each size. Within a size, source-file/row order is preserved. Each label occupies one PDF page with exactly the template's dimensions; copies repeat pages without an A4 carrier or crop marks. Print with the matching stock at **100% / Actual size**. This creates print artwork, not cutting paths or physical die-cutting.

## Excel values

- Preserve identifier/SKU columns as text in Excel. Text identifiers retain leading zeroes; simple numeric formats such as `000000` are also preserved. Arbitrary custom Excel display formats are not reproduced.
- Date cells become `YYYY-MM-DD`; text dates remain exactly the supplied text. Production/expiry fields are simply supplied values. Shelf-life calculation and approval are not part of this workflow.
- Formula cells use their saved cached result. The app never evaluates formulas or fetches linked data. Recalculate and save the workbook in Excel before uploading. Missing caches and error results block the sheet.
- Header matching is exact and case-sensitive after trimming header whitespace. Differing workbook columns need common headers for the mapped fields; a missing mapped column identifies the file/sheet/row and prevents export.

## Integrity, quality and local storage

The server fingerprint covers workbook-derived rows, bindings and actual selected template documents. Export revalidates current templates; changed input/artwork requires a new preview. A single-process queue serializes generation. Identical current inputs reuse the same export and generation record. PDFs are rendered from frozen template copies using the existing shared compiler and lossless 300-dpi PNG embedding. No JPEG conversion is used. Rasterization is not vector artwork; inspect quality on the actual printer before production.

The bulk path uses strict image/barcode/QR asset rendering: a failed asset blocks the entire export instead of releasing a PDF with a silently missing code. Invalid text element geometry is blocked. Other existing single-template rendering behavior is unchanged. Overflowing text, chosen fonts, barcode scan quality and stock feed still require template and physical-printer QA.

Files and immutable input/template/value snapshots persist under `LABELPRINT_DATA_DIR/bulk/`. The directory is excluded from git. A completed output is atomically renamed before its manifest is exposed. An incomplete generation does not create a successful history record. Records mean **PDF generated**, not downloaded successfully or physically printed. History is separate from the order-batch approval history. Local bulk exports currently have no archive/retention UI; back up and manage their disk usage before production.

Guardrails: 500 selected data rows and 5000 labels per export, 64 columns / 500 data rows per sheet, 10 visible sheets per workbook, 1000 characters per cell, 20,000 parsed table cells per workbook. ZIP preflight checks bounded actual decompression before ExcelJS loads an XLSX (16 MiB per entry / 32 MiB per workbook). Export dimensions are limited to 5–200 mm wide and 5–300 mm high. Rendering is bounded to 64 million unique-image pixels / 32 MiB PNG bytes and 64 MiB final export; split large batches when a guardrail is reached. These caps are not throughput guarantees.

The application remains a trusted-network local Node service with no tenant/user authorization; this feature does not make it ready for direct public exposure or Cloudflare Workers. Batch export continues while the server process runs; browser navigation can lose the download handoff, but retrying the same reviewed inputs reuses the recorded file.

## API

| Method | Path | Input / output |
|---|---|---|
| POST | `/api/studio/excel/read?name=orders.xlsx` | Raw XLSX bytes with `application/octet-stream`; returns visible sheets, headers, source rows and sheet errors |
| POST | `/api/studio/bulk/preview` | Normalized rows, template choice and bindings; returns fingerprint, counts, sizes, first PNG |
| POST | `/api/studio/bulk/pdf` | `{ input, fingerprint }`; returns PDF or size-separated ZIP |
| GET | `/api/studio/bulk/history` | Successful generation manifests only |

`input` includes `templateId`, `templateColumn` (empty for default template), `quantityColumn` (empty for one copy), `bindings` (`{ column }` or `{ value }` per parameter), and `rows` (`{ file, sheet, row, cells }`). Uploaded workbooks are not automatically accepted into the ordering system.

## Verification

Tests exercise real XLSX bytes, Unicode and leading-zero IDs, date and formula-cache handling, duplicate headers, merged tables, oversized/decompression failures, bindings and count errors, template changes, invalid later-row barcodes, concurrent/restarted export reuse and HTTP responses. Generated PDFs are reopened to check every expected page count and width/height. Temporary two-size sample proofs were rendered with Poppler and visually inspected for readable text and page fit.

Browser desktop/mobile interaction QA is still pending because Chromium is unavailable in this environment. No live production workbook, company artwork or physical printer has been validated.
