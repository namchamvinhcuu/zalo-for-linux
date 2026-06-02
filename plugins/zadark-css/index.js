/**
 * plugins/zadark-css/index.js
 *
 * ZaDark integrates by injecting <link rel="stylesheet"> tags into index.html
 * at build time. On Linux, Zalo's SPA strips those <link> tags from the DOM on
 * boot, so ZaDark's CSS never applies: the settings popup (#js-zadark-popup)
 * renders as an unstyled, unpositioned block at the end of <body> and stays
 * invisible — clicking the ZaDark sidebar button appears to do nothing.
 *
 * The ZaDark JavaScript still works (the <script> tags execute before the SPA
 * strips them), so only the CSS is missing. We re-apply it from the main
 * process by injecting a real <style> element (re-added if the SPA strips it,
 * via MutationObserver).
 *
 * The ZaDarkIcons icon font is a separate problem: neither insertCSS nor an
 * @font-face rule in the injected <style> reliably registers it (it never
 * appears in document.fonts), so the icon glyphs render as empty boxes. We
 * register it the bulletproof way — document.fonts.add(new FontFace(...)) from
 * the raw font bytes — which needs no @font-face, no file:// URL, and is not
 * subject to the page's `font-src` CSP.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Order matches index.html: fonts, base theme, popup.
const CSS_FILES = [
  'zadark-fonts.min.css',
  'zadark.min.css',
  'zadark-popup.min.css',
];

let _assetsCache = null;

function loadAssets(appDir) {
  if (_assetsCache !== null) return _assetsCache;

  const cssDir = path.join(appDir, 'pc-dist', 'zadark', 'css');
  const fontsDir = path.join(appDir, 'pc-dist', 'zadark', 'fonts');

  // Raw icon-font bytes, registered at runtime via the FontFace API.
  let fontB64 = '';
  try {
    fontB64 = fs.readFileSync(path.join(fontsDir, 'ZaDarkIcons.woff')).toString('base64');
  } catch (e) {
    console.error('[zadark-css] icon font read failed:', e.message);
  }

  let combined = '';

  // Tippy injects its core stylesheet (.tippy-box layout/box) at runtime; the
  // SPA strips it, so tooltips lose their background and read as bare text.
  // Extract that core CSS straight from the lib and inject it too — the ZaDark
  // tippy theme (in zadark-popup.min.css) then overrides the colors.
  try {
    const tippyJs = fs.readFileSync(path.join(appDir, 'pc-dist', 'zadark', 'libs', 'zadark-tippy.min.js'), 'utf8');
    const m = tippyJs.match(/'[^']*\.tippy-box\{position:relative[^']*'/);
    if (m) combined += m[0].slice(1, -1) + '\n';
  } catch (e) {
    console.error('[zadark-css] tippy core css extract failed:', e.message);
  }

  for (const name of CSS_FILES) {
    try {
      // Strip the UTF-8 BOM: each ZaDark css file starts with one, and once
      // concatenated it lands mid-stylesheet right before the leading `:root`
      // selector, turning it into an invalid `\uFEFF:root` rule. That drops the
      // whole :root block — including every --zadark-tippy* variable — so tippy
      // tooltips end up with no background/border (the vars resolve to nothing).
      let css = fs.readFileSync(path.join(cssDir, name), 'utf8').replace(/\uFEFF/g, '');
      // Drop the ZaDarkIcons @font-face src (file:// urls that the SPA/CSP block);
      // the FontFace API registers the font instead.
      if (fontB64) {
        css = css.replace(/src:url\((['"]?)\.\.\/fonts\/ZaDarkIcons[^;]*;/, '');
      }
      // Other url("../fonts/...") is relative to the css dir; in an injected
      // <style> urls resolve relative to index.html (pc-dist), so rewrite.
      css = css.replace(/url\((['"]?)\.\.\/fonts\//g, 'url($1zadark/fonts/');
      combined += css + '\n';
    } catch (e) {
      // Missing on the non-ZaDark (Original) build — nothing to inject there.
      console.error('[zadark-css] skip', name + ':', e.message);
    }
  }

  _assetsCache = { css: combined, fontB64 };
  return _assetsCache;
}

function buildInjector(css, fontB64) {
  // Inject a <style> (re-added if the SPA strips it) for the rules, and register
  // the icon font via the FontFace API. The boot-time wipe is brief, so the
  // observer self-disconnects; dom-ready re-fires on a real navigation.
  return `(function(){
  var ID='zadark-injected-css';
  var CSS=${JSON.stringify(css)};
  var FONT=${JSON.stringify(fontB64)};
  function inject(){
    if(document.getElementById(ID))return;
    var s=document.createElement('style');
    s.id=ID;
    s.textContent=CSS;
    (document.head||document.documentElement).appendChild(s);
  }
  inject();
  try{
    if(FONT && !window.__zadarkIconFont){
      window.__zadarkIconFont=true;
      var bin=atob(FONT), bytes=new Uint8Array(bin.length);
      for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      var ff=new FontFace('ZaDarkIcons', bytes.buffer);
      ff.load().then(function(face){ document.fonts.add(face); }).catch(function(){});
    }
  }catch(e){}
  try{
    var mo=new MutationObserver(function(){ if(!document.getElementById(ID)) inject(); });
    mo.observe(document.documentElement,{childList:true,subtree:true});
    setTimeout(function(){ mo.disconnect(); },20000);
  }catch(e){}
})();`;
}

function register({ app, appDir }) {
  app.on('browser-window-created', (_evt, win) => {
    win.webContents.on('dom-ready', () => {
      const { css, fontB64 } = loadAssets(appDir);
      if (css || fontB64) {
        win.webContents.executeJavaScript(buildInjector(css, fontB64)).catch(() => {});
      }
    });
  });
}

module.exports = { register };
