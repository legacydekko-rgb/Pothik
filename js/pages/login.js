/* ==========================================================================
   Pothik — Login / Registration / OTP controller
   Flow: phone -> (password if account exists | register) -> OTP -> success
   ========================================================================== */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  let role = params.get('role') || 'passenger';
  const nextUrl = params.get('next') || '';

  let pendingPhone = '';
  let pendingUser = null;
  let otpCode = '';
  let mode = 'login';         // 'login' | 'register'
  let resendTimer = null;

  const $ = function (s) { return document.getElementById(s); };

  document.addEventListener('DOMContentLoaded', async function () {
    Shell.wireLangToggle(document);
    await Shell.boot();

    // Role guard: only passenger/driver can use this page
    if (role !== 'passenger' && role !== 'driver') role = 'passenger';

    setupDemoBox();
    setupForms();
    setupOtp();
    applyRoleText();

    // Already logged in? Go straight through.
    const sess = Auth.getSession();
    if (sess) {
      if (sess.role === 'driver' && role === 'driver') { location.replace('driver/index.html'); return; }
      if (sess.role === 'passenger' && role === 'passenger') { location.replace('app/index.html'); return; }
      if (sess.role === 'admin') { location.replace('admin/index.html'); return; }
    }

    // ?mode=register shortcut
    if (params.get('mode') === 'register') setMode('register');
  });

  /* -------------------------------------------------------------- helpers */
  function applyRoleText() {
    const isDriver = role === 'driver';
    $('register-role-note').textContent = isDriver
      ? t('drv.register') + ' · ' + t('drv.appSubmittedSub')
      : t('auth.loginSub');
    $('reg-vehicle-field').style.display = isDriver ? '' : 'none';
    document.title = (isDriver ? t('drv.title') : t('app.role.passenger')) + ' · Pothik';
  }

  function setupDemoBox() {
    const box = $('demo-creds');
    if (role === 'driver') {
      box.innerHTML = '1712000001 / driver123<br><span style="color:var(--muted)">approved driver</span><br>' +
        '1712000006 / driver123<br><span style="color:var(--muted)">pending approval (test the approval flow)</span>';
    } else {
      box.innerHTML = '1711100001 / passenger123<br><span style="color:var(--muted)">Rahim Uddin</span><br>' +
        '1811100002 / passenger123<br><span style="color:var(--muted)">Nusrat Jahan</span>';
    }
  }

  function show(stepId) {
    ['step-phone', 'step-register', 'step-otp', 'step-done'].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      el.classList.toggle('hidden', id !== stepId);
    });
    window.scrollTo(0, 0);
  }

  function setMode(m) {
    mode = m;
    if (m === 'register') {
      show('step-register');
      $('header-title').textContent = t('auth.register');
    } else {
      show('step-phone');
      $('header-title').textContent = t('auth.login');
      // For login we only need the phone first, then password
      $('password-field').style.display = 'none';
    }
  }

  function fieldError(inputEl, showIt, msg) {
    const field = inputEl.closest('.field');
    if (!field) return;
    field.classList.toggle('is-invalid', !!showIt);
    const err = field.querySelector('.err');
    if (err && msg) err.textContent = msg;
  }

  function busy(btn, isBusy, label) {
    if (!btn) return;
    btn.disabled = isBusy;
    if (isBusy) {
      btn.dataset.label = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span>' + (label || '');
    } else if (btn.dataset.label) {
      btn.innerHTML = btn.dataset.label;
    }
  }

  /* --------------------------------------------------------- phone screen */
  function setupForms() {
    // Show/hide password
    $('toggle-pw').addEventListener('click', function () {
      const inp = $('password-input');
      const isPw = inp.type === 'password';
      inp.type = isPw ? 'text' : 'password';
      this.querySelector('i').className = 'fa-solid fa-eye' + (isPw ? '-slash' : '');
    });

    $('switch-mode').addEventListener('click', function () { setMode('register'); });
    $('back-to-login').addEventListener('click', function () { setMode('login'); });

    // ---- Phone submit ----
    $('phone-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      const inp = $('phone-input');
      const pwInp = $('password-input');
      const pwVisible = $('password-field').style.display !== 'none';

      if (!PothikGeo.isValidBdPhone(inp.value)) {
        fieldError(inp, true, t('auth.invalidPhone'));
        return;
      }
      fieldError(inp, false);

      const btn = $('phone-submit');
      busy(btn, true, '');

      try {
        const user = await Auth.exists(inp.value);

        if (mode === 'login' && user) {
          // Account exists — if password field is not yet shown, reveal it
          if (!pwVisible) {
            pendingPhone = PothikGeo.normalizePhone(inp.value);
            pendingUser = user;
            $('password-field').style.display = '';
            $('phone-submit').textContent = t('auth.login');
            $('phone-submit').setAttribute('data-i18n', 'auth.login');
            busy(btn, false);
            pwInp.focus();
            return;
          }
          // Verify the password
          if (!pwInp.value) { fieldError(pwInp, true, t('auth.password')); busy(btn, false); return; }
          const ok = await Auth.verifyPassword(pwInp.value, user.password_hash);
          if (!ok) { fieldError(pwInp, true, t('auth.wrongPassword')); busy(btn, false); return; }
          fieldError(pwInp, false);
          await completeLogin(user);
          return;
        }

        if (mode === 'login' && !user) {
          fieldError(inp, true, t('auth.notFound'));
          busy(btn, false);
          // Offer registration
          UI.toast(t('auth.notFound') + ' — ' + t('auth.register') + '?', 'warn');
          setMode('register');
          $('reg-phone').value = PothikGeo.normalizePhone(inp.value);
          return;
        }

        busy(btn, false);
      } catch (err) {
        busy(btn, false);
        UI.toast(err.message && err.message.indexOf('auth.') === 0 ? t(err.message) : t('err.generic'), 'error');
      }
    });

    // ---- Register submit ----
    $('register-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      const nameEl = $('reg-name');
      const phoneEl = $('reg-phone');
      const emailEl = $('reg-email');
      const pwEl = $('reg-pw');
      const pw2El = $('reg-pw2');
      const agreeEl = $('reg-agree');
      const btn = e.target.querySelector('button[type=submit]');

      let bad = false;
      if (!nameEl.value.trim() || nameEl.value.trim().length < 2) { fieldError(nameEl, true, t('auth.nameRequired')); bad = true; } else fieldError(nameEl, false);
      if (!PothikGeo.isValidBdPhone(phoneEl.value)) { fieldError(phoneEl, true, t('auth.invalidPhone')); bad = true; } else fieldError(phoneEl, false);
      if (pwEl.value.length < 6) { fieldError(pwEl, true, t('auth.passwordShort')); bad = true; } else fieldError(pwEl, false);
      if (pwEl.value !== pw2El.value) { fieldError(pw2El, true, t('auth.passwordMismatch')); bad = true; } else fieldError(pw2El, false);
      if (!agreeEl.checked) { UI.toast(t('auth.mustAgree'), 'warn'); bad = true; }
      if (bad) return;

      busy(btn, true, '');

      try {
        const existing = await Auth.exists(phoneEl.value);
        if (existing) {
          fieldError(phoneEl, true, t('auth.phoneTaken'));
          busy(btn, false);
          return;
        }

        pendingPhone = PothikGeo.normalizePhone(phoneEl.value);

        // Send an OTP to prove the number, then register on verify
        otpCode = Auth.generateOtp();
        Auth.storeOtp(pendingPhone, otpCode, 'register');

        // Stash the registration payload until the OTP is verified
        Store.set('pending.registration', {
          fullName: nameEl.value.trim(),
          phone: pendingPhone,
          email: emailEl.value.trim(),
          password: pwEl.value,
          emergencyContact: $('reg-emergency').value,
          vehicleType: $('reg-vehicle').value,
          role: role,
          language: I18n.getLang()
        });

        goToOtp(t('auth.verifyOtp'));
      } catch (err) {
        busy(btn, false);
        UI.toast(err.message && err.message.indexOf('auth.') === 0 ? t(err.message) : t('err.generic'), 'error');
      }
    });
  }

  /* ------------------------------------------------------------ OTP screen */
  function setupOtp() {
    const inputs = Array.prototype.slice.call(document.querySelectorAll('#otp-row input'));

    inputs.forEach(function (inp, idx) {
      inp.addEventListener('input', function () {
        // Bangla digits -> ASCII so users on a Bangla keyboard can type
        const bnMap = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };
        inp.value = inp.value.replace(/[০-৯]/g, function (d) { return bnMap[d]; }).replace(/\D/g, '');
        if (inp.value && idx < inputs.length - 1) inputs[idx + 1].focus();
        if (getOtp().length === 6) verify();
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !inp.value && idx > 0) inputs[idx - 1].focus();
        if (e.key === 'Enter') verify();
      });
      inp.addEventListener('paste', function (e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
        text.split('').forEach(function (ch, i) { if (inputs[i]) inputs[i].value = ch; });
        if (text.length === 6) verify();
      });
    });

    $('otp-verify').addEventListener('click', verify);
    $('otp-change').addEventListener('click', function () {
      pendingPhone = ''; pendingUser = null;
      $('password-field').style.display = 'none';
      $('phone-submit').textContent = t('auth.sendOtp');
      Store.remove('pending.registration');
      setMode('login');
    });
    $('otp-resend').addEventListener('click', function () {
      otpCode = Auth.generateOtp();
      Auth.storeOtp(pendingPhone, otpCode, mode);
      $('otp-demo-code').textContent = otpCode;
      UI.toast(t('auth.resend') + ' ✓', 'success');
      startResendCooldown();
    });
  }

  function getOtp() {
    return Array.prototype.slice.call(document.querySelectorAll('#otp-row input'))
      .map(function (i) { return i.value; }).join('');
  }

  function goToOtp(heading) {
    show('step-otp');
    $('header-title').textContent = heading || t('auth.otpTitle');
    $('otp-phone').textContent = ' +880 ' + PothikGeo.formatBdPhone(pendingPhone);
    $('otp-demo-code').textContent = otpCode;
    $('otp-error').textContent = '';
    document.querySelectorAll('#otp-row input').forEach(function (i) { i.value = ''; });
    const first = document.querySelector('#otp-row input');
    if (first) setTimeout(function () { first.focus(); }, 180);
    startResendCooldown();
  }

  function startResendCooldown() {
    const btn = $('otp-resend');
    let left = 30;
    btn.disabled = true;
    clearInterval(resendTimer);
    btn.textContent = t('auth.resendIn') + ' ' + left + 's';
    resendTimer = setInterval(function () {
      left--;
      if (left <= 0) {
        clearInterval(resendTimer);
        btn.disabled = false;
        btn.textContent = t('auth.resend');
      } else {
        btn.textContent = t('auth.resendIn') + ' ' + left + 's';
      }
    }, 1000);
  }

  async function verify() {
    const entered = getOtp();
    if (entered.length !== 6) return;
    const btn = $('otp-verify');
    busy(btn, true, '');

    const res = Auth.checkOtp(pendingPhone, entered);
    if (!res.ok) {
      busy(btn, false);
      const msg = res.reason === 'expired' ? t('auth.invalidOtp') : (res.reason === 'locked' ? t('auth.invalidOtp') : t('auth.invalidOtp'));
      $('otp-error').textContent = msg + (res.attemptsLeft !== undefined ? ' (' + res.attemptsLeft + ' left)' : '');
      document.querySelectorAll('#otp-row input').forEach(function (i) { i.value = ''; });
      const first = document.querySelector('#otp-row input');
      if (first) first.focus();
      return;
    }

    try {
      // New registration?
      const pending = Store.get('pending.registration', null);
      if (pending && pending.phone === pendingPhone) {
        const result = await Auth.register({
          fullName: pending.fullName,
          phone: pending.phone,
          email: pending.email,
          password: pending.password,
          emergencyContact: pending.emergencyContact,
          vehicleType: pending.vehicleType,
          role: pending.role,
          language: pending.language
        });
        Store.remove('pending.registration');
        await Auth.audit(result.user.id, result.user.role, 'USER_REGISTERED', 'users', result.user.id, { role: result.user.role });
        await completeLogin(result.user, result.session);
        return;
      }

      // Existing user
      const user = pendingUser || await Auth.exists(pendingPhone);
      if (!user) { busy(btn, false); UI.toast(t('auth.notFound'), 'error'); return; }
      await completeLogin(user);
    } catch (err) {
      busy(btn, false);
      const key = err.message && err.message.indexOf('auth.') === 0 ? err.message : 'err.generic';
      $('otp-error').textContent = t(key);
    }
  }

  /* ---------------------------------------------------------- completion */
  async function completeLogin(user, existingSession) {
    const session = existingSession || (await Auth.loginWithOtp(user.phone, role)).session;
    Auth.saveSession(session);

    await Notify.requestPermission().catch(function () {});
    Notify.subscribePush().catch(function () {});

    show('step-done');
    $('header-title').textContent = t('app.name');
    $('done-title').textContent = t('auth.welcome') + ', ' + (user.full_name || '') + '!';

    let dest, sub;
    if (session.role === 'driver') {
      dest = 'driver/index.html';
      sub = session.driverStatus === 'approved' ? t('drv.status.approved.desc') : t('drv.status.pending.desc');
    } else if (session.role === 'admin') {
      dest = 'admin/index.html';
      sub = t('admin.title');
    } else {
      dest = 'app/index.html';
      sub = t('home.whereTo');
    }
    $('done-sub').textContent = sub;

    // Animate the bar, then navigate
    let pct = 8;
    const bar = $('done-bar');
    const tick = setInterval(function () {
      pct = Math.min(100, pct + 14);
      bar.style.width = pct + '%';
      if (pct >= 100) {
        clearInterval(tick);
        const target = nextUrl ? decodeURIComponent(nextUrl) : dest;
        setTimeout(function () { location.replace(target); }, 260);
      }
    }, 110);
  }
})();
