// Languages. English text is the key: t('Start Exploring') returns the current language's
// translation, or the English when one is missing. Translations live in src/i18n/<code>.js and
// load only when chosen. tests/i18n.test.js checks every key used by translated screens exists in
// every language, with the same {placeholders}.

export const LANGS = [
  { code: 'en', label: 'English', locale: 'en-US' },
  { code: 'es', label: 'Español', locale: 'es' },
  { code: 'fr', label: 'Français', locale: 'fr-FR' },
  { code: 'pt', label: 'Português', locale: 'pt-BR' },
  { code: 'zh', label: '中文', locale: 'zh-CN' },
];
export const LANG_KEY = 'abremi:lang';

let lang = 'en';
let dict = {};

/** The saved choice, else the browser's first supported language, else English. */
export function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (LANGS.some((l) => l.code === saved)) return saved;
  } catch { /* private mode */ }
  for (const pref of (typeof navigator !== 'undefined' && navigator.languages) || []) {
    const code = String(pref).toLowerCase().slice(0, 2);
    if (LANGS.some((l) => l.code === code)) return code;
  }
  return 'en';
}

/** Loads a language (its dictionary) and makes it current. */
export async function setLang(code, { save = false } = {}) {
  const next = LANGS.some((l) => l.code === code) ? code : 'en';
  dict = next === 'en' ? {} : (await import(`../i18n/${next}.js`)).default;
  lang = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next === 'zh' ? 'zh-Hans' : next;
  if (save) { try { localStorage.setItem(LANG_KEY, next); } catch { /* private mode */ } }
  return next;
}

/** For tests: use a dictionary directly. */
export function useDictionary(code, d) { lang = code; dict = d || {}; }

export const getLang = () => lang;
export const locale = () => LANGS.find((l) => l.code === lang)?.locale || 'en-US';

/** Translate English text; {name} placeholders are filled from vars. */
export function t(text, vars) {
  const out = dict[text] ?? text;
  return vars ? out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : out;
}

/** Singular or plural: tn(n, '{n} work', '{n} works'). Chinese has one form; both keys exist anyway. */
export const tn = (n, one, many) => t(n === 1 ? one : many, { n });

let regionNames = null, regionLang = '';
/** A country's name in the current language (from the browser), falling back to the given name. */
export function regionName(code, fallback = '') {
  if (!code) return fallback;
  try {
    if (regionLang !== lang) { regionNames = new Intl.DisplayNames([locale()], { type: 'region' }); regionLang = lang; }
    return regionNames.of(code) || fallback;
  } catch { return fallback; }
}

/**
 * Dates in the current language.
 * @param {string | number | Date} d
 * @param {Intl.DateTimeFormatOptions} [opts]
 */
export const formatDate = (d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => new Date(d).toLocaleDateString(locale(), opts);
