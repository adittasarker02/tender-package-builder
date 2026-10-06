# Tender Document Package Builder

**AI DevFest – Vibe Coding Contest · Problem: Tender Document Package Builder**

## 1. Identity

| | |
|---|---|
| **Name** | Aditta Sarker |
| **Student ID** | 241-15-068 |


## 2. What it does

A frontend-only web app that helps office staff turn a set of PDF files into **one complete, checked and correctly ordered tender package PDF**.

1. Open `requirements.json` → tender details and the required documents are shown, sorted by `order`.
2. Upload many PDFs → file name, page count and size are shown. Non-PDF files are rejected with a clear message. Any file can be removed.
3. Match each file to one required document (one file per document, one document per file). A match can be changed or undone at any time.
4. Enter expiry dates for documents that need them.
5. Every document shows exactly one live status: **Missing / Expiry date needed / Expired / Not provided / OK**.
6. Duplicate files (identical content, even with different names) are marked and cannot be matched to different documents.
7. **Generate package** stays disabled while anything blocks the package, and the reasons are shown. When everything is fine it creates one combined PDF.
8. Download as `<tender_id>_Package.pdf` (for example `T-2026-0417_Package.pdf`).

All processing happens **in the browser**. No document is uploaded anywhere.

## 3. Run it locally

Requirements: Node.js (any recent version) and Google Chrome.

```bash

npm install
npm run dev
```

Open **http://localhost:8080** in Chrome.
(`npm install` downloads nothing: all libraries are already bundled in `vendor/`. You can also just double-click `index.html`.)

**To test with the sample pack:** upload `sample-pack/requirements.json` in Step 1, then all files from `sample-pack/documents/` in Step 2.

## 4. Implemented features

### Main tasks (all done)
- **4.1 Load the list** – tender details + required documents sorted by order; clear message for invalid JSON.
- **4.2 Upload files** – many PDFs at once (drag and drop or button), name, pages, size; non-PDF rejected; remove any file; limits of 30 files / 50 MB enforced.
- **4.3 Match files** – dropdown per document; one file ↔ one document; change or undo any time.
- **4.4 Expiry dates** – date field appears only for documents with `has_expiry = true` that have a file.
- **4.5 Check everything** – live status for every document, updated instantly after every change.
- **4.6 Duplicates** – detected by content hash (SHA-256); marked in the file list; duplicates cannot be matched to different documents.
- **4.7 Make the package** – Generate button disabled while any blocking status exists, with the reasons listed.
- **4.8 Download** – `<tender_id>_Package.pdf`.
- **4.9 Two languages** – the whole app switches between English and Bangla; document names come from `title_en` / `title_bn`.

### Status rules
- Required, no file → **Missing** (blocks)
- Needs expiry and file matched, no date → **Expiry date needed** (blocks)
- Expiry date before the submission deadline → **Expired** (blocks)
- Optional, no file → **Not provided** (does not block)
- File matched and date on or after the deadline → **OK** (a document expiring on the deadline day is still OK)

### Package rules
- Page 1 is an English cover: tender ID, title, procuring entity, bidder, submission deadline, date made, and the ordered list of included documents with page numbers.
- Documents follow the cover in `order`, all pages of each file in original order; optional documents without a file are skipped.
- Every page (including the cover) has the footer `<tender_id> | Page X of Y`.
- The footer sits in a **blank band added below each page**, so it never covers the document's content (works for rotated, landscape and cropped pages too).

### Bonus features
- Index page after the cover with the start page of each document (optional checkbox).
- Seal / signature: upload a PNG, choose pages, position and size.
- Export the checklist as CSV (opens in Excel; Bangla text works).
- Save and restore work (browser storage on this computer only).
- Bangla text shown correctly on the PDF index page.
- Auto-match: suggests matches from file names and the text inside the PDFs; it also reads expiry dates found in the file and offers a "Use this date" button.
- Safe handling of bad files: damaged, empty, fake-PDF and password-protected files show a clear message instead of crashing.
- PDF preview of any uploaded file (helpful for scanned files with no readable name or text).

## 5. Problems found in the sample pack

| Problem | How the app handles it |
|---|---|
| `company_logo.png` is not a PDF | Rejected with a clear message |
| `experience_cert.pdf` and `experience_cert (1).pdf` are identical | Both marked as duplicates; only one can be used |
| `trade_license_2025.pdf` expired on 2025-06-30 | Shows **Expired** and blocks the package; the 2026 license (valid until 2027-06-30) is used instead |
| `scan_0042.pdf` is a scanned image with no useful name | Preview shows it is the Signed Declaration; matched by hand |
| Bank solvency certificate valid until 2026-12-31 | Expiry date entered and checked against the deadline 2026-10-20 |

## 6. Tech

HTML, CSS and plain JavaScript (no build step). Libraries bundled locally in `vendor/`: **pdf-lib** (merge PDFs, cover page, footers, seal) and **pdf.js** (previews and text reading). Noto Sans Bengali font bundled in `fonts/`.

## 7. Submitted files

- `output/T-2026-0417_Package.pdf` – final package generated from the sample pack (16 pages) after resolving its problems.
- `screenshots/` – statuses with problems found, expired document blocking Generate, blocked state with reasons, all OK, package ready, and Bangla view.

## 8. Known issues

- Only PDF files up to 30 files / 50 MB in total are accepted, as required.
- Bangla text on the generated PDF appears on the index page (as an image); the cover page is English as required.
- Duplicates are detected by exact file content only. The same document saved or scanned twice with different bytes is not detected.
- A PDF page with unusual or unreadable layout is copied as-is. The app cannot fix problems inside the original document.
- Expiry dates suggested from the file text are only hints; the user must confirm them.
- Tested in the latest Google Chrome only.

## 9. AI tools used

- **Claude (Anthropic)** – generated the application code, tested it in a headless Chrome browser against the sample pack and extra edge-case PDFs (rotated pages, cropped pages, damaged, empty and password-protected files), and prepared the output PDF and screenshots.

### Most useful prompt

> Build the complete project according to all the requirements provided.
Implement every feature properly and make the UI clean, responsive, and functional.
Test the project yourself, fix all errors, and make sure everything works correctly.
Give me the final working project ZIP with no unnecessary or broken files.
Also give me simple VS Code commands to install and run the project.


## 10. License / data

All companies, people and documents in `sample-pack/` are fictional and provided by the contest organisers for contest use only.