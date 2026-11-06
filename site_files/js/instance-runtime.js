(function(){
'use strict';
const cfg=window.__emailInstance||{};
const brand=cfg.brand||{};
const features=cfg.features||{};
const product=String(brand.productName||cfg.instance?.name||'Social Mail');
const company=String(brand.companyName||product);
const website=String(brand.websiteUrl||'').replace(/\/+$/,'');
const support=String(brand.supportUrl||'').replace(/\/+$/,'');
const logo=String(brand.logoUrl||'');
const windowsUrl=String(brand.downloads?.windows||'');
const linuxUrl=String(brand.downloads?.linux||'');
const socialEnabled=features.socialBrowserLogin!==false&&brand.socialBrowserLogin?.enabled!==false;

function setHref(el,value){if(el&&value)el.setAttribute('href',value);}
function rewriteBrandText(value){
  return String(value||'')
    .replace(/\bSocial Temp Mail\b/g,product)
    .replace(/\bSocial Browser Email Manager\b/g,product+' Email Manager')
    .replace(/\bSocial Browser\b/g,company)
    .replace(/\bEgytag\b/g,company);
}
function apply(){
  document.querySelectorAll('.sb-brand').forEach(el=>{
    const span=el.querySelector('span');
    el.childNodes.forEach(n=>{if(n.nodeType===3)n.textContent='';});
    el.insertBefore(document.createTextNode(product+' '),span||null);
    if(span)span.textContent=company;
  });

  if(document.title) document.title=rewriteBrandText(document.title);
  document.querySelectorAll('meta[property="og:title"],meta[name="application-name"]').forEach(el=>{
    const v=el.getAttribute('content');if(v)el.setAttribute('content',rewriteBrandText(v));
  });

  if(logo){
    document.querySelectorAll('img[src*="social-browser-brand-icon"],img[data-instance-logo]').forEach(el=>el.setAttribute('src',logo));
    document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]').forEach(el=>{
      if(el.getAttribute('href')&&/\/images\/logo\.png$/i.test(el.getAttribute('href')))el.setAttribute('href',logo);
    });
  }

  document.querySelectorAll('a[href^="https://social-browser.com"]').forEach(el=>{
    const href=el.getAttribute('href')||'';
    if(/download-windows-latest/i.test(href)&&windowsUrl)setHref(el,windowsUrl);
    else if(/download-linux-latest/i.test(href)&&linuxUrl)setHref(el,linuxUrl);
    else if(website)setHref(el,website);
  });

  document.querySelectorAll('[data-browser-download]').forEach(el=>setHref(el,windowsUrl));
  document.querySelectorAll('[data-browser-download-linux]').forEach(el=>setHref(el,linuxUrl));

  if(!socialEnabled){
    document.querySelectorAll('[data-browser-signin],[data-browser-account],[data-browser-signout],[data-browser-user-menu],[data-quick-mail-link="social_browser"],[data-limit-alert-cta],[data-browser-download],[data-browser-download-linux]').forEach(el=>el.hidden=true);
    document.querySelectorAll('a[href^="/login?next="]').forEach(el=>el.hidden=true);
  }

  document.querySelectorAll('[data-instance-product]').forEach(el=>el.textContent=product);
  document.querySelectorAll('[data-instance-company]').forEach(el=>el.textContent=company);
  document.querySelectorAll('[data-instance-support]').forEach(el=>{if(support)setHref(el,support);else el.hidden=true;});
  document.documentElement.dataset.mailInstance=String(cfg.instance?.id||'');
  document.documentElement.dataset.mailEdition=String(cfg.instance?.edition||'');
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',apply,{once:true});else apply();
})();