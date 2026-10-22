/* StremioBrew UI translations: language list + loader.
   Keys are the English UI text itself (gettext-style): the app calls T('Added to Library'),
   and the player (player.js) uses the app's T(). Each language lives in app/i18n/<code>.js (I18N_DICTS.<code> = {...}) and
   only the one in use is loaded, so more languages cost the TV nothing at startup.
   To add a language: copy app/i18n/fr.js to app/i18n/<code>.js, translate it (anything missing
   or empty falls back to English; {placeholders} must be kept) and list it in I18N_LANGS below
   with its own name, as shown in Settings > Language. Right-to-left languages also go in I18N_RTL. */
var I18N_LANGS = {
  fr: 'Français', es: 'Español', de: 'Deutsch', it: 'Italiano', pt: 'Português',
  nl: 'Nederlands', pl: 'Polski', tr: 'Türkçe', ru: 'Русский', ar: 'العربية'
};
var I18N_RTL = { ar: 1 };
var I18N_DICTS = {};

/* UI language = Settings > Language; "auto" = the TV's own UI language. index.html and the
   player both resolve it with this, so they always agree. */
function i18nPick(uiPref, tvLocale) {
  if (uiPref === 'en' || I18N_LANGS[uiPref]) return uiPref;
  var tv = String(tvLocale || 'en').slice(0, 2).toLowerCase();
  return I18N_LANGS[tv] ? tv : 'en';
}

/* in a page: load the chosen language synchronously, before the page's own scripts run
   (the helper runs this file in Node, without a document, and loads the files itself) */
(function () {
  if (typeof document === 'undefined') return;
  var ui = 'auto', tv = '';
  try { ui = localStorage.getItem('uiLang') || 'auto'; tv = localStorage.getItem('tvUiLocale') || ''; } catch (e) {}
  var l = i18nPick(ui, tv || navigator.language);
  if (l !== 'en') document.write('<script src="i18n/' + l + '.js"><\/script>');
})();
