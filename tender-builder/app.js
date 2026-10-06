/* Tender Document Package Builder - UI and logic. Frontend only: nothing leaves the browser. */
(function () {
  'use strict';

  var LIMITS = { files: 30, bytes: 50 * 1024 * 1024 };
  var $ = function (s) { return document.querySelector(s); };
  var state = {
    lang: 'en',
    req: null,            // { tender, requirements[] sorted by order }
    rawReq: null,
    files: [],            // { id, name, size, pages, bytes, hash, text, expHint }
    matches: {},          // reqId -> fileId
    expiry: {},           // reqId -> 'YYYY-MM-DD'
    index: false,
    seal: null,           // { name, bytes }
    sealPages: '', sealPos: 'br', sealPct: 18,
    gen: null,            // { url, pages, name }
    nextId: 1
  };
  var pendingRestore = null;

  /* ---------------- helpers ---------------- */
  function t(key, p) {
    var s = (I18N[state.lang] && I18N[state.lang][key]);
    if (s == null) s = I18N.en[key];
    if (s == null) s = key;
    if (p) Object.keys(p).forEach(function (k) { s = s.split('{' + k + '}').join(p[k]); });
    return s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function pagesText(n) { return t(n === 1 ? 'pages1' : 'pagesN', { n: n }); }
  function reqTitle(r) { return state.lang === 'bn' ? (r.title_bn || r.title_en) : (r.title_en || r.title_bn); }
  function fileById(id) { for (var i = 0; i < state.files.length; i++) if (state.files[i].id === id) return state.files[i]; return null; }
  function validDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }
  function safeName(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '_'); }
  function showMsg(el, kind, text) {
    el.className = 'banner ' + kind; el.textContent = text; el.hidden = !text;
  }
  function invalidateGen() {
    if (state.gen) { try { URL.revokeObjectURL(state.gen.url); } catch (e) { } state.gen = null; }
    $('#downloadBtn').hidden = true; $('#previewBtn').hidden = true; $('#genMsg').innerHTML = '';
  }

  /* ---------------- requirements ---------------- */
  function parseRequirements(data) {
    if (!data || typeof data !== 'object') throw new Error('not an object');
    var T = data.tender;
    if (!T || typeof T !== 'object') throw new Error('"tender"');
    ['tender_id', 'title', 'procuring_entity', 'bidder', 'submission_deadline'].forEach(function (k) {
      if (T[k] == null || String(T[k]).trim() === '') throw new Error('tender.' + k);
    });
    var tender = {
      tender_id: String(T.tender_id).trim(), title: String(T.title), procuring_entity: String(T.procuring_entity),
      bidder: String(T.bidder), submission_deadline: String(T.submission_deadline).trim()
    };
    if (!validDate(tender.submission_deadline)) throw new Error('tender.submission_deadline (YYYY-MM-DD)');
    if (!Array.isArray(data.requirements) || !data.requirements.length) throw new Error('"requirements"');
    var seen = {};
    var list = data.requirements.map(function (r, i) {
      if (!r || r.id == null || String(r.id) === '') throw new Error('requirements[' + i + '].id');
      var id = String(r.id);
      if (seen[id]) throw new Error('duplicate id ' + id);
      seen[id] = 1;
      var order = Number(r.order);
      if (!isFinite(order)) throw new Error('requirements[' + i + '].order');
      if (!r.title_en && !r.title_bn) throw new Error('requirements[' + i + '].title_en');
      return {
        id: id, order: order, _i: i,
        title_en: String(r.title_en || r.title_bn), title_bn: String(r.title_bn || r.title_en),
        mandatory: r.mandatory === true || r.mandatory === 'true',
        has_expiry: r.has_expiry === true || r.has_expiry === 'true'
      };
    });
    list.sort(function (a, b) { return a.order - b.order || a._i - b._i; });
    return { tender: tender, requirements: list };
  }

  function loadRequirementsText(text) {
    var data;
    try { data = JSON.parse(text.replace(/^﻿/, '')); }
    catch (e) { showMsg($('#globalMsg'), 'bad', t('reqBadJson')); return false; }
    var parsed;
    try { parsed = parseRequirements(data); }
    catch (e) { showMsg($('#globalMsg'), 'bad', t('reqBadShape', { why: e.message })); return false; }
    state.req = parsed; state.rawReq = data;
    state.matches = {}; state.expiry = {};
    showMsg($('#globalMsg'), 'good', t('reqLoaded', { id: parsed.tender.tender_id }));
    setTimeout(function () { if ($('#globalMsg').classList.contains('good')) $('#globalMsg').hidden = true; }, 3500);
    invalidateGen(); renderAll(); save();
    return true;
  }
  function handleReqFile(file) {
    if (!file) return;
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') { showMsg($('#globalMsg'), 'bad', t('reqNotJson')); return; }
    var fr = new FileReader();
    fr.onload = function () { loadRequirementsText(String(fr.result)); };
    fr.onerror = function () { showMsg($('#globalMsg'), 'bad', t('reqBadJson')); };
    fr.readAsText(file);
  }

  /* ---------------- hashing / duplicates ---------------- */
  function fallbackHash(u8) {
    var h1 = 0xdeadbeef ^ u8.length, h2 = 0x41c6ce57 ^ u8.length;
    for (var i = 0; i < u8.length; i++) {
      var ch = u8[i];
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 'f' + u8.length + '-' + (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
  }
  function sha256(u8) {
    if (window.crypto && crypto.subtle) {
      return crypto.subtle.digest('SHA-256', u8).then(function (b) {
        return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      }).catch(function () { return fallbackHash(u8); });
    }
    return Promise.resolve(fallbackHash(u8));
  }
  function dupGroups() {
    var map = {};
    state.files.forEach(function (f) { (map[f.hash] = map[f.hash] || []).push(f); });
    var res = {};
    Object.keys(map).forEach(function (h) { if (map[h].length > 1) res[h] = map[h]; });
    return res;
  }
  function dupMates(f) {
    return state.files.filter(function (g) { return g.id !== f.id && g.hash === f.hash; });
  }
  function reqOfFile(fileId) {
    if (!state.req) return null;
    for (var i = 0; i < state.req.requirements.length; i++) {
      var r = state.req.requirements[i];
      if (state.matches[r.id] === fileId) return r;
    }
    return null;
  }
  // can file f be chosen for requirement r ?  returns 'ok' | 'used' | 'dup'
  function availability(f, r) {
    var usedBy = reqOfFile(f.id);
    if (usedBy && usedBy.id !== r.id) return 'used';
    var mates = dupMates(f);
    for (var i = 0; i < mates.length; i++) {
      var m = reqOfFile(mates[i].id);
      if (m && m.id !== r.id) return 'dup';
    }
    return 'ok';
  }

  /* ---------------- PDF reading ---------------- */
  function readFileBytes(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (res, rej) {
      var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsArrayBuffer(file);
    });
  }
  function looksLikePdf(u8) {
    var head = '';
    for (var i = 0; i < Math.min(u8.length, 1024); i++) head += String.fromCharCode(u8[i]);
    return head.indexOf('%PDF-') !== -1;
  }

  function addFiles(fileList) {
    var list = Array.prototype.slice.call(fileList || []);
    if (!list.length) return Promise.resolve();
    var box = $('#uploadMsgs'); box.innerHTML = '';
    var msgs = [], added = 0;
    function reject(key, p) { msgs.push('<div class="msg">' + esc(t(key, p)) + '</div>'); }

    var chain = Promise.resolve();
    list.forEach(function (file) {
      chain = chain.then(function () {
        var name = file.name;
        var extPdf = /\.pdf$/i.test(name), typePdf = file.type === 'application/pdf';
        if (!extPdf && !typePdf) { reject('rejNotPdf', { name: name }); return; }
        if (file.size === 0) { reject('rejEmpty', { name: name }); return; }
        if (state.files.length >= LIMITS.files) { reject('rejTooMany', { name: name, max: LIMITS.files }); return; }
        var total = state.files.reduce(function (a, f) { return a + f.size; }, 0);
        if (total + file.size > LIMITS.bytes) { reject('rejTooBig', { name: name }); return; }
        return readFileBytes(file).then(function (buf) {
          var u8 = new Uint8Array(buf);
          if (!looksLikePdf(u8)) { reject('rejNotPdf', { name: name }); return; }
          return PDFLib.PDFDocument.load(u8, { updateMetadata: false }).then(function (doc) {
            var pages = doc.getPageCount();
            if (pages < 1) { reject('rejDamaged', { name: name }); return; }
            return sha256(u8).then(function (hash) {
              var f = { id: state.nextId++, name: name, size: file.size, pages: pages, bytes: u8, hash: hash, text: '', expHint: '' };
              state.files.push(f); added++;
              extractInfo(f);
            });
          }, function (err) {
            var enc = (PDFLib.EncryptedPDFError && err instanceof PDFLib.EncryptedPDFError) || /encrypt/i.test(err && err.message || '');
            reject(enc ? 'rejEncrypted' : 'rejDamaged', { name: name });
          });
        }, function () { reject('rejDamaged', { name: name }); });
      }).catch(function () { reject('rejDamaged', { name: file.name }); });
    });
    return chain.then(function () {
      if (added) msgs.push('<div class="msg ok">' + esc(t('added', { n: added })) + '</div>');
      box.innerHTML = msgs.join('');
      if (added) { invalidateGen(); save(); }
      renderAll();
    });
  }

  function removeFile(id) {
    state.files = state.files.filter(function (f) { return f.id !== id; });
    Object.keys(state.matches).forEach(function (rid) {
      if (state.matches[rid] === id) { delete state.matches[rid]; delete state.expiry[rid]; }
    });
    invalidateGen(); renderAll(); save();
  }

  /* ---------- text hints (expiry date, auto-match) ---------- */
  var MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function iso(y, m, d) {
    var s = y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
    return validDate(s) ? s : '';
  }
  function findDateIn(s) {
    var m;
    if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(s))) { var a = iso(m[1], +m[2], +m[3]); if (a) return { v: a, i: m.index }; }
    var best = null;
    var re1 = /(\d{1,2})(?:st|nd|rd|th)?[\s,-]+([A-Za-z]{3,9})\.?,?[\s,-]+(\d{4})/g;
    while ((m = re1.exec(s))) { var mo = MONTHS[m[2].toLowerCase()]; if (mo) { var b = iso(m[3], mo, +m[1]); if (b) { best = { v: b, i: m.index }; break; } } }
    var re2 = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/g;
    while ((m = re2.exec(s))) { var mo2 = MONTHS[m[1].toLowerCase()]; if (mo2) { var c = iso(m[3], mo2, +m[2]); if (c && (!best || m.index < best.i)) best = { v: c, i: m.index }; break; } }
    var re3 = /(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/g;
    while ((m = re3.exec(s))) { var d3 = iso(m[3], +m[2], +m[1]); if (d3 && (!best || m.index < best.i)) { best = { v: d3, i: m.index }; break; } }
    return best;
  }
  function findExpiry(text) {
    var re = /(expiry date|expiration date|expires on|expires|expiry|expire|valid until|valid till|valid up to|valid through|validity)/ig;
    var m;
    while ((m = re.exec(text))) {
      var seg = text.substr(m.index + m[0].length, 90);
      var d = findDateIn(seg);
      if (d) return d.v;
    }
    return '';
  }
  function extractInfo(f) {
    if (!window.pdfjsLib) return Promise.resolve();
    var task = pdfjsLib.getDocument({ data: new Uint8Array(f.bytes) });
    return task.promise.then(function (doc) {
      var n = Math.min(doc.numPages, 2), chain = Promise.resolve(), txt = '';
      var _loop = function (p) {
        chain = chain.then(function () { return doc.getPage(p); }).then(function (pg) { return pg.getTextContent(); })
          .then(function (c) { txt += c.items.map(function (i) { return i.str; }).join(' ') + ' \n '; });
      };
      for (var p = 1; p <= n; p++) _loop(p);
      return chain.then(function () {
        f.text = txt.replace(/\s+/g, ' ').trim().slice(0, 4000);
        f.expHint = findExpiry(f.text);
        try { doc.destroy(); } catch (e) { }
        renderChecklist();
      });
    }).catch(function () { /* hints are optional */ });
  }

  /* ---------------- matching ---------------- */
  function setMatch(rid, fileId) {
    var cur = state.matches[rid];
    if (fileId == null || fileId === '') {
      if (cur == null) return;
      delete state.matches[rid]; delete state.expiry[rid];
    } else {
      fileId = +fileId;
      if (cur === fileId) return;
      var f = fileById(fileId), r = reqById(rid);
      if (!f || !r || availability(f, r) !== 'ok') { renderChecklist(); return; }
      state.matches[rid] = fileId; delete state.expiry[rid];
    }
    invalidateGen(); renderAll(); save();
  }
  function reqById(id) { return state.req && state.req.requirements.filter(function (r) { return r.id === id; })[0]; }

  var STOP = { of: 1, the: 1, and: 1, for: 1, to: 1, a: 1, an: 1, in: 1, on: 1, or: 1, s: 1, pdf: 1 };
  var GENERIC = { certificate: 1, certification: 1, registration: 1, document: 1, letter: 1, statement: 1, copy: 1, cert: 1, signed: 1 };
  function tokens(s) {
    return String(s).toLowerCase().replace(/\.pdf$/, '').replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter(function (x) { return x && !STOP[x] && !/^\d+$/.test(x); });
  }
  function score(f, r) {
    var ft = tokens(f.name), rt = tokens(r.title_en), sc = 0;
    var text = (f.text || '').toLowerCase().slice(0, 600);
    rt.forEach(function (w) {
      var wt = GENERIC[w] ? 0.5 : 3;
      var hit = ft.some(function (x) { return x === w || (x.length >= 3 && w.indexOf(x) === 0) || (w.length >= 4 && x.indexOf(w) === 0 && x.length - w.length <= 2); });
      if (hit) sc += wt;
      else if (text && !GENERIC[w] && w.length >= 3 && new RegExp('\\b' + w.replace(/[^a-z0-9]/g, '') + '\\b').test(text)) sc += 1;
    });
    var phrase = r.title_en.toLowerCase().replace(/['’]/g, '');
    if (text && text.replace(/['’]/g, '').indexOf(phrase) !== -1) sc += 4;
    return sc;
  }
  function autoMatch() {
    if (!state.req) { showMsg($('#globalMsg'), 'warn', t('needReq')); return; }
    if (!state.files.length) { showMsg($('#globalMsg'), 'warn', t('needFilesFirst')); return; }
    var pairs = [];
    state.files.forEach(function (f) {
      state.req.requirements.forEach(function (r) {
        if (state.matches[r.id] != null) return;
        var s = score(f, r);
        if (s >= 2.5) pairs.push({ f: f, r: r, s: s, e: f.expHint || '' });
      });
    });
    pairs.sort(function (a, b) { return b.s - a.s || (a.e < b.e ? 1 : a.e > b.e ? -1 : 0) || a.f.id - b.f.id; });
    var n = 0;
    pairs.forEach(function (p) {
      if (state.matches[p.r.id] != null || reqOfFile(p.f.id)) return;
      if (availability(p.f, p.r) !== 'ok') return;
      state.matches[p.r.id] = p.f.id; delete state.expiry[p.r.id]; n++;
    });
    $('#globalMsg').hidden = true;
    if (n) showMsg($('#globalMsg'), 'info', t('autoDone', { n: n })); else showMsg($('#globalMsg'), 'warn', t('autoNone'));
    invalidateGen(); renderAll(); save();
  }

  /* ---------------- status ---------------- */
  function statusOf(r) {
    var fid = state.matches[r.id];
    if (fid == null || !fileById(fid)) return r.mandatory ? 'missing' : 'notprovided';
    if (r.has_expiry) {
      var d = state.expiry[r.id];
      if (!validDate(d)) return 'needexpiry';
      if (d < state.req.tender.submission_deadline) return 'expired';
    }
    return 'ok';
  }
  var BLOCKING = { missing: 1, needexpiry: 1, expired: 1 };

  /* ---------------- rendering ---------------- */
  function translateStatic() {
    document.documentElement.lang = state.lang;
    document.title = t('appTitle');
    $('#appTitle').textContent = t('appTitle');
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    $('#langEn').classList.toggle('active', state.lang === 'en');
    $('#langBn').classList.toggle('active', state.lang === 'bn');
    $('#langEn').setAttribute('aria-pressed', state.lang === 'en');
    $('#langBn').setAttribute('aria-pressed', state.lang === 'bn');
  }

  function renderTender() {
    var el = $('#tenderInfo');
    if (!state.req) { el.hidden = true; el.innerHTML = ''; return; }
    var T = state.req.tender;
    el.hidden = false;
    el.innerHTML = '<dl class="tender">' +
      [['tenderId', T.tender_id], ['tenderTitle', T.title], ['entity', T.procuring_entity], ['bidder', T.bidder], ['deadline', T.submission_deadline]]
        .map(function (x) { return '<div><dt>' + esc(t(x[0])) + '</dt><dd>' + esc(x[1]) + '</dd></div>'; }).join('') +
      '<div><dt>&nbsp;</dt><dd>' + esc(t('docsCount', { n: state.req.requirements.length })) + '</dd></div></dl>';
  }

  function renderFiles() {
    var el = $('#fileList');
    if (!state.files.length) { el.innerHTML = '<p class="muted">' + esc(t('noFiles')) + '</p>'; $('#dupWarn').hidden = true; return; }
    var groups = dupGroups();
    var hasDup = Object.keys(groups).length > 0;
    showMsg($('#dupWarn'), 'warn', hasDup ? t('dupWarn') : '');
    var rows = state.files.map(function (f) {
      var badges = '';
      var mates = groups[f.hash] ? dupMates(f) : [];
      if (mates.length) {
        badges += ' <span class="badge dup">⚠ ' + esc(t('dupOf', { name: mates[0].name })) + '</span>';
      }
      var r = reqOfFile(f.id);
      badges += r ? ' <span class="badge used">' + esc(t('usedFor', { doc: reqTitle(r) })) + '</span>' : ' <span class="badge">' + esc(t('notUsed')) + '</span>';
      return '<tr><td class="name">' + esc(f.name) + '<div>' + badges + '</div></td>' +
        '<td>' + esc(pagesText(f.pages)) + '</td><td>' + esc(fmtSize(f.size)) + '</td>' +
        '<td><button type="button" class="btn small-btn" data-act="preview" data-id="' + f.id + '">' + esc(t('preview')) + '</button> ' +
        '<button type="button" class="btn small-btn danger" data-act="remove" data-id="' + f.id + '">' + esc(t('remove')) + '</button></td></tr>';
    }).join('');
    el.innerHTML = '<div class="tablewrap"><table class="files"><thead><tr><th>' + esc(t('fName')) + '</th><th>' + esc(t('fPages')) + '</th><th>' + esc(t('fSize')) +
      '</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function statusPill(r) {
    var st = statusOf(r);
    return '<span class="pill ' + st + '" data-status="' + esc(r.id) + '" title="' + (BLOCKING[st] ? esc(t('blocks')) : '') + '">' + esc(t('s_' + st)) + '</span>';
  }

  function expiryCell(r) {
    var fid = state.matches[r.id], f = fid != null ? fileById(fid) : null;
    if (!r.has_expiry) return '<span class="muted">' + esc(t('noExpiryNeeded')) + '</span>';
    if (!f) return '<span class="muted">' + esc(t('noExpiryNeeded')) + '</span>';
    var v = state.expiry[r.id] || '';
    var hint = '';
    if (f.expHint && f.expHint !== v) {
      hint = '<span class="hint">' + esc(t('expiryHint', { d: f.expHint })) +
        ' <button type="button" class="btn small-btn" data-act="usedate" data-rid="' + esc(r.id) + '" data-date="' + f.expHint + '">' + esc(t('useDate')) + '</button></span>';
    }
    return '<input type="date" data-role="exp" data-rid="' + esc(r.id) + '" value="' + esc(v) + '" aria-label="' + esc(t('expiryLabel', { doc: reqTitle(r) })) + '">' + hint;
  }

  function renderChecklist() {
    var el = $('#checklist');
    if (!state.req) { el.innerHTML = '<p class="muted">' + esc(t('needReq')) + '</p>'; return; }
    var active = document.activeElement, focusKey = null;
    if (active && el.contains(active)) focusKey = (active.getAttribute('data-role') || active.getAttribute('data-act') || '') + '|' + (active.getAttribute('data-rid') || '');
    var rows = state.req.requirements.map(function (r) {
      var cur = state.matches[r.id];
      var opts = '<option value="">' + esc(t('chooseFile')) + '</option>';
      state.files.forEach(function (f) {
        var a = availability(f, r);
        if (a === 'used') return;
        var label = f.name + ' (' + pagesText(f.pages) + ')' + (a === 'dup' ? ' ' + t('dupBlocked') : '');
        opts += '<option value="' + f.id + '"' + (cur === f.id ? ' selected' : '') + (a === 'dup' ? ' disabled' : '') + '>' + esc(label) + '</option>';
      });
      return '<tr><td>' + r.order + '</td><td><strong>' + esc(reqTitle(r)) + '</strong></td>' +
        '<td><span class="badge ' + (r.mandatory ? 'req' : '') + '">' + esc(t(r.mandatory ? 'mandatory' : 'optional')) + '</span></td>' +
        '<td><select data-role="sel" data-rid="' + esc(r.id) + '" aria-label="' + esc(t('fileLabel', { doc: reqTitle(r) })) + '">' + opts + '</select> ' +
        (cur != null ? '<button type="button" class="btn small-btn" data-act="unmatch" data-rid="' + esc(r.id) + '">' + esc(t('unmatch')) + '</button>' : '') + '</td>' +
        '<td>' + expiryCell(r) + '</td><td data-statuscell="' + esc(r.id) + '">' + statusPill(r) + '</td></tr>';
    }).join('');
    el.innerHTML = '<div class="tablewrap"><table class="checklist"><thead><tr><th>' + esc(t('cNo')) + '</th><th>' + esc(t('cDoc')) + '</th><th>' + esc(t('cType')) +
      '</th><th>' + esc(t('cFile')) + '</th><th>' + esc(t('cExpiry')) + '</th><th>' + esc(t('cStatus')) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    if (focusKey) {
      var parts = focusKey.split('|');
      var sel = parts[0] === 'sel' || parts[0] === 'exp' ? '[data-role="' + parts[0] + '"]' : '[data-act="' + parts[0] + '"]';
      var cand = el.querySelector(sel + '[data-rid="' + parts[1] + '"]');
      if (cand) cand.focus();
    }
  }

  function updateStatusCells() {
    if (!state.req) return;
    state.req.requirements.forEach(function (r) {
      var td = document.querySelector('[data-statuscell="' + r.id.replace(/"/g, '\\"') + '"]');
      if (td) td.innerHTML = statusPill(r);
    });
  }

  function planTotal() {
    var n = 1; var idx = 0;
    var docs = state.req.requirements.filter(function (r) { return state.matches[r.id] != null && fileById(state.matches[r.id]); });
    if (state.index && docs.length) idx = Math.ceil(docs.length / 17);
    docs.forEach(function (r) { n += fileById(state.matches[r.id]).pages; });
    return n + idx;
  }

  function renderSummary() {
    var el = $('#summary'), btn = $('#generateBtn');
    if (!state.req) {
      el.innerHTML = '<div class="banner warn">' + esc(t('needReq')) + '</div>';
      btn.disabled = true; btn.title = t('needReq'); return;
    }
    var T = state.req.tender, ok = 0, bad = 0, opt = 0, reasons = [];
    state.req.requirements.forEach(function (r) {
      var st = statusOf(r);
      if (st === 'ok') ok++; else if (st === 'notprovided') opt++; else bad++;
      var title = '<strong>' + esc(reqTitle(r)) + '</strong>';
      if (st === 'missing') reasons.push(t('reasonMissing', { doc: '\u0000' }).replace('\u0000', title));
      else if (st === 'needexpiry') reasons.push(t('reasonNeedExpiry', { doc: '\u0000' }).replace('\u0000', title));
      else if (st === 'expired') {
        var s = t('reasonExpired', { doc: '\u0000', d: esc(state.expiry[r.id]), dl: esc(T.submission_deadline) });
        reasons.push(s.replace('\u0000', title));
      }
    });
    // safe: only our own markup + escaped values were inserted above
    var html = '<div class="summary-counts"><span class="pill ok">' + esc(t('sumOk', { n: ok })) + '</span>' +
      (bad ? '<span class="pill expired">' + esc(t('sumBlock', { n: bad })) + '</span>' : '') +
      (opt ? '<span class="pill notprovided">' + esc(t('sumOpt', { n: opt })) + '</span>' : '') + '</div>';
    if (reasons.length) {
      html += '<div class="banner bad" id="blockWhy"><strong>' + esc(t('blockedMsg')) + '</strong><ul class="reasons">' +
        reasons.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul></div>';
    } else {
      html += '<div class="banner good" id="blockWhy">' + esc(t('readyMsg')) + '</div>';
    }
    el.innerHTML = html;
    btn.disabled = reasons.length > 0;
    btn.title = reasons.length ? t('blockedMsg') : '';
    if (reasons.length) btn.setAttribute('aria-describedby', 'blockWhy'); else btn.removeAttribute('aria-describedby');
    validateSealPages();
  }

  function validateSealPages() {
    var msg = $('#sealMsg');
    if (!state.seal || !state.req) { msg.textContent = ''; return true; }
    var total = planTotal();
    var set = PKG.parsePages(state.sealPages, total);
    msg.textContent = set ? '' : t('sealBadPages', { n: total });
    return !!set;
  }

  function renderOptions() {
    $('#optIndex').checked = !!state.index;
    $('#sealName').textContent = state.seal ? state.seal.name : '';
    $('#sealRemove').hidden = !state.seal;
    $('#sealOpts').hidden = !state.seal;
    $('#sealPages').value = state.sealPages;
    $('#sealPos').value = state.sealPos;
    $('#sealSize').value = state.sealPct; $('#sealSizeOut').textContent = state.sealPct;
  }

  function renderAll() {
    translateStatic();
    renderTender(); renderFiles(); renderChecklist(); renderOptions(); renderSummary();
  }

  /* ---------------- generate / download ---------------- */
  function generate() {
    if (!state.req) return;
    var btn = $('#generateBtn'), gm = $('#genMsg');
    var blocked = state.req.requirements.some(function (r) { return BLOCKING[statusOf(r)]; });
    if (blocked) { renderSummary(); return; }
    if (state.seal && !validateSealPages()) { $('#optDetails').open = true; $('#genMsg').innerHTML = '<div class="banner bad">' + esc(t('sealBadPages', { n: planTotal() })) + '</div>'; return; }
    btn.disabled = true;
    gm.innerHTML = '<div class="banner info">' + esc(t('generating')) + '</div>';
    var entries = state.req.requirements.filter(function (r) { return state.matches[r.id] != null && fileById(state.matches[r.id]); })
      .map(function (r) { var f = fileById(state.matches[r.id]); return { title_en: r.title_en, title_bn: r.title_bn, file: f }; });
    PKG.build(state.req.tender, entries, {
      index: state.index,
      seal: state.seal ? { bytes: state.seal.bytes, pagesSpec: state.sealPages, pos: state.sealPos, pct: state.sealPct } : null
    }).then(function (res) {
      invalidateGen();
      var blob = new Blob([res.bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var name = safeName(state.req.tender.tender_id) + '_Package.pdf';
      state.gen = { url: url, pages: res.pageCount, name: name };
      var a = $('#downloadBtn'); a.href = url; a.setAttribute('download', name); a.hidden = false;
      var p = $('#previewBtn'); p.href = url; p.hidden = false;
      $('#genMsg').innerHTML = '<div class="banner good">' + esc(t('genDone', { pages: res.pageCount })) + ' <strong>' + esc(name) + '</strong></div>';
      renderSummary();
    }).catch(function (err) {
      var why;
      if (err && err.sealPages) why = t('sealBadPages', { n: err.total });
      else if (err && err.sealImg) why = t('sealBadImg');
      else if (err && err.fileName) why = t('genFailFile', { name: err.fileName });
      else why = (err && err.message) || String(err);
      $('#genMsg').innerHTML = '<div class="banner bad">' + esc(t('genFail', { why: why })) + '</div>';
      renderSummary();
    });
  }

  function csvCell(v) { v = String(v == null ? '' : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function exportCsv() {
    if (!state.req) { showMsg($('#globalMsg'), 'warn', t('needReq')); return; }
    var rows = [[t('csvOrder'), t('csvDoc'), t('csvFile'), t('csvPages'), t('csvExpiry'), t('csvStatus')]];
    state.req.requirements.forEach(function (r) {
      var f = state.matches[r.id] != null ? fileById(state.matches[r.id]) : null;
      rows.push([r.order, reqTitle(r), f ? f.name : '', f ? f.pages : '', r.has_expiry && f ? (state.expiry[r.id] || '') : '', t('s_' + statusOf(r))]);
    });
    var csv = '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    var a = document.createElement('a'); a.href = url; a.download = safeName(state.req.tender.tender_id) + '_Checklist.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ---------------- preview modal ---------------- */
  var previewToken = 0, previewDoc = null;
  function openPreview(f) {
    var m = $('#modal'), body = $('#modalBody');
    $('#modalTitle').textContent = f.name + ' — ' + pagesText(f.pages);
    body.innerHTML = ''; m.hidden = false; $('#modalClose').focus();
    var token = ++previewToken;
    if (!window.pdfjsLib) { body.textContent = t('previewFail'); return; }
    pdfjsLib.getDocument({ data: new Uint8Array(f.bytes) }).promise.then(function (doc) {
      previewDoc = doc;
      var chain = Promise.resolve();
      var max = Math.min(doc.numPages, 40);
      var _loop = function (p) {
        chain = chain.then(function () {
          if (token !== previewToken) return;
          return doc.getPage(p).then(function (pg) {
            var vp1 = pg.getViewport({ scale: 1 });
            var scale = Math.min(1.6, 820 / vp1.width);
            var vp = pg.getViewport({ scale: scale });
            var c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
            var lab = document.createElement('div'); lab.className = 'pg'; lab.textContent = t('page') + ' ' + p + ' / ' + doc.numPages;
            body.appendChild(lab); body.appendChild(c);
            return pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
          });
        });
      };
      for (var p = 1; p <= max; p++) _loop(p);
      return chain;
    }).catch(function () { if (token === previewToken) body.textContent = t('previewFail'); });
  }
  function closePreview() {
    previewToken++; $('#modal').hidden = true; $('#modalBody').innerHTML = '';
    if (previewDoc) { try { previewDoc.destroy(); } catch (e) { } previewDoc = null; }
  }

  /* ---------------- persistence (IndexedDB, this browser only) ---------------- */
  var DB = 'tender-package-builder', STORE = 'kv', saveTimer = null;
  function idb() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('no idb'));
      var rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore(STORE); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function idbSet(key, val) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { db.close(); res(); }; tx.onerror = function () { db.close(); rej(tx.error); };
      });
    });
  }
  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        rq.onsuccess = function () { db.close(); res(rq.result); }; rq.onerror = function () { db.close(); rej(rq.error); };
      });
    });
  }
  function idbDel(key) {
    return idb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { db.close(); res(); }; tx.onerror = function () { db.close(); res(); };
      });
    });
  }
  function save() {
    if (pendingRestore) { pendingRestore = null; $('#restoreBanner').hidden = true; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var snap = {
        v: 1, lang: state.lang, rawReq: state.rawReq, matches: state.matches, expiry: state.expiry, nextId: state.nextId,
        index: state.index, sealPages: state.sealPages, sealPos: state.sealPos, sealPct: state.sealPct,
        seal: state.seal, files: state.files.map(function (f) { return { id: f.id, name: f.name, size: f.size, pages: f.pages, hash: f.hash, bytes: f.bytes }; })
      };
      idbSet('state', snap).catch(function () { /* storage unavailable: ignore */ });
    }, 400);
  }
  function checkSaved() {
    idbGet('state').then(function (s) {
      if (!s || !s.v || (!(s.files && s.files.length) && !s.rawReq)) return;
      pendingRestore = s;
      var b = $('#restoreBanner');
      b.innerHTML = '<span>' + esc(t('restoreFound', { n: s.files.length })) + '</span> ' +
        '<button type="button" class="btn small-btn primary" id="restoreYes">' + esc(t('restore')) + '</button> ' +
        '<button type="button" class="btn small-btn" id="restoreNo">' + esc(t('discard')) + '</button>';
      b.hidden = false;
    }).catch(function () { });
  }
  function restore(s) {
    state.files = (s.files || []).map(function (f) {
      return { id: f.id, name: f.name, size: f.size, pages: f.pages, hash: f.hash, bytes: new Uint8Array(f.bytes), text: '', expHint: '' };
    });
    state.nextId = s.nextId || (state.files.reduce(function (m, f) { return Math.max(m, f.id); }, 0) + 1);
    state.rawReq = s.rawReq || null;
    try { state.req = s.rawReq ? parseRequirements(s.rawReq) : null; } catch (e) { state.req = null; }
    state.matches = {}; state.expiry = {};
    if (state.req) {
      Object.keys(s.matches || {}).forEach(function (rid) { if (reqById(rid) && fileById(s.matches[rid])) state.matches[rid] = s.matches[rid]; });
      Object.keys(s.expiry || {}).forEach(function (rid) { if (state.matches[rid] != null) state.expiry[rid] = s.expiry[rid]; });
    }
    state.index = !!s.index; state.seal = s.seal && s.seal.bytes ? { name: s.seal.name, bytes: new Uint8Array(s.seal.bytes) } : null;
    state.sealPages = s.sealPages || ''; state.sealPos = s.sealPos || 'br'; state.sealPct = s.sealPct || 18;
    pendingRestore = null; $('#restoreBanner').hidden = true;
    invalidateGen(); renderAll();
    state.files.forEach(extractInfo);
    showMsg($('#globalMsg'), 'good', t('restored'));
    setTimeout(function () { if ($('#globalMsg').classList.contains('good')) $('#globalMsg').hidden = true; }, 3000);
  }
  function resetAll() {
    if (!confirm(t('resetConfirm'))) return;
    invalidateGen();
    state.req = null; state.rawReq = null; state.files = []; state.matches = {}; state.expiry = {};
    state.index = false; state.seal = null; state.sealPages = ''; state.sealPos = 'br'; state.sealPct = 18; state.nextId = 1;
    $('#uploadMsgs').innerHTML = ''; $('#globalMsg').hidden = true;
    pendingRestore = null; $('#restoreBanner').hidden = true;
    clearTimeout(saveTimer);
    idbDel('state'); renderAll();
  }

  /* ---------------- events ---------------- */
  function setLang(l) {
    state.lang = l;
    try { localStorage.setItem('tpb-lang', l); } catch (e) { }
    renderAll();
    if (pendingRestore) checkSavedBannerText();
    if (state.gen) { /* keep download */ }
  }
  function checkSavedBannerText() {
    var b = $('#restoreBanner'); if (!pendingRestore) return;
    b.innerHTML = '<span>' + esc(t('restoreFound', { n: pendingRestore.files.length })) + '</span> ' +
      '<button type="button" class="btn small-btn primary" id="restoreYes">' + esc(t('restore')) + '</button> ' +
      '<button type="button" class="btn small-btn" id="restoreNo">' + esc(t('discard')) + '</button>';
  }

  function wireDrop(zone, onFiles) {
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) onFiles(e.dataTransfer.files); });
  }

  function init() {
    try { var l = localStorage.getItem('tpb-lang'); if (l === 'bn' || l === 'en') state.lang = l; } catch (e) { }
    if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

    $('#langEn').addEventListener('click', function () { setLang('en'); });
    $('#langBn').addEventListener('click', function () { setLang('bn'); });

    $('#reqInput').addEventListener('change', function (e) { handleReqFile(e.target.files[0]); e.target.value = ''; });
    $('#pdfInput').addEventListener('change', function (e) { addFiles(e.target.files); e.target.value = ''; });
    wireDrop($('#reqDrop'), function (fl) { handleReqFile(fl[0]); });
    wireDrop($('#pdfDrop'), function (fl) { addFiles(fl); });
    // do not let a stray drop navigate away from the app
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('#fileList').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]'); if (!b) return;
      var id = +b.getAttribute('data-id');
      if (b.getAttribute('data-act') === 'remove') removeFile(id);
      else if (b.getAttribute('data-act') === 'preview') { var f = fileById(id); if (f) openPreview(f); }
    });

    var cl = $('#checklist');
    cl.addEventListener('change', function (e) {
      var s = e.target.closest('select[data-role="sel"]');
      if (s) setMatch(s.getAttribute('data-rid'), s.value);
    });
    cl.addEventListener('input', function (e) {
      var d = e.target.closest('input[data-role="exp"]');
      if (!d) return;
      state.expiry[d.getAttribute('data-rid')] = d.value;
      invalidateGen(); updateStatusCells(); renderSummary(); save();
    });
    cl.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]'); if (!b) return;
      var rid = b.getAttribute('data-rid');
      if (b.getAttribute('data-act') === 'unmatch') setMatch(rid, '');
      else if (b.getAttribute('data-act') === 'usedate') { state.expiry[rid] = b.getAttribute('data-date'); invalidateGen(); renderAll(); save(); }
    });

    $('#autoMatchBtn').addEventListener('click', autoMatch);
    $('#clearMatchBtn').addEventListener('click', function () { state.matches = {}; state.expiry = {}; invalidateGen(); renderAll(); save(); });
    $('#generateBtn').addEventListener('click', generate);
    $('#csvBtn').addEventListener('click', exportCsv);
    $('#resetBtn').addEventListener('click', resetAll);
    $('#modalClose').addEventListener('click', closePreview);
    $('#modal').addEventListener('click', function (e) { if (e.target === $('#modal')) closePreview(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#modal').hidden) closePreview(); });

    $('#optIndex').addEventListener('change', function (e) { state.index = e.target.checked; invalidateGen(); renderSummary(); save(); });
    $('#sealInput').addEventListener('change', function (e) {
      var file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      if (!/\.png$/i.test(file.name) && file.type !== 'image/png') { showMsg($('#globalMsg'), 'bad', t('sealNotPng')); return; }
      readFileBytes(file).then(function (buf) {
        var u8 = new Uint8Array(buf);
        if (!(u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47)) { showMsg($('#globalMsg'), 'bad', t('sealNotPng')); return; }
        state.seal = { name: file.name, bytes: u8 };
        $('#globalMsg').hidden = true; invalidateGen(); renderOptions(); renderSummary(); save();
      });
    });
    $('#sealRemove').addEventListener('click', function () { state.seal = null; invalidateGen(); renderOptions(); renderSummary(); save(); });
    $('#sealPages').addEventListener('input', function (e) { state.sealPages = e.target.value; invalidateGen(); validateSealPages(); save(); });
    $('#sealPos').addEventListener('change', function (e) { state.sealPos = e.target.value; invalidateGen(); save(); });
    $('#sealSize').addEventListener('input', function (e) { state.sealPct = +e.target.value; $('#sealSizeOut').textContent = e.target.value; invalidateGen(); save(); });
    $('#sealFirstPages').addEventListener('click', function () {
      if (!state.req) return;
      var matched = state.req.requirements.filter(function (r) { return state.matches[r.id] != null && fileById(state.matches[r.id]); }).length;
      var n = 1 + (state.index && matched ? Math.ceil(matched / 17) : 0), list = [];
      state.req.requirements.forEach(function (r) {
        var f = state.matches[r.id] != null ? fileById(state.matches[r.id]) : null;
        if (!f) return;
        list.push(n + 1); n += f.pages;
      });
      state.sealPages = list.join(', '); $('#sealPages').value = state.sealPages; invalidateGen(); validateSealPages(); save();
    });

    $('#restoreBanner').addEventListener('click', function (e) {
      if (e.target.id === 'restoreYes' && pendingRestore) restore(pendingRestore);
      else if (e.target.id === 'restoreNo') { pendingRestore = null; $('#restoreBanner').hidden = true; idbDel('state'); }
    });

    renderAll();
    checkSaved();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
