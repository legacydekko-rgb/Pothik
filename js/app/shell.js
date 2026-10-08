/* ==========================================================================
   Pothik — App shell: header, bottom nav, screen router, boot sequence
   Shared by the Passenger and Driver apps.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------- boot */
  let booted = false;

  /**
   * Boot sequence shared by every app page:
   *   i18n -> theme -> settings from DB -> seed demo data (if empty) -> ready
   */
  async function boot(opts) {
    if (booted) return;
    booted = true;
    const o = opts || {};

    global.UI.initTheme();
    global.I18n.applyI18n(document);

    const status = document.getElementById('boot-status');
    const setStatus = function (msg) { if (status) status.textContent = msg; };

    setStatus(global.t('common.loading'));

    try {
      await global.Settings.load();
    } catch (e) { /* defaults already loaded */ }

    if (o.seed !== false) {
      try {
        setStatus(global.t('splash.loading'));
        await global.Seed.ensure();
      } catch (e) { /* seeding is best-effort */ }
    }

    // Flush any writes queued while offline
    global.DB.flushQueue().catch(function () {});

    // Register the service worker (PWA + push) — best effort.
    // NOTE: must be anchored to the SITE ROOT, not to document.baseURI.
    // new URL('sw.js', document.baseURI) resolves to /admin/sw.js on the admin
    // page and /driver/sw.js on the driver page — both 404, which the browser
    // then reports as an unhandled error. DB.API_BASE already knows the root.
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      var swRoot = (global.DB && global.DB.API_BASE) ? global.DB.API_BASE : '/';
      navigator.serviceWorker.register(swRoot + 'sw.js').catch(function () {});
    }

    global.dispatchEvent(new CustomEvent('pothik:ready'));
    return true;
  }

  /* ---------------------------------------------------------- language */
  function langToggleHtml() {
    const lang = global.I18n.getLang();
    return '<button class="btn btn-ghost btn-sm" id="lang-toggle" aria-label="Change language">' +
      '<i class="fa-solid fa-language"></i><span>' + (lang === 'bn' ? 'EN' : 'বাং') + '</span></button>';
  }

  function wireLangToggle(root) {
    const btn = (root || document).getElementById('lang-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      const next = global.I18n.getLang() === 'bn' ? 'en' : 'bn';
      global.I18n.setLang(next);
      btn.querySelector('span').textContent = next === 'bn' ? 'EN' : 'বাং';
      global.dispatchEvent(new CustomEvent('pothik:langtoggle', { detail: { lang: next } }));
    });
  }

  /* ------------------------------------------------------------- header */
  /**
   * Render the app header into #app-header.
   * @param opts {title, back, right (html), hideNav}
   */
  function renderHeader(opts) {
    const o = opts || {};
    const host = document.getElementById('app-header');
    if (!host) return;
    let html = '';
    if (o.back) {
      html += '<button class="back" id="header-back" aria-label="' + global.UI.esc(global.t('common.back')) + '">' +
        '<i class="fa-solid fa-arrow-left"></i></button>';
    } else if (o.brand) {
      html += '<span class="brand-mark" aria-hidden="true">প</span>';
    }
    html += '<h1 class="grow" id="header-title">' + global.UI.esc(o.title || '') + '</h1>';
    html += '<div class="row gap-2">' + (o.right || '') + '</div>';
    host.innerHTML = html;
    host.classList.remove('hidden');

    const back = document.getElementById('header-back');
    if (back) back.addEventListener('click', function () { if (o.onBack) o.onBack(); else history.back(); });
    wireLangToggle(host);
    return host;
  }

  function setHeaderTitle(title) {
    const t = document.getElementById('header-title');
    if (t) t.textContent = title;
  }

  /* ---------------------------------------------------------- bottom nav */
  /**
   * Render the bottom navigation.
   * @param items [{id, icon, labelKey, badge}]
   * @param activeId
   * @param onSelect(id)
   */
  function renderNav(items, activeId, onSelect) {
    let nav = document.getElementById('app-nav');
    if (!nav) {
      nav = document.createElement('nav');
      nav.id = 'app-nav';
      nav.className = 'app-nav';
      nav.setAttribute('aria-label', 'Primary');
      document.body.appendChild(nav);
    }
    nav.innerHTML = '';
    items.forEach(function (it) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.navId = it.id;
      if (it.id === activeId) b.setAttribute('aria-current', 'page');
      b.innerHTML = '<i class="fa-solid ' + it.icon + '"></i><span>' + global.UI.esc(global.t(it.labelKey)) + '</span>' +
        (it.badge ? '<span class="nav-badge">' + global.UI.esc(String(it.badge)) + '</span>' : '');
      b.addEventListener('click', function () { if (onSelect) onSelect(it.id); });
      nav.appendChild(b);
    });
    nav.classList.remove('hidden');
    return nav;
  }

  function updateNavBadge(navId, count) {
    const nav = document.getElementById('app-nav');
    if (!nav) return;
    const btn = nav.querySelector('[data-nav-id="' + navId + '"]');
    if (!btn) return;
    let badge = btn.querySelector('.nav-badge');
    if (!count) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      btn.appendChild(badge);
    }
    badge.textContent = count > 99 ? '99+' : String(count);
  }

  function hideNav() {
    const nav = document.getElementById('app-nav');
    if (nav) nav.classList.add('hidden');
  }

  /* ------------------------------------------------------------ router */
  /**
   * Tiny hash-free screen router: shows one .screen at a time.
   * Screens register {id, el, onEnter, onLeave}.
   */
  class Router {
    constructor(hostSel) {
      this.host = document.querySelector(hostSel);
      this.screens = new Map();
      this.current = null;
      this.history = [];
    }

    add(id, el, hooks) {
      el.classList.add('screen');
      el.classList.add('hidden');
      el.dataset.screen = id;
      if (this.host && !el.parentElement) this.host.appendChild(el);
      this.screens.set(id, { el: el, hooks: hooks || {} });
      return this;
    }

    async go(id, params) {
      const next = this.screens.get(id);
      if (!next) { console.warn('Unknown screen', id); return; }
      if (this.current === id) return;
      const prev = this.current ? this.screens.get(this.current) : null;
      if (prev) {
        if (prev.hooks.onLeave) { try { await prev.hooks.onLeave(params); } catch (e) {} }
        prev.el.classList.add('hidden');
        this.history.push(this.current);
      }
      next.el.classList.remove('hidden');
      // Restart the entrance animation
      next.el.style.animation = 'none';
      void next.el.offsetHeight;
      next.el.style.animation = '';
      this.current = id;
      if (next.hooks.onEnter) { try { await next.hooks.onEnter(params); } catch (e) { console.error(e); } }
      global.dispatchEvent(new CustomEvent('pothik:screenchange', { detail: { screen: id } }));
      window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    }

    back() {
      const prev = this.history.pop();
      if (prev) this.go(prev);
    }

    get currentScreen() { return this.current; }
  }

  /* --------------------------------------------------------- auth guard */
  /**
   * Ensure a session of the expected role exists; otherwise redirect.
   * Returns the session or null (after redirecting).
   */
  function requireAuth(role, loginUrl) {
    const s = global.Auth.getSession();
    if (!s) {
      const url = loginUrl || ('login.html?role=' + role + '&next=' + encodeURIComponent(location.pathname.split('/').pop() + location.search));
      location.replace(url);
      return null;
    }
    if (role && s.role !== role) {
      location.replace(loginUrl || ('login.html?role=' + role));
      return null;
    }
    return s;
  }

  /* ------------------------------------------------------- misc helpers */
  function showLoading(show, message) {
    let overlay = document.getElementById('app-loading');
    if (show) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'app-loading';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:90;background:var(--overlay);display:grid;place-items:center;backdrop-filter:blur(2px)';
        overlay.innerHTML = '<div class="card center" style="min-width:220px">' +
          '<span class="spinner" style="color:var(--brand-500);width:28px;height:28px"></span>' +
          '<p class="mt-4" style="margin:0;font-weight:600" id="app-loading-msg"></p></div>';
        document.body.appendChild(overlay);
      }
      const m = document.getElementById('app-loading-msg');
      if (m) m.textContent = message || global.t('common.loading');
      overlay.classList.remove('hidden');
    } else if (overlay) {
      overlay.remove();
    }
  }

  /** Live connection indicator element. */
  function connectionPill() {
    const online = navigator.onLine;
    const q = (global.DB && global.DB.queueLength) || 0;
    if (!online) {
      return '<span class="badge badge-danger"><i class="fa-solid fa-wifi"></i>' + global.UI.esc(global.t('err.offline')) + '</span>';
    }
    if (q > 0) {
      return '<span class="badge badge-warn"><i class="fa-solid fa-cloud-arrow-up"></i>' + q + '</span>';
    }
    return '<span class="badge badge-success"><span class="dot dot-live"></span>Live</span>';
  }

  global.Shell = {
    boot: boot,
    renderHeader: renderHeader,
    setHeaderTitle: setHeaderTitle,
    renderNav: renderNav,
    updateNavBadge: updateNavBadge,
    hideNav: hideNav,
    Router: Router,
    requireAuth: requireAuth,
    showLoading: showLoading,
    connectionPill: connectionPill,
    langToggleHtml: langToggleHtml,
    wireLangToggle: wireLangToggle
  };
})(window);
