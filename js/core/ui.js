/* ==========================================================================
   Pothik — UI helpers: toasts, modals, sheets, stars, uploads, formatting
   ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ DOM */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  /** Escape untrusted text before injecting into innerHTML. */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* --------------------------------------------------------------- toasts */
  function toastStack() {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = el('div', { id: 'toast-stack', class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(stack);
    }
    return stack;
  }

  function toast(message, type, ms) {
    const icons = { success: 'fa-circle-check', error: 'fa-circle-exclamation', warn: 'fa-triangle-exclamation', info: 'fa-circle-info' };
    const t = type || 'info';
    const node = el('div', { class: 'toast t-' + t }, [
      el('i', { class: 'fa-solid ' + (icons[t] || icons.info) }),
      el('div', { class: 'grow', text: message })
    ]);
    toastStack().appendChild(node);
    const life = ms || (t === 'error' ? 5200 : 3400);
    setTimeout(function () {
      node.classList.add('out');
      setTimeout(function () { node.remove(); }, 260);
    }, life);
    return node;
  }

  /* --------------------------------------------------------------- modal */
  function modal(opts) {
    const backdrop = el('div', { class: 'modal-backdrop', role: 'dialog', 'aria-modal': 'true' });
    const box = el('div', { class: 'modal' });
    if (opts.title) {
      box.appendChild(el('div', { class: 'modal-hd' }, [
        el('h2', { text: opts.title }),
        el('button', { class: 'btn btn-icon btn-sm btn-ghost', 'aria-label': 'Close', onclick: close }, [
          el('i', { class: 'fa-solid fa-xmark' })
        ])
      ]));
    }
    if (opts.bodyHtml) {
      const b = el('div', { class: 'modal-body' });
      b.innerHTML = opts.bodyHtml;
      box.appendChild(b);
    }
    if (opts.content) box.appendChild(opts.content);

    const footer = el('div', { class: 'row gap-3 mt-4' });
    (opts.actions || []).forEach(function (a) {
      footer.appendChild(el('button', {
        class: 'btn grow ' + (a.class || 'btn-ghost'),
        text: a.label,
        onclick: function () { if (a.onClick) a.onClick(close); else close(); }
      }));
    });
    if (footer.children.length) box.appendChild(footer);

    backdrop.appendChild(box);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop && opts.dismissible !== false) close(); });
    document.body.appendChild(backdrop);
    requestAnimationFrame(function () { backdrop.classList.add('open'); });

    function onKey(e) { if (e.key === 'Escape' && opts.dismissible !== false) close(); }
    document.addEventListener('keydown', onKey);

    function close() {
      backdrop.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      setTimeout(function () { backdrop.remove(); }, 220);
      if (opts.onClose) opts.onClose();
    }
    return { close: close, root: backdrop, box: box };
  }

  function confirm(opts) {
    return new Promise(function (resolve) {
      modal({
        title: opts.title,
        bodyHtml: '<p style="margin:0">' + esc(opts.message) + '</p>' +
          (opts.detail ? '<p class="mt-3" style="color:var(--muted);font-size:13px">' + esc(opts.detail) + '</p>' : ''),
        actions: [
          { label: opts.cancelLabel || global.t('common.cancel'), class: 'btn-ghost', onClick: function (c) { c(); resolve(false); } },
          { label: opts.confirmLabel || global.t('common.confirm'), class: opts.danger ? 'btn-danger' : 'btn-primary', onClick: function (c) { c(); resolve(true); } }
        ],
        onClose: function () { resolve(false); }
      });
    });
  }

  /* --------------------------------------------------------------- sheet */
  function sheet(opts) {
    const s = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
    s.appendChild(el('div', { class: 'sheet-grip' }));
    if (opts.title) {
      s.appendChild(el('div', { class: 'sheet-hd' }, [
        el('div', { class: 'row-between' }, [
          el('h2', { style: 'margin:0;font-size:18px', text: opts.title }),
          opts.dismissible === false ? null : el('button', { class: 'btn btn-icon btn-sm btn-ghost', 'aria-label': 'Close', onclick: close }, [
            el('i', { class: 'fa-solid fa-xmark' })
          ])
        ])
      ]));
    }
    const body = el('div', { class: 'sheet-bd' });
    if (opts.bodyHtml) body.innerHTML = opts.bodyHtml;
    if (opts.content) body.appendChild(opts.content);
    s.appendChild(body);
    if (opts.footerContent) {
      const f = el('div', { class: 'sheet-ft' });
      f.appendChild(opts.footerContent);
      s.appendChild(f);
    }
    document.body.appendChild(s);
    requestAnimationFrame(function () { s.classList.add('open'); });

    function close() {
      s.classList.remove('open');
      setTimeout(function () { s.remove(); }, 340);
      if (opts.onClose) opts.onClose();
    }
    return { close: close, root: s, body: body };
  }

  /* ------------------------------------------------------------- stars */
  function starsHtml(value, size) {
    const v = Math.round(Number(value) || 0);
    let html = '<span class="stars ' + (size === 'sm' ? 'stars-sm' : '') + '" aria-label="' + v + ' ' + global.t('rate.stars') + '">';
    for (let i = 1; i <= 5; i++) {
      html += '<i class="fa-' + (i <= v ? 'solid' : 'regular') + ' fa-star" style="color:' + (i <= v ? 'var(--gold-500)' : 'var(--line)') + '"></i>';
    }
    return html + '</span>';
  }

  /** Interactive 1–5 star input. */
  function starInput(initial, onChange) {
    const wrap = el('div', { class: 'stars', role: 'radiogroup', 'aria-label': global.t('rate.stars') });
    let value = Number(initial) || 0;
    for (let i = 1; i <= 5; i++) {
      (function (n) {
        const b = el('button', {
          type: 'button', class: 'btn-reset', role: 'radio',
          'aria-checked': n === value ? 'true' : 'false',
          'aria-label': n + ' ' + global.t('rate.stars'),
          onclick: function () { set(n); }
        }, [el('i', { class: 'fa-solid fa-star' })]);
        wrap.appendChild(b);
      })(i);
    }
    function set(n) {
      value = n;
      $$('button', wrap).forEach(function (b, idx) {
        const on = idx + 1 <= n;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', idx + 1 === n ? 'true' : 'false');
      });
      if (onChange) onChange(n);
    }
    if (value) set(value);
    return { node: wrap, get value() { return value; }, set: set };
  }

  /* ------------------------------------------------------------ uploads */
  const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];

  /**
   * Read a File as a compressed data URL (max 1000px, JPEG q0.82).
   * Keeps document images small enough for the table API while staying legible.
   */
  function compressImage(file, maxDim, quality) {
    const max = maxDim || 1000;
    const q = quality || 0.82;
    return new Promise(function (resolve, reject) {
      if (!ALLOWED_TYPES.includes(file.type)) { reject(new Error('err.uploadType')); return; }
      if (file.size > MAX_UPLOAD_BYTES) { reject(new Error('err.uploadTooBig')); return; }
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('read failed')); };
      reader.onload = function () {
        const img = new Image();
        img.onerror = function () { reject(new Error('decode failed')); };
        img.onload = function () {
          let w = img.width, h = img.height;
          if (Math.max(w, h) > max) {
            const scale = max / Math.max(w, h);
            w = Math.round(w * scale); h = Math.round(h * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          try {
            resolve({ dataUrl: canvas.toDataURL('image/jpeg', q), width: w, height: h, name: file.name });
          } catch (e) { reject(e); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /**
   * Wire a dropzone element to a file input.
   * @param zone   the clickable element
   * @param input  hidden <input type=file>
   * @param onDone ({dataUrl,width,height,name}) => void
   */
  function wireUpload(zone, input, onDone, onError) {
    zone.addEventListener('click', function () { input.click(); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('dragover'); });
    });
    zone.addEventListener('drop', function (e) {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handle(f);
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) handle(input.files[0]);
    });

    function handle(file) {
      zone.classList.add('is-loading');
      compressImage(file).then(function (res) {
        zone.classList.remove('is-loading');
        if (onDone) onDone(res);
      }).catch(function (err) {
        zone.classList.remove('is-loading');
        const key = err && err.message && err.message.indexOf('err.') === 0 ? err.message : 'drv.uploadFailed';
        toast(global.t(key), 'error');
        if (onError) onError(err);
      });
    }
    return { trigger: function () { input.click(); } };
  }

  /* ---------------------------------------------------------- formatting */
  function statusBadge(status) {
    const map = {
      REQUESTED: 'badge-neutral', SEARCHING_DRIVER: 'badge-info', DRIVER_ASSIGNED: 'badge-info',
      DRIVER_ARRIVING: 'badge-info', DRIVER_ARRIVED: 'badge-warn', RIDE_STARTED: 'badge-brand',
      RIDE_COMPLETED: 'badge-success', PAYMENT_PENDING: 'badge-warn', PAYMENT_COMPLETED: 'badge-success',
      CANCELLED_BY_PASSENGER: 'badge-danger', CANCELLED_BY_DRIVER: 'badge-danger',
      pending: 'badge-warn', approved: 'badge-success', rejected: 'badge-danger',
      suspended: 'badge-warn', blocked: 'badge-danger', active: 'badge-success', inactive: 'badge-neutral',
      Paid: 'badge-success', Pending: 'badge-warn', Failed: 'badge-danger', Refunded: 'badge-info',
      open: 'badge-warn', resolved: 'badge-success', closed: 'badge-neutral'
    };
    const cls = map[status] || 'badge-neutral';
    const label = (global.RideState && global.RideState.STATUS[status]) ? global.RideState.label(status)
      : (global.t('drv.status.' + status) !== 'drv.status.' + status ? global.t('drv.status.' + status)
      : (global.t('pay.' + String(status).toLowerCase()) !== 'pay.' + String(status).toLowerCase() ? global.t('pay.' + String(status).toLowerCase())
      : status));
    return '<span class="badge ' + cls + '">' + esc(label) + '</span>';
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
  }

  function avatarHtml(name, photoUrl, size) {
    const cls = 'avatar' + (size ? ' avatar-' + size : '');
    if (photoUrl) return '<span class="' + cls + '"><img src="' + esc(photoUrl) + '" alt="' + esc(name) + '" loading="lazy"></span>';
    return '<span class="' + cls + '" aria-hidden="true">' + esc(initials(name)) + '</span>';
  }

  /* ------------------------------------------------------------- helpers */
  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait || 250);
    };
  }

  function throttle(fn, wait) {
    let last = 0, timer = null;
    return function () {
      const args = arguments, self = this, nowTs = Date.now();
      const remaining = wait - (nowTs - last);
      if (remaining <= 0) { last = nowTs; fn.apply(self, args); }
      else if (!timer) { timer = setTimeout(function () { last = Date.now(); timer = null; fn.apply(self, args); }, remaining); }
    };
  }

  function uuid() { return global.DB ? global.DB.uid() : Math.random().toString(36).slice(2); }

  /** Render a small inline spinner. */
  function spinner(size) {
    return '<span class="spinner" style="width:' + (size || 18) + 'px;height:' + (size || 18) + 'px"></span>';
  }

  function emptyState(icon, title, sub) {
    return '<div class="empty"><i class="fa-solid ' + esc(icon) + '"></i><h3>' + esc(title) + '</h3>' +
      (sub ? '<p style="font-size:13px">' + esc(sub) + '</p>' : '') + '</div>';
  }

  /** CSV export helper used by admin reports. */
  function downloadCsv(filename, rows, columns) {
    if (!rows || !rows.length) { toast(global.t('common.noData'), 'warn'); return; }
    const cols = columns || Object.keys(rows[0]);
    const escape = function (v) {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.join(',')];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return escape(r[c]); }).join(',')); });
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'export.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /** Set the browser theme + persist. */
  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    global.Store.set('theme', theme);
  }

  function initTheme() {
    const saved = global.Store.get('theme', null);
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  }

  global.UI = {
    $: $, $$: $$, el: el, esc: esc,
    toast: toast, modal: modal, confirm: confirm, sheet: sheet,
    starsHtml: starsHtml, starInput: starInput,
    compressImage: compressImage, wireUpload: wireUpload, MAX_UPLOAD_BYTES: MAX_UPLOAD_BYTES,
    statusBadge: statusBadge, initials: initials, avatarHtml: avatarHtml,
    debounce: debounce, throttle: throttle, uuid: uuid, spinner: spinner,
    emptyState: emptyState, downloadCsv: downloadCsv,
    setTheme: setTheme, initTheme: initTheme
  };
})(window);
