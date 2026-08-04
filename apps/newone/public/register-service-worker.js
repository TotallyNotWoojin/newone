(() => {
  if (!('serviceWorker' in navigator)) return;
  const localDevelopment = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !localDevelopment) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    }).then((registration) => registration.update()).catch(() => {
      // Installed-web support is optional; authentication and online use remain available.
    });
  }, { once: true });
})();
