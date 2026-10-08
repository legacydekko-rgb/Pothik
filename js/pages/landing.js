/* ==========================================================================
   Pothik — Landing page controller
   ========================================================================== */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', async function () {
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.querySelector('span').textContent = I18n.getLang() === 'bn' ? 'EN' : 'বাং';
    Shell.wireLangToggle(document);

    // Boot (loads settings + seeds demo data on first run)
    await Shell.boot();

    document.getElementById('role-passenger').addEventListener('click', function () {
      location.href = 'login.html?role=passenger';
    });
    document.getElementById('role-driver').addEventListener('click', function () {
      location.href = 'login.html?role=driver';
    });
    document.getElementById('role-admin').addEventListener('click', function () {
      location.href = 'admin/index.html';
    });
  });
})();
