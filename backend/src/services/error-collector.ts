/**
 * Klientkoden som fanger feil i nettleseren.
 *
 * Ligger som en streng og ikke som en egen .js-fil av én praktisk grunn:
 * backend bygges med `tsc`, som kopierer .ts til .js og ikke rører noe annet.
 * En løs .js-fil ved siden av ville måttet kopieres inn i `dist/` av et eget
 * steg som noen før eller siden glemmer, og resultatet ville vært en collector
 * som virker i dev og gir 404 i produksjon.
 *
 * ## Designkravene
 *
 * Dette scriptet kjører på hver eneste side i hver eneste app vi hoster, hos
 * folk som aldri har bedt om det. Det gir tre absolutter:
 *
 * 1. **Det kan ikke brekke siden.** Alt ligger i en try/catch, ingenting kaster
 *    videre, og de originale `onerror`/`onunhandledrejection`-håndtererne
 *    kalles alltid – også når vår egen kode feiler.
 * 2. **Det kan ikke merkes.** Under 2 kB, `defer`, ingen synkron I/O, ingen
 *    henting av noe annet. Rapporten går med `sendBeacon`, som nettleseren
 *    sender i bakgrunnen uten å holde på sideskiftet.
 * 3. **Det kan ikke lekke.** Ingen cookies, ingen `localStorage`, ingen
 *    URL-parametre, ingen skjemaverdier. Se `strip()`.
 *
 * ## Taket
 *
 * `MAX` rapporter per sidelast, og hver unik feil rapporteres kun én gang.
 * En React-komponent som kaster i en render-løkke kan produsere tusenvis av
 * identiske feil på et sekund; uten taket ville nettleseren til brukeren brukt
 * båndbredden sin på å fortelle oss det samme tusen ganger.
 */
export const COLLECTOR_JS = `(function(){
try{
var MAX=8,sent=0,seen={};
var URL_="/__snoat/errors";

/* Sti uten query-streng. Tokens og e-postadresser bor i query-strenger. */
function strip(u){try{var a=document.createElement("a");a.href=u||location.href;return a.pathname.slice(0,255)}catch(e){return null}}

/* Kun de øverste rammene. Bunnen av en stack er rammeverkskode vi ikke kan fikse,
   og en uendelig rekursjon gir en stack på megabyte. */
function trim(s){if(typeof s!=="string")return null;var l=s.split("\\n").slice(0,30);return l.join("\\n").slice(0,8000)}

function send(p){
  if(sent>=MAX)return;
  /* Samme feil to ganger fra samme side er ikke to feil. */
  var k=p.message+"|"+p.file+"|"+p.line;
  if(seen[k])return;
  seen[k]=1;sent++;
  p.url=strip(location.href);
  var b=JSON.stringify(p);
  try{
    if(navigator.sendBeacon){navigator.sendBeacon(URL_,new Blob([b],{type:"application/json"}));return}
  }catch(e){}
  /* Eldre nettlesere, og Safari når beacon-koen er full. keepalive slik at
     rapporten overlever at brukeren navigerer bort i samme øyeblikk. */
  try{fetch(URL_,{method:"POST",body:b,keepalive:true,headers:{"Content-Type":"application/json"}})}catch(e){}
}

var prevError=window.onerror;
window.onerror=function(msg,file,line,col,err){
  try{
    send({
      kind:"client",
      message:String((err&&err.message)||msg||"Ukjent feil").slice(0,500),
      file:file?String(file).slice(0,500):null,
      line:line||null,
      col:col||null,
      stack:trim(err&&err.stack)
    });
  }catch(e){}
  /* Appens egen håndterer skal ikke miste hendelsen fordi vi kom først. */
  if(typeof prevError==="function")return prevError.apply(this,arguments);
  return false;
};

var prevRej=window.onunhandledrejection;
window.onunhandledrejection=function(ev){
  try{
    var r=ev&&ev.reason;
    send({
      kind:"client",
      message:String((r&&r.message)||r||"Ubehandlet promise-avvisning").slice(0,500),
      file:null,line:null,col:null,
      stack:trim(r&&r.stack)
    });
  }catch(e){}
  if(typeof prevRej==="function")return prevRej.apply(this,arguments);
};
}catch(e){}
})();`;
