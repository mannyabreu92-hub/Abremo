// Installable app: service worker (offline + updates), install prompts, offline indicator.

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/**
 * hooks: { toast(msg, opts), onChange() } — onChange re-renders anything showing install state.
 */
export function initPWA(hooks) {
  let deferredPrompt = null;
  let waitingWorker = null;
  let updateRequested = false;
  const root = document.documentElement;
  root.classList.toggle('is-standalone', isStandalone());

  // ——— Install ———
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own, quieter entry points
    deferredPrompt = e;
    hooks.onChange();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hooks.toast('Abremi is on your home screen', { force: true });
    hooks.onChange();
  });
  window.matchMedia('(display-mode: standalone)').addEventListener?.('change', () => {
    root.classList.toggle('is-standalone', isStandalone());
    hooks.onChange();
  });

  // ——— Offline indicator ———
  const network = () => {
    root.classList.toggle('is-offline', !navigator.onLine);
  };
  window.addEventListener('offline', () => { network(); hooks.toast('You’re offline. Your saved art is still here.', { force: true, duration: 3500 }); });
  window.addEventListener('online', () => { network(); hooks.toast('Back online', { force: true }); });
  network();

  // ——— Service worker ———
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && secure) {
    const offerUpdate = (worker) => {
      waitingWorker = worker;
      hooks.toast('A new version of Abremi is ready', { action: 'Refresh', act: 'pwa-update', duration: 12000, force: true });
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updateRequested) location.reload(); // only after the person asked; first installs claim silently
    });
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });
      const check = () => { if (!document.hidden) reg.update().catch(() => {}); };
      document.addEventListener('visibilitychange', check);
      setInterval(check, 60 * 60 * 1000);
    }).catch((e) => console.warn('Service worker registration failed', e));
  }

  return {
    /** What to offer: a native prompt, iPhone instructions, or nothing (already installed / unsupported). */
    status() {
      const standalone = isStandalone();
      const ios = isIOS();
      return { standalone, canPrompt: Boolean(deferredPrompt), ios, available: !standalone && (Boolean(deferredPrompt) || ios) };
    },
    /** Returns 'prompted' | 'ios' | 'unavailable'. */
    async install() {
      if (deferredPrompt) {
        const prompt = deferredPrompt;
        deferredPrompt = null;
        prompt.prompt();
        await prompt.userChoice.catch(() => null);
        hooks.onChange();
        return 'prompted';
      }
      return isIOS() && !isStandalone() ? 'ios' : 'unavailable';
    },
    applyUpdate() {
      if (!waitingWorker) return location.reload();
      updateRequested = true;
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    },
  };
}
