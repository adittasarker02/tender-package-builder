/* Builds the final combined PDF (cover, optional index, documents, footers, optional seal).
   Everything runs in the browser using pdf-lib. */
(function () {
  'use strict';
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;

  const A4 = [595.28, 841.89];
  const BAND = 30;          // height of the footer band added under every document page (points)
  const FOOT_SIZE = 10;
  const INK = rgb(0.07, 0.1, 0.16);
  const GRAY = rgb(0.38, 0.42, 0.48);
  const NAVY = rgb(0.06, 0.14, 0.25);
  const LINE = rgb(0.8, 0.84, 0.9);

  /* ---------- helpers ---------- */
  function normRot(a) {
    a = ((Math.round(a) % 360) + 360) % 360;
    return [0, 90, 180, 270].includes(a) ? a : (Math.round(a / 90) * 90) % 360;
  }

  // Map a point in "visual" coordinates (origin = bottom-left of the page as the reader sees it)
  // to the page's own (unrotated) coordinate system.
  function toUser(g, vx, vy) {
    switch (g.rot) {
      case 90: return [g.x1 - vy, g.y0 + vx];
      case 180: return [g.x1 - vx, g.y1 - vy];
      case 270: return [g.x0 + vy, g.y1 - vx];
      default: return [g.x0 + vx, g.y0 + vy];
    }
  }

  // Add a blank footer band below the visible area of a copied page, return its geometry.
  function extendPage(page) {
    const rot = normRot(page.getRotation().angle);
    const cb = page.getCropBox();
    let x0 = cb.x, y0 = cb.y, x1 = cb.x + cb.width, y1 = cb.y + cb.height;
    if (rot === 0) y0 -= BAND;
    else if (rot === 90) x1 += BAND;
    else if (rot === 180) y1 += BAND;
    else x0 -= BAND;
    page.setMediaBox(x0, y0, x1 - x0, y1 - y0);
    page.setCropBox(x0, y0, x1 - x0, y1 - y0);
    const g = { rot, x0, y0, x1, y1 };
    g.W = rot % 180 === 0 ? x1 - x0 : y1 - y0;
    g.H = rot % 180 === 0 ? y1 - y0 : x1 - x0;
    // paint the band white so that nothing hidden outside the old crop box can show through
    const corners = [toUser(g, 0, 0), toUser(g, g.W, BAND)];
    const bx = Math.min(corners[0][0], corners[1][0]);
    const by = Math.min(corners[0][1], corners[1][1]);
    page.drawRectangle({
      x: bx, y: by,
      width: Math.abs(corners[1][0] - corners[0][0]),
      height: Math.abs(corners[1][1] - corners[0][1]),
      color: rgb(1, 1, 1), borderWidth: 0
    });
    return g;
  }

  function plainGeom(page) {
    const { width, height } = page.getSize();
    return { rot: 0, x0: 0, y0: 0, x1: width, y1: height, W: width, H: height };
  }

  // Render text to a PNG with the browser (used for characters that the PDF standard fonts cannot draw, e.g. Bangla).
  async function textToPng(text, size, bold, color) {
    const scale = 4;
    const fam = '"Noto Sans Bengali","Nirmala UI","Segoe UI",Arial,sans-serif';
    const font = (bold ? '700 ' : '400 ') + (size * scale) + 'px ' + fam;
    try { await document.fonts.load(font, text); } catch (e) { /* ignore */ }
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 4;
    const h = Math.ceil(size * scale * 1.7);
    c.width = Math.max(w, 4); c.height = h;
    const ctx2 = c.getContext('2d');
    ctx2.font = font;
    ctx2.fillStyle = color || '#111a28';
    ctx2.textBaseline = 'alphabetic';
    ctx2.fillText(text, 2, Math.round(size * scale * 1.2));
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    return { bytes: buf, wPt: w / scale, hPt: h / scale, descent: size * 0.5 };
  }

  function makeCtx(out, fonts) { return { out, fonts, imgCache: new Map() }; }

  function canEncode(font, text) {
    try { font.widthOfTextAtSize(text, 10); return true; } catch (e) { return false; }
  }

  async function imageFor(ctx, text, size, bold) {
    const key = (bold ? 'b' : 'r') + size + '|' + text;
    if (!ctx.imgCache.has(key)) {
      const png = await textToPng(text, size, bold);
      const img = await ctx.out.embedPng(png.bytes);
      ctx.imgCache.set(key, { img, wPt: png.wPt, hPt: png.hPt, descent: png.descent });
    }
    return ctx.imgCache.get(key);
  }

  function ellipsize(font, text, size, maxW) {
    if (font.widthOfTextAtSize(text, size) <= maxW) return text;
    let s = text;
    while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > maxW) s = s.slice(0, -1);
    return s + '...';
  }

  /* Draw one line on an unrotated page. Returns the width used. */
  async function line(ctx, page, text, x, y, o) {
    o = o || {};
    const size = o.size || 11;
    const font = o.bold ? ctx.fonts.bold : ctx.fonts.reg;
    const color = o.color || INK;
    text = String(text == null ? '' : text);
    if (canEncode(font, text)) {
      let s = text;
      if (o.maxW) s = ellipsize(font, s, size, o.maxW);
      let w = font.widthOfTextAtSize(s, size);
      let px = x;
      if (o.align === 'right') px = x - w;
      else if (o.align === 'center') px = x - w / 2;
      page.drawText(s, { x: px, y, size, font, color });
      return w;
    }
    const im = await imageFor(ctx, text, size, o.bold);
    let w = im.wPt, h = im.hPt;
    if (o.maxW && w > o.maxW) { const k = o.maxW / w; w *= k; h *= k; }
    let px = x;
    if (o.align === 'right') px = x - w;
    else if (o.align === 'center') px = x - w / 2;
    page.drawImage(im.img, { x: px, y: y - (h - h * 1.2 / 1.7), width: w, height: h });
    return w;
  }

  /* Wrap and draw text (several lines). Returns the y position after the last line. */
  async function wrapped(ctx, page, text, x, y, maxW, o) {
    o = o || {};
    const size = o.size || 11;
    const lh = o.lh || size * 1.35;
    const font = o.bold ? ctx.fonts.bold : ctx.fonts.reg;
    text = String(text == null ? '' : text);
    if (!canEncode(font, text)) {
      await line(ctx, page, text, x, y, Object.assign({}, o, { maxW }));
      return y - lh;
    }
    const words = text.split(/\s+/);
    let cur = '';
    const lines = [];
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(t, size) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    for (const l of lines.slice(0, o.maxLines || 4)) {
      await line(ctx, page, l, x, y, Object.assign({}, o, { maxW }));
      y -= lh;
    }
    return y;
  }

  /* ---------- footer ---------- */
  async function drawFooter(ctx, page, g, text) {
    const font = ctx.fonts.reg;
    const baseV = 11; // baseline height above the visual bottom edge
    if (canEncode(font, text)) {
      const w = font.widthOfTextAtSize(text, FOOT_SIZE);
      const [px, py] = toUser(g, g.W / 2 - w / 2, baseV);
      page.drawText(text, { x: px, y: py, size: FOOT_SIZE, font, color: rgb(0.05, 0.05, 0.05), rotate: degrees(g.rot) });
    } else {
      const im = await imageFor(ctx, text, FOOT_SIZE, false);
      const [px, py] = toUser(g, g.W / 2 - im.wPt / 2, baseV - im.hPt * (1 - 1.2 / 1.7));
      page.drawImage(im.img, { x: px, y: py, width: im.wPt, height: im.hPt, rotate: degrees(g.rot) });
    }
  }

  /* ---------- seal ---------- */
  function parsePages(spec, total) {
    spec = String(spec || '').trim().toLowerCase();
    if (spec === '' || spec === 'all') { const s = new Set(); for (let i = 1; i <= total; i++) s.add(i); return s; }
    const set = new Set();
    for (const part of spec.split(/[,\s;]+/).filter(Boolean)) {
      const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
      if (!m) return null;
      const a = +m[1], b = m[2] ? +m[2] : a;
      if (a < 1 || b < a || b > total) return null;
      for (let i = a; i <= b; i++) set.add(i);
    }
    return set.size ? set : null;
  }

  function drawSeal(page, g, img, o) {
    const w = Math.max(20, g.W * (o.pct / 100));
    const h = w * img.height / img.width;
    const m = 30, bottomMin = BAND + 10;
    let vx, vy;
    const col = o.pos[1], row = o.pos[0];
    if (col === 'l') vx = m; else if (col === 'r') vx = g.W - m - w; else vx = (g.W - w) / 2;
    if (o.pos === 'cc') { vx = (g.W - w) / 2; vy = (g.H - h) / 2; }
    else if (row === 'b') vy = bottomMin;
    else vy = g.H - m - h;
    const [px, py] = toUser(g, vx, vy);
    page.drawImage(img, { x: px, y: py, width: w, height: h, rotate: degrees(g.rot) });
  }

  /* ---------- main ---------- */
  function fmtDate(d) {
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /**
   * entries: [{ title_en, title_bn, file: {name, bytes, pages} }] already sorted by order.
   * opts: { index: bool, seal: {bytes, pagesSpec, pos, pct} | null }
   */
  async function build(tender, entries, opts) {
    opts = opts || {};
    const ROWS = 17;
    const idxPages = opts.index && entries.length ? Math.ceil(entries.length / ROWS) : 0;

    // load all sources first (so we know the real page counts and can report which file is bad)
    const srcs = [];
    for (const e of entries) {
      let doc;
      try { doc = await PDFDocument.load(e.file.bytes, { updateMetadata: false }); }
      catch (err) { const x = new Error(err && err.message ? err.message : String(err)); x.fileName = e.file.name; throw x; }
      if (doc.getPageCount() < 1) { const x = new Error('no pages'); x.fileName = e.file.name; throw x; }
      srcs.push(doc);
    }
    const counts = srcs.map(d => d.getPageCount());
    const total = 1 + idxPages + counts.reduce((a, b) => a + b, 0);

    // validate seal pages early
    let sealImg = null, sealSet = null;
    const out = await PDFDocument.create();
    if (opts.seal && opts.seal.bytes) {
      sealSet = parsePages(opts.seal.pagesSpec, total);
      if (!sealSet) { const x = new Error('SEAL_PAGES'); x.total = total; x.sealPages = true; throw x; }
      try { sealImg = await out.embedPng(opts.seal.bytes); }
      catch (e) { const x = new Error('SEAL_IMG'); x.sealImg = true; throw x; }
    }

    const fonts = { reg: await out.embedFont(StandardFonts.Helvetica), bold: await out.embedFont(StandardFonts.HelveticaBold) };
    const ctx = makeCtx(out, fonts);

    const cover = out.addPage(A4);
    const idxList = [];
    for (let i = 0; i < idxPages; i++) idxList.push(out.addPage(A4));

    const geoms = [plainGeom(cover)].concat(idxList.map(plainGeom));
    const ranges = [];
    let pageNo = 1 + idxPages;
    for (let i = 0; i < entries.length; i++) {
      const src = srcs[i];
      const copied = await out.copyPages(src, src.getPageIndices());
      const start = pageNo + 1;
      for (const p of copied) {
        const pg = out.addPage(p);
        geoms.push(extendPage(pg));
        pageNo++;
      }
      ranges.push([start, pageNo]);
    }

    // cover
    await drawCover(ctx, cover, tender, entries, ranges);
    // index
    for (let k = 0; k < idxList.length; k++) {
      await drawIndex(ctx, idxList[k], tender, entries, ranges, k, ROWS, idxList.length);
    }

    // footer + seal on every page
    const pages = out.getPages();
    for (let i = 0; i < pages.length; i++) {
      const text = tender.tender_id + ' | Page ' + (i + 1) + ' of ' + pages.length;
      await drawFooter(ctx, pages[i], geoms[i], text);
      if (sealImg && sealSet.has(i + 1)) drawSeal(pages[i], geoms[i], sealImg, opts.seal);
    }

    out.setTitle(tender.tender_id + ' Package');
    out.setSubject(tender.title);
    out.setProducer('Tender Document Package Builder');
    out.setCreator('Tender Document Package Builder');
    const bytes = await out.save();
    return { bytes, pageCount: pages.length, ranges };
  }

  async function drawCover(ctx, page, T, entries, ranges) {
    const [W, H] = A4;
    const M = 56;
    page.drawRectangle({ x: 0, y: H - 120, width: W, height: 120, color: NAVY });
    await line(ctx, page, 'TENDER DOCUMENT PACKAGE', M, H - 62, { size: 24, bold: true, color: rgb(1, 1, 1) });
    await line(ctx, page, 'Tender ID: ' + T.tender_id, M, H - 90, { size: 13, color: rgb(0.85, 0.9, 1), maxW: W - 2 * M });

    let y = H - 160;
    const rows = [
      ['Tender ID', T.tender_id],
      ['Tender title', T.title],
      ['Procuring entity', T.procuring_entity],
      ['Bidder', T.bidder],
      ['Submission deadline', T.submission_deadline],
      ['Package created on', fmtDate(new Date())]
    ];
    for (const [k, v] of rows) {
      await line(ctx, page, k.toUpperCase(), M, y, { size: 8.5, bold: true, color: GRAY });
      const ny = await wrapped(ctx, page, v, M + 150, y, W - 2 * M - 150, { size: 12.5, bold: true, lh: 16, maxLines: 3 });
      y = Math.min(y - 24, ny - 8);
      page.drawLine({ start: { x: M, y: y + 14 }, end: { x: W - M, y: y + 14 }, thickness: 0.5, color: LINE });
    }

    y -= 14;
    await line(ctx, page, 'Included documents (in order)', M, y, { size: 14, bold: true, color: NAVY });
    y -= 10;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: NAVY });
    y -= 6;
    const avail = y - 60;
    const n = Math.max(entries.length, 1);
    const rh = Math.min(24, avail / (n + 1));
    const fs = Math.max(7, Math.min(11.5, rh * 0.5));
    y -= rh * 0.7;
    await line(ctx, page, 'No.', M, y, { size: fs - 1.5, bold: true, color: GRAY });
    await line(ctx, page, 'DOCUMENT', M + 34, y, { size: fs - 1.5, bold: true, color: GRAY });
    await line(ctx, page, 'PAGES', W - M, y, { size: fs - 1.5, bold: true, color: GRAY, align: 'right' });
    y -= rh;
    if (!entries.length) {
      await line(ctx, page, '(no documents)', M + 34, y, { size: fs, color: GRAY });
    }
    for (let i = 0; i < entries.length; i++) {
      await line(ctx, page, String(i + 1), M, y, { size: fs, color: GRAY });
      await line(ctx, page, entries[i].title_en, M + 34, y, { size: fs, bold: true, maxW: W - 2 * M - 34 - 90 });
      const [a, b] = ranges[i];
      await line(ctx, page, a === b ? String(a) : a + '-' + b, W - M, y, { size: fs, align: 'right' });
      page.drawLine({ start: { x: M, y: y - rh * 0.3 }, end: { x: W - M, y: y - rh * 0.3 }, thickness: 0.3, color: LINE });
      y -= rh;
    }
  }

  async function drawIndex(ctx, page, T, entries, ranges, k, ROWS, nIdx) {
    const [W, H] = A4;
    const M = 56;
    let y = H - 80;
    await line(ctx, page, 'Index' + (nIdx > 1 ? ' (' + (k + 1) + '/' + nIdx + ')' : ''), M, y, { size: 22, bold: true, color: NAVY });
    await line(ctx, page, 'সূচিপত্র', W - M, y, { size: 16, bold: true, color: NAVY, align: 'right' });
    y -= 12;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: NAVY });
    y -= 26;
    await line(ctx, page, 'No.', M, y, { size: 9, bold: true, color: GRAY });
    await line(ctx, page, 'DOCUMENT', M + 36, y, { size: 9, bold: true, color: GRAY });
    await line(ctx, page, 'STARTS ON PAGE', W - M - 70, y, { size: 9, bold: true, color: GRAY, align: 'right' });
    await line(ctx, page, 'PAGES', W - M, y, { size: 9, bold: true, color: GRAY, align: 'right' });
    y -= 22;
    const from = k * ROWS, to = Math.min(entries.length, from + ROWS);
    for (let i = from; i < to; i++) {
      const e = entries[i];
      const [a, b] = ranges[i];
      await line(ctx, page, String(i + 1), M, y, { size: 12, color: GRAY });
      await line(ctx, page, e.title_en, M + 36, y, { size: 12.5, bold: true, maxW: W - 2 * M - 36 - 130 });
      if (e.title_bn) await line(ctx, page, e.title_bn, M + 36, y - 15, { size: 10.5, color: GRAY, maxW: W - 2 * M - 36 - 130 });
      await line(ctx, page, String(a), W - M - 70, y, { size: 12.5, bold: true, align: 'right' });
      await line(ctx, page, String(b - a + 1), W - M, y, { size: 12, align: 'right' });
      page.drawLine({ start: { x: M, y: y - 24 }, end: { x: W - M, y: y - 24 }, thickness: 0.3, color: LINE });
      y -= 40;
    }
  }

  window.PKG = { build, parsePages, BAND };
})();
