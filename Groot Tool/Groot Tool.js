// ==UserScript==
// @name         Groot Tool
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  FMC: Route watcher -> Shipper/Cost/Stops + carrier (RLB1<30h / AZNG>=30h), fast carrier commit.
// @author       eramsai
// @match        https://trans-logistics-eu.amazon.com/fmc/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function(){
"use strict";

/* ═══ DATA ═══ */
var IP={"CDG7":1,"BHX4":1,"LBA4":1,"LPX2":1,"DTM1":1,"DTM2":1,"UXD1":1,"UXD2":1,"WRO5":1,"HAJ1":1,"ZAZ1":1,"TRN3":1,"STR4":1};

/* ═══ INTERMODAL (IM) LANES ═══
   Authoritative IM lane list (compiled by eramsai). ONLY IM lanes are listed here - SEA
   and TTA lanes are deliberately NOT included (user request: only IM lane).
   Shipper rule (see fillShipper): an IM lane whose pasted SDT is >= 12h above now gets
   shipper "ATSwarehouseTransfersIntermodal"; an IM lane with SDT < 12h (or no confirmed
   SDT at all) and every non-IM lane keep the normal IP/warehouse logic unchanged.
   Keyed "ORIGIN->DEST", uppercased, same lane-string shape onRouteChange builds. */
var IMLANES={};
("BCN4->CDG7,BGY1->BTS2,BRQ2->NUE1,BRQ2->PAD1,BTS2->LEJ3,BTS2->ORY1,CDG7->HAJ1,"+
 "CDG7->MRS1,DTM1->BLQ1,DTM1->BVA1,DTM1->KTW1,DTM1->ORY4,DTM1->POZ1,DTM1->PRG2,"+
 "DTM1->WRO2,DTM1->XWR4,DTM2->KTW1,DTM2->MUC3,DTM2->ORY4,DTM2->PRG2,DTM2->WRO2,"+
 "DTM8->TRN3,DUS2->FCO2,DUS2->KTW5,DUS2->VLC1,DUS2->XMP4,DUS2->XOR4,EDI4->BHX4,"+
 "ETZ2->HAJ1,ETZ2->KTW3,FCO1->TRN3,FCO1->WRO5,FRA1->BCN1,FRA1->FCO1,HAJ1->CDG7,"+
 "HAJ1->ETZ2,HAJ1->KTW3,HAJ1->ORY4,HAJ1->XWR4,HAM2->KTW3,HERMES_GRABEN_DE->KTW1,"+
 "HERMESPAKET_MAINZ_DE->WRO1,KTW1->BRE4,KTW1->DUS4,KTW1->FRA7,LCJ4->LEJ5,LCJ4->MXP6,"+
 "LCJ4->PRG2,LEJ3->FCO2,LEJ3->MXP3,LEJ3->XOR4,LEJ3->XOS1,LIN8->DTM9,MAD6->KTW5,"+
 "MAD6->XOR4,MAD7->BCN4,MRS1->CDG7,MXP3->XWR3,ORY4->HAJ1,ORY4->WRO5,OVD1->ZAZ1,"+
 "POZ1->BGY1,POZ1->TRN3,PSR2->TRN3,RMU1->WRO5,SCN2->KTW3,SHRT-DTM8-2->LIL1,"+
 "STN8->EDI4,STR4->ORY4,STR4->POZ2,STR4->PRG2,TRN3->BRQ2,TRN3->FCO1,TRN3->ORY1,"+
 "WRO1->CGN1,WRO1->XOS1,WRO5->BRE2,WRO5->BRE4,WRO5->HAM2,WRO5->MUC3,XCD2->BGY1,"+
 "XCD2->BLQ1,XCD2->MRS1,XCD2->MXP6,XDT3->FCO2,XDT3->XMP4,XFR7->XIBA,XFR7->XITF,"+
 "XOR1->KTW5,XOR1->RLG1,XOR1->VLC1,XOR1->XWR3,XPO1->FCO2,XPO1->MAD9,XPO1->MXP3,"+
 "XPO1->VLC1,XPO1->XOS1,XWR4->MUC3"
).split(",").forEach(function(l){IMLANES[l.trim().toUpperCase()]=1;});
function isIMLane(fullLane){return!!(fullLane&&IMLANES[String(fullLane).trim().toUpperCase()]);}


/* ═══ CURRENCY TABLE (origin prefix -> GBP/EUR) ═══
   REVIEW ME: single source of truth for the offline fallback classifier (gCur). The
   Amazon node API (resolveCurrencyFromAmazon) is still authoritative at runtime; this
   table only supplies the instant guess shown while the API resolves, and the answer
   used if the API call fails. Grouped ONE COUNTRY PER KEY (country name in the
   comment on every group), codes sorted alphabetically within each group, so this is
   easy to read/edit. Only the UK group is GBP; every other country is EUR - the
   lane's ORIGIN decides, cost is always 0. Sources: fmc pull.txt (XLE1=DE, TRN3=IT),
   groot-inspector/groot-final references, the user-supplied authoritative facility
   list (16.0.2 - see report.md for exactly what was added/corrected), and general
   airport/site-code knowledge. Where general knowledge conflicts with sample data or
   the user's own list, the user's list and the reference scripts win (see report.md).
   4-letter codes (XIBA, XITF) are listed in CODE4 and checked BEFORE the 3-letter
   prefix map, since slice(0,3) would otherwise mis-truncate them. A code is a 3-letter
   PREFIX: the 4th character of a real node (STR1/STR2/STR4) is only the site number,
   so one prefix entry covers every site number for that city. */
var CUR_TABLE={
    // United Kingdom -> GBP
    GBP:["ABZ","BFS","BHD","BHX","BOH","BRS","CWL","DSA","EDI","EMA","EUK","EXT","GLA",
         "HUY","INV","LBA","LCY","LGW","LHR","LPL","LPX","LTN","MAN","MME","NCL","NWI",
         "PIK","SEN","SOU","STN","UXD","XUK"],
    // Germany -> EUR
    EUR_Germany:["BER","BRE","CGN","DRS","DTM","DUS","EDE","ERF","FRA","HAJ","HAM",
            "LEJ","MUC","NUE","PAD","SCN","STR","XDE","XLE"],
    // France -> EUR
    EUR_France:["BOD","BVA","CDG","ETZ","LIL","LYS","MRS","NTE","ORY","SXB","TLS","XFR"],
    // Italy -> EUR
    EUR_Italy:["AOI","BGY","BLQ","FCO","LIN","MXP","PSR","TRN","VCE","XIT"],
    // Spain -> EUR
    EUR_Spain:["BCN","BIO","MAD","OVD","RMU","SVQ","VLC","ZAZ","XES"],
    // Poland -> EUR
    EUR_Poland:["GDN","KTW","LCJ","POZ","SZZ","WAW","WRO","XPL"],
    // Czechia -> EUR
    EUR_Czechia:["BRQ","PRG"],
    // Slovakia -> EUR
    EUR_Slovakia:["BTS"],
    // Ireland -> EUR
    EUR_Ireland:["DUB","ORK","SNN"],
    // Netherlands -> EUR
    EUR_Netherlands:["AMS","EIN","RTM"],
    // Belgium -> EUR
    EUR_Belgium:["BRU","LGG"],
    // Austria -> EUR
    EUR_Austria:["VIE","LNZ"],
    // Sweden -> EUR
    EUR_Sweden:["ARN","GOT"],
    // Portugal -> EUR
    EUR_Portugal:["LIS","OPO"]
};
// 4-letter codes that must be matched in full BEFORE any 3-letter prefix fallback.
var CODE4={
    GBP:[],
    EUR:["XIBA","XITF"]
};
/* UNSURE - please confirm. These X-codes could not be confirmed UK-vs-EU from sample
   data (fmc pull.txt) or the reference scripts (groot-final/groot-inspector), and are
   NOT general-knowledge airport/city codes either. They are deliberately placed in
   NEITHER GBP nor EUR: gCur() returns null for them so the live node API is the only
   source of truth; if the API also fails, the dropdown is left unchanged and
   console.warn('[Groot] unknown origin', laneText) fires. Do NOT add these to GBP
   or EUR without confirming the real country first. */
var UNSURE=["XOR","XCD","XBH","XAR","XWR","XOS","XMP","XDT","XPO"];
/* X+COUNTRY RULE (user-confirmed real lane format: every node is exactly 4 chars,
   either 3 letters + 1 digit like "STR4"/"LTN4", or 4 letters like "XDEQ"). For a
   4-letter X-code, letters 2-3 ARE the ISO country code: "XDEQ" = X + DE + Q -> EUR.
   This rule applies ONLY when the code is not already a CODE4/UNSURE explicit entry
   (those win first - see classification order in gCur). City-style X-codes with a
   trailing digit, e.g. "XLE1" (X + 2 letters + digit), are NOT X+country codes - they
   stay on the table/UNSURE path, same as any 3-letter-prefix code. */
var XCOUNTRY_GB=/^X(UK|GB)[A-Z]$/;
var XCOUNTRY_EU=/^X(DE|FR|IT|ES|PL|CZ|SK|NL|BE|AT|IE|SE|PT|DK|HU|RO|LU)[A-Z]$/;
var GB={},EU={};
Object.keys(CUR_TABLE).forEach(function(grp){
    var isGB=grp==="GBP";
    CUR_TABLE[grp].forEach(function(code){(isGB?GB:EU)[code]=1;});
});
CODE4.GBP.forEach(function(code){GB[code]=1;});
CODE4.EUR.forEach(function(code){EU[code]=1;});

var ST={reason:"1",carrier:"",lane:"",sdtH:null,origin:""};
var PANEL_RESIZE_HANDLER=null; // the CURRENT panel instance's own window "resize" handler (see buildPanel) - removed+replaced on every refreshPanel() call so it never leaks
var NS=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;
var LAST_ROUTE="";
/* ═══ GENERATION TOKEN (16.0.1) ═══
   ONE counter for every explicit user action that can apply something: Go, Paste, Fill
   and Clear each call startGen() to get a fresh token BEFORE doing any work. Every
   delayed step (setTimeout/setInterval) captures the token it was scheduled under and
   is a no-op if GEN has since moved on - so a newer action always supersedes an older
   one's still-pending work, and nothing stale ever gets written. startGen() also clears
   every timer/interval the previous action had pending, so an abandoned action can never
   fire again later. SUBMITTED_GEN remembers which generation(s) already got an auto
   submit-for-validation click, so a slow/duplicate check can never click twice for the
   same paste. */
var GEN=0;
var PENDING_TIMERS=[];
var SUBMITTED_GEN=null;
function startGen(){
    PENDING_TIMERS.forEach(function(id){clearTimeout(id);clearInterval(id);});
    PENDING_TIMERS=[];
    GEN++;
    return GEN;
}
function genTimeout(tok,fn,ms){
    var id=setTimeout(function(){if(tok!==GEN)return;fn();},ms);
    PENDING_TIMERS.push(id);
    return id;
}

/* ═══ MASTER ON/OFF SWITCH (16.0.2 item 3) ═══
   The user's words (translated): "I also want a turn off and turn on option for this
   panel. When I turn it off it must be off; when I turn it on it must work as it is."
   OFF is a real inert state, not just a hidden panel: every entry point that could
   touch FMC checks ENABLED first, so while off the script writes no field, shows no Go
   button, ignores the Route field, ignores a paste into the box, ignores Ctrl+G, runs
   no re-apply / stops poll / carrier commit, and marks nothing manual. FMC is left
   exactly as it is - nothing is cleared and nothing is reverted; the script simply
   stops acting.
   WHY GATED, NOT DETACHED: the intervals and window-level listeners are created ONCE at
   init. Gating their bodies keeps interval/listener counts flat across any number of
   off/on cycles (the duplicate-#grt / duplicate-Go-button / leaking-interval class of
   bug this file has already been bitten by twice), and makes ON provably identical to
   today's build, because nothing was ever torn down to rebuild wrongly. The one thing
   that IS re-done on turn-on is the Route-field listener attach, so the Go button
   starts tracking again immediately instead of on the next 2 s tick.
   The window state machine (minimize/maximize/restore/close + its own persistence) is
   a SEPARATE dimension and is untouched: a panel can be open and off, or minimized and
   on, and the launcher pill still reopens a closed panel in whatever on/off state it
   was left in. */
var ENABLED=true;
function lsGetRaw(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function lsSetRaw(k,v){try{localStorage.setItem(k,v);}catch(e){}}
// Default ON for a missing, unreadable or unrecognised key, so a first install and a
// teammate's fresh copy always get the working script. ONLY the exact string "0" is off.
ENABLED=(lsGetRaw("winkiro.enabled")!=="0");
var ATTACH_ROUTE_EVENTS=null;   // set by startRouteWatcher - re-run on turn-on
function offToast(){toast("\u26A0 Script is off",1);}
function setEnabled(on){
    on=!!on;
    var changed=(on!==ENABLED);
    ENABLED=on;
    lsSetRaw("winkiro.enabled",on?"1":"0");
    if(!on){
        // Cancel every pending delayed step (startGen's own sweep) and drop everything
        // that could be replayed later. No FMC field is written or cleared here.
        startGen();
        wantClear();
        clearAllManual();
        REASON_WANTED=null;REASON_APPLIED_TO=null;
        if(GO_BTN)GO_BTN.style.display="none";
    }else{
        if(ATTACH_ROUTE_EVENTS)try{ATTACH_ROUTE_EVENTS();}catch(e){}
        try{updateGoButton();}catch(e2){}
    }
    applyEnabledUI();
    if(changed)toast(on?"Script on":"Script off");
}
/* Visible state, for a user with no console: the power glyph's own colour (driven by
   aria-pressed in the one stylesheet block), a dimmed panel body, and a red panel
   border. No new text row, no layout or width change. */
function applyEnabledUI(){
    var w=document.getElementById("grt");
    var ct=document.getElementById("grt-content");
    var pb=document.getElementById("grt-power");
    if(pb){
        pb.setAttribute("aria-pressed",ENABLED?"true":"false");
        var lab=ENABLED?"Turn the script off":"Turn the script on";
        pb.setAttribute("aria-label",lab);pb.title=lab;
    }
    if(ct)ct.style.opacity=ENABLED?"":"0.55";
    if(w)w.style.borderColor=ENABLED?"#3a316b":"#c42b1c";
}

/* ═══ ONE MANUAL-EDIT REGISTRY + ONE WRITER GUARD (16.0.2 item 1a) ═══
   "Any value I set by hand must still be there when I press Submit." This replaces the
   THREE parallel mechanisms the previous builds grew - MANUAL_SHIPPER/WRITING_SHIPPER
   for the shipper account, MANUAL_REASON/WRITING_REASON for Create reason, and
   isOperatorTypeSelect()'s always-manual refusal - with ONE registry, ONE guard flag,
   ONE capture-phase listener pair and ONE jQuery Select2 binding, covering EVERY
   Manual Scheduling control this script can write (see the investigation table in
   report.md): Shipper Account, Carrier, Cost, Currency, Stop 1/2 location, Arrival /
   Departure / Critical departure / Arrival 2, Load type, Unload type, Freight type,
   Equipment type, Create Reason and Vehicle name.
   MANUAL is a WeakSet keyed on the ELEMENT, so a new load's brand-new controls start
   clean with nothing to reset - which is exactly what "theirs for that load" means.
   WRITING is a nesting COUNTER (not a boolean) around the script's own writes: a guarded
   write can call another guarded writer (nudgeFormRerender -> the shipper commit, the
   re-apply -> setSelect2), and a boolean would be cleared by the inner finally while the
   outer write was still running, which would let the outer write's own change event mark
   its own field manual and permanently block every later auto-fill for that load.
   Detection never relies on event.isTrusted (the headless harness cannot produce trusted
   events, and a real page can dispatch an untrusted change too): ANY change/input on a
   guarded control while WRITING is zero is a manual edit.
   OPERATOR TYPE stays on its own dedicated refusal (isOperatorTypeSelect) rather than
   being folded in here, because it is "always manual" - the script must never write it
   even on a load where the user has not touched it yet, so a mark-on-edit registry is
   the wrong tool for it.
   ROUTE is deliberately NOT guarded. FMC's own code settles it: the Route input has no
   `name` attribute, so EditableView._onInputChange ignores it entirely and it is never a
   model field; RouteSummaryView binds {"change #route":"_handleRouteChange"}, parses the
   text into stop models and then re-derives the input's text from the stops on every
   render. It is a COMMAND, not a value - and marking it manual would break the normal
   workflow (type a lane, then paste the block for it). */
var MANUAL=(typeof WeakSet!=="undefined")?new WeakSet():null;
var WRITING=0;
function beginWrite(){WRITING++;}
function endWrite(){if(WRITING>0)WRITING--;}
/* THE MARK HAS TO SURVIVE FMC REPLACING THE CONTROL.
   An element-keyed WeakSet alone is not enough, and that was a real hole: the user's own
   pick is committed through jQuery/Select2, so it DOES reach FMC's model; FMC then
   re-renders (the auto "Submit for validation" is enough on its own) and restores their
   value into a BRAND NEW element - which carries no mark, so the next Go or equipment
   click overwrote the value they had set by hand. Caught by this round's persist suite on
   Currency and Cost before the build shipped.
   So the mark is kept twice over, and both halves are needed:
     - MANUAL, the WeakSet on the element: covers a control with no name attribute, and
       dies with the element at no cost;
     - MANUAL_KEYS, keyed on the control's IDENTITY (its FMC name attribute plus which
       stop block it sits in) and STAMPED WITH THE MODAL INSTANCE it was marked in: this
       is what carries across a re-render, and the modal stamp is what makes a NEW LOAD
       start clean - a different dialog instance ignores every key mark, exactly like the
       brand-new-element rule it replaces.
   MANUAL_KEY_COUNT keeps isManual() cheap: with nothing marked by hand - the normal
   case, every load - it costs one integer test and the WeakSet lookup, no DOM walk. */
var MANUAL_KEYS={};
var MANUAL_KEY_COUNT=0;
function controlKey(el){
    if(!el||!el.name)return null;
    var idx="",stop=el.closest?el.closest(".manual-scheduling-stop"):null;
    if(stop){var all=document.querySelectorAll(".manual-scheduling-stop");idx=Array.prototype.indexOf.call(all,stop);}
    return el.name+"@"+idx;
}
function isManual(el){
    if(!el)return false;
    if(MANUAL&&MANUAL.has(el))return true;
    if(!MANUAL_KEY_COUNT)return false;
    var k=controlKey(el);
    return!!(k&&MANUAL_KEYS[k]&&MANUAL_KEYS[k]===findModal());
}
function dropManual(el){
    if(el&&MANUAL&&MANUAL.delete)MANUAL.delete(el);
    var k=controlKey(el);
    if(k&&MANUAL_KEYS[k]){delete MANUAL_KEYS[k];MANUAL_KEY_COUNT--;}
}
/* Used only by the user's OWN explicit resets (Ctrl+G, and switching the script off) -
   never by automatic work. */
function clearAllManual(){
    MANUAL=(typeof WeakSet!=="undefined")?new WeakSet():null;
    MANUAL_KEYS={};MANUAL_KEY_COUNT=0;
}
/* THE SECOND HALF OF THE WRITER GUARD, for a write whose change event cannot be inside
   the synchronous WRITING window. setDT() is the case that forces this: WHAT it writes is
   FROZEN by the user's own confirmation that the timings are correct, and its write fires
   from its own internal 50 ms setTimeout, after any caller's try/finally has unwound. The
   first version of item 1 wrapped only the synchronous writers, and every paste then
   marked its OWN four timing fields, its stop locations and its carrier manual - so the
   SECOND paste of a session refused to write anything (caught by ctrlg-live L1/L4 before
   this build shipped).
   EXPECT records, per element, the exact value the script intends that element to hold.
   A change/input whose resulting value IS that value is the script's own write and never
   marks the field manual; anything else - a different value, or a hand-clear to empty -
   is a manual edit. The expectation is deliberately NOT consumed on first match, because
   one setDT write fires input, change and keydown on the same field; it simply stays
   until the next intended write for that element replaces it (a WeakMap, so it dies with
   the element). The failure mode is narrow and benign in the only direction it can go:
   a user who types EXACTLY the value the script just wrote is not detected as manual -
   and the field already holds what they typed. */
var EXPECT=(typeof WeakMap!=="undefined")?new WeakMap():null;
function expectWrite(el,val){if(el&&EXPECT)EXPECT.set(el,String(val===null||val===undefined?"":val));}
function isOwnWrite(el){
    if(!el||!EXPECT||!EXPECT.has(el))return false;
    var exp=EXPECT.get(el),v=String(el.value===null||el.value===undefined?"":el.value);
    return v===exp||normFT(v)===normFT(exp);
}
/* Every control FMC gives a name attribute to is guarded by that name wherever it sits
   (FMC's search panel can render a same-named select of its own, which is why a
   MULTIPLE select is always rejected - the shipperAccounts filter is a multi-select).
   Anything else is guarded only inside the open load modal. */
var GUARD_NAMES={shipperAccount:1,createReason:1,carrier:1,currency:1,cost:1,subCarrier:1,
    loadType:1,unloadType:1,freightType:1,equipmentType:1,nodeName:1,vehicleName:1,
    arrivalTime:1,departureTime:1,criticalDepartureTime:1};
function isGuardedField(el){
    if(!el||!el.tagName)return false;
    var tag=el.tagName;
    if(tag!=="SELECT"&&tag!=="INPUT")return false;
    if(el.closest&&el.closest("#grt"))return false;      // this script's own panel
    if(el.id==="route")return false;                     // a command, not a value - see above
    if(tag==="SELECT"&&el.multiple)return false;          // FMC's own multi-select filters
    if(tag==="INPUT"&&(el.type==="hidden"||el.type==="radio"||el.type==="checkbox"))return false;
    if(el.name&&GUARD_NAMES[el.name])return true;
    var modal=findModal();
    return!!(modal&&modal.contains&&modal.contains(el));
}
/* THE one marker. Cheap first gates (tag/#grt/name) before any modal lookup, so a
   change on an unrelated control of any size stays cheap. */
function markManual(el){
    if(!ENABLED)return;
    if(WRITING>0)return;                  // the script's own synchronous write
    if(!MANUAL||!isGuardedField(el))return;
    if(isOwnWrite(el))return;             // the script's own deferred write (setDT)
    MANUAL.add(el);
    var mk=controlKey(el);
    if(mk&&!MANUAL_KEYS[mk])MANUAL_KEY_COUNT++;
    if(mk)MANUAL_KEYS[mk]=findModal();
    // A hand edit also cancels any pending re-apply for that control: the user's value
    // wins from here on, including an edit made AFTER a paste or a Go (see wantPoll).
    wantDropByElement(el);
}
document.addEventListener("change",function(e){markManual(e.target);},true);
document.addEventListener("input",function(e){markManual(e.target);},true);
/* Select2 4.0.0 commits a pick through jQuery's trigger("change"), which never
   dispatches a DOM event, so the two native listeners above can never see it. ONE
   binding through the page's OWN jQuery (the same instance the carrier engine uses)
   covers all of it: "select2:select"/"select2:unselect" for a pick made in the Select2
   dropdown UI, plus jQuery's own "change" for a pick delivered as
   .val(x).trigger("change") - which is how FMC/Select2 commit internally, and which
   Select2 never relays as select2:select. It reuses the SAME WRITING guard, so the
   script's own commits are excluded exactly as they are natively. */
var MANUAL_JQ_BOUND=false;
function bindManualJQuery(){
    if(MANUAL_JQ_BOUND)return;
    var jq=fmcPageJQuery();
    if(!jq)return;
    jq(document).on("select2:select select2:unselect change","select,input",function(e){markManual(e.target);});
    MANUAL_JQ_BOUND=true;
}

/* ═══ ONE RE-APPLY REGISTRY (16.0.2 item 1b) ═══
   "A value the panel put in must still be there at Submit." FMC rebuilds its views from
   its OWN model and throws the DOM away (report.md's investigation table): the Select2
   renderer re-initialises each select and then calls select2("val", model.get(prop)),
   and a stop block is re-templated from model.toJSON() with the datetimepicker
   re-deriving its text from data-epoch-millis. So a value that reached FMC's model
   survives a re-render and a DOM-only value silently does not - which is exactly the
   Create Reason bug: the pick survived "Submit for validation" and was gone by the
   final "Submit".
   This generalises what applyReason()/reasonPoll() proved for that one control to every
   control: remember the value that was WANTED per control, detect that FMC replaced or
   blanked the control, re-commit through the correct path for that control's type, and
   stop as soon as the value is confirmed present.
   BOUNDED, never a fight: at most WANT_MAX commit attempts and WANT_MAX resolve misses
   per control per load, then ONE warning toast naming the field and it gives up. A hand
   edit on the control removes its entry outright - the user always wins over a pending
   re-apply. Driven by the EXISTING 600 ms route-watcher interval, so no new timer. */
var WANT={};
var WANT_MAX=12;
var DATE_KINDS={arr1:1,dep1:1,crit:1,arr2:1};
function wantClear(){WANT={};}
function wantDrop(key){delete WANT[key];}
function wantDropByElement(el){
    Object.keys(WANT).forEach(function(k){if(WANT[k].el===el)wantDrop(k);});
    // The element may be the CURRENT resolve target without having been applied to yet
    // (a re-apply scheduled for a replacement control the user then edited first).
    Object.keys(WANT).forEach(function(k){if(wantResolve(WANT[k])===el)wantDrop(k);});
}
/* Register (or update) what a control should hold. Called by the writers themselves, so
   the registry can only ever contain values the script really applied. A different value
   for the same control resets its budget - that is a new explicit intent, not a retry. */
function wantSet(key,label,val,opts){
    if(!ENABLED)return;
    if(val===null||val===undefined||String(val)==="")return;
    var e=WANT[key];
    if(!e){e=WANT[key]={key:key,label:label};}
    if(e.val!==val){e.el=null;e.tries=0;e.misses=0;e.warned=false;}
    e.val=val;e.label=label;
    // MODAL IDENTITY, the same rule resolveTimingTarget() already uses for a deferred
    // timing write: remember WHICH modal instance this value was meant for. A re-render
    // rebuilds the views INSIDE the dialog and the dialog element survives, so the value
    // is still wanted; a different modal instance means FMC closed and reopened the
    // dialog - a DIFFERENT LOAD - and re-applying there would write the previous load's
    // values into a brand-new form. That is the one thing a re-apply must never do.
    e.modal=findModal();
    // GENERATION, the same token every other delayed step in this file carries. The
    // registry's job is surviving an FMC RE-RENDER, never finishing a paste the user has
    // already superseded: once a newer explicit action (another paste, Go, Clear, Ctrl+G)
    // has started, an older generation's entries stop being re-applied and are dropped.
    // Without this, a re-apply tick landing between a new paste's startGen() and that
    // paste's own writes re-commits the PREVIOUS paste's values - a genuine stale write,
    // and exactly what the stress suite's A1 scenario caught before this build shipped.
    e.gen=GEN;
    if(opts){Object.keys(opts).forEach(function(o){e[o]=opts[o];});}
    if(e.tries===undefined){e.tries=0;e.misses=0;e.warned=false;}
}
/* True when the form this value was meant for is gone (a different modal instance), so
   the entry must be abandoned rather than re-applied. The ONE shared rule - see
   staleModal(), which resolveTimingTarget and every deferred writer on the paste / Go
   path now use as well. */
function wantStaleModal(e){return staleModal(e.modal);}
/* Resolve a control's LIVE element, every time, through the same finders the writers
   use - never a reference captured earlier, which FMC's re-render would have detached. */
function wantResolve(e){
    if(DATE_KINDS[e.key])return findTI()[e.key];
    switch(e.key){
        case "shipper": return findShipperSelect();
        case "reason":  return findReasonSelect();
        case "carrier": var root=findModal();return root?findField(root,["select[name=carrier]","[name=carrier]"]):null;
        case "currency":return findCurrencySelect();
        case "cost":    return findCostInput();
        case "stop1":   return findStopField(1);
        case "stop2":   return findStopField(2);
        case "vname":   return findVehicleNameInput();
        default:        return e.pat?resolveSelByLabel(e.nameAttr,e.pat,e.skip):null;
    }
}
/* Does the live control REALLY hold the wanted value right now? Same comparison each
   control's own verified toast uses, so the registry and the toasts can never disagree. */
function wantHolds(e,el){
    if(!el||!el.isConnected)return false;
    if(DATE_KINDS[e.key])return timingLanded(el,e.val);
    if(e.key==="stop1"||e.key==="stop2")return stopHolds(el,e.val);
    if(el.tagName==="SELECT"){
        var o=el.options[el.selectedIndex];
        if(!o)return false;
        return normFT(o.value)===normFT(e.val)||normFT(o.text)===normFT(e.val);
    }
    return String(el.value||"").trim()===String(e.val).trim();
}
/* Re-commit through the RIGHT path for that control's type - a Select2-backed select
   must go through setSelect2's jQuery commit (a bare native .value set never reaches
   FMC's model), a stop location through setFieldVal's option-injection path (the real
   control is AJAX-backed with zero static options), a timing field through setDT's
   focus/click/type/blur chain (the datetimepicker is lazily initialised on first click).
   Always inside the WRITING guard, so a re-apply can never mark its own field manual. */
function wantCommit(e,el){
    beginWrite();
    try{
        if(DATE_KINDS[e.key]){expectWrite(el,e.val);setDT(el,e.val);return true;}
        if(e.key==="stop1"||e.key==="stop2")return setFieldVal(el,e.val);
        if(el.tagName==="SELECT")return setSelect2(el,e.val,e.allowCreate===true);
        NS.call(el,e.val);
        el.dispatchEvent(new Event("input",{bubbles:true}));
        el.dispatchEvent(new Event("change",{bubbles:true}));
        rFire(el);
        return true;
    }catch(err){return false;}
    finally{endWrite();}
}
function wantPoll(){
    if(!ENABLED)return;
    Object.keys(WANT).forEach(function(k){
        var e=WANT[k];
        if(e.gen!==GEN){wantDrop(k);return;}         // superseded by a newer user action
        if(wantStaleModal(e)){wantDrop(k);return;}   // a different load's form - never re-apply here
        var el=wantResolve(e);
        if(!el){
            e.misses=(e.misses||0)+1;
            if(e.misses>WANT_MAX&&!e.warned){e.warned=true;toast("\u26A0 "+e.label+" could not be restored",1);}
            return;
        }
        if(isManual(el)){wantDrop(k);return;}        // the user's own value - theirs, full stop
        if(wantHolds(e,el)){e.el=el;return;}         // present (ours, or FMC restored it from its model) - done
        if(e.tries>=WANT_MAX){
            if(!e.warned){e.warned=true;toast("\u26A0 "+e.label+" could not be restored",1);}
            return;
        }
        e.tries++;
        if(wantCommit(e,el))e.el=el;
    });
}

/* ═══ UTILS ═══ */
function rFire(el){try{var k=Object.keys(el).find(function(k){return k.startsWith("__reactProps");});if(k&&el[k].onChange)el[k].onChange({target:el});}catch(e){}}
/* A warning toast (w truthy) must stay visible for >=3.5s even if a success toast fires
   right after it - so a success toast never removes/replaces a still-live warning; it
   stacks a second element above it instead. Each toast tracks its own expiry time and
   only removes ITSELF once that time has passed (never removes another toast early). */
var TOAST_SEQ=0;
function toast(m,w){
    var mySeq=++TOAST_SEQ;
    var life=w?3800:8000;
    var expiresAt=Date.now()+life;
    var liveWarn=document.querySelector('#grt-toast[data-warn="1"]');
    var stackAbove=(!w&&liveWarn&&+liveWarn.getAttribute("data-expires")>Date.now());
    if(!stackAbove){
        document.querySelectorAll("#grt-toast").forEach(function(o){
            if(+o.getAttribute("data-expires")<=Date.now())o.remove();
        });
    }
    var t=document.createElement("div");t.id="grt-toast";t.textContent=m;
    t.setAttribute("data-warn",w?"1":"0");t.setAttribute("data-expires",String(expiresAt));t.setAttribute("data-seq",String(mySeq));
    var bottom=stackAbove?70:22;
    t.style="position:fixed;bottom:"+bottom+"px;left:22px;z-index:999999;padding:11px 20px;border-radius:9px;font:600 11px/1.3 Arial;color:#fff;box-shadow:0 6px 22px rgba(0,0,0,.4);max-width:80vw;word-break:break-all;background:"+(w?"#e67e22":"#2d5a27");
    document.body.appendChild(t);
    setTimeout(function(){if(t.isConnected)t.remove();},life);
}
function uStat(msg){console.log("[Rohit] "+msg);}
/* Offline fallback classifier ONLY (the API in resolveCurrencyFromAmazon is always
   consulted first by the caller - this is step (b)-(e) of the classification order).
   Classifies on the ORIGIN node only - caller passes just the origin code, never the
   whole lane string, so this never substring-searches a lane. Real nodes are exactly
   4 chars: 3 letters + 1 digit ("STR4") or 4 letters ("XDEQ"); trim/uppercase/strip any
   stray non-alphanumeric first so whitespace/case variants still match, then validate
   the shape - anything that doesn't match is unknown (returns null) rather than guessed.
   Classification order after the API (handled by the caller):
     (b) explicit full 4-char entry in CODE4/UNSURE - always checked first, wins over (c)
     (c) X+country rule for 4-letter X-codes (XDEQ -> DE -> EUR; XUKA -> UK -> GBP)
     (d) 3-letter prefix for letter+digit codes (STR4 -> STR -> EUR)
     (e) unknown -> null (caller warns + leaves dropdown unchanged) */
function gCur(o){
    if(!o)return null;
    var p=o.toUpperCase().replace(/[^A-Z0-9]/g,"");
    if(!/^[A-Z]{3}\d$|^[A-Z]{4}$/.test(p))return null;
    // (b) explicit 4-char table entry wins over the X+country rule.
    if(UNSURE.indexOf(p)!==-1)return null;
    if(GB[p]||EU[p])return GB[p]?"GBP":"EUR";
    // (c) X+country rule - only for 4-letter codes starting with X (not letter+digit).
    if(/^[A-Z]{4}$/.test(p)&&p.charAt(0)==="X"){
        if(XCOUNTRY_GB.test(p))return"GBP";
        if(XCOUNTRY_EU.test(p))return"EUR";
    }
    // (d) 3-letter prefix fallback for letter+digit codes (and as a last resort for
    // 4-letter codes not covered by (b) or (c)).
    var p3=p.slice(0,3);
    if(UNSURE.indexOf(p3)!==-1)return null;
    if(GB[p3])return"GBP";
    if(EU[p3])return"EUR";
    return null;
}

/* ═══ SHIVA-PROVEN CARRIER ENGINE (page jQuery Select2) ═══ */
function fmcPageJQuery(){try{var page=(typeof unsafeWindow!=="undefined")?unsafeWindow:window;return page&&page.jQuery?page.jQuery:null;}catch(e){return null;}}
function normFT(v){return String(v==null?"":v).replace(/\s+/g," ").replace(/:\s*$/,"").trim().toLowerCase();}
var MODAL_SELECTOR="dialog[open],[role=dialog],.ui-dialog,.a-modal,.a-modal-scroller,.a-popover-wrapper,.ReactModal__Content,.modal-dialog";
function findModal(){
    var stop=document.querySelector(".manual-scheduling-stop");
    if(stop&&stop.closest){var owner=stop.closest(MODAL_SELECTOR);if(owner)return owner;}
    var modals=document.querySelectorAll(MODAL_SELECTOR);
    for(var i=0;i<modals.length;i++){var modal=modals[i];if(modal.id==="grt")continue;
        if(modal.querySelector&&(modal.querySelector(".manual-scheduling-stop")||modal.querySelector("select[name=carrier],select[name=shipperAccount]")))return modal;}
    if(stop)return stop.parentElement||document;
    if(document.querySelector("select[name=carrier],select[name=shipperAccount]"))return document;
    return null;
}
/* ═══ THE MODAL-IDENTITY RULE, IN ONE PLACE ═══
   resolveTimingTarget() (timings) and wantStaleModal() (the re-apply registry) already
   refuse to write when findModal() returns a DIFFERENT element than the one their action
   resolved at schedule time. Every OTHER deferred write on the paste / Go path now shares
   this one function, so "the form this write was meant for is gone" has a single
   definition.
   WHY THE GENERATION TOKEN IS NOT ENOUGH, and this is the whole point: a token only
   supersedes an older action once a NEWER one has started. If FMC rebuilds the dialog (a
   different load) and the user has not pasted again yet, there is no newer generation -
   so an older load's still-pending poll or re-apply happily writes the PREVIOUS load's
   values into the brand-new form. That is exactly what stress CONT2 catches: 30 pastes
   with the modal rebuilt between them produced stale writes on the stop locations and
   the currency, and never on the timings, because only the timing path had this rule.
   Decisive only when an identity WAS recorded and a modal resolves now: a caller that
   passes nothing keeps its previous behavior, and a transient "no modal resolves" moment
   mid-re-render is not mistaken for a different load - the writers' own isConnected /
   re-resolve guards cover that case. */
function staleModal(m0){return !!(m0&&findModal()!==m0);}
function usableCtrl(el){return !!(el&&el.isConnected&&!el.disabled&&!(el.closest&&el.closest("#grt")));}
function findField(root,selectors){var owner=root||document;if(!owner.querySelectorAll)return null;
    for(var i=0;i<selectors.length;i++){var ms;try{ms=owner.querySelectorAll(selectors[i]);}catch(e){ms=[];}
        for(var m=0;m<ms.length;m++)if(usableCtrl(ms[m]))return ms[m];}return null;}
/* myToken is OPTIONAL (most callers - manual shipper, create reason, Ctrl+G's clear -
   are either not part of the paste pipeline at all or already re-check manual state
   themselves right at write time). When a caller DOES pass myToken (the paste
   pipeline's carrier commit - see fillCarrier), the commit is skipped if a newer
   generation has already superseded it: the real root cause of the stale-carrier-
   write regression hit during the (reverted) speed attempt was that this jQuery
   commit had NO generation check at all, so an older paste's carrier write could
   still land after a newer paste's startGen() had already moved on. */
function setSelect2(select,desired,allowCreate,myToken){
    if(!select||select.tagName!=="SELECT")return false;
    if(myToken!==undefined&&myToken!==GEN)return false;
    // ONE manual gate for every Select2-backed control this function commits (carrier,
    // create reason, the generic clear path): a value the user set by hand is theirs for
    // that load and nothing the script does may overwrite it (item 1a). The explicit
    // reset paths - Ctrl+G and the panel's Clear - drop the mark first, so an explicit
    // user action still clears what the user themselves asked to clear.
    if(isManual(select))return false;
    var wanted=normFT(desired),option=null;
    for(var i=0;i<select.options.length;i++){var opt=select.options[i];
        if(normFT(opt.textContent)===wanted||normFT(opt.value)===wanted){option=opt;break;}}
    if(!option&&allowCreate){option=new Option(desired,desired,true,true);select.add(option);}
    if(!option)return false;
    // The whole commit is synchronous, so the ONE writer guard covers every event it
    // fires - without it this function's own change event would mark carrier / create
    // reason / the cleared selects manual and block every later auto-fill for that load.
    beginWrite();
    expectWrite(select,option.value);
    try{var jq=fmcPageJQuery();
        if(myToken!==undefined&&myToken!==GEN)return false; // re-check right before the commit too - option lookup/creation above never yields, but stay consistent with every other token-gated writer in this file
        if(jq){var f=jq(select);f.val(option.value);f.trigger("change");f.trigger("input");f.trigger("blur");}
        else{var setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,"value");if(setter&&setter.set)setter.set.call(select,option.value);else select.value=option.value;option.selected=true;select.dispatchEvent(new Event("input",{bubbles:true}));select.dispatchEvent(new Event("change",{bubbles:true}));select.dispatchEvent(new Event("blur",{bubbles:true}));}
        try{var rendered=null;if(select.id)rendered=document.getElementById("select2-"+select.id+"-container");if(!rendered&&select.closest){var s2=select.closest(".select2");if(s2)rendered=s2.querySelector(".select2-selection__rendered");}if(!rendered&&select.parentElement)rendered=select.parentElement.querySelector(".select2-selection__rendered");if(rendered){var lab=option.textContent||option.value;rendered.textContent=lab;rendered.setAttribute("title",lab);}}catch(e){}
        return normFT(select.value)===normFT(option.value);
    }catch(e){return false;}
    finally{endWrite();}
}

/* ═══ FIND FMC ROUTE INPUT FIELD ═══ */
function findRouteInput(){
    var inps=document.querySelectorAll("input");
    for(var i=0;i<inps.length;i++){var inp=inps[i];
        if(inp.closest&&inp.closest("#grt"))continue;
        if(inp.type==="hidden"||inp.type==="radio"||inp.type==="checkbox")continue;
        var par=inp;
        for(var d=0;d<5;d++){par=par.parentElement;if(!par)break;
            var ft=par.textContent.trim().split("\n")[0].trim();
            if(/^route$/i.test(ft)||/^route\s*\*/i.test(ft)){return inp;}}}
    return null;
}

/* ═══ MODAL IDENTITY + RE-RENDER RECOVERY (16.0.2: "after Ctrl+G a bare Ctrl+V fills
   nothing") ═══
   ROOT CAUSE, confirmed against the SAVED REAL PAGE (Downloads/FMC_files, the
   manual-scheduling view bundle), not just the mock:
     - every Manual Scheduling control lives in a Backbone view whose base events are
       {"change input":"_onInputChange","change select":"_onInputChange"}, so ANY
       change event on a field writes FMC's own model (which is why every clear in this
       file deliberately fires input/change - the model must really clear);
     - RouteSummaryView binds {"change #route":"_handleRouteChange"}, and that handler
       REBUILDS THE STOPS COLLECTION from the Route text (it add()s/remove()s Stop
       models to match the node codes it parses);
     - StopsView re-renders on that collection's add/remove/reset by emptying its
       container and re-appending freshly rendered stop blocks
       (template-manual-scheduling-stop2), and closes the views it no longer needs.
   So clearing the Route DESTROYS the stop blocks that hold the arrival/departure/
   critical inputs and the stop-location selects, and every element reference captured
   before that moment is detached. Two consequences are fixed here:
   (1) a DEFERRED write must never trust a node it captured earlier -
       resolveTimingTarget() re-resolves a target when the modal instance the action
       started against has been replaced, or when the captured node went detached, so
       a write can never land in a node that is no longer in the form (which is how a
       fill could report success while the live form stayed empty);
   (2) when the form's structure is missing ENTIRELY, nudgeFormRerender() re-commits
       the CURRENT value of a surviving model-bound Select2 control (shipper, else
       carrier) exactly once per generation: the value does not change (FMC's
       model.set with an identical value is a no-op, and a hand-picked shipper is
       re-committed as-is, so nothing the user chose is touched), but the change event
       asks FMC's view to re-render - the only way to get a collapsed Route-summary /
       stop block back without the page reload the user rejected twice. */
function nodeUsable(el){return !!(el&&el.isConnected&&!el.disabled);}
/* Re-resolve one timing slot ("arr1"/"dep1"/"crit"/"arr2") at WRITE time, with the
   MODAL IDENTITY rule:
     - a DIFFERENT modal instance than the one this action started against means the
       form this write was meant for is gone (FMC closed/rebuilt the whole modal, i.e.
       another load) - BAIL. Writing the old load's value into the new modal is exactly
       the stale write the stress suite's CONT/CONT2 scenarios look for, and a plain
       token check cannot catch it: if the user's next paste never reached the box, no
       newer generation exists to supersede this one.
     - the SAME modal instance with a detached/replaced field means FMC re-rendered
       part of THIS load's form (the stop block the Route change rebuilds) - re-resolve
       and write the live node, which is what makes a paste right after Ctrl+G land. */
function resolveTimingTarget(slot,el,modalAtStart){
    if(modalAtStart&&findModal()!==modalAtStart)return null;
    if(nodeUsable(el))return el;
    var fresh=findTI()[slot];
    return nodeUsable(fresh)?fresh:null;
}
/* A timing field counts as FILLED only when the live field is still attached AND holds
   the value THIS generation wrote. Presence-only ("not empty") was the remaining hole
   in the toast audit: on the real widget a 12-hour source landed 12 hours early and a
   day-first source landed an instant FMC reads as a different month, and BOTH still
   reported a green "4/4 timings OK" because the box was not blank (reviewer's rv-dtp
   D8/D9). Three tiers, in order:
     1. exact string match - the normal case on the real widget and on every harness
        page (the real xdsoft field keeps exactly what was typed; confirmed D1/D5/D6);
     2. FMC's own parser reading the live value as the SAME INSTANT as the string we
        wrote - covers a widget that re-formats what was typed (e.g. zero-pads it);
     3. anything else is NOT landed, so the caller warns and names the field.
   Verification that cannot be completed (value differs and no parser is available) is
   deliberately counted as NOT landed rather than falling through to green. The field's
   own fmcDatetimepicker("millis") is not used as the test: it returns an INSTANT built
   with moment-timezone from the field's data-timezone, and the expected side here is a
   wall clock, so comparing the two would need the same moment bridge FMC has and the
   script does not - a finite number on its own would only prove the widget parsed
   something, not that it parsed what we meant. */
function timingLanded(el,want){
    if(!el||!el.isConnected)return false;
    var v=String(el.value||"").trim();
    if(v==="")return false;
    if(want===undefined||want===null||want==="")return true;  // no expectation recorded (non-paste caller): presence is all there is to check
    var w=String(want).trim();
    if(v===w)return true;
    var a=fmcReads(v),b=fmcReads(w);
    return!!(a&&b&&a.getTime()===b.getTime());
}
/* The nudge budget is keyed per generation AND per retry loop ("route", "timings").
   It used to be one nudge per generation shared by both loops, so a form that needed a
   re-render for the Route and again for the stop block only ever got one. */
var NUDGED_GEN=null,NUDGED_KEYS={};
function nudgeFormRerender(myToken,why){
    var tok=(myToken===undefined)?GEN:myToken,key=why||"any";
    if(NUDGED_GEN!==tok){NUDGED_GEN=tok;NUDGED_KEYS={};}
    if(NUDGED_KEYS[key])return false;   // at most ONE nudge per retry loop per explicit user action
    NUDGED_KEYS[key]=true;
    var sel=findShipperSelect();
    if(!sel){var root=findModal();sel=root?findField(root,["select[name=carrier]","[name=carrier]"]):null;}
    if(!sel||!sel.isConnected)return false;
    beginWrite();   // the ONE writer guard, so this re-commit is never mistaken for a manual edit
    try{
        var jq=fmcPageJQuery();
        if(jq)jq(sel).val(sel.value).trigger("change"); // same value in, same value out - only the event matters
        else sel.dispatchEvent(new Event("change",{bubbles:true}));
    }catch(e){}
    finally{endWrite();}
    return true;
}

/* ═══ STOP 1 / STOP 2 LOCATION FILL ═══ */
/* Fully synchronous, so the ONE writer guard wraps the whole thing: this function's own
   change event must never be read back as the user editing the stop location. */
function setFieldVal(field,val){
    if(!field||!val)return false;
    if(isManual(field))return false;   // item 1a - the user's own stop location wins
    val=val.toUpperCase();
    beginWrite();
    try{
    if(field.tagName==="SELECT"){
        for(var i=0;i<field.options.length;i++){var ov=(field.options[i].value||"").toUpperCase(),ot=(field.options[i].text||"").toUpperCase();
            if(ov===val||ot===val||ov.indexOf(val)>=0||ot.indexOf(val)>=0){field.value=field.options[i].value;field.selectedIndex=i;expectWrite(field,field.value);field.dispatchEvent(new Event("change",{bubbles:true}));rFire(field);return true;}}
        var opt=document.createElement("option");opt.value=val;opt.text=val;opt.selected=true;field.appendChild(opt);field.value=val;field.selectedIndex=field.options.length-1;expectWrite(field,val);field.dispatchEvent(new Event("change",{bubbles:true}));rFire(field);return true;}
    if(field.tagName==="INPUT"){expectWrite(field,val);NS.call(field,val);field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}));rFire(field);return true;}
    return false;
    }finally{endWrite();}
}
function findStopField(stopNum){
    var allEls=document.querySelectorAll("label,span,div,b,strong,p,td,th");
    for(var i=0;i<allEls.length;i++){var el=allEls[i];if(el.closest&&el.closest("#grt"))continue;
        var txt=(el.textContent||"").trim();if(el.children.length>3)continue;
        var re=new RegExp("^stop\\s*"+stopNum+"\\b","i");
        if(!re.test(txt)||txt.length>30)continue;
        var par=el;
        for(var d=0;d<6;d++){par=par.parentElement;if(!par)break;
            var sels=par.querySelectorAll("select");
            for(var si=0;si<sels.length;si++){if(sels[si].closest&&sels[si].closest("#grt"))continue;var sp=sels[si];
                for(var pd=0;pd<4;pd++){sp=sp.parentElement;if(!sp)break;var pt=(sp.textContent||"").trim().substring(0,60).toLowerCase();
                    if((/location/i.test(pt)||re.test(sp.textContent.trim()))&&!/load\s*type|unload\s*type|arrival|departure|critical/i.test(pt)){return sels[si];}}}
            var inps=par.querySelectorAll("input:not([type=hidden]):not([type=radio]):not([type=checkbox])");
            for(var ii=0;ii<inps.length;ii++){if(inps[ii].closest&&inps[ii].closest("#grt"))continue;var ip=inps[ii];var ipp=ip;
                for(var ipd=0;ipd<4;ipd++){ipp=ipp.parentElement;if(!ipp)break;var ipt=(ipp.textContent||"").trim().substring(0,60).toLowerCase();
                    if((/location/i.test(ipt)||re.test(ipp.textContent.trim()))&&!/time|arrival|departure|critical|load\s*type|unload/i.test(ipt)){return ip;}}}
        }
    }
    return null;
}
/* Re-reads one stop field AFTER its write (16.0.2 toast audit): setFieldVal() returns
   true as soon as it has written, which on a re-rendering form can mean "written into
   a node FMC is about to replace". Accepts a value OR selected-option-text match,
   since setFieldVal itself matches options on either. */
function stopHolds(field,val){
    if(!field||!field.isConnected)return false;
    var want=String(val||"").toUpperCase();
    if(!want)return false;
    var v=String(field.value||"").toUpperCase(),t="";
    if(field.tagName==="SELECT"&&field.selectedIndex>=0&&field.options[field.selectedIndex])t=String(field.options[field.selectedIndex].text||"").toUpperCase();
    if(!v&&!t)return false;
    return v===want||v.indexOf(want)>=0||t===want||t.indexOf(want)>=0;
}
/* Capped at ~10 attempts (5s @500ms) so a stop field that keeps throwing/never resolves
   can never run forever (stress F2's "runaway 500ms interval" bug). Cleared early by
   startGen() too, since the poll's id is pushed into PENDING_TIMERS.
   modalAtStart: the dialog instance the LANE was applied to (captured by onRouteChange
   before any of its deferred steps run). This poll lives for up to 5 seconds, which is
   long enough for FMC to replace the whole dialog with the next load's - see
   staleModal() for why the token check below cannot catch that on its own. */
function fillStops(origin,dest,myToken,modalAtStart){
    if(!ENABLED)return;
    var att=0;
    var poll=setInterval(function(){
        if(!ENABLED){clearInterval(poll);return;}
        if(myToken!==undefined&&myToken!==GEN){clearInterval(poll);return;}
        // A DIFFERENT dialog instance is a DIFFERENT LOAD: stop, and write nothing.
        // Silent on purpose - the load this poll was filling no longer exists, so a
        // warning here would describe a form the user has already left behind.
        if(staleModal(modalAtStart)){clearInterval(poll);return;}
        att++;
        try{
            var s1=findStopField(1),s2=findStopField(2);
            // Under rapid FMC re-renders findStopField's parent-walk can (rarely)
            // resolve Stop 1 and Stop 2 to the SAME element while the old and new
            // modal briefly coexist. Writing both origin and dest into one element
            // would corrupt it - treat that as "not found yet" and retry next tick
            // instead, same as any other not-yet-resolved case.
            if(s1&&s2&&s1===s2){s1=null;s2=null;}
            // A stop location the user set by hand is theirs (item 1a): it is never
            // written and never counted as a failure - the toast names what is really
            // in the field instead of what the script wanted to put there.
            var m1=isManual(s1),m2=isManual(s2);
            var ok1=s1?(m1||setFieldVal(s1,origin)):false,ok2=s2?(m2||setFieldVal(s2,dest)):false;
            // Success toast only after RE-READING both fields (16.0.2 toast audit) -
            // never on setFieldVal's own return value alone. A write that landed in a
            // node FMC replaced mid-render simply keeps polling (and ends in the
            // existing "Stops not filled" warning) instead of claiming success.
            if(ok1&&ok2&&(m1||stopHolds(s1,origin))&&(m2||stopHolds(s2,dest))){
                clearInterval(poll);
                // Registered only for what the script itself applied, so a re-render
                // cannot silently empty a stop location before Submit (item 1b).
                if(!m1)wantSet("stop1","Stop 1 location",origin);
                if(!m2)wantSet("stop2","Stop 2 location",dest);
                toast("Stop1="+(m1?String(s1.value||""):origin)+" Stop2="+(m2?String(s2.value||""):dest)+" \u2705");
                return;
            }
        }catch(e){}
        if(att>=10){clearInterval(poll);toast("\u26A0 Stops not filled",1);}
    },500);
    if(myToken!==undefined)PENDING_TIMERS.push(poll);
}

/* ═══ FORM FILLERS ═══
   isOperatorTypeSelect() is an explicit, name/id/class-based refusal - NOT a label-
   text coincidence - used by every select-writing path below (setSel, setCurrency,
   clearFmcForm) so "Operator type" can never be matched by a label-text walk, no
   matter how its DOM neighbors shift on the real page. The user picks this control
   by hand; the script must never read, write or clear it. */
function isOperatorTypeSelect(sel){
    if(!sel)return false;
    if(sel.name==="operatorType"||sel.id==="operatorType")return true;
    return!!(sel.closest&&sel.closest(".operator-type"));
}
/* Resolves through the ONE resolver (name attribute first, then the label-text walk,
   Operator type always refused) and writes. A control the user set BY HAND is never
   written and reports TRUE - "settled, stop retrying" - which is what keeps runATS's
   retry loop from fighting the user and from reporting their own pick as pending
   (item 1a). */
function setSel(lp,sp,val,nameAttr){
    if(!ENABLED)return false;
    var sel=resolveSelByLabel(nameAttr,lp,sp);
    if(!sel)return false;
    if(isManual(sel))return true;
    for(var oi=0;oi<sel.options.length;oi++){if(sel.options[oi].value===val||sel.options[oi].text===val||sel.options[oi].value.toUpperCase()===val.toUpperCase()||sel.options[oi].text.toUpperCase()===val.toUpperCase()){beginWrite();try{sel.value=sel.options[oi].value;sel.selectedIndex=oi;sel.dispatchEvent(new Event("change",{bubbles:true}));rFire(sel);}finally{endWrite();}return true;}}
    var opt=document.createElement("option");opt.value=val;opt.text=val;opt.selected=true;sel.appendChild(opt);
    beginWrite();try{sel.value=val;sel.selectedIndex=sel.options.length-1;sel.dispatchEvent(new Event("change",{bubbles:true}));rFire(sel);}finally{endWrite();}
    return true;
}
/* READ-ONLY twin of setSel(): resolves the same control the same way (name attribute
   first, then the label-text walk, Operator type always refused) and reports whether
   it REALLY holds val right now. Used by runATS so the equipment success toast
   describes the live form instead of "every setSel() returned true at some point" -
   a field FMC re-rendered blank after an earlier successful write is re-written
   instead of being reported as done (16.0.2 toast audit). */
/* The ONE resolver for the name-attribute-then-label-walk controls (freight type,
   equipment type, load type, unload type). setSel writes through it, selHoldsVal reads
   through it and the re-apply registry resolves through it, so all three always agree on
   the same element - the ambiguity that let a label-text walk hit the wrong control. */
function resolveSelByLabel(nameAttr,lp,sp){
    if(nameAttr){
        var named=document.querySelector("select[name="+nameAttr+"]");
        if(named&&!named.closest("#grt")&&!isOperatorTypeSelect(named))return named;
    }
    if(!lp)return null;
    var sels=document.querySelectorAll("select");
    for(var si=0;si<sels.length;si++){var sel=sels[si],p=sel;
        if(sel.closest("#grt"))continue;
        if(isOperatorTypeSelect(sel))continue;
        for(var d=0;d<6;d++){p=p.parentElement;if(!p)break;var ft=p.textContent.trim().split("\n")[0].trim();
            if(ft.length<50&&lp.test(ft)){if(sp&&sp.test(ft))break;return sel;}}}
    return null;
}
function selHoldsVal(nameAttr,lp,sp,val){
    var want=String(val||"").toUpperCase();
    var sel=resolveSelByLabel(nameAttr,lp,sp);
    if(!sel||!sel.isConnected)return false;
    // A control the user set by hand counts as satisfied: the script deliberately did
    // not write it, so it is never "pending" and never re-written (item 1a).
    if(isManual(sel))return true;
    var o=sel.options[sel.selectedIndex];
    if(!o)return false;
    return String(o.value||"").toUpperCase()===want||String(o.text||"").toUpperCase()===want;
}
/* Read-only resolvers for the controls the re-apply registry has to find again after a
   re-render. Each one mirrors the matching rules its own writer already uses (currency:
   a GBP/EUR option inside a cost/unit/currency wrapper; cost: the "Cost" label walk;
   vehicle name: the "Vehicle name" label walk), with no writes of any kind. */
function findCurrencySelect(){
    var sels=document.querySelectorAll("select");
    for(var si=0;si<sels.length;si++){var sel=sels[si];
        if(sel.closest&&sel.closest("#grt"))continue;
        if(isOperatorTypeSelect(sel))continue;
        var hasCur=false;
        for(var oi=0;oi<sel.options.length;oi++){var ov=(sel.options[oi].value||"").trim().toUpperCase(),ot=(sel.options[oi].text||"").trim().toUpperCase();
            if(ov==="GBP"||ov==="EUR"||ot==="GBP"||ot==="EUR"){hasCur=true;break;}}
        if(!hasCur)continue;
        var p=sel;
        for(var d=0;d<6;d++){p=p.parentElement;if(!p)break;
            if(/cost|unit|currency/i.test(p.textContent.trim().substring(0,50)))return sel;}
    }
    return null;
}
function findCostInput(){
    var inps=document.querySelectorAll("input");
    for(var ci=0;ci<inps.length;ci++){var inp=inps[ci];
        if(inp.closest&&inp.closest("#grt"))continue;
        if(inp.type==="hidden"||inp.type==="radio"||inp.type==="checkbox")continue;
        var par=inp;
        for(var d=0;d<5;d++){par=par.parentElement;if(!par)break;var ft=par.textContent.trim().split("\n")[0].trim().toLowerCase();
            if(/^cost$/i.test(ft)||(/cost/i.test(ft)&&ft.length<15&&!/center/i.test(ft)))return inp;}}
    return null;
}
/* Prefers the real name attribute FMC gives this field (unambiguous), and only then
   falls back to the label-text walk the equipment button has always used. The walk now
   also requires a SHORT first text line, the same `ft.length<50` guard every other label
   walk in this file carries: without it a wrapper that CONTAINS the "Vehicle name" label
   somewhere in its concatenated text (the real .vr-properties block holds create reason,
   carrier, cost, equipment type, freight type AND vehicle name) matched for the FIRST
   input inside it - which is the COST field - and the equipment button wrote the vehicle
   name into Cost. Confirmed on this round's persist harness, whose markup is built with
   createElement and therefore has no whitespace between controls to hide it. */
function findVehicleNameInput(){
    var named=document.querySelector("input[name=vehicleName]");
    if(named&&!(named.closest&&named.closest("#grt")))return named;
    var inps=document.querySelectorAll("input");
    for(var vi=0;vi<inps.length;vi++){var inp=inps[vi];
        if(inp.closest&&inp.closest("#grt"))continue;
        if(inp.type==="hidden"||inp.type==="radio"||inp.type==="checkbox")continue;
        var p=inp;
        for(var d=0;d<5;d++){p=p.parentElement;if(!p)break;
            var ft=p.textContent.trim().split("\n")[0].trim();
            if(ft.length<50&&/vehicle.?name/i.test(ft))return inp;}}
    return null;
}
/* ═══ SHIPPER ACCOUNT ═══
   The manual-edit guarantee for this control now comes from the ONE registry at the top
   of this file (MANUAL / WRITING / markManual / bindManualJQuery) instead of its own
   MANUAL_SHIPPER + WRITING_SHIPPER pair, which is what the generalisation in item 1
   replaced: the same WeakSet-on-the-element rule, the same guard-flag-around-our-own-
   write rule and the same jQuery Select2 binding now cover every Manual Scheduling
   control, not just this one. What is left here is only this control's own RESOLVER -
   which <select> on the page is the open load's shipper account. */
/* Cheap properties ONLY (tag, multiple, name, #grt) - never scans sel.options. Used by
   isShipperSelect() as a fast first gate and by the generic guard's own cheap path, so a
   change/input on a big non-shipper select (no matching name, not inside the modal)
   never pays for an option-by-option scan. */
function isShipperCandidate(sel){
    if(!sel||sel.tagName!=="SELECT")return false;
    if(sel.multiple)return false;
    if(sel.closest&&sel.closest("#grt"))return false;
    if(sel.name==="shipperAccount")return true;
    var modal=findModal();
    return!!(modal&&modal.contains&&modal.contains(sel));
}
function isShipperSelect(sel){
    if(!isShipperCandidate(sel))return false;
    if(sel.name==="shipperAccount")return true;
    for(var oi=0;oi<sel.options.length;oi++){var v=sel.options[oi].value,t=sel.options[oi].text;if(v==="TransfersInitialPlacement"||v==="ATSWarehouseTransfers"||t==="TransfersInitialPlacement"||t==="ATSWarehouseTransfers")return true;}
    return false;
}
/* Single resolver - used for the write, the manual lookup AND the mark check, so all
   three always agree on the same element. Prefers the load's own shipper select inside
   the modal (findModal()) over any other select on the page: FMC's search panel can
   list a non-multiple shipperAccount-named select of its own, and a bare multi-select
   filter (shipperAccounts) must never be picked at all (isShipperSelect rejects
   sel.multiple). Falls back to a document-wide search only if the modal isn't found or
   doesn't contain a shipper select yet. */
function findShipperSelect(){
    var modal=findModal();
    if(modal){
        var inModal=modal.querySelector?modal.querySelector("select[name=shipperAccount]"):null;
        if(inModal&&isShipperSelect(inModal))return inModal;
        var sels=modal.querySelectorAll?modal.querySelectorAll("select"):[];
        for(var mi=0;mi<sels.length;mi++)if(isShipperSelect(sels[mi]))return sels[mi];
    }
    var named=document.querySelector("select[name=shipperAccount]:not([multiple])");
    if(named&&isShipperSelect(named))return named;
    var all=document.querySelectorAll("select");
    for(var si=0;si<all.length;si++)if(isShipperSelect(all[si]))return all[si];
    return null;
}
/* Writes sh into the shipper select UNLESS it's currently marked manual (checked
   again right here, at write time, not just when fillShipper() was first called - a
   manual edit landing during the deferred window (n3) must still block this write).
   On a real write it registers the value with the re-apply registry, so FMC blanking or
   replacing this control later restores it instead of submitting an empty account. */
function fillShipperDom(sh){
    if(!ENABLED)return;
    var sel=findShipperSelect();
    if(!sel||isManual(sel))return;
    beginWrite();
    try{
        var hit=-1;
        for(var oi=0;oi<sel.options.length;oi++){if(sel.options[oi].value===sh||sel.options[oi].text===sh){hit=oi;break;}}
        // The Intermodal account may not exist as a preset option in the dropdown: inject
        // it so the exact string can still be selected. The normal IP / warehouse values
        // always exist as presets, so this only ever fires for the Intermodal case.
        if(hit<0&&sh==="ATSwarehouseTransfersIntermodal"){
            var opt=document.createElement("option");opt.value=sh;opt.text=sh;sel.appendChild(opt);
            hit=sel.options.length-1;
        }
        if(hit>=0){sel.value=sel.options[hit].value;sel.selectedIndex=hit;sel.dispatchEvent(new Event("change",{bubbles:true}));rFire(sel);}
    }finally{endWrite();}
    // allowCreate so the re-apply poll (wantCommit -> setSelect2) can re-inject the
    // Intermodal option if FMC re-renders the select from a model that lacks it as a
    // preset. The normal IP / warehouse values are always presets, so allowCreate is
    // only ever needed (and only ever set) for the Intermodal account.
    wantSet("shipper","Shipper account",sh,sh==="ATSwarehouseTransfersIntermodal"?{allowCreate:true}:null);
}
/* Re-reads the live shipper select (16.0.2 toast audit - used by onRouteChange's
   verified lane toast). A select the user has since marked manual counts as OK: the
   script deliberately did not write it, so that is not a failed fill. */
function shipperHolds(sh){
    if(!sh)return true;
    var sel=findShipperSelect();
    if(!sel||!sel.isConnected)return false;
    if(isManual(sel))return true;
    var o=sel.options[sel.selectedIndex];
    if(!o)return false;
    return o.value===sh||o.text===sh;
}
/* Returns {isIP,sh,manual} describing the account that will actually be in effect -
   the computed auto value normally, or (if the select is ALREADY marked manual at the
   moment this runs) the user's own current pick, read straight from the DOM - so the
   popup/toast/uStat this generation shows always describe reality, never a value that
   was skipped. The deferred genTimeout below re-checks manual state again right before
   writing (fillShipperDom), since a manual edit can land anywhere up to that moment. */
/* INTERMODAL shipper rule (user request). fullLane is threaded in so the IM lane list
   (IMLANES / isIMLane) can be looked up, and ST.sdtH (set by calcCarrier from the pasted
   SDT, the same hrs=(sdt-now)/3600000 used for the carrier) decides:
     - IM lane AND SDT >= 12h above now -> shipper "ATSwarehouseTransfersIntermodal"
     - IM lane AND SDT < 12h            -> NORMAL logic (IP -> TransfersInitialPlacement, else ATSWarehouseTransfers)
     - SDT unknown (ST.sdtH==null, e.g. a plain Go with no pasted timings) -> NORMAL logic
       (never switch to the Intermodal account without a confirmed >=12h SDT)
     - non-IM lanes                     -> NORMAL logic, unchanged
   A hand-picked shipper still wins: when the select is already marked manual we read the
   user's own current pick straight from the DOM and never overwrite it (unchanged). */
function fillShipper(o,myToken,fullLane){
    var isIP=IP[o]?true:false;var sh=isIP?"TransfersInitialPlacement":"ATSWarehouseTransfers";
    var isIM=isIMLane(fullLane);
    if(isIM&&ST.sdtH!=null&&ST.sdtH>=12){sh="ATSwarehouseTransfersIntermodal";isIP=false;}
    ST.origin=o;
    var sel=findShipperSelect();
    var manual=isManual(sel);
    if(manual){
        var cur=sel.options[sel.selectedIndex];
        var curVal=cur?(cur.value||cur.text):"";
        isIP=curVal==="TransfersInitialPlacement";sh=curVal;
    }
    // MODAL IDENTITY for the deferred write (see staleModal): this runs synchronously
    // inside onRouteChange, so the dialog captured here is the one the lane is being
    // applied to; 410ms later FMC may have replaced it with the next load's.
    var modalAtStart=findModal();
    if(myToken===undefined)fillShipperDom(sh);
    else genTimeout(myToken,function(){if(staleModal(modalAtStart))return;fillShipperDom(sh);},410);
    return{isIP:isIP,sh:sh,manual:manual};
}

/* ═══ CREATE REASON (survives FMC's post-validation re-render) ═══
   ROOT CAUSE (confirmed from the real FMC page, see report.md): the Create Reason
   control is <select name="createReason" class="select2 unit-select"> - a Select2
   4.0.0 widget, same wrapping as shipperAccount - but it lives inside an underscore
   template with TWO near-identical conditional blocks
   (`<% if (!model.biddingEnabled) { %> ... <% } else { %> ... <% } %>`), so a model
   change around validation (biddingEnabled flipping, or any attribute that forces
   this section to re-render) throws away the OLD <select> entirely and renders a
   BRAND NEW one with no selection. The 16.0.1 runATS() wrote the reason with setSel()
   - a one-shot native .value set - so the pick never survived that re-render and FMC's
   own model held nothing (or a stale default) by the time the user clicked the final
   Submit, which is why AC React / Dock Cong submits failed.
   16.0.2 item 1: this control's bespoke re-apply (REASON_WANTED + applyReason/reasonPoll
   + MANUAL_REASON + WRITING_REASON) is the mechanism that was GENERALISED - the same
   remember-what-was-wanted / detect-replacement / re-commit-through-the-right-path /
   stop-once-confirmed loop now runs for every Manual Scheduling control through the ONE
   registry at the top of this file (wantSet/wantPoll), and the manual mark comes from the
   ONE registry too (MANUAL/WRITING). What survives here is this control's own RESOLVER
   plus applyReason(), which is now just "register the reason and commit it once". */
var REASON_ENUM={"1":"AC_HIGH_VOLUME","2":"AC_DOCK_CONGESTION","3":"NC_CONTROLLABLE","4":"AC_REACTIVE_SCHEDULING"};
var REASON_WANTED=null;      // enum value the user picked via the panel, or null if none yet
var REASON_APPLIED_TO=null;  // the <select> element REASON_WANTED was last successfully committed to
function isReasonCandidate(sel){
    if(!sel||sel.tagName!=="SELECT")return false;
    if(sel.multiple)return false;
    if(sel.closest&&sel.closest("#grt"))return false;
    if(sel.name==="createReason")return true;
    var modal=findModal();
    return!!(modal&&modal.contains&&modal.contains(sel));
}
function isReasonSelect(sel){
    if(!isReasonCandidate(sel))return false;
    if(sel.name==="createReason")return true;
    for(var oi=0;oi<sel.options.length;oi++){var v=sel.options[oi].value;if(v==="AC_DOCK_CONGESTION"||v==="AC_REACTIVE_SCHEDULING"||v==="AC_HIGH_VOLUME"||v==="NC_CONTROLLABLE")return true;}
    return false;
}
function findReasonSelect(){
    var modal=findModal();
    if(modal){
        var inModal=modal.querySelector?modal.querySelector("select[name=createReason]"):null;
        if(inModal&&isReasonSelect(inModal))return inModal;
        var sels=modal.querySelectorAll?modal.querySelectorAll("select"):[];
        for(var mi=0;mi<sels.length;mi++)if(isReasonSelect(sels[mi]))return sels[mi];
    }
    var named=document.querySelector("select[name=createReason]:not([multiple])");
    if(named&&isReasonSelect(named))return named;
    var all=document.querySelectorAll("select");
    for(var si=0;si<all.length;si++)if(isReasonSelect(all[si]))return all[si];
    return null;
}
/* Commits REASON_WANTED into the live reason <select> via the proven Select2/jQuery
   path (setSelect2 - same function the carrier engine uses) and registers it with the
   re-apply registry, which is what carries it through FMC's post-validation re-render
   from here on. No-ops if there is nothing wanted yet, the control is missing, or the
   control is marked manual (the user's own pick wins). On a failed commit it warns, so a
   submit can never go out silently with the wrong reason. */
function applyReason(){
    if(!ENABLED)return;
    if(!REASON_WANTED)return;
    wantSet("reason","Create reason",REASON_WANTED);
    var sel=findReasonSelect();
    if(!sel)return; // not rendered yet - wantPoll will retry
    if(isManual(sel)){wantDrop("reason");return;} // user's own pick wins
    if(sel===REASON_APPLIED_TO&&normFT(sel.value)===normFT(REASON_WANTED))return; // already applied, nothing changed
    beginWrite();
    var ok;
    try{ok=setSelect2(sel,REASON_WANTED,false);}finally{endWrite();}
    if(ok)REASON_APPLIED_TO=sel;
    else toast("\u26A0 Create reason could not be set",1);
}

/* Read-only twin of fillCost's own cost-input scan (same matching rules, no writes):
   true only if at least one cost field was found and every one of them really holds a
   value now. Used by onRouteChange's verified lane toast (16.0.2 toast audit). */
function costFieldsHold(){
    var inps=document.querySelectorAll("input"),seen=0,held=0;
    for(var ci=0;ci<inps.length;ci++){var inp=inps[ci];if(inp.closest&&inp.closest("#grt"))continue;if(inp.type==="hidden"||inp.type==="radio"||inp.type==="checkbox")continue;var par=inp;
        for(var d=0;d<5;d++){par=par.parentElement;if(!par)break;var ft=par.textContent.trim().split("\n")[0].trim().toLowerCase();
            if(/^cost$/i.test(ft)||(/cost/i.test(ft)&&ft.length<15&&!/center/i.test(ft))){seen++;if(isManual(inp)||String(inp.value||"").trim()!=="")held++;break;}}}
    return seen>0&&held===seen;
}
function fillCost(origin,laneText,myToken,modalAtStart){
    if(!ENABLED)return;
    // MODAL IDENTITY (see staleModal): this whole function IS a deferred step - 430ms
    // after onRouteChange - and both of its writes (the cost input and the currency
    // dropdown, plus the authoritative currency re-apply it schedules) would otherwise
    // land in a dialog FMC rebuilt inside that window, i.e. in the next load's form.
    if(staleModal(modalAtStart))return;
    // 1) Cost = 0 (always), unchanged from 15.8. A cost the user typed by hand is never
    // overwritten (item 1a).
    var allInps=document.querySelectorAll("input"),wroteCost=false;
    for(var ci=0;ci<allInps.length;ci++){var inp=allInps[ci];if(inp.closest&&inp.closest("#grt"))continue;if(inp.type==="hidden"||inp.type==="radio"||inp.type==="checkbox")continue;var par=inp;
        for(var d=0;d<5;d++){par=par.parentElement;if(!par)break;var ft=par.textContent.trim().split("\n")[0].trim().toLowerCase();
            if(/^cost$/i.test(ft)||(/cost/i.test(ft)&&ft.length<15&&!/center/i.test(ft))){if(isManual(inp))break;beginWrite();try{NS.call(inp,"0");inp.dispatchEvent(new Event("input",{bubbles:true}));inp.dispatchEvent(new Event("change",{bubbles:true}));rFire(inp);}finally{endWrite();}wroteCost=true;break;}}}
    if(wroteCost)wantSet("cost","Cost","0");
    // 2) Currency: origin-only classification, re-evaluated every lane (no stale cache
    //    consulted here besides TNT_CACHE which is keyed per-origin). If the fallback
    //    table AND the API both fail to classify, leave the dropdown untouched and warn.
    // This fillCost call fires 300ms after onRouteChange (see caller); guard against the
    // lane having moved on in that window. Two guards: the GENERATION TOKEN (always
    // correct, even if two different lanes share the same origin code) plus the
    // pre-existing ST.origin===origin check (kept for the case fillCost is ever called
    // without a token, e.g. legacy/manual use).
    if(myToken!==undefined&&myToken!==GEN)return;
    if(ST.origin!==origin)return;
    if(REAPPLY_TIMER){clearTimeout(REAPPLY_TIMER);REAPPLY_TIMER=null;}
    var fb=gCur(origin);
    if(fb)setCurrency(fb);
    resolveCurrencyFromAmazon(origin,fb,laneText,myToken,modalAtStart);
    if(!fb&&!TNT_CACHE[origin]){
        console.warn("[Rohit] unknown origin",laneText||origin);
    }
}

/* Set the currency dropdown to cur (GBP/EUR). Robust to separator/case/whitespace:
   match wrapper text case-insensitively and trim before testing. Uses the native
   setter + change/input events so framework (React/jQuery) listeners pick it up. */
function setCurrency(cur){
    if(!ENABLED)return false;
    if(!cur)return false;
    var sels=document.querySelectorAll("select");
    for(var si=0;si<sels.length;si++){var sel=sels[si];if(sel.closest&&sel.closest("#grt"))continue;if(isOperatorTypeSelect(sel))continue;
        for(var oi=0;oi<sel.options.length;oi++){
            var ov=(sel.options[oi].value||"").trim().toUpperCase(),ot=(sel.options[oi].text||"").trim().toUpperCase();
            if(ov===cur||ot===cur){var par2=sel;
                for(var d2=0;d2<6;d2++){par2=par2.parentElement;if(!par2)break;
                    if(/cost|unit|currency/i.test(par2.textContent.trim().substring(0,50))){
                        if(isManual(sel))return true;   // item 1a - the user's own currency wins, and is not a failure
                        beginWrite();
                        try{
                            var setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,"value");
                            if(setter&&setter.set)setter.set.call(sel,sel.options[oi].value);else sel.value=sel.options[oi].value;
                            sel.selectedIndex=oi;
                            sel.dispatchEvent(new Event("input",{bubbles:true}));
                            sel.dispatchEvent(new Event("change",{bubbles:true}));
                            rFire(sel);
                        }finally{endWrite();}
                        wantSet("currency","Currency",cur);
                        return true;
                    }}}}}
    return false;
}

/* Amazon node data -> origin country -> currency. GB (incl. Northern Ireland, which is
   still country code GB) -> GBP; any other country -> EUR. This is the AUTHORITATIVE
   source; the gCur() prefix table is only the instant fallback shown while this resolves.
   Re-applies once more after ~700ms to beat any FMC reset of the dropdown. */
var TNT_CACHE={};
// Only ONE "re-verify after a short delay" timer may be pending at a time. Cancelling
// the previous one before scheduling a new one guarantees a stale timer from an OLDER
// lane can never fire later and clobber whatever lane is active now - a per-call
// setTimeout (even with an ST.origin===origin guard at fire time) is not enough
// because multiple overlapping timers can otherwise pile up across rapid lane changes.
// Guarded by the GENERATION TOKEN (myToken===GEN), NOT by "ST.origin===origin" alone:
// two different pastes/lanes can legitimately share the same origin code (e.g.
// LTN4->DTM1 then later LTN4->XDEQ), so an origin-string match is not proof the SAME
// apply is still current - only the generation token is.
// MODAL IDENTITY on top of both (see staleModal): this ~700ms re-apply is the longest-
// lived delayed write on the lane path, and it was one of the two writers (with
// fillStops) that stress CONT2 caught putting an older load's value into a dialog FMC
// had already rebuilt - the case neither the token nor ST.origin can see.
var REAPPLY_TIMER=null;
function scheduleReapply(origin,cur,myToken,modalAtStart){
    if(REAPPLY_TIMER){clearTimeout(REAPPLY_TIMER);REAPPLY_TIMER=null;}
    REAPPLY_TIMER=setTimeout(function(){REAPPLY_TIMER=null;if(myToken!==GEN)return;if(staleModal(modalAtStart))return;if(ST.origin===origin)setCurrency(cur);},700);
    if(myToken!==undefined)PENDING_TIMERS.push(REAPPLY_TIMER);
}
function resolveCurrencyFromAmazon(origin,fallback,laneText,myToken,modalAtStart){
    if(!origin)return;
    // Guard every apply with the generation token so a slow/cached response for an
    // OLDER apply can never clobber a NEWER one's currency, even if they share the
    // same origin code.
    if(TNT_CACHE[origin]){
        if(myToken===GEN&&ST.origin===origin&&!staleModal(modalAtStart))setCurrency(TNT_CACHE[origin]);
        scheduleReapply(origin,TNT_CACHE[origin],myToken,modalAtStart);
        return;
    }
    var url="/networkconfiguration/api/v1/node/"+encodeURIComponent(origin);
    fetch(url,{credentials:"include"})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(json){
          if(myToken!==undefined&&myToken!==GEN)return; // a newer action has since taken over
          if(staleModal(modalAtStart))return;           // the dialog this lane was resolved for is gone - a different load (see staleModal)
          var country=json&&json.address?json.address.countryCode:"";
          if(!country){
              if(!fallback&&ST.origin===origin)console.warn("[Rohit] unknown origin",laneText||origin);
              return;
          }
          var cur=String(country).toUpperCase()==="GB"?"GBP":"EUR";
          TNT_CACHE[origin]=cur;
          if(ST.origin!==origin)return; // a newer lane has since taken over
          setCurrency(cur);
          scheduleReapply(origin,cur,myToken,modalAtStart);
          var cb=document.getElementById("grt-cost-badge");
          if(cb)cb.textContent="Cost: 0 "+cur;
          uStat("Currency "+cur+" ("+country+")");
      })
      .catch(function(){
          // network/API unavailable: keep the gCur fallback already set (or the
          // unknown-origin warn already issued above if there was no fallback).
      });
}

/* ═══ CARRIER (Shiva writeSelect method - INSTANT) ═══
   Shiva's shipped script sets carrier via setFmcSelectValue:
   inject the option if missing, then page jQuery .val().trigger('change').
   No select2 search typing, no polling -> instant. */
/* myToken is OPTIONAL - runATS's own 100ms setTimeout call (equipment button, not
   part of the paste pipeline) passes none, same as before. fillTimings' call (the
   paste pipeline) passes its own generation token through to setSelect2 so a
   superseded paste's carrier write can never land after a newer paste/Go/Clear has
   already taken over - the fix for the stale-carrier-write regression found while
   investigating the sub-1s fill target (see report.md). */
function fillCarrier(cid,myToken){
    if(!cid)return;
    if(myToken!==undefined&&myToken!==GEN)return;
    var root=findModal();
    if(!root){toast("\u26A0 Carrier: modal not open",1);return;}
    var sel=findField(root,["select[name=carrier]","[name=carrier]"]);
    if(!sel){toast("\u26A0 Carrier field not found",1);return;}
    var ok=setSelect2(sel,cid,true,myToken);   // allowCreate=true -> inject + jQuery commit, token-gated
    if(myToken!==undefined&&myToken!==GEN)return; // superseded while setSelect2 ran - stay silent, a newer generation's own toast already covers this paste
    toast(ok?("Carrier \u2705 "+cid):("Carrier \u26A0\uFE0F "+cid+" failed"),ok?0:1);
}

/* ═══ TIMINGS ═══ */
/* ═══ WHAT FORMAT DOES FMC READ THE TIMING BOXES IN? ═══
   Read out of the saved real page, not guessed (Downloads\FMC.htm ~196,834 +
   FMC_files\A1eVP2PiABL.js):
     window.FMC.UserPreferences.dateFormat          = "mm/dd/yyyy"   (THIS user)
     FMC.Utils.DataTimePicker.getDateFormat()       = "m/d/Y H:i"    (xdsoft widget)
     FMC.Utils.DataTimePicker.getDateFormatForMoment() = "MM/DD/YYYY HH:mm" (model)
   The string in the box is NOT cosmetic: the field's change handler runs it through
   moment.tz(val, that format, data-timezone) and stores the result in
   data-epoch-millis, which is the value FMC's model keeps. So the format is the only
   input to the stored instant, and the format is per-user, not fixed.
   WHAT THE REVIEWER FOUND on the real widget (rv-dtp D8/D9): the parsed value is
   re-emitted exactly as the source spelled it, so a "04:37 PM" source lost its meridiem
   and landed 12 hours early, and a day-first "15/10/2026" source was NOT rejected by the
   widget - it silently rolled over to Mar 10 2027 and fed the carrier engine an SDT
   3,511 h out. Both still showed a green "4/4 timings OK".
   WHAT THE USER CONFIRMED on live FMC, which decides what this build does: "RLB1 and
   AZNG are working correctly, don't make any changes to that." The carrier is derived
   from the SAME parsed SDT as the written times (calcCarrier, below), so a misread date
   would show up as a wrong carrier on nearly every load - it does not. Their source
   order therefore already matches what their own FMC expects, and the write has been
   landing correctly for weeks.
   SO THE DATE PATH IS FROZEN: what goes into the field is the source's own date parts,
   verbatim, exactly as every build since 15.x has written them. The rollover above is a
   REAL defect in the parser's tolerance but LATENT for this user's data, so it is
   DETECTED and REPORTED (see fmcMisreads + the resolved instant in the verified toast)
   and never silently "corrected". The meridiem fix is pure robustness: a line carrying
   AM/PM is honoured, a line without one is byte-for-byte what it was. */
function fmcDateFmt(){
    try{var U=window.FMC;if(U&&U.Utils&&U.Utils.DataTimePicker&&typeof U.Utils.DataTimePicker.getDateFormat==="function"){var f=U.Utils.DataTimePicker.getDateFormat();if(f)return String(f);}}catch(e){}
    // Same derivation FMC's own helper uses, straight off the preference, if the helper itself is not reachable.
    try{var p=window.FMC&&window.FMC.UserPreferences;if(p&&p.dateFormat)return String(p.dateFormat).replace(/\w+/g,function(a){return a[0].toLowerCase().replace("y","Y");})+" H:i";}catch(e){}
    return null;
}
function fmcDateOrder(){
    var f=fmcDateFmt();if(!f)return"mdy";
    var s=f.toLowerCase(),im=s.indexOf("m"),id=s.indexOf("d");
    if(im<0||id<0)return"mdy";
    return im<id?"mdy":"dmy";
}
/* Tri-state on purpose: a Date = FMC's own parser read it; null = FMC's parser REJECTS
   it; undefined = there is no parser on this page, so this check has no opinion and the
   caller keeps its previous behavior. Date.parseDate is the bundled xdsoft plugin's own
   global parser, i.e. the same code that decides what the real field accepts. */
function fmcReads(v){
    var f=fmcDateFmt()||((fmcDateOrder()==="dmy"?"d/m/Y":"m/d/Y")+" H:i");
    try{if(typeof Date.parseDate!=="function")return undefined;var d=Date.parseDate(String(v),f);return(d&&isFinite(d.getTime()))?d:null;}catch(e){return null;}
}
function pad2n(n){return(n<10?"0":"")+n;}
var TI_SRC_LABEL={vA:"arrival",vD:"departure",vC:"critical departure",vA2:"arrival 2"};
var MON3=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
/* ─── THE ONE SWITCH FOR DATE RE-ORDERING. IT SHIPS OFF. ───
   OFF (shipped): the date is written through verbatim - the frozen, proven path. The
   script still READS the instant and reports it (the verified toast names it, and
   fmcMisreads warns when FMC's own parser would read the written string as a different
   day), so a misread is visible instead of being discovered on a submitted load. No
   value changes.
   ON: the block's source order is decided from evidence (a part >12 can only be a day),
   the date is re-emitted in FMC's own configured order, and a value FMC's parser reads
   back as a different instant is refused rather than written. Turn this on ONLY with
   evidence from the user's own account - flipping the one `false` below to `true` is the
   whole change; AMBIG_SRC_ORDER then decides blocks that prove nothing either way. */
var REORDER_DATES=false;
var AMBIG_SRC_ORDER="dmy";   // consulted ONLY when REORDER_DATES is true (EU site -> day-first)
/* Which order did the SOURCE spell its dates in? Decided ONCE for the WHOLE paste, so a
   block can never end up half-read each way: any line that proves an order decides the
   block. Contradictory proof inside one paste ("15/10" on one line, "10/16" on another)
   has no consistent answer - it is reported and nothing is written. */
function srcDateEvidence(recs){
    var dmy=0,mdy=0;
    for(var i=0;i<recs.length;i++){if(+recs[i].p1>12)dmy++;if(+recs[i].p2>12)mdy++;}
    if(dmy&&mdy)return"mixed";
    if(dmy)return"dmy";
    if(mdy)return"mdy";
    return"none";
}
/* day/month/hour from one pasted line, under a decided source order. Returns null when
   the line cannot be trusted: a meridiem that cannot be applied ("16:37 PM"), or a part
   outside the calendar. ONE implementation, shared by the string the field gets and the
   epoch the carrier decision uses, so the two can never disagree. */
function normRec(rec,srcOrder){
    var mo=+((srcOrder==="dmy")?rec.p2:rec.p1),dy=+((srcOrder==="dmy")?rec.p1:rec.p2),h=mer24(rec),mi=+rec.mm;
    if(h===null)return null;
    if(mo<1||mo>12||dy<1||dy>31||h<0||h>23||mi<0||mi>59)return null;
    return{mo:mo,dy:dy,y:+rec.y,h:h,mi:mi};
}
/* The ONLY time arithmetic in this file. No meridiem = the source's own hour, untouched
   (so a 24-hour line is byte-for-byte what every previous build wrote). With a meridiem
   it converts to 24-hour; a meridiem that cannot be applied ("16:37 PM") returns null so
   the caller warns instead of writing a guess. */
function mer24(rec){
    var h=+rec.hh;
    if(!rec.mer)return h;
    if(h>12||h<1)return null;
    if(rec.mer==="p")return(h===12)?12:h+12;
    return(h===12)?0:h;
}
/* THE FROZEN WRITE PATH (REORDER_DATES off): the source's own date parts, in the source's
   own order, with the source's own spelling - identical to what parseTimings has always
   produced. The only difference from the previous build is that a meridiem, if the source
   carries one, is applied to the hour instead of being dropped. */
function passThroughValue(rec){
    var h=mer24(rec);
    if(h===null)return null;
    return rec.p1+"/"+rec.p2+"/"+rec.y+" "+(rec.mer?pad2n(h):rec.hh)+":"+rec.mm;
}
/* THE FROZEN SDT PATH. Same arithmetic as the previous build's parseGmt - first part as
   the month, second as the day, the line's own GMT offset applied, and deliberately NO
   validity clamping, so the carrier decision the user confirmed as correct keeps reading
   exactly the number it reads today. Only a meridiem (which their source does not carry)
   changes anything here. */
function passThroughEpoch(rec,raw){
    var h=mer24(rec);
    if(h===null)return null;
    var off=/GMT\s*([+-])\s*(\d{1,2})(?::(\d{2}))?/i.exec(raw||""),om=0;
    if(off)om=(off[1]==="-"?-1:1)*(+off[2]*60+(off[3]?+off[3]:0));
    return Date.UTC(+rec.y,+rec.p1-1,+rec.p2,h,+rec.mm,0)-om*60000;
}
/* What will FMC make of the string we are about to write? Uses FMC's OWN parser and
   FMC's OWN configured order, and returns a pretty instant ONLY when that reading does
   not match the parts as written (i.e. the widget silently rolled the date over, the
   15/10 -> Mar 10 2027 case). Pure observation: it never changes a written value, it
   only gives the user - who has no console - something to see. Returns null where there
   is no parser (every harness page) or where the reading agrees. */
function fmcMisreads(out,rec){
    var d=fmcReads(out);
    if(d===undefined)return null;
    if(!d)return"unreadable";
    var fo=fmcDateOrder(),wantMo=+((fo==="dmy")?rec.p2:rec.p1),wantDy=+((fo==="dmy")?rec.p1:rec.p2);
    if(d.getMonth()+1===wantMo&&d.getDate()===wantDy)return null;
    return prettyInstant({dy:d.getDate(),mo:d.getMonth()+1,y:d.getFullYear(),h:d.getHours(),mi:d.getMinutes()});
}
/* The instant to show in the verified toast: FMC's own reading of what was written when
   its parser is available (that is what the user's load will actually carry), otherwise
   the script's own reading of the same parts. */
function resolvedPretty(out,n){
    var d=fmcReads(out);
    if(d)return prettyInstant({dy:d.getDate(),mo:d.getMonth()+1,y:d.getFullYear(),h:d.getHours(),mi:d.getMinutes()});
    return prettyInstant(n);
}
/* "15 Oct 2026 14:30" - the resolved instant in a spelling no date order can be
   confused with, for the toast. */
function prettyInstant(n){return n?(n.dy+" "+MON3[n.mo-1]+" "+n.y+" "+pad2n(n.h)+":"+pad2n(n.mi)):"";}
/* One pasted date/time -> the exact string to type into the FMC field: FMC's configured
   part order, 24-hour clock, then VERIFIED with FMC's own parser before it is accepted.
   Returns null when the value cannot be trusted (meridiem that cannot be applied, an
   impossible part, or FMC's parser reading it back as a different instant) - the caller
   warns and writes nothing for that field rather than landing a wrong instant.
   Pass-through is byte-exact when the source already matches FMC's order and carries no
   meridiem (the normal case), so nothing about a working paste changes. */
function fmtForFmc(rec,n,fmcOrder){
    if(!n)return null;
    // The parts are re-spelled from the NORMALIZED values, never copied from the source
    // text, so the widget can only ever receive FMC's own order. Padding matches what
    // the source used for the month/day pair when no re-ordering was needed (both the
    // real widget and the mock accept padded and unpadded alike - rv-dtp D6).
    var same=srcSpelledSame(rec,n,fmcOrder);
    var mp=same?(rec.p1+"/"+rec.p2):((fmcOrder==="dmy")?(pad2n(n.dy)+"/"+pad2n(n.mo)):(pad2n(n.mo)+"/"+pad2n(n.dy)));
    var out=mp+"/"+n.y+" "+(same?(rec.hh+":"+rec.mm):(pad2n(n.h)+":"+pad2n(n.mi)));
    var chk=fmcReads(out);
    if(chk===undefined)return out;                   // no parser on this page - unchanged behavior
    if(!chk)return null;
    if(chk.getMonth()+1!==n.mo||chk.getDate()!==n.dy||chk.getFullYear()!==n.y||chk.getHours()!==n.h||chk.getMinutes()!==n.mi)return null;
    return out;
}
/* True when the source already spelled this value exactly the way FMC wants it, so the
   field can keep the source's own characters (the normal month-first 24-hour paste is
   therefore written through byte-for-byte, as it always was). */
function srcSpelledSame(rec,n,fmcOrder){
    if(rec.mer)return false;
    var first=+((fmcOrder==="dmy")?n.dy:n.mo),second=+((fmcOrder==="dmy")?n.mo:n.dy);
    return(+rec.p1===first&&+rec.p2===second);
}
/* SDT epoch for the carrier decision, from the NORMALIZED parts (+ the line's own
   GMT offset). Built from the same month/day/hour the field gets, which is what keeps
   the carrier choice and the written times telling the same story - the day-first case
   used to compute an SDT 3,511 h out and pick the wrong carrier. */
function gmtEpoch(n,raw){
    if(!n)return null;
    var off=/GMT\s*([+-])\s*(\d{1,2})(?::(\d{2}))?/i.exec(raw||""),om=0;
    if(off)om=(off[1]==="-"?-1:1)*(+off[2]*60+(off[3]?+off[3]:0));
    return Date.UTC(n.y,n.mo-1,n.dy,n.h,n.mi,0)-om*60000;
}
/* Two passes on purpose: collect every timing line FIRST (the source's order can only
   be decided from the whole block), then emit. r.warn = nothing can be written at all;
   r.bad = the named fields could not be understood and are deliberately left empty. */
function parseTimings(t){
    var r={vA:null,vD:null,vC:null,vA2:null,o:null,d:null,sdtEpoch:null,warn:null,bad:[],odd:[],pretty:{},amb:false,srcOrder:null},recs=[],sn=0;
    t.split("\n").forEach(function(l){
        l=l.trim();if(!l)return;
        var lm=l.match(/([A-Z0-9]{3,6})\s*[-=>\u2192]+\s*([A-Z0-9]{3,6})/i);
        if(lm&&!r.o){r.o=lm[1].toUpperCase();r.d=lm[2].toUpperCase();}
        var tm=l.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?:\s*([AaPp])\.?[Mm]\.?)?\s*(\([^)]*\))?/);
        if(!tm)return;
        var kind=null;
        if(/SAT\s*:/i.test(l)){sn++;kind=(sn===1)?"vA":"vA2";}
        else if(/SDT\s*:/i.test(l))kind="vD";
        else if(/CPT\s*:/i.test(l))kind="vC";
        if(!kind)return;
        recs.push({kind:kind,p1:tm[1],p2:tm[2],y:tm[3],hh:tm[4],mm:tm[5],mer:tm[6]?tm[6].toLowerCase():null,raw:tm[0]});
    });
    if(!recs.length)return r;
    var fo=fmcDateOrder(),ev=srcDateEvidence(recs),so=(ev==="none")?AMBIG_SRC_ORDER:ev;
    if(REORDER_DATES&&ev==="mixed"){r.warn="Mixed date order in the pasted text, timings not filled";return r;}
    r.amb=(REORDER_DATES&&ev==="none");r.srcOrder=REORDER_DATES?so:"verbatim";
    for(var i=0;i<recs.length;i++){
        var rec=recs[i],n,out;
        if(REORDER_DATES){n=normRec(rec,so);out=fmtForFmc(rec,n,fo);}
        // FROZEN PATH (shipped): write the source's own spelling. `n` is computed only as
        // the fallback reading for the toast - it never decides what is written.
        else{n=normRec(rec,"mdy");out=passThroughValue(rec);}
        if(!out){if(r.bad.indexOf(TI_SRC_LABEL[rec.kind])<0)r.bad.push(TI_SRC_LABEL[rec.kind]);continue;}
        r[rec.kind]=out;
        r.pretty[rec.kind]=resolvedPretty(out,n);
        if(!REORDER_DATES){var mis=fmcMisreads(out,rec);if(mis)r.odd.push(TI_SRC_LABEL[rec.kind]+" = "+(mis==="unreadable"?"not readable by FMC":mis));}
        if(rec.kind==="vD")r.sdtEpoch=REORDER_DATES?gmtEpoch(n,rec.raw):passThroughEpoch(rec,rec.raw);
    }
    return r;
}
function calcCarrier(sdtE){
    if(!sdtE){toast("SDT not read -> carrier blank",1);return"";}
    var dh=(sdtE-Date.now())/3600000;ST.sdtH=dh;ST.carrier=dh<30?"RLB1":"AZNG";
    uStat("SDT:"+dh.toFixed(1)+"h\u2192"+ST.carrier);
    toast("SDT "+dh.toFixed(1)+"h -> "+ST.carrier);
    try{localStorage.setItem("groot_carrier",JSON.stringify({c:ST.carrier,h:ST.sdtH,t:Date.now()}));}catch(e){}
    return ST.carrier;}
/* Internal delays: 50ms before the write, 40ms before the blur (16.0.2 item 2, the
   user's "the timings must come automatically, within a second" - SHIPPED this round
   after three deferrals; it was 150/100 before). Both are still POSITIVE ticks, not
   zero: the 50ms gives the real page's lazy fmcDatetimepicker widget room to finish
   initializing after .click() (confirmed real-DOM finding, report.md) and the 40ms
   lets the typed value commit before the blur.
   THE INVARIANT, and it is the one that actually matters: the per-field stagger in
   fillTimings (110ms) stays GREATER than this function's own total internal chain
   (50+40=90ms). The regression caught in an earlier speed round's stress run
   (A1/A2/CONT/CONT2 stale writes + CONT2 losing focus entirely) was exactly a
   too-short stagger letting field N+1's focus()/click() fire before field N's own
   deferred write+blur chain had finished, which reorders writes across fields and
   breaks the one-field-at-a-time ordering every later re-read depends on. Keep
   stagger >= 50+40 if these are ever retuned. */
/* myToken is OPTIONAL (clearDT's own calls, and any other non-paste-pipeline caller,
   pass none - unchanged behavior). fillTimings' call passes its generation token
   through so this function's OWN internal deferred write (previously a bare
   setTimeout with NO token check at all) can never land after a newer paste/Go/
   Clear has superseded it. ROOT CAUSE of the real stale-write regression this round
   (see report.md "speed investigation"): genTimeout already re-checks the token
   before CALLING setDT, but once setDT itself started running, its own internal
   60ms-deferred write used to fire UNCONDITIONALLY - a newer paste's startGen() a
   few ms later cancels every PENDING_TIMERS entry (the genTimeout calls), but never
   touched this bare setTimeout, which was never registered in PENDING_TIMERS at
   all. 16.0.1's 400ms stagger + 500-600ms entry defers happened to make this hard to
   observe (by the time setDT's internal write fired, the whole paste had almost
   always already fully superseded or fully committed); compressing the pipeline for
   the "under 1s" target made the race land far more often, which is what A2/CONT2's
   stress failures were actually catching - not the stagger-vs-settle-chain ordering
   bug alone, and not fillCarrier's missing gate alone. Both re-checks below (before
   scheduling the write, and again right before actually writing) mirror the same
   pattern setSelect2/fillCarrier already use. */
/* isConnected gates (16.0.2): never focus/click/write a DETACHED field. FMC replaces
   the whole stop block on a re-render, so the node this call captured can be gone by
   the time the internal 150ms write fires - writing into it used to "succeed"
   silently while the live form stayed empty. The caller (applyTimings) re-resolves
   the slot before each write; this is the last line of defence for the gap between
   that resolve and the deferred write. */
function setDT(inp,val,myToken){if(!inp||!val)return;if(myToken!==undefined&&myToken!==GEN)return;if(!inp.isConnected)return;inp.focus();inp.click();setTimeout(function(){if(myToken!==undefined&&myToken!==GEN)return;if(!inp.isConnected)return;NS.call(inp,val);inp.dispatchEvent(new Event("input",{bubbles:true}));inp.dispatchEvent(new Event("change",{bubbles:true}));rFire(inp);inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,bubbles:true}));setTimeout(function(){inp.dispatchEvent(new Event("blur",{bubbles:true}));},40);},50);}
/* refocusAfterTimings() / refocusTimingsBox() are GONE with the paste box (16.0.2
   no-box). setDT still calls inp.focus() - the FMC timepicker needs it - but there is
   no longer anywhere to hand focus back TO, and the whole reason for taking it back was
   that a bare Ctrl+V had to land in the panel's textarea. It does not any more: the
   window capture-phase net sees a paste no matter which element is focused, so focus
   after a fill is simply left where FMC put it, which is also what the user would get
   if they had typed the value themselves. */
function findTI(){var result={arr1:null,dep1:null,crit:null,arr2:null},fields=[];var labels=document.querySelectorAll("label,span,div,b,strong,p");for(var li=0;li<labels.length;li++){var lbl=labels[li];if(lbl.closest("#grt"))continue;var t=lbl.textContent.trim().toLowerCase();if(t.length>30)continue;var isA=/^arrival/i.test(t)||/arrival\s*time/i.test(t),isD=/^departure/i.test(t)||/departure\s*time/i.test(t),isC=/^critical/i.test(t)||/critical\s*dep/i.test(t);if(!isA&&!isD&&!isC)continue;var par=lbl;for(var d=0;d<6;d++){par=par.parentElement;if(!par)break;var inps=par.querySelectorAll("input:not([type=hidden]):not([type=radio]):not([type=checkbox])");for(var ii=0;ii<inps.length;ii++){var inp=inps[ii];if(inp.closest("#grt"))continue;var r=inp.getBoundingClientRect();if(r.width>0&&r.height>0){fields.push({el:inp,type:isC?"crit":isD?"dep":"arr",y:r.top});break;}}if(fields.length>0&&fields[fields.length-1].type===(isC?"crit":isD?"dep":"arr"))break;}}var seen=new Set(),arrs=[];for(var fi=0;fi<fields.length;fi++){if(seen.has(fields[fi].el))continue;seen.add(fields[fi].el);if(fields[fi].type==="arr")arrs.push(fields[fi]);else if(fields[fi].type==="dep")result.dep1=fields[fi].el;else if(fields[fi].type==="crit")result.crit=fields[fi].el;}arrs.sort(function(a,b){return a.y-b.y;});if(arrs.length>=1)result.arr1=arrs[0].el;if(arrs.length>=2)result.arr2=arrs[1].el;return result;}
var TI_LABEL={arr1:"arrival",dep1:"departure",crit:"critical departure",arr2:"arrival 2"};
var TI_RETRY_MAX=5,TI_RETRY_MS=300;   // bounded: ~1.5s of re-resolving, never an open-ended poll
function fillTimings(txt,myToken){
    if(!ENABLED)return;
    var ad=parseTimings(txt);
    // A pasted date/time the script cannot map onto FMC's own format is a WARNING and
    // is NOT written: writing it lands a parseable-but-wrong instant in FMC's model
    // with nothing on screen to show it (the two real-widget defects rv-dtp D8/D9
    // found), and the old presence-only landed-check would still have called it green.
    if(ad.warn){toast("\u26A0 "+ad.warn,1);return;}
    var vals=[ad.vA,ad.vD,ad.vC,ad.vA2];var cnt=vals.filter(Boolean).length;
    if(!cnt){toast(ad.bad.length?("\u26A0 "+ad.bad.join(", ")+" time not understood, nothing filled"):"\u26A0 No timings found",1);return;}
    if(ad.bad.length)toast("\u26A0 "+ad.bad.join(", ")+" time not understood, left empty",1);
    // DETECTION, NOT CORRECTION (the date path is frozen - see REORDER_DATES): the value
    // still goes in exactly as pasted, but if FMC's own parser would read that string as
    // a different day, say so. The user has no console, so this toast is the only place
    // such a mismatch can surface before the load is submitted.
    if(ad.odd.length)toast("\u26A0 FMC reads "+ad.odd[0]+(ad.odd.length>1?" (+"+(ad.odd.length-1)+" more)":"")+" - check the date order",1);
    // Only reachable with REORDER_DATES on: the block proved no order and one was assumed.
    if(ad.amb)toast("\u26A0 Date order unclear, read as "+(AMBIG_SRC_ORDER==="dmy"?"d/m":"m/d")+": "+(ad.pretty.vA||ad.pretty.vD||""),1);
    if(myToken===undefined)myToken=startGen();
    if(ad.sdtEpoch)calcCarrier(ad.sdtEpoch);
    // FAST: fire carrier IMMEDIATELY (parallel with date filling), not after.
    // Token-gated (myToken) so a superseded paste's carrier commit can never land
    // after a newer paste has already started - see fillCarrier's own comment.
    // The registry entry is set HERE rather than inside fillCarrier because the carrier
    // path itself is frozen by the user's own confirmation ("RLB1 and AZNG are working
    // correctly, don't make any changes to that") - registering at the call site keeps
    // fillCarrier byte-for-byte what it was while still making the value survive a
    // re-render (item 1b).
    if(ST.carrier){fillCarrier(ST.carrier,myToken);wantSet("carrier","Carrier",ST.carrier,{allowCreate:true});}
    applyTimings(ad,cnt,myToken,0);
}
/* Resolve the timing fields, write them, then REPORT WHAT REALLY LANDED.
   16.0.2 BLOCKER FIX: findTI() can legitimately resolve ZERO fields right after
   Ctrl+G, because clearing the Route makes FMC rebuild its stops collection and
   re-render the stop blocks (see MODAL IDENTITY above) - so the fields are missing for
   a moment, or gone until the form re-renders. The old code took findTI()'s answer
   once, wrote nothing, and still showed a green "0/4 timings OK": the user (who has no
   console) read a success toast on an empty form. Now a zero resolve is retried a few
   times - with ONE re-render nudge on the first miss - and anything short of a full
   fill ends in a WARNING, never a success-styled toast.
   The normal path is unchanged in SHAPE: when the fields are there on attempt 0 (every
   case except a collapsed form) this runs synchronously inside fillTimings, with the
   110ms per-field stagger (16.0.2 item 2 - it was 400ms) and the same delay+300 toast /
   delay+1000 submit offsets relative to it. */
function applyTimings(ad,cnt,myToken,attempt){
    if(!ENABLED)return;
    if(myToken!==undefined&&myToken!==GEN)return;
    var modalAtStart=findModal();
    var ti=findTI();
    var slots=[["arr1",ad.vA],["dep1",ad.vD],["crit",ad.vC],["arr2",ad.vA2]];
    var found=0,si2;
    for(si2=0;si2<slots.length;si2++)if(slots[si2][1]&&nodeUsable(ti[slots[si2][0]]))found++;
    if(!found){
        if(attempt<TI_RETRY_MAX){
            if(attempt===0)nudgeFormRerender(myToken,"timings");
            genTimeout(myToken,function(){applyTimings(ad,cnt,myToken,attempt+1);},TI_RETRY_MS);
            return;
        }
        toast("\u26A0 No timings filled, press Ctrl+G again or reload",1);
        return;
    }
    // Field stagger 110ms (16.0.2 item 2, SHIPPED - it was 400ms for three rounds).
    // 110 >= setDT's own internal chain (50+40=90) - see setDT's comment for why that
    // invariant, not the exact numbers, is what keeps the writes ordered. What made
    // this safe to ship at last is the modal-identity rule now applied to EVERY
    // deferred writer on this path (see staleModal): with the pipeline compressed, an
    // older load's poll/re-apply is still pending when FMC rebuilds the dialog, and
    // the generation token alone cannot see that.
    var delay=0;
    for(var ui=0;ui<slots.length;ui++){
        var slot=slots[ui][0],val=slots[ui][1],el=ti[slot];
        if(!el||!val)continue;
        (function(s,e0,v,d){genTimeout(myToken,function(){
            // Re-resolve right before writing: if FMC replaced the modal/stop block
            // since this write was scheduled, write into the LIVE field, never the
            // detached one we captured.
            var live=resolveTimingTarget(s,e0,modalAtStart);
            if(!live)return;
            // A timing the user typed by hand is theirs for this load: the paste does
            // not overwrite it and the re-apply registry never claims it (item 1a).
            if(isManual(live)){wantDrop(s);return;}
            // setDT's write fires from its OWN internal 50 ms timer, so the
            // synchronous writer guard cannot cover it (and what setDT writes is frozen).
            // Record the intended value instead: the change event that eventually
            // arrives carrying exactly this value is ours, anything else is the user.
            expectWrite(live,v);
            setDT(live,v,myToken);
            // Registered only AFTER the write was really issued into a live field, so a
            // post-validation re-render that blanks the stop block restores it instead
            // of letting the final Submit go out with an empty time (item 1b).
            wantSet(s,TI_LABEL[s],v);
        },d);})(slot,el,val,delay);
        delay+=110;
    }
    // (The end-of-chain refocus that used to run here, and the `written` list of
    // just-focused fields it needed, both went with the paste box - see the
    // refocusAfterTimings removal note above setDT. The verified toast below has always
    // re-read the LIVE fields via findTI(), so it never depended on that list.)
    // VERIFIED toast: re-read the LIVE fields (findTI() again, not the captured
    // nodes) and compare each one against the string THIS generation wrote - not just
    // against "not empty", which is what let a wrong-but-parseable value through (see
    // timingLanded). Zero filled is a warning that tells the user what to do; a partial
    // fill is a warning that names what is missing; only a complete fill is
    // success-styled.
    genTimeout(myToken,function(){
        var live=findTI(),landed=0,miss=[];
        for(var vi=0;vi<slots.length;vi++){
            var s2=slots[vi][0];if(!slots[vi][1])continue;
            // A field the user owns counts as landed: the script deliberately did not
            // write it, so that is not a failed fill (same rule shipperHolds uses).
            if(isManual(live[s2])||timingLanded(live[s2],slots[vi][1]))landed++;else miss.push(TI_LABEL[s2]);
        }
        // The success toast names the RESOLVED INSTANT ("SAT 15 Oct 2026 14:30"), read
        // back through FMC's own parser where it exists. A date order the script read
        // differently from the user's intent is invisible in "10/15/2026" but obvious
        // here, which is the only check a user with no console can make.
        var pr=ad.pretty.vA?("SAT "+ad.pretty.vA):(ad.pretty.vD?("SDT "+ad.pretty.vD):"");
        if(landed>=cnt)toast(landed+"/"+cnt+" timings \u2705"+(pr?" "+pr:"")+(ST.carrier?" ["+ST.carrier+"]":""));
        else if(!landed)toast("\u26A0 No timings filled, press Ctrl+G again or reload",1);
        else toast("\u26A0 Only "+landed+"/"+cnt+" timings filled: "+miss.join(", ")+" missing",1);
    },delay+300);
    // After timings are committed, auto-click "Submit for validation" (NOT final Submit) -
    // but only once this generation's own fields have actually landed (see
    // clickSubmitValidation's own re-read-and-verify guard). The TIMING FIELDS
    // themselves are the hard "under 1s" requirement (met: 940ms, see report.md);
    // the submit click is deliberately NOT raced down with them -
    // it still waits long enough that a rapid-fire run of further pastes (the stress
    // suite's own 50-300ms scenario) has settled before the FIRST retry even looks,
    // which keeps clicks from ever firing mid-flight between two very-close pastes,
    // while still completing well under a second after the fields land. NEVER
    // force-submits early and NEVER fires more than once (SUBMITTED_GEN).
    for(var sAtt=0;sAtt<5;sAtt++){
        genTimeout(myToken,function(){clickSubmitValidation(myToken,ad,modalAtStart);},delay+1000+sAtt*200);
    }
}

/* ═══ SUBMIT FOR VALIDATION (auto, ~1s after timings) ═══
   Click the FMC "Submit for validation" button. Never the plain "Submit". Fires AT MOST
   ONCE per generation (SUBMITTED_GEN dedupes), only for the generation that is still
   CURRENT (myToken===GEN - a newer paste/Go/Clear cancels it), and only after re-reading
   the actual timing fields from the DOM and confirming they match what THIS generation
   expects - so a submit can never fire on old/half-written/mixed data. */
function clickSubmitValidation(myToken,expectedAd,modalAtStart){
    if(!ENABLED)return false;
    if(myToken!==undefined&&myToken!==GEN)return false;
    if(myToken!==undefined&&SUBMITTED_GEN===myToken)return false;
    // MODAL IDENTITY (see staleModal): never submit a dialog this generation did not
    // fill. The field re-read below already fails closed on a rebuilt form (its fields
    // are empty, so nothing matches and no click happens), but findTI() scans the whole
    // document, so this makes the rule explicit rather than incidental - a submit is the
    // one action that must never fire on another load's form.
    if(staleModal(modalAtStart))return false;
    if(expectedAd){
        var ti=findTI();
        var pairs=[[ti.arr1,expectedAd.vA],[ti.dep1,expectedAd.vD],[ti.crit,expectedAd.vC],[ti.arr2,expectedAd.vA2]];
        for(var pi=0;pi<pairs.length;pi++){
            var el=pairs[pi][0],want=pairs[pi][1];
            if(!want)continue; // this generation never expected this field - don't block on it
            if(isManual(el))continue; // the user owns this field - never wait for OUR value to appear in it
            if(!el||(el.value||"")!==want)return false; // not landed yet - a later retry (another genTimeout tick) may still catch it, but we never force-submit early
        }
    }
    var btns=document.querySelectorAll("button,input[type=button],input[type=submit],a[role=button]");
    for(var i=0;i<btns.length;i++){
        var b=btns[i];if(b.closest&&b.closest("#grt"))continue;
        var t=(b.textContent||b.value||"").replace(/\s+/g," ").trim().toLowerCase();
        if(/submit\s*for\s*validation/.test(t)||(/validation/.test(t)&&/submit/.test(t))){
            var r=b.getBoundingClientRect();
            if(r.width>0&&r.height>0&&!b.disabled){
                if(myToken!==undefined)SUBMITTED_GEN=myToken;
                b.scrollIntoView({block:"center"});
                b.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));
                b.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));
                b.click();
                toast("Submit for validation \u2705");
                // b.click() moves focus to the FMC button; nothing is taken back any
                // more (no paste box to take it back to - see the refocusAfterTimings
                // removal note above setDT). The next bare Ctrl+V is caught by the
                // window capture-phase net whatever is focused, so this no longer
                // matters to the "works twice then stops" failure mode.
                return true;
            }
        }
    }
    toast("\u26A0 Submit-for-validation button not found",1);
    return false;
}

/* ═══ SUBMIT IS THE BOUNDARY (16.0.2 item 1) ═══
   WHAT THE FINAL SUBMIT ACTUALLY READS, out of FMC's own bundle (FMC_files\A1eVP2PiABL.js,
   see report.md's investigation table):
     save:function(){this._save(!0,"Submit")},
     _save:function(b,c,d){this.scheduleModel.set("update",b); ... this.scheduleModel.isValid(!0) ...}
   It submits the BACKBONE MODEL TREE, never the DOM. The model is only ever written by
   EditableView._onInputChange, which runs on a `change` event, requires the control to
   have a `name` attribute, and for a date input stores
   a.fmcDatetimepicker("moment").valueOf() rather than the text. So a DOM-only write is
   invisible to Submit, which is exactly how the Create Reason pick could survive "Submit
   for validation" and be gone by the final "Submit".
   THIS CHECK runs on the capture phase of the final Submit click - before FMC's own
   handler - and reports anything that is not actually there, naming the field. The user
   has no console, so the toast is the only thing standing between a silent mismatch and a
   wrongly submitted load. It deliberately does NOT block the click: refusing a submit the
   user asked for would be a behaviour change they did not ask for.
   HOW "present in FMC's MODEL" is established without FMC exposing the model:
     - a Select2-backed control's value, after any re-render, IS the model's value
       (Select2Renderer does select2("val", model.get(prop))), and the live value is the
       exact string _onInputChange read;
     - a date input additionally carries the widget's OWN parsed epoch - the
       fmcDatetimepicker's _change handler writes data("epoch-millis") on the same change
       event _onInputChange consumes - so an EMPTY epoch next to a non-empty text means
       the widget never parsed it and the model never got it. Tri-state: a number is
       proof, an empty string is a miss, a missing attribute (every harness page, no
       widget) has no opinion and the text comparison stands alone;
     - where FMC's own view layer is present, a control with NO `name` attribute cannot
       reach the model at all, so that is reported too. */
function dateEpochState(el){
    try{
        var jq=fmcPageJQuery();
        if(!jq)return 0;                       // no page jQuery - no opinion
        var d=jq(el).data("epoch-millis");
        if(d===undefined||d===null)return 0;   // attribute absent (harness pages) - no opinion
        if(String(d).trim()==="")return -1;    // present but empty - the widget never parsed our text
        return isFinite(Number(d))?1:-1;
    }catch(err){return 0;}
}
function fmcViewLayerPresent(){
    try{return!!(window.FMC&&window.FMC.View&&window.FMC.View.EditableView);}catch(e){return false;}
}
/* Verify every value the script applied, at the instant the final Submit fires. A control
   the user owns is skipped by design - it is theirs, and whatever they chose is correct. */
function verifyAtSubmit(){
    var miss=[],named=fmcViewLayerPresent();
    Object.keys(WANT).forEach(function(k){
        var e=WANT[k];
        if(e.gen!==GEN||wantStaleModal(e)){wantDrop(k);return;} // superseded, or a form that is gone
        var el=wantResolve(e);
        if(!el){miss.push(e.label);return;}
        if(isManual(el))return;
        if(!wantHolds(e,el)){miss.push(e.label);return;}
        if(DATE_KINDS[e.key]&&dateEpochState(el)<0){miss.push(e.label+" (not read by FMC)");return;}
        if(named&&!el.name)miss.push(e.label+" (not a model field)");
    });
    if(miss.length)toast("\u26A0 Submit: "+miss.join(", ")+" not in the load - check before submitting",1);
    return miss;
}
/* The FINAL Submit only - "Submit for validation" is a different button and is matched
   out explicitly (normalised text must be exactly "submit"). Capture phase on document so
   it runs before FMC's own click handler, and before any stopPropagation. */
function isFinalSubmitButton(b){
    if(!b)return false;
    if(b.closest&&b.closest("#grt"))return false;
    var t=(b.textContent||b.value||"").replace(/\s+/g," ").trim().toLowerCase();
    return t==="submit";
}
document.addEventListener("click",function(e){
    if(!ENABLED)return;
    var t=e.target;
    if(!t||!t.closest)return;
    var b=t.closest("button,input[type=button],input[type=submit],a[role=button]");
    if(isFinalSubmitButton(b)){try{verifyAtSubmit();}catch(err){console.warn("[Rohit] submit check failed",err);}}
},true);

/* ═══ CLEAR FMC TIMINGS ═══
   clearDT() necessarily calls inp.focus() on the real FMC field to make the clear
   "stick" (same requirement setDT has for filling). The refocus-the-box calls that used
   to run inside clearDT and at the end of the chain are GONE with the paste box
   (16.0.2 no-box): the "paste after Clear" bug they existed to fix was a bare Ctrl+V
   being dispatched at whatever FMC field clearDT had last focused instead of reaching
   the panel's box, and that cannot happen any more - the window capture-phase net sees
   the paste wherever it is aimed. Everything about WHAT is cleared is unchanged. */
function clearDT(inp){if(!inp)return;inp.focus();inp.click();NS.call(inp,"");inp.dispatchEvent(new Event("input",{bubbles:true}));inp.dispatchEvent(new Event("change",{bubbles:true}));rFire(inp);inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",code:"Backspace",keyCode:8,bubbles:true}));setTimeout(function(){inp.dispatchEvent(new Event("blur",{bubbles:true}));},100);}
/* ROOT CAUSE (16.0.2, "after a paste finishes, Clear does nothing" - see report.md):
   this used to skip a field entirely with `if(!el.value)continue` BEFORE ever
   scheduling its clearDT() call. Right after a paste, FMC can still be settling
   (the real timing fields are a lazily-initialized jQuery widget - see setDT) or
   can have just re-rendered the stop/timing block (the same class of re-render
   change 2 found for createReason) - findTI() re-resolving to elements whose
   `.value` reads empty at that EXACT instant (even though they are about to hold,
   or the user still visually sees, a value) made Clear silently decide there was
   "nothing to clear" and skip every field, with no error and no visible sign to a
   user who has no console. Every resolved field is now ALWAYS cleared
   unconditionally - clearing an already-empty field is harmless, and this is the
   only way to guarantee Clear can never silently no-op right after a paste.
   TIMINGS AS SHIPPED (these two lines used to claim the stagger had been cut and that
   clearDT() was fully synchronous - neither is true of the code below): the Clear
   button's path still staggers 300ms per field, and clearDT() does its DOM work
   synchronously but still defers that field's blur by 100ms. Only Ctrl+G's path skips
   the stagger, by passing sync=true - see clearFmcTimings' own comment for why. */
/* One field's clear: re-resolve the slot first (the modal/stop block may have been
   re-rendered since the chain was scheduled - see MODAL IDENTITY), then clear, then
   RE-READ that field. st.done/st.left count what the DOM confirmed, which is what the
   toast reports - not how many fields were resolved when the chain started (16.0.2
   toast audit: "4 FMC timings cleared OK" used to fire even when all four writes had
   landed in detached nodes). A slot that no longer exists in the live form holds
   nothing and is counted as done, not as a failure. */
function clearOneTiming(slot,el,modalAtStart,st){
    var live=resolveTimingTarget(slot,el,modalAtStart);
    if(!live){st.done++;return;}
    // clearDT's DOM work is synchronous (only its blur is deferred, and a blur never
    // marks anything), so the ONE writer guard covers it - a clear must never be read
    // back as the user emptying the field by hand.
    dropManual(live);wantDrop(slot);
    beginWrite();expectWrite(live,"");
    try{clearDT(live);}finally{endWrite();}
    if(String(live.value||"").trim()==="")st.done++;else st.left++;
}
/* sync=true (Ctrl+G's clearFmcForm only): clear every resolved field IMMEDIATELY
   instead of over the 300ms-per-field chain. Ctrl+G clears the Route too, and on the
   real page that single change makes FMC rebuild the stops collection and re-render
   the stop blocks - so a staggered chain's later ticks would find their fields already
   destroyed and the timings would never clear in FMC's own model. Clearing them in the
   same synchronous turn, BEFORE the Route goes, is what makes the model-level clear
   real. The Clear button keeps the original staggered path unchanged. */
function clearFmcTimings(myToken,sync){
    if(!ENABLED)return 0;
    var modalAtStart=findModal();
    var ti=findTI();var slots=["arr1","dep1","crit","arr2"];
    var st={done:0,left:0},n=0,delay=0;
    // An EXPLICIT clear outranks a manual mark: the user asked for these fields to be
    // emptied, so their own mark and any pending re-apply for them are dropped first -
    // otherwise Clear would silently refuse to clear exactly the field they had typed by
    // hand. This is the only place the manual mark is overridden, and it is overridden by
    // the user's own newer action, never by the script's automatic work.
    for(var di=0;di<slots.length;di++){dropManual(ti[slots[di]]);wantDrop(slots[di]);}
    for(var i=0;i<slots.length;i++){var el=ti[slots[i]];if(!el)continue;n++;
        if(sync)clearOneTiming(slots[i],el,modalAtStart,st);
        else{(function(s,inp,d){genTimeout(myToken,function(){clearOneTiming(s,inp,modalAtStart,st);},d);})(slots[i],el,delay);delay+=300;}
    }
    // (The refocus-the-box step that used to run here, sync or at the end of the
    // staggered chain, went with the paste box - see clearDT's note above.)
    genTimeout(myToken,function(){
        if(st.left)toast("\u26A0 "+st.left+" timing field(s) did not clear",1);
        else if(st.done)toast(st.done+" FMC timings cleared \u2705");
        else toast("\u26A0 No timing fields found",1);
    },delay+200);
    return n;
}

/* ═══ RUN ATS (equipment button click) ═══ */
function runATS(eq,lt,ut,vn){
    if(!ENABLED){offToast();return;}
    var cn=ST.carrier||"RLB1";
    // Create Reason: set REASON_WANTED and let applyReason()/wantPoll() (see
    // "CREATE REASON" above) do the actual commit - a plain setSel() one-shot write
    // does not survive FMC's post-validation re-render of this control (root cause,
    // see report.md), so reason is deliberately NOT part of the generic flds/setSel
    // retry loop below any more.
    // MODAL IDENTITY for this button's own deferred writes (see staleModal): the carrier
    // commit 100ms in, the timings 800ms in, and the field loop below, which re-applies
    // for up to 7.5s. All of them are for the load that was open when the button was
    // clicked; if FMC has replaced the dialog since, they stop instead of filling the
    // next load with this one's equipment/reason/carrier.
    var modalAtStart=findModal();
    REASON_WANTED=REASON_ENUM[ST.reason]||REASON_ENUM["1"];
    REASON_APPLIED_TO=null;
    applyReason();
    setTimeout(function(){if(staleModal(modalAtStart))return;fillCarrier(cn);},100);
    wantSet("carrier","Carrier",cn,{allowCreate:true});
    // The 800ms "re-fill the timings from whatever text is still in the box" step is
    // gone with the box (16.0.2 no-box). It could only ever fire on text the box still
    // held, and the paste path cleared the box at the END of every processPastedText()
    // AND preventDefault()ed the insertion in the first place - so after any real paste
    // the box was empty and this branch did nothing. It was textarea-only machinery,
    // and the timings now come from the Paste button / Ctrl+V net alone. The equipment
    // button's own writes (reason, carrier, the four type selects) are untouched.
    // NOTE: Operator type intentionally NOT set here -> user picks it manually.
    // INTENT (answers the reviewer's "decide and state it" on Load type / Unload type):
    // those two are filled HERE, by the equipment button, and deliberately NOT by a
    // paste. A paste applies the LANE and the FOUR TIMINGS only - the pasted block
    // carries no load/unload type, so a paste could only guess, and guessing a type
    // dropdown is the thing the user explicitly asked not to have done for them
    // (same reason Operator type is left alone). Unload type is a required-field on the
    // real rendered form, so one paste alone does not complete the form by design:
    // paste the block, then click the equipment button.
    var flds=[{pat:/freight/i,skip:/identifier/i,val:"Truckload",name:"freightType",label:"Freight type"},{pat:/equipment/i,skip:null,val:eq,name:"equipmentType",label:"Equipment type"},{pat:/load.?type/i,skip:/unload/i,val:lt,name:"loadType",label:"Load type"},{pat:/unload/i,skip:null,val:ut,name:"unloadType",label:"Unload type"}];
    var att=0;var tmr=setInterval(function(){
        // A different dialog instance is a different load - stop re-applying (silent for
        // the same reason fillStops' poll is: the form these values were for is gone).
        if(staleModal(modalAtStart)){clearInterval(tmr);return;}
        att++;applyReason();
        // Every tick RE-READS each control (selHoldsVal) instead of trusting that an
        // earlier setSel() returned true (16.0.2 toast audit): FMC can re-render a
        // field blank after a successful write, and reporting the WRITE as success
        // while the live form is empty is the same false-success pattern the timings
        // toast had. A field that no longer holds its value is simply re-written, and
        // the success toast below can only fire once every field reads back correct.
        var left=0;for(var fi=0;fi<flds.length;fi++){var f=flds[fi];
            if(f.done&&!selHoldsVal(f.name,f.pat,f.skip,f.val))f.done=false;
            if(f.done)continue;
            if(setSel(f.pat,f.skip,f.val,f.name)&&selHoldsVal(f.name,f.pat,f.skip,f.val))f.done=true;else left++;
            // Re-registered on EVERY tick a field reads back correct, not just on the
            // transition to done: this loop's own fillTimings call starts a new
            // generation 800 ms in, and the registry drops entries from an older one, so
            // a one-shot registration here would be thrown away before FMC ever
            // re-renders. A control the user owns is never registered.
            if(f.done){var fEl=resolveSelByLabel(f.name,f.pat,f.skip);
                if(fEl&&!isManual(fEl))wantSet("sel:"+f.name,f.label,f.val,{nameAttr:f.name,pat:f.pat,skip:f.skip});}
        }
        // Reason counts as "done" once applyReason() has committed it OR the control is
        // marked manual (the user's own pick is deliberately left alone - never "pending").
        var rSel=findReasonSelect();
        var reasonDone=!!((rSel&&isManual(rSel))||(REASON_APPLIED_TO&&rSel===REASON_APPLIED_TO&&normFT(rSel.value)===normFT(REASON_WANTED)));
        if((left===0&&reasonDone)||att>=15){clearInterval(tmr);if(left===0&&reasonDone)toast(eq+" \u2705 ["+cn+"] 0"+gCur(ST.origin));else toast((left+(reasonDone?0:1))+" pending",1);}
    },500);
    // Vehicle name: never overwrites a name the user typed by hand (item 1a), and what
    // the script does write is registered so a re-render cannot drop it (item 1b).
    if(vn){var vinp=findVehicleNameInput();
        if(vinp&&!isManual(vinp)){
            beginWrite();
            try{NS.call(vinp,vn);vinp.dispatchEvent(new Event("input",{bubbles:true}));vinp.dispatchEvent(new Event("change",{bubbles:true}));rFire(vinp);}finally{endWrite();}
            wantSet("vname","Vehicle name",vn);
        }}
}

/* ═══ ROUTE WATCHER ═══ */
/* force=true bypasses the LAST_ROUTE dedupe guard. The guard still protects the
   passive 600ms route-field poller from re-firing on an unchanged value, but explicit
   user actions (paste, History click) must always re-run so currency/cost/stops are
   re-evaluated for every lane, including repeats and alternating UK/EU/UK sequences. */
/* myToken: pass the token from an already-started generation (Go, or the paste flow
   which starts its own generation covering timings too) so onRouteChange's delayed
   steps share that SAME generation. If omitted, onRouteChange starts its own. */
function onRouteChange(lane,force,myToken){
    if(!ENABLED)return;
    var m=lane.toUpperCase().match(/([A-Z0-9]{3,6})\s*[-=>\u2192]+\s*([A-Z0-9]{3,6})/);
    if(!m)return;
    var o=m[1],d=m[2],fullLane=o+"->"+d;
    if(!force&&fullLane===LAST_ROUTE)return;
    if(myToken===undefined)myToken=startGen();
    // A DIFFERENT lane is a different load: drop everything the re-apply registry was
    // still holding for the previous one, so an equipment type or stop location from the
    // last load can never be re-applied onto this one. Re-applying the SAME lane (a
    // repeat paste, a second Go) keeps the registry, which is the point of it.
    if(fullLane!==LAST_ROUTE)wantClear();
    LAST_ROUTE=fullLane;ST.lane=fullLane;ST.origin=o;
    // Shipper is set synchronously (ST.origin/LAST_ROUTE must be current immediately,
    // other code reads them right away), but the actual DOM write is nudged a few ms
    // into a genTimeout so overlapping actions settle in the same relative order as
    // cost/currency/stops - avoids a write landing before its OWN action's settle
    // window while a slightly-older action's is still open, which looks like staleness
    // even though every value is for the lane that was current when IT ran.
    // NOTE: the hard "under 1s" speed requirement is specifically about the TIMING
    // fields (see fillTimings/setDT) - shipper/cost/currency/stops keep their
    // original 410/430/500ms relative spacing unchanged, since currency in
    // particular has its own legitimate ~700ms authoritative re-apply
    // (scheduleReapply) that these values were tuned against; cutting them was not
    // needed to meet the user's actual request and risked destabilizing the
    // existing, already-proven stale-write guarantees for those fields.
    // MODAL IDENTITY for every deferred step below (see staleModal). Captured HERE, at
    // the start of the lane's write burst and AFTER the route write that makes FMC
    // rebuild its stop blocks - the same place and the same rule applyTimings uses for
    // the timing fields. A re-render INSIDE this dialog keeps the element, so this
    // load's own writes still land; a replaced dialog is the next load, and then
    // shipper / cost / currency / stops stop writing instead of filling it with these
    // values.
    var modalAtStart=findModal();
    var info=fillShipper(o,myToken,fullLane);
    genTimeout(myToken,function(){fillCost(o,fullLane,myToken,modalAtStart);},430);
    genTimeout(myToken,function(){fillStops(o,d,myToken,modalAtStart);},500);
    /* LANE-TYPE POPUP REMOVED (user request, confirmed twice: "intermodal lanes come
       and it shows a popup saying IM when I enter the lane - I don't want that" then
       "IM / SEA - I don't want these two, don't show them to me. Or else remove them
       from the script"). The blocking lane-type overlay that listed SEA/IM/TTA per lane,
       its own element id, its OK button, the Escape-to-close branch and the whole LM
       lane-type map that fed it are gone - nothing replaces them, and no identifier or
       stylesheet rule for it survives anywhere in this file. What was applied is still
       confirmed by the verified toast just below and by the panel's own status line. */
    var manualTag=info.manual?(info.sh?"manual":"manual: none"):"";
    /* VERIFIED lane toast (16.0.2 toast audit). The shipper and cost/currency writes
       above are DEFERRED (410/430ms), so the old toast fired GREEN the instant the
       lane was parsed - a claim about what had been SCHEDULED. On a form FMC had
       re-rendered out from under those writes it still said "Shipper+Cost+Stops filled
       OK" while nothing landed (exactly what the live "0/4 timings OK" report looked
       like). It now fires after those writes' own window and only describes what the
       DOM really holds. The stops are no longer claimed here at all - fillStops()
       owns their own confirmed "Stop1=.. Stop2=.. OK" / "Stops not filled" toast and
       may legitimately still be polling at this point. */
    genTimeout(myToken,function(){
        // Same rule as the writes it reports on (see staleModal): once FMC has replaced
        // the dialog, the shipper/cost writes above have correctly refused to write and
        // this toast would describe a form the user has already left - so it says
        // nothing at all rather than warning about a load that no longer exists. It
        // never goes the other way: a dialog that is still THERE and still empty is
        // reported as "not filled", exactly as before.
        if(staleModal(modalAtStart))return;
        var shOk=info.manual||shipperHolds(info.sh);
        var costOk=costFieldsHold();
        var miss=[];
        if(!shOk)miss.push("Shipper");
        if(!costOk)miss.push("Cost");
        var kept=info.manual?(" \u2192 Shipper kept ("+manualTag+"), "):" \u2192 ";
        if(!miss.length)toast(fullLane+kept+(info.manual?"Cost filled \u2705":"Shipper+Cost filled \u2705"));
        else toast("\u26A0 "+fullLane+kept+miss.join("+")+" not filled",1);
    },700);
    uStat(fullLane+" | "+(info.manual&&!info.sh?"none":(info.isIP?"IP":"ATS"))+(info.manual?" (manual)":"")+" | 0"+(gCur(o)||"?"));
}
/* GO GATE (16.0.1): typing/editing/pasting in the FMC Route field never auto-applies
   anything any more. The passive poller and attachEvents only show/hide/reposition the
   floating Go button; the actual apply (shipper/cost/currency/stops) runs ONLY from
   goClick() when the user presses Go, or from the paste box (explicit user action,
   unchanged - see TIMINGS PASTE below). Parses the field with the SAME regex/normalize
   onRouteChange uses so whitespace/case/arrow variants of the already-applied lane never
   pop the button up again. */
function parseLaneText(v){
    var m=(v||"").toUpperCase().match(/([A-Z0-9]{3,6})\s*[-=>\u2192]+\s*([A-Z0-9]{3,6})/);
    return m?(m[1]+"->"+m[2]):null;
}
function startRouteWatcher(){
    // The SAME two intervals as every build since 16.0.1 - their bodies are gated on
    // ENABLED (item 3) rather than the intervals being torn down and recreated, so
    // interval and listener counts stay flat across any number of off/on cycles.
    // wantPoll() replaces reasonPoll() here: one bounded re-apply pass for every
    // registered control instead of a dedicated poll for Create reason alone (item 1b).
    setInterval(function(){if(!ENABLED)return;updateGoButton();bindManualJQuery();wantPoll();},600);
    var attachEvents=function(){if(!ENABLED)return;var ri=findRouteInput();if(!ri||ri._grtWatched)return;ri._grtWatched=true;
        var handler=function(){updateGoButton();};
        ri.addEventListener("input",handler);ri.addEventListener("change",handler);ri.addEventListener("keyup",handler);
        ri.addEventListener("paste",function(){setTimeout(handler,0);});
        ri.addEventListener("blur",handler);};
    ATTACH_ROUTE_EVENTS=attachEvents;   // re-run immediately on turn-on, not on the next 2 s tick
    attachEvents();setInterval(attachEvents,2000);
    window.addEventListener("scroll",function(){updateGoButton();},true);
    window.addEventListener("resize",function(){updateGoButton();});
}

/* ═══ GO BUTTON ═══
   One floating element appended to document.body (never inserted into FMC's
   React-managed DOM, so a re-render can't remove it or throw). Re-finds the Route
   input every time - no stale references kept. z-index 100000: above the FMC load
   modal and this script's own panel (99999), below the confirmation overlay (999999). */
var GO_BTN=null;
function buildGoButton(){
    if(GO_BTN)return GO_BTN;
    var b=document.createElement("button");
    b.type="button";b.id="grt-go";b.textContent="Go";b.setAttribute("aria-label","Apply lane");
    b.setAttribute("style","position:fixed;display:none;z-index:100000;height:26px;padding:0 14px;border-radius:13px;background:#2a2160;border:1px solid #a78bfa;color:#fff;font-weight:bold;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,0.35);cursor:pointer;line-height:24px;box-sizing:border-box;font-family:Arial;");
    b.addEventListener("mouseenter",function(){b.style.background="#3a2d80";});
    b.addEventListener("mouseleave",function(){b.style.background="#2a2160";});
    // A mouse click must never move focus off the Route input or change its value.
    b.addEventListener("mousedown",function(e){e.preventDefault();});
    b.addEventListener("click",function(e){
        e.preventDefault();
        try{goClick();}catch(err){console.warn("[Rohit] Go click failed",err);toast("\u26A0 Go failed, try again",1);}
    });
    document.body.appendChild(b);
    GO_BTN=b;
    return b;
}
/* Shows iff: the Route field exists, is visible, its current text is non-empty AND the
   lane it parses to (same regex/normalization as onRouteChange) differs from LAST_ROUTE
   (the last APPLIED lane - whether applied via Go or the paste box). */
function updateGoButton(){
    var btn=buildGoButton();
    if(!ENABLED){btn.style.display="none";return;}   // item 3: no Go button at all while off
    var ri=findRouteInput();
    if(!ri){btn.style.display="none";return;}
    var r=ri.getBoundingClientRect();
    if(r.width===0&&r.height===0){btn.style.display="none";return;}
    var v=(ri.value||"").trim();
    if(!v){btn.style.display="none";return;}
    var lane=parseLaneText(v);
    if(!lane||lane===LAST_ROUTE){btn.style.display="none";return;}
    btn.style.left=(r.right+8)+"px";
    btn.style.top=(r.top+r.height/2-13)+"px";
    btn.style.display="block";
}
/* Click Go: read the Route field AT CLICK TIME (never a stale value) and run the full
   apply, same as onRouteChange(lane,true) - shipper/cost/currency/stops. Clicking Go
   again on the same lane simply re-applies (harmless, same as any force=true call). */
function goClick(){
    if(!ENABLED){offToast();return;}
    var ri=findRouteInput();
    if(!ri){toast("\u26A0 Open the load first",1);return;}
    var v=(ri.value||"").trim();
    var lane=parseLaneText(v);
    if(!lane){toast("\u26A0 No lane found",1);return;}
    onRouteChange(lane,true);
    if(GO_BTN)GO_BTN.style.display="none";
}

/* ═══ TIMINGS PASTE (16.0.1: generation-token rewrite) ═══
   Every explicit action (the Paste button, the window Ctrl+V net, Clear) starts a NEW
   generation via startGen() BEFORE touching anything, so an overlapping older action's
   still-pending delayed work (currency re-verify, timings setDT chain, stops poll, auto
   submit-for-validation) can never land after a newer action has started - this fixes
   the stale-write and multi-submit bugs the stress suite found.
   TWO ENTRY POINTS, ONE PIPELINE (16.0.2 no-box): doPaste() (clipboard API) and the
   window capture-phase paste listener (bare Ctrl+V, timings-looking clipboard only)
   both call queuePaste(). Nothing else writes FMC on a paste.
   PROCESSED_PASTE_EVENTS (a WeakSet) stops the SAME physical paste event from being
   handled twice if more than one listener ever sees it - never a time-based dedupe, so
   two genuinely different pastes (even identical text) are always both processed. */
var PROCESSED_PASTE_EVENTS=(typeof WeakSet!=="undefined")?new WeakSet():null;
function markPasteEventProcessed(e){
    if(!e)return false; // no event object (e.g. Paste button / prompt-less clipboard read) - always process
    if(!PROCESSED_PASTE_EVENTS)return false;
    if(PROCESSED_PASTE_EVENTS.has(e))return true;
    PROCESSED_PASTE_EVENTS.add(e);
    return false;
}
/* The second dedupe, kept after the box was removed. One physical Ctrl+V dispatches ONE
   paste event object through capture and bubble, which PROCESSED_PASTE_EVENTS already
   collapses on its own; this guard covers the case the WeakSet cannot see - two
   DIFFERENT event objects produced by the same physical paste inside one synchronous
   cascade (a page that re-dispatches, or any future second listener). It is why a
   single physical paste can never be applied twice even though two entry points exist.
   16.0.1 used a 120ms WALL-CLOCK window for this, which is wrong: with pastes spaced
   as little as 50ms apart (a fast user, or the stress harness) that window drops
   GENUINELY NEW later pastes outright. A wall-clock window can never tell "two
   listeners, one physical paste" apart from "two different physical pastes" by time
   alone - only being in the SAME synchronous/microtask turn can. PASTE_CLAIMED is
   therefore cleared on the very next microtask (Promise.resolve().then), not after a
   fixed delay: it only ever collapses listeners reacting to the SAME physical event
   cascade (always resolved within the same tick), and unconditionally reopens before
   any later real paste - even one only 1ms later - can ever reach claimPaste(). */
var PASTE_CLAIMED=false;
function claimPaste(){
    if(PASTE_CLAIMED)return false;
    PASTE_CLAIMED=true;
    Promise.resolve().then(function(){PASTE_CLAIMED=false;});
    return true;
}
/* ═══ IS THIS CLIPBOARD A TIMINGS BLOCK? ═══
   The ONE test the silent Ctrl+V net uses to decide whether a paste is meant for this
   script. With the panel's own textarea gone there is no target id to key on any more,
   so the decision has to come from the TEXT, and it has to be conservative: a paste
   that is not clearly a timings block must be left completely alone (not claimed, not
   processed, never preventDefault()ed) so the user can still paste normally into any
   real FMC field - a lane into Route, a VRID into a filter, anything.
   DERIVED FROM parseTimings ITSELF, deliberately - NOT a second pattern. An earlier
   draft of this used its own three regexes (a SAT|SDT|CPT label, a slash date, an
   HH:MM time, each anywhere in the text) and that is a drift hazard: if parseTimings'
   accepted shape ever changes, a separate copy of the rule silently starts accepting or
   rejecting the wrong things, and with the box gone a MISSED paste is invisible - no
   box to look at, nothing to retry. So the gate simply asks the real parser whether it
   found anything: parseTimings pushes a record only for a line that carries one of the
   SAT: / SDT: / CPT: labels TOGETHER WITH a slash date and an HH:MM time (its own
   /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/ match, on that SAME line - which
   is stricter than three independent regexes, and exactly the shape the requirement
   describes), and it returns early with nothing at all when there is no such line.
   A record that WAS recognised but could not be emitted counts as ours too (r.bad /
   r.warn): that text is a timings block the user expects something to happen for, so it
   must reach processPastedText and produce the real warning instead of silence.
   parseTimings is frozen and is only CALLED here, never changed. It is cheap on a
   non-timings clipboard - the no-record early return happens before any date-order or
   DOM work - and it is wrapped so a throw can never swallow a user's ordinary paste. */
function looksLikeTimings(txt){
    if(!txt||typeof txt!=="string")return false;
    if(txt.length>20000)return false;   // not a timings block; never scan an arbitrarily large clipboard
    try{
        var r=parseTimings(txt);
        return !!(r.vA||r.vD||r.vC||r.vA2||(r.bad&&r.bad.length)||r.warn);
    }catch(err){return false;}
}
/* The ONE function every paste path funnels through. Takes the generation token its
   caller already started (via queuePaste - see below), applies the lane (force=true,
   same generation token so a stale currency/stops step from THIS lane never survives a
   newer action either) and schedules the timings fill under the same token. The old
   finally block that cleared and re-focused the panel textarea is gone with the box;
   the try/catch stays, so an exception anywhere above still ends in one honest warning
   toast instead of a silent dead paste (stress F1). */
function processPastedText(text,myToken){
    if(myToken===undefined)myToken=startGen();
    try{
        var trimmed=(text||"").trim();
        if(!trimmed){toast("\u26A0 No timings found",1);return;}
        if(!findModal()&&!findRouteInput()){toast("\u26A0 Open the load first",1);return;}
        var ad=parseTimings(trimmed);
        if(ad.sdtEpoch)calcCarrier(ad.sdtEpoch);
        applyPastedForm(trimmed,ad,myToken,0);
    }catch(err){
        console.warn("[Rohit] paste failed",err);
        toast("\u26A0 Paste failed, try again",1);
    }
}
/* Applies the pasted lane + schedules the timings fill. Split out of
   processPastedText for the 16.0.2 blocker: right after Ctrl+G the Route input can be
   MISSING for a moment (FMC re-renders the route summary / stop blocks when the Route
   change rebuilds its stops collection - see MODAL IDENTITY), and the old code just
   skipped the route write silently, called onRouteChange anyway and reported success -
   findModal() still resolves off the surviving carrier/shipper selects, so the "Open
   the load first" guard never tripped either. The Route lookup is now retried a few
   times (bounded: 5 x 300ms, with ONE re-render nudge on the first miss), and if it
   still is not there the user gets a WARNING naming the real problem. Everything else
   (the route write itself, onRouteChange, and the timings defer - now 60ms, item 2) is
   unchanged in shape, and on attempt 0 - every normal paste - this still runs
   synchronously inside processPastedText. */
var RI_RETRY_MAX=5,RI_RETRY_MS=300;
function applyPastedForm(trimmed,ad,myToken,attempt){
    if(myToken!==undefined&&myToken!==GEN)return;
    if(ad.o&&ad.d){
        var ls=ad.o+"->"+ad.d;
        var ri=findRouteInput();
        if(!ri&&attempt<RI_RETRY_MAX){
            if(attempt===0)nudgeFormRerender(myToken,"route");
            genTimeout(myToken,function(){applyPastedForm(trimmed,ad,myToken,attempt+1);},RI_RETRY_MS);
            return;
        }
        if(ri){NS.call(ri,ls);ri.dispatchEvent(new Event("input",{bubbles:true}));ri.dispatchEvent(new Event("change",{bubbles:true}));rFire(ri);}
        else toast("\u26A0 Route field not found, reopen the load",1);
        onRouteChange(ls,true,myToken);
        updateGoButton();
    }else{
        toast("\u26A0 No lane found",1);
    }
    /* 60ms (it was 600ms for three rounds). FOURTH SPEED ATTEMPT - SHIPPED (16.0.2
       item 2, the user's "the timings must come automatically, fast, within a second").
       queuePaste's 500ms entry defer is KEPT: it is the load-bearing half, the thing
       that makes a superseded paste never write at all, and keeping it also means every
       field still lands later than the 490ms window the stress suite uses to attribute
       a write to a paste, so the stale-write detection keeps its full discriminating
       power (the two earliest attempts had to recalibrate that window down to ~30ms,
       which is why their "clean" runs proved little). Only the post-debounce fill was
       compressed: 600 -> 60 here, the per-field stagger 400 -> 110, setDT's internal
       150/100 -> 50/40. MEASURED paste-to-LAST-timing-field, 20 pastes: median 940ms,
       worst 940ms, against 2450ms before.
       WHY IT SHIPS NOW, after being deferred three times: the one scenario that blocked
       it was stress CONT2 (30 pastes with the FMC modal REBUILT between them and no
       re-click), which showed 7 stale writes on the STOP LOCATIONS and the CURRENCY at
       dt~900ms - an older load's fillStops poll / currency re-apply landing in the new
       load's form. The timing path was already clean because it bails on a different
       modal instance; those two paths only had the generation token, which cannot see a
       rebuild when no newer paste has started yet. Every deferred writer on this path
       now shares that rule - see staleModal() - and CONT2 is back to 0 stale writes
       WITH the compressed delays. */
    genTimeout(myToken,function(){fillTimings(trimmed,myToken);},60);
}
/* Entry point for every paste source (Ctrl+V, Paste button, page-intercepted paste,
   input fallback). Starts the new generation IMMEDIATELY (so it supersedes an older
   paste's pending work right away, same instant the user's keystroke/click happens),
   but defers the actual field-writing (processPastedText) by 500ms. A paste that
   lands within that window (two Ctrl+V's close together) therefore never gets to
   write anything at all for the superseded generation - startGen()'s own timer sweep
   cancels its still-pending genTimeout before it fires - instead of letting an older
   paste's synchronous writes land first and then race a newer one.
   16.0.2 NOTE: this 500ms is DELIBERATELY KEPT at full length, including in the round
   that finally shipped the sub-1-second fill (item 2). It is the load-bearing half of
   the pipeline - the only thing that makes a superseded paste write nothing at all -
   and every earlier attempt that cut it exposed real stale writes under sustained
   paste load. Only the POST-debounce fill was compressed (see applyPastedForm's
   fillTimings defer, applyTimings' stagger and setDT's internal delays): 500 + 60 +
   3x110 + 50 = 940ms to the last field, which meets the user's requirement without
   touching the debounce. */
function queuePaste(text){
    if(!ENABLED)return;   // item 3: a paste into the box is not processed while off
    var myToken=startGen();
    // 16.0.2 NOTE: three earlier attempts cut THIS delay (to 20ms, then 450ms) and each
    // one exposed a real bug rather than a test artifact - fillCarrier/setSelect2 had NO
    // generation-token check at all, and setDT's own internal deferred write was a bare,
    // un-gated setTimeout (both fixed and kept), and finally fillStops / the currency
    // re-apply had no modal-identity rule (fixed this round - see staleModal). The
    // under-1-second target was met WITHOUT cutting this one: it stays at 500ms.
    genTimeout(myToken,function(){processPastedText(text,myToken);},500);
}
/* ═══ THE PASTE BUTTON IS THE ONE PATH (16.0.2 no-box) ═══
   With the textarea gone this button IS the feature: it reads the clipboard itself and
   runs the exact same pipeline a paste into the box used to run (queuePaste ->
   processPastedText -> the lane into Route + onRouteChange's full apply, shipper /
   Cost 0 / currency / stops, then fillTimings), under ONE generation token, with the
   modal-identity guard and the verified toasts untouched. There is no second
   implementation of any of it.
   CLIPBOARD PERMISSION IS THE ONE REAL RISK. navigator.clipboard.readText() rejects
   when the document is not focused or the permission was denied, and it can resolve
   with an empty string. The old fallback was "use Ctrl+V in the box" and the box no
   longer exists, so the message now names the only action that still works - Ctrl+V,
   which the window net below picks up - and it is a WARNING toast. Never a prompt(). */
function clipboardBlocked(){toast("\u26A0 Clipboard blocked, press Ctrl+V",1);}
function doPaste(){
    if(!ENABLED){offToast();return;}
    if(!(navigator.clipboard&&navigator.clipboard.readText)){clipboardBlocked();return;}
    var p;
    // readText() can THROW synchronously (older engines / a revoked permission) as well
    // as reject, and a stub can return something that is not a promise at all.
    try{p=navigator.clipboard.readText();}catch(err){clipboardBlocked();return;}
    if(!p||typeof p.then!=="function"){clipboardBlocked();return;}
    p.then(function(t){
        // An empty read is treated exactly like a blocked one: there is nothing to
        // apply, and "No timings found" would blame the text when the real cause is
        // just as likely a read the browser quietly emptied. One message, one action.
        if(!t||!String(t).trim()){clipboardBlocked();return;}
        queuePaste(t);
    }).catch(function(){clipboardBlocked();});
}
/* ═══ CTRL+V SAFETY NET - capture phase, on window, completely silent ═══
   The Paste button cannot be the only path: readText() is exactly the call that fails
   when the document is not focused or the permission was denied, and with the box gone
   there is nothing left to Ctrl+V into. So a bare Ctrl+V anywhere on the page still
   works - but ONLY when the clipboard text LOOKS LIKE A TIMINGS BLOCK
   (looksLikeTimings). This is the whole of the net; it adds no UI of any kind.
   - Capture on window runs FIRST, before any FMC/page handler can stopPropagation()
     (stress G1) or preventDefault() (G2) it, and clipboardData is read directly, so
     nothing here depends on the browser's own default insertion.
   - NOT a timings block -> this listener does NOTHING AT ALL: no claim, no
     preventDefault, no FMC write. A normal paste into any real FMC field behaves
     exactly as if this script were not installed. That is the whole reason the sniff
     is a three-part test and not "any text".
   - A timings block -> preventDefault() (the block must not be dumped into whatever
     field happens to be focused - setDT leaves focus on an FMC timing input after
     every fill, so that is the usual target) and then the SAME queuePaste the Paste
     button uses, same pipeline, same token, same guard.
   - Processed EXACTLY ONCE per physical paste, by two independent dedupes that were
     already here: PROCESSED_PASTE_EVENTS (one event object seen in capture and bubble)
     and claimPaste() (two different events inside one physical paste's cascade).
   - ENABLED-gated like every other entry point, and while off it does not even
     preventDefault, so Ctrl+V is completely normal with the script switched off. */
window.addEventListener("paste",function(e){
    if(!ENABLED)return;
    var txt=(e.clipboardData&&e.clipboardData.getData("text/plain"))||"";
    if(!looksLikeTimings(txt))return;   // not ours - leave the event entirely alone
    if(markPasteEventProcessed(e))return;
    try{e.preventDefault();}catch(err){}
    if(!claimPaste())return;
    queuePaste(txt);
},true);

/* ═══ CTRL+G: CLEAR FMC FORM + REFRESH PANEL ═══
   CORRECTED REQUIREMENT (the user rejected a page reload twice, then insisted
   decisively on this instead - see report.md "CHANGE 4 CORRECTION"): Ctrl+G NEVER
   reloads or navigates the page. It (a) empties every Manual Scheduling field the
   script can write, scoped to findModal() so FMC's search-panel filters (e.g. the
   shipperAccounts multi-select) and anything inside #grt are never touched, writing
   each clear the way the script's own writers already do (native setter + input/
   change + rFire, or setSelect2()'s jQuery commit for Select2-backed controls) so
   FMC's own model really clears, not just the visible DOM; and (b) rebuilds the #grt
   panel from scratch via buildPanel(), which already restores the saved
   winkiro.state/winkiro.rect/winkiro.prevState/winkiro.maxPos on every call. */
/* guardSetter: for shipperAccount/createReason selects, the SAME writer guard
   (beginWrite/endWrite - the one flag every write in this file now uses) their own
   fillShipperDom()/applyReason() writes take - without it, this clear's own change event
   is indistinguishable from a real user edit and would wrongly mark the (now-blank)
   select "manual" forever, silently blocking every future auto-fill for the rest of the
   session (found by the RAND100-style Ctrl+V-after-refresh harness check - see
   report.md). */
/* An ALREADY-BLANK field is left completely alone (16.0.2): on the real page every
   control's change event writes FMC's model and can drive a view re-render, so firing
   a blank change into a field that is already blank is a pure re-render trigger with
   no clearing value at all. Skipping it keeps a second Ctrl+G (or a Ctrl+G on a fresh
   load) from tearing the form down for nothing. */
function clearNativeField(field,guardSetter){
    if(!field)return;
    if(String(field.value||"").trim()==="")return;
    if(guardSetter)guardSetter(true);
    beginWrite();                 // every clear is one of the script's own writes
    expectWrite(field,"");
    try{
        if(field.tagName==="INPUT"){NS.call(field,"");field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}));rFire(field);}
        else if(field.tagName==="SELECT"){setSelect2(field,"",false)||(function(){var setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,"value");if(setter&&setter.set)setter.set.call(field,"");else field.value="";field.selectedIndex=0;field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}));rFire(field);})();}
    }finally{endWrite();if(guardSetter)guardSetter(false);}
}
/* A field counts as cleared if it now reads blank - OR, for a <select>, if FMC gives
   it no blank option at all to select (then there is no empty state to reach and
   reporting a failure would be a false alarm). A missing/detached field holds nothing
   and is never reported either. Used for the verified Ctrl+G toast. */
function clearedOk(el){
    if(!el||!el.isConnected)return true;
    if(String(el.value||"").trim()==="")return true;
    if(el.tagName==="SELECT"){
        for(var i=0;i<el.options.length;i++)if(String(el.options[i].value||"")==="")return false;
        return true;
    }
    return false;
}
/* Blanks every Manual Scheduling field the script can write, scoped to findModal().
   Returns {modal:bool,left:[names]} - modal=false means no load is open (caller shows
   the existing "Open the load first" warning, same wording as every other "no load
   open" path in this file); left lists the fields that were RE-READ after the clear
   and still hold a value, so the caller's toast can never claim a clear that did not
   happen (16.0.2 toast audit).
   ORDER MATTERS (16.0.2 blocker fix, confirmed on the real page - see MODAL IDENTITY):
   FMC's RouteSummaryView binds {"change #route":"_handleRouteChange"}, which rebuilds
   the stops collection from the Route text, and StopsView then empties and re-renders
   the stop blocks - destroying the timing inputs and stop-location selects. Clearing
   the Route FIRST (as this did) therefore pulled those fields out from under their own
   clear: clearFmcTimings() resolved zero fields, FMC's model kept the old times, and
   the user's next paste met a half-rendered form. The Route is now cleared LAST, after
   every field that lives inside the stop blocks has really been cleared (and the
   timings are cleared synchronously, in the same turn - see clearFmcTimings' sync
   flag). */
function clearFmcForm(myToken){
    if(!ENABLED)return{modal:false,left:[]};
    var root=findModal();
    if(!root)return{modal:false,left:[]};
    // Ctrl+G is a FRESH-LOAD RESET, so it drops everything the re-apply registry is
    // holding and every manual mark in one go: nothing from the old load may be
    // re-applied onto the next one, and a field the user had set by hand must still
    // actually clear when they ask for the form to be cleared (the mark is overridden
    // only by the user's own newer explicit action - never by automatic work).
    wantClear();
    clearAllManual();
    // Arrival/Departure/Critical-departure timing fields FIRST, and synchronously -
    // reuse the existing clearDT()/clearFmcTimings() chain (never a second
    // implementation), which also keeps clearDT's own focus-reclaim behavior so a bare
    // Ctrl+V right afterwards still lands in the paste box. These live inside the stop
    // blocks the Route change destroys, so they must be done before it.
    clearFmcTimings(myToken,true);
    // Stop 1 / Stop 2 location selects - also inside the stop blocks.
    clearNativeField(findStopField(1));
    clearNativeField(findStopField(2));
    // Shipper account + carrier - both Select2-backed on the real page, same commit
    // path as the manual-shipper fix / change 2 (setSelect2 inside clearNativeField).
    // Ctrl+G is a fresh-load reset, so a manual shipper mark on THIS element is
    // cleared too (same as the brand-new-select case elsewhere in this file) - the
    // guard flag prevents this clear's own change event from re-marking it manual.
    var shipperSel=findShipperSelect();
    if(shipperSel)clearNativeField(shipperSel,function(v){if(v)beginWrite();else endWrite();});
    var carrierSel=findField(root,["select[name=carrier]","[name=carrier]"]);
    clearNativeField(carrierSel);
    // Create reason - clear the real control AND the pending REASON_WANTED, so the
    // poll never re-applies the old pick onto a freshly-cleared form; clear its own
    // manual mark too, same reasoning as shipper above.
    var reasonSel=findReasonSelect();
    clearNativeField(reasonSel,function(v){if(v)beginWrite();else endWrite();});
    REASON_WANTED=null;REASON_APPLIED_TO=null;
    // Cost + currency.
    var allInps=root.querySelectorAll?root.querySelectorAll("input"):[];
    for(var ci=0;ci<allInps.length;ci++){var inp=allInps[ci];if(inp.type==="hidden"||inp.type==="radio"||inp.type==="checkbox")continue;var par=inp;
        for(var d=0;d<5;d++){par=par.parentElement;if(!par)break;var ft=par.textContent.trim().split("\n")[0].trim().toLowerCase();
            if(/^cost$/i.test(ft)||(/cost/i.test(ft)&&ft.length<15&&!/center/i.test(ft))){clearNativeField(inp);break;}}}
    var allSels=root.querySelectorAll?root.querySelectorAll("select"):[];
    for(var si=0;si<allSels.length;si++){var sel=allSels[si],p2=sel;if(isOperatorTypeSelect(sel))continue;
        for(var d2=0;d2<6;d2++){p2=p2.parentElement;if(!p2)break;
            if(/cost|unit|currency/i.test(p2.textContent.trim().substring(0,50))){clearNativeField(sel);break;}}}
    // Load type / Unload type selects. Prefer the real name attribute (unambiguous)
    // and only fall back to the label-text walk if the named select is absent - the
    // loose label walk is what let the wrong control get matched before (reason,
    // timings), so named selectors come first wherever FMC provides one.
    var ltSel=root.querySelector?root.querySelector("select[name=loadType]"):null;
    var utSel=root.querySelector?root.querySelector("select[name=unloadType]"):null;
    if(!ltSel||!utSel){
        for(si=0;si<allSels.length;si++){var s2b=allSels[si],p3=s2b;if(isOperatorTypeSelect(s2b))continue;
            for(var d3=0;d3<6;d3++){p3=p3.parentElement;if(!p3)break;var pt3=p3.textContent.trim().substring(0,50);
                if(!utSel&&/unload.?type/i.test(pt3)){utSel=s2b;break;}
                if(!ltSel&&/load.?type/i.test(pt3)&&!/unload/i.test(pt3)){ltSel=s2b;break;}}}
    }
    clearNativeField(ltSel);clearNativeField(utSel);
    // Route field LAST (see this function's own comment): on the real page this single
    // change rebuilds FMC's stops collection and re-renders the stop blocks, so every
    // field that lives inside them is already cleared by the time it fires.
    // findRouteInput() is NOT modal-scoped on the real page since the Route input can
    // sit just outside the strict modal node - unchanged from how every other part of
    // this file already finds it.
    clearNativeField(findRouteInput());
    // Verified result (16.0.2 toast audit): re-read what was just cleared so the
    // caller's success toast describes the real form. The timing fields report
    // themselves from clearFmcTimings() (they can legitimately be re-rendered away by
    // the Route clear above), so they are deliberately not re-checked here.
    var left=[];
    function chk(el,label){if(!clearedOk(el))left.push(label);}
    chk(findRouteInput(),"Route");chk(shipperSel,"Shipper");chk(carrierSel,"Carrier");
    chk(reasonSel,"Reason");chk(ltSel,"Load type");chk(utSel,"Unload type");
    return{modal:true,left:left};
}
/* Removes the current #grt panel + its launcher pill and rebuilds from scratch.
   buildPanel() itself reads winkiro.state/winkiro.rect/winkiro.prevState/
   winkiro.maxPos from localStorage every time it runs (see "RESTORE PERSISTED STATE"
   inside buildPanel), so the rebuilt panel reappears in the same place/state with no
   extra bookkeeping needed here. The old setupAD() call is gone with the paste box:
   there is no per-panel element left to bind, and the paste net lives on window and is
   attached ONCE at init, so a panel rebuild cannot duplicate it. startRouteWatcher()
   and the Go button are deliberately NOT re-created here either - they are page-level
   (not panel-owned) and already survive a panel rebuild untouched, so re-calling them
   would be the only way to actually create a duplicate interval/listener/Go-button. */
/* Brief, subtle visual confirmation that a refresh actually happened - the user
   reported "the panel is not refreshing at all. I only watched the panel" (live FMC
   report): if the rebuilt panel lands in the exact same place in the exact same
   state, a WORKING refresh looks IDENTICAL to a dead shortcut with no console to
   check. A ~300ms border flash on the just-rebuilt panel makes a successful refresh
   visible even when nothing else about the panel's position/content changed. Pure
   CSS transition, no new static text, no layout shift (border-color only). */
function flashPanel(w){
    if(!w)return;
    // A panel the user CLOSED (display:none) or minimized is left exactly as it is -
    // flashing a border nobody can see is pointless, and the refresh must not make a
    // hidden panel visible (16.0.2 item 3: a refresh leaves a closed panel closed and
    // a minimized panel minimized; the toast is the visible confirmation in those
    // states, and the launcher pill keeps working).
    if(!w.offsetParent&&w.style.display==="none")return;
    var prevBorder=w.style.borderColor;
    w.style.transition="border-color 150ms ease";
    w.style.borderColor="#f3f1ff";
    setTimeout(function(){w.style.borderColor=prevBorder||"#3a316b";},300);
}
function refreshPanel(){
    var old=document.getElementById("grt");if(old)old.remove();
    var oldFab=null;var bodyBtns=document.querySelectorAll("body > button");
    for(var i=0;i<bodyBtns.length;i++)if(/Groot/.test(bodyBtns[i].textContent))oldFab=bodyBtns[i];
    if(oldFab)oldFab.remove();
    var oldStyle=document.getElementById("grt-style");if(oldStyle)oldStyle.remove(); // re-injected fresh by buildPanel -> injectGrtStyle
    buildPanel();
    updateGoButton();
    // No box to re-focus after the rebuild any more (16.0.2 no-box): a bare Ctrl+V
    // right after a refresh is caught by the window net regardless of what is focused,
    // including when the panel is minimized or closed - which is strictly better than
    // the old behaviour, where a hidden box could not be focused and the paste went
    // nowhere.
    flashPanel(document.getElementById("grt"));
}
/* The one function both the Ctrl+G shortcut and the panel's own Refresh control call.
   Cancels pending work FIRST (startGen()) so nothing from a prior load writes during
   the clear/rebuild; clears the form (or warns if no load is open, exactly like every
   other "no load open" path), resets this script's own per-load state so the NEXT
   lane behaves like a fresh load, then refreshes the panel and shows one short
   success toast.
   LIVE-FMC BUG FIX ("the panel is not refreshing at all. I only watched the panel."):
   the whole flow is wrapped in try/catch now. On the real page, removing/rebuilding
   #grt or clearing a Select2-wrapped field can throw on things the mock never
   exercised (a missing element, a localStorage read failure, a detached node from a
   concurrent FMC re-render) - previously an exception anywhere in this chain left the
   user with NO panel, NO toast and NO visible sign anything happened at all, which is
   indistinguishable from the shortcut never firing. Now any failure still shows a
   warning toast AND still attempts the panel rebuild in its own try/catch, so a form-
   clear failure can never also take the panel down with it. */
function doRefresh(){
    try{
        var tok=startGen();
        var res;
        try{res=clearFmcForm(tok);}catch(e1){console.warn("[Rohit] Ctrl+G clearFmcForm failed",e1);res={modal:false,left:[]};}
        if(!res||!res.modal){
            // Still refresh the panel itself (the user's own complaint is specifically
            // about the PANEL not refreshing) even when there is no load open to clear -
            // only the "no load" warning differs from the success path below.
            try{refreshPanel();}catch(e2){console.warn("[Rohit] Ctrl+G refreshPanel failed",e2);}
            toast("\u26A0 Open the load first",1);
            return;
        }
        LAST_ROUTE="";ST.lane="";ST.origin="";ST.carrier="";ST.sdtH=null;
        SUBMITTED_GEN=tok;
        if(GO_BTN)GO_BTN.style.display="none";
        try{refreshPanel();}catch(e3){console.warn("[Rohit] Ctrl+G refreshPanel failed",e3);toast("\u26A0 Form cleared, but the panel refresh failed",1);return;}
        // Success toast only for a clear the re-read confirmed (16.0.2 toast audit) -
        // if a field refused to clear, say so instead of claiming the form is clean.
        if(res.left&&res.left.length)toast("\u26A0 Panel refreshed, but "+res.left.join(", ")+" did not clear",1);
        else toast("Form cleared + panel refreshed \u2705");
    }catch(eAll){
        console.warn("[Rohit] Ctrl+G failed",eAll);
        toast("\u26A0 Refresh failed, see console",1);
    }
}
/* Re-entrancy guard shared by the capture-phase window listener below and the
   panel's own Refresh button - a single key press can reach a capture-phase AND a
   bubble-phase listener on different targets in rare synthetic-event setups (the
   harness itself dispatches on multiple targets in its hostile-stopPropagation
   check), and this guard makes sure doRefresh() only actually runs once per
   keypress/click no matter how many listeners observe it. */
var REFRESH_IN_FLIGHT=false;
function doRefreshOnce(){
    if(!ENABLED){offToast();return;}
    if(REFRESH_IN_FLIGHT)return;
    REFRESH_IN_FLIGHT=true;
    try{doRefresh();}finally{setTimeout(function(){REFRESH_IN_FLIGHT=false;},0);}
}
/* LIVE-FMC BUG FIX ("the panel is not refreshing at all"): a CAPTURE-phase listener
   on window, added BEFORE the existing bubble-phase document listener below (and
   before FMC's own React/Backbone handlers get a chance to run), so a stopPropagation()
   anywhere on the real page's keydown chain - a modal, a Select2 dropdown, FMC's own
   shortcut handling - can never swallow Ctrl+G before this script sees it. This is
   the exact class of fix the paste path already needed (a capture-phase window
   listener defending against the page intercepting/stopping an event first - see the
   paste interception handling elsewhere in this file) applied to the SAME problem for
   keydown. The old bubble-phase document listener's own Ctrl+G branch is kept too
   (belt-and-suspenders for a page that only listens on document, not window) but
   doRefreshOnce()'s guard means the two can never double-fire for one keypress. */
window.addEventListener("keydown",function(e){
    if(!ENABLED)return;   // item 3: Ctrl+G is the browser's again while off - no preventDefault
    if((e.key==="g"||e.key==="G")&&(e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey){
        e.preventDefault();
        doRefreshOnce();
    }
},true);

/* ═══ SHORTCUTS ═══ */
document.addEventListener("keydown",function(e){
    if(!ENABLED)return;
    // Ctrl+G (lowercase/uppercase, never with Alt/Shift) - handled BEFORE the #grt
    // early-return below so it also fires while the focus sits inside the panel.
    // preventDefault() so the browser's own find-next (Ctrl+G) never fires.
    // Belt-and-suspenders alongside the capture-phase window listener above (see its
    // own comment) - doRefreshOnce() de-dupes so this never runs doRefresh() twice.
    if((e.key==="g"||e.key==="G")&&(e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey){
        e.preventDefault();
        doRefreshOnce();
        return;
    }
    // The Escape branch that used to close the removed lane-type overlay is gone with
    // the popup itself (nothing else in this script opens an overlay, so Escape is left
    // to the page). Ctrl+G above is all this listener does now.
});

/* ═══ PANEL ═══ */
function buildPanel(){
    var w=document.createElement("div");w.id="grt";
    // Deep indigo gradient background (user-requested "pick a background color that
    // suits" - no image). background-color is the solid fallback underneath (shows
    // instantly, and covers any edge case where a gradient fails to paint); the
    // gradient layers over it. Lightest stop is #2a2160 (top-left, same purple as the
    // Go pill) -> #1b1740 (panel's old solid color, mid) -> #120e2e (darkest, bottom-
    // right), so every bit of text contrast below is checked against #2a2160, the
    // LIGHTEST part of the background any label/button could sit on.
    w.setAttribute("style","position:fixed;top:80px;right:20px;z-index:99999;width:300px;box-sizing:border-box;font-family:Arial;background-color:#1b1740;background-image:linear-gradient(160deg,#2a2160 0%,#1b1740 55%,#120e2e 100%);border:2px solid #3a316b;border-radius:10px;padding:0;box-shadow:0 4px 20px rgba(0,0,0,0.3)");
    injectGrtStyle();
    var hdr=document.createElement("div");hdr.id="grt-hdr";hdr.setAttribute("style","display:flex;justify-content:space-between;align-items:center;padding:8px 6px 8px 12px;background:rgba(14,11,32,0.72);border-radius:8px 8px 0 0;cursor:default;touch-action:none");
    var ttl=document.createElement("b");ttl.id="grt-title";ttl.setAttribute("style","font-size:14px;color:#f3f1ff;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,0.75)");ttl.textContent="\uD83C\uDF31 Groot";hdr.appendChild(ttl);
    var bs=document.createElement("span");bs.id="grt-controls";bs.setAttribute("style","display:flex;align-items:center;gap:2px");
    function mkCtl(label,svg){var b=document.createElement("button");b.type="button";b.className="grt-ctl";b.setAttribute("aria-label",label);b.title=label;b.innerHTML=svg;return b;}
    var SVG_MIN='<svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="8" x2="9" y2="8" stroke="rgba(255,255,255,0.92)" stroke-width="1"/></svg>';
    var SVG_MAX='<svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="1"/></svg>';
    var SVG_RESTORE='<svg width="10" height="10" viewBox="0 0 10 10"><rect x="3" y="1.5" width="5.5" height="5.5" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="1"/><rect x="1.5" y="3" width="5.5" height="5.5" fill="rgba(27,23,64,1)" stroke="rgba(255,255,255,0.92)" stroke-width="1"/></svg>';
    var SVG_CLOSE='<svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="rgba(255,255,255,0.92)" stroke-width="1"/><line x1="9" y1="1" x2="1" y2="9" stroke="rgba(255,255,255,0.92)" stroke-width="1"/></svg>';
    // Power glyph (item 3). currentColor so the one stylesheet rule keyed on
    // aria-pressed drives both the on and the off colour - no inline colour to fight
    // the :hover rule, and the contrast is checked against the header background.
    var SVG_POWER='<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M5 1.1 V4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><path d="M2.7 2.8 A3.1 3.1 0 1 0 7.3 2.8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>';
    var bM=mkCtl("Minimize",SVG_MIN);
    var bMax=mkCtl("Maximize",SVG_MAX);
    var bX=mkCtl("Close",SVG_CLOSE);
    bX.classList.add("grt-ctl-close");
    /* ═══ MASTER ON/OFF TOGGLE (item 3) ═══ a real <button type="button">, keyboard
       focusable with the same visible focus ring as the other window controls,
       aria-pressed + aria-label + title reflecting the live state. It sits to the LEFT
       of minimize/maximize/close and is an INDEPENDENT dimension from them: the window
       state machine's meanings and persistence are untouched. */
    var bPwr=mkCtl("Turn the script off",SVG_POWER);
    bPwr.id="grt-power";
    bPwr.classList.add("grt-ctl-power");
    bPwr.setAttribute("aria-pressed",ENABLED?"true":"false");
    bPwr.addEventListener("click",function(){setEnabled(!ENABLED);});
    bs.appendChild(bPwr);bs.appendChild(bM);bs.appendChild(bMax);bs.appendChild(bX);hdr.appendChild(bs);w.appendChild(hdr);
    var ct=document.createElement("div");ct.id="grt-content";ct.setAttribute("style","padding:8px 12px 12px 12px");
    // NOTE: the "Watching FMC Route field..." status line, the live #grt-status line,
    // AND History (label + collapsible list + their handlers) were removed per the
    // panel-cleanup / history-removal requirements. Transient status now goes to
    // console.log via uStat() (see UTILS).
    var rl=document.createElement("div");rl.className="grt-lbl";rl.textContent="Create Reason";ct.appendChild(rl);
    var rg=document.createElement("div");rg.id="grp-rs";rg.setAttribute("style","display:grid;grid-template-columns:repeat(4,1fr);gap:3px;margin-bottom:8px");
    [["1","High Vol"],["2","Dock Cong"],["3","NC Ctrl"],["4","AC React"]].forEach(function(rd,i){var b=document.createElement("button");b.className="grb";b.setAttribute("data-v",rd[0]);b.textContent=rd[1];b.setAttribute("style","padding:5px;border:2px solid #d4a574;border-radius:5px;font-size:8px;font-weight:600;cursor:pointer;"+(i===0?"background:#2d5a27;color:#fff":"background:#fff;color:#333"));b.addEventListener("click",function(){if(!ENABLED){offToast();return;}rg.querySelectorAll(".grb").forEach(function(x){x.style.background="#fff";x.style.color="#333";});this.style.background="#2d5a27";this.style.color="#fff";ST.reason=this.getAttribute("data-v");
        // If an equipment button already applied a reason for this load, switching the
        // reason button updates the live control immediately too (not just the NEXT
        // equipment click) - same "last explicit pick wins" principle as everywhere else.
        if(REASON_WANTED){REASON_WANTED=REASON_ENUM[ST.reason]||REASON_ENUM["1"];REASON_APPLIED_TO=null;applyReason();}
    });rg.appendChild(b);});
    ct.appendChild(rg);
    var el=document.createElement("div");el.className="grt-lbl";el.textContent="Equipment";ct.appendChild(el);
    var eqD=[["DETACHED_TRAILER","Live","Live",null,"DT","#fca5a5","#7f1d1d"],["BOX_DETACHED_TRAILER","Live","Live",null,"BOX DT","#fcd34d","#78350f"],["BOX_DROP_TRAILER","Preloaded","Drop",null,"BOX DP","#fb923c","#7c2d12"],["DROP_TRAILER","Preloaded","Drop",null,"DROP","#93c5fd","#1e3a8a"],["SEVEN_HALF_TON_TRUCK","Live","Live",null,"7.5T","#67e8f9","#164e63"],["SPRINTER_VAN","Live","Live","","VAN","#c084fc","#4c1d95"]];
    var g1=document.createElement("div");g1.setAttribute("style","display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin-bottom:3px");
    var g2=document.createElement("div");g2.setAttribute("style","display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin-bottom:8px");
    eqD.forEach(function(ed,i){var b=document.createElement("button");b.textContent=ed[4];b.setAttribute("style","padding:6px;border:none;border-radius:5px;font-size:9px;font-weight:600;cursor:pointer;background:"+ed[5]+";color:"+ed[6]);b.addEventListener("click",function(){runATS(ed[0],ed[1],ed[2],ed[3]);});(i<3?g1:g2).appendChild(b);});
    ct.appendChild(g1);ct.appendChild(g2);
    /* ═══ TIMINGS PASTE BOX (user request: a box under Equipment to paste timings into,
       filling continuously) ═══ A plain textarea wired to the SAME pipeline the Paste
       button and the window paste net use (queuePaste -> processPastedText). It fills on
       every paste into it, any number of times in a row (queuePaste starts a fresh
       generation each time, so a new paste cleanly supersedes the previous one). The box
       clears itself right after so the next timings block always pastes into an empty
       field. While the script is off it does nothing but show the off toast. */
    var tl=document.createElement("div");tl.className="grt-lbl";tl.textContent="Timings (paste \u2192 auto fill)";ct.appendChild(tl);
    var ta=document.createElement("textarea");ta.id="grt-paste";ta.rows=3;ta.placeholder="Paste timings\u2026";
    ta.setAttribute("style","width:100%;box-sizing:border-box;margin-bottom:8px;padding:7px 9px;border:1px solid #3a316b;border-radius:6px;background:#f6f5ff;color:#222;font:11px/1.4 Consolas,monospace;resize:vertical;outline:none");
    ta.addEventListener("paste",function(e){
        if(!ENABLED){offToast();e.preventDefault();return;}
        var txt="";try{txt=(e.clipboardData||window.clipboardData).getData("text/plain")||(e.clipboardData||window.clipboardData).getData("text");}catch(err){txt="";}
        if(!txt)return;
        e.preventDefault();ta.value="";
        // Dedupe against the window capture-phase net, which runs FIRST and already
        // queues any timings-looking paste through the same pipeline. markPasteEvent-
        // Processed returns true when the net has already seen THIS event; claimPaste
        // collapses the net's and this handler's calls within one physical paste. If the
        // net ignored the clipboard (not a timings block), both guards pass and this box
        // still fills from whatever the user pasted - the whole point of the box.
        if(markPasteEventProcessed(e))return;
        if(!claimPaste())return;
        queuePaste(txt);
    });
    ct.appendChild(ta);
    /* ═══ NO PASTE BOX (16.0.2 final change) ═══ the user, decisively: "I don't want
       the pasting box - when I paste, the timings must just be set automatically,
       that's it" and "one Paste option working is enough". The "Timings (paste -> auto
       fill)" label row and the timings textarea are GONE, together with their CSS,
       their placeholder and every listener that only existed to serve them. Two paths
       remain and they share one pipeline (queuePaste -> processPastedText):
         - the Paste button, which reads the clipboard itself (doPaste), and
         - a capture-phase paste listener on window that acts only when the clipboard
           TEXT LOOKS LIKE A TIMINGS BLOCK (see looksLikeTimings) - a silent safety net
           for a bare Ctrl+V when the clipboard API is blocked, with no visible UI.
       The panel is just shorter: still 300px wide, still the same three-column button
       row (Paste, Refresh, Clear). */
    var tb=document.createElement("div");tb.setAttribute("style","display:grid;grid-template-columns:repeat(3,1fr);gap:3px");
    // Fill was removed (16.0.2 change 5): pasting already auto-fills, so a separate
    // Fill button was redundant - fillTimings() itself is KEPT, the paste flow still
    // needs it. Refresh (change 4) takes the freed middle slot so the row stays a
    // clean three-button grid: Paste, Refresh, Clear.
    [["Paste",doPaste,"#86efac","#14532d"],["\u27F3 Refresh",doRefreshOnce,"#bfdbfe","#1e3a8a"],["Clear",function(){if(!ENABLED){offToast();return;}var tok=startGen();ST.carrier="";ST.sdtH=null;SUBMITTED_GEN=tok;clearFmcTimings(tok);uStat("Ready");},"#ddd6fe","#4c1d95"]].forEach(function(bd){var b=document.createElement("button");b.textContent=bd[0];b.setAttribute("style","padding:5px;border:none;border-radius:5px;font-size:9px;font-weight:600;cursor:pointer;background:"+bd[2]+";color:"+bd[3]);
        if(bd[0].indexOf("Refresh")>=0){b.title="Clear FMC form + refresh panel (Ctrl+G)";b.setAttribute("aria-label","Clear FMC form and refresh panel (Ctrl+G)");}
        b.addEventListener("click",bd[1]);tb.appendChild(b);});
    ct.appendChild(tb);
    w.appendChild(ct);document.body.appendChild(w);
    var fab=document.createElement("button");fab.textContent="\uD83C\uDF31 Groot";fab.setAttribute("style","position:fixed;bottom:20px;right:20px;z-index:99998;background:#2d5a27;color:#fff;border:none;border-radius:20px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.2);display:none");document.body.appendChild(fab);

    /* ═══ WINDOW STATE MACHINE (normal/minimized/maximized/closed) + DRAG + PERSIST ═══
       See plan D1-D6. PANEL_STATE/PREV_STATE/NORMAL_RECT are the single source of
       truth; Restore always returns to the exact saved NORMAL_RECT. localStorage
       (prefix "winkiro.") persists state+rect across loads; all access wrapped in
       try/catch since @grant none relies on ordinary same-origin localStorage. */
    var PANEL_STATE="normal";       // normal|minimized|maximized|closed
    var PREV_STATE="normal";        // state to return to from minimized (normal|maximized)
    var NORMAL_RECT=null;           // {left,top,width,height} - the Restore target
    var MAX_RECT=null;              // {left,top} - last dragged position while maximized

    function lsGet(k){try{return localStorage.getItem(k);}catch(e){return null;}}
    function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}

    function clamp(v,lo,hi){return Math.max(lo,Math.min(v,hi));}
    function currentRect(){var r=w.getBoundingClientRect();return{left:r.left,top:r.top,width:r.width,height:r.height};}
    function applyRect(rc){w.style.right="auto";w.style.left=rc.left+"px";w.style.top=rc.top+"px";if(rc.width)w.style.width=rc.width+"px";}
    function clampRectIntoView(rc){
        var vw=window.innerWidth,vh=window.innerHeight;
        var barH=hdr.getBoundingClientRect().height||36;
        var left=clamp(rc.left,-(rc.width-40),vw-40);
        var top=clamp(rc.top,0,Math.max(0,vh-barH));
        return{left:left,top:top,width:rc.width,height:rc.height};
    }
    function saveNormalRect(){if(PANEL_STATE!=="normal")return;NORMAL_RECT=currentRect();persist();}
    function saveMaxRect(){if(PANEL_STATE!=="maximized")return;var r=currentRect();MAX_RECT={left:r.left,top:r.top};persist();}
    function persist(){
        lsSet("winkiro.state",PANEL_STATE);
        lsSet("winkiro.prevState",PREV_STATE);
        if(NORMAL_RECT)lsSet("winkiro.rect",JSON.stringify(NORMAL_RECT));
        if(MAX_RECT)lsSet("winkiro.maxPos",JSON.stringify(MAX_RECT));
    }

    function goNormal(){
        w.classList.remove("grt-max");
        if(NORMAL_RECT)applyRect(NORMAL_RECT);
        w.style.height="";ct.style.display="block";
        bM.innerHTML=SVG_MIN;bM.setAttribute("aria-label","Minimize");bM.title="Minimize";
        bMax.innerHTML=SVG_MAX;bMax.setAttribute("aria-label","Maximize");bMax.title="Maximize";
        PANEL_STATE="normal";PREV_STATE="normal";persist();
    }
    function goMinimize(){
        if(PANEL_STATE==="minimized")return;
        PREV_STATE=PANEL_STATE==="maximized"?"maximized":"normal";
        ct.style.display="none";
        PANEL_STATE="minimized";persist();
    }
    function goUnminimize(){
        ct.style.display="block";
        if(PREV_STATE==="maximized")goMaximize();else goNormal();
    }
    function goMaximize(){
        if(PANEL_STATE==="normal")saveNormalRect();
        w.classList.add("grt-max");
        w.style.right="auto";
        var mw=Math.min(640,window.innerWidth*0.92);
        w.style.width=mw+"px";
        w.style.maxHeight="88vh";w.style.height="auto";
        var barH=hdr.getBoundingClientRect().height||36;
        if(MAX_RECT){
            var rc=clampRectIntoView({left:MAX_RECT.left,top:MAX_RECT.top,width:mw,height:barH});
            w.style.left=rc.left+"px";w.style.top=rc.top+"px";
        }else{
            w.style.left=clamp(window.innerWidth-mw-16,0,window.innerWidth-mw)+"px";
            w.style.top="16px";
        }
        ct.style.display="block";ct.style.overflow="auto";
        bMax.innerHTML=SVG_RESTORE;bMax.setAttribute("aria-label","Restore");bMax.title="Restore";
        bM.innerHTML=SVG_MIN;bM.setAttribute("aria-label","Minimize");bM.title="Minimize";
        PANEL_STATE="maximized";PREV_STATE="maximized";persist();
    }
    function goMaximizeToggle(){
        if(PANEL_STATE==="maximized")goNormal();else goMaximize();
    }
    function goClose(){
        if(PANEL_STATE!=="closed")PREV_STATE=PANEL_STATE==="minimized"?PREV_STATE:PANEL_STATE;
        PANEL_STATE="closed";persist();
        w.style.display="none";fab.style.display="block";
    }
    function goOpenFromLauncher(){
        w.style.display="block";fab.style.display="none";
        var target=lsGet("winkiro.prevState")||PREV_STATE||"normal";
        if(target==="maximized")goMaximize();else goNormal();
    }
    bM.addEventListener("click",function(){if(PANEL_STATE==="minimized")goUnminimize();else goMinimize();});
    bMax.addEventListener("click",goMaximizeToggle);
    bX.addEventListener("click",goClose);
    fab.addEventListener("click",goOpenFromLauncher);

    /* ═══ DRAG (title bar only, pointer events) — see plan D4/D5 ═══
       A pointerdown on a .grt-ctl must never start a drag. Dragging while maximized
       MOVES the panel at its maximized size (user request): PANEL_STATE stays
       "maximized", the .grt-max class and maximized width/height are untouched, and
       only left/top change, clamped so the title bar stays inside the viewport.
       Dragging also works while minimized (title-bar-only) - only left/top move. */
    var DRAG=null;
    hdr.addEventListener("pointerdown",function(e){
        if(e.target.closest&&e.target.closest(".grt-ctl"))return;
        e.preventDefault();
        var start=currentRect();
        DRAG={id:e.pointerId,sx:e.clientX,sy:e.clientY,sl:start.left,st:start.top};
        try{hdr.setPointerCapture(e.pointerId);}catch(err){}
        document.body.style.userSelect="none";
    });
    hdr.addEventListener("pointermove",function(e){
        if(!DRAG||e.pointerId!==DRAG.id)return;
        var nl=DRAG.sl+(e.clientX-DRAG.sx),nt=DRAG.st+(e.clientY-DRAG.sy);
        var rc=clampRectIntoView({left:nl,top:nt,width:w.getBoundingClientRect().width,height:w.getBoundingClientRect().height});
        applyRect(rc);
    });
    function dragEnd(e){
        if(!DRAG||(e&&e.pointerId!==DRAG.id))return;
        try{hdr.releasePointerCapture(DRAG.id);}catch(err){}
        DRAG=null;document.body.style.userSelect="";
        if(PANEL_STATE==="normal")saveNormalRect();
        else if(PANEL_STATE==="maximized")saveMaxRect();
    }
    hdr.addEventListener("pointerup",dragEnd);
    hdr.addEventListener("pointercancel",dragEnd);
    // buildPanel() is now re-callable (change 4's refreshPanel()), so the PREVIOUS
    // panel instance's own resize handler must be removed before this one is added -
    // window-level listeners never die with the removed #grt element the way the
    // header/button listeners above do, so without this a resize listener would leak
    // on every refresh (confirmed by the harness: liveListeners/resize count grew
    // after repeated Ctrl+G presses before this fix).
    if(PANEL_RESIZE_HANDLER)window.removeEventListener("resize",PANEL_RESIZE_HANDLER);
    PANEL_RESIZE_HANDLER=function(){
        if(PANEL_STATE==="normal"){var rc=clampRectIntoView(currentRect());applyRect(rc);NORMAL_RECT=rc;persist();}
        else if(PANEL_STATE==="maximized"){
            var cur=currentRect();
            var mw=Math.min(640,window.innerWidth*0.92);
            var rc2=clampRectIntoView({left:cur.left,top:cur.top,width:mw,height:cur.height});
            w.style.width=mw+"px";w.style.left=rc2.left+"px";w.style.top=rc2.top+"px";
            MAX_RECT={left:rc2.left,top:rc2.top};persist();
        }
    };
    window.addEventListener("resize",PANEL_RESIZE_HANDLER);

    /* ═══ RESTORE PERSISTED STATE on load (plan D6) ═══ */
    (function restoreOnLoad(){
        var r0=currentRect();
        var savedRectRaw=lsGet("winkiro.rect"),savedState=lsGet("winkiro.state"),savedPrev=lsGet("winkiro.prevState");
        var savedMaxRaw=lsGet("winkiro.maxPos");
        var rc=r0;
        if(savedRectRaw){try{rc=JSON.parse(savedRectRaw);}catch(e){rc=r0;}}
        rc=clampRectIntoView(rc);
        NORMAL_RECT=rc;
        applyRect(rc);
        if(savedMaxRaw){try{MAX_RECT=JSON.parse(savedMaxRaw);}catch(e){MAX_RECT=null;}}
        PREV_STATE=savedPrev==="maximized"?"maximized":"normal";
        if(savedState==="closed"){
            PANEL_STATE="normal";goClose();
        }else if(savedState==="maximized"){
            goMaximize();
        }else if(savedState==="minimized"){
            PANEL_STATE="normal";goMinimize();
        }else{
            goNormal();
        }
    })();

    /* ═══ RESTORE THE ON/OFF STATE (item 3) ═══ a SEPARATE dimension from the window
       state above: the panel can be open and off, or minimized and on, and a closed
       panel reopened from the launcher pill still shows whichever on/off state it was
       left in. Read from localStorage at startup (winkiro.enabled, defaulting to ON),
       re-applied here on every panel build so a refresh/rebuild never loses it. */
    applyEnabledUI();
}

/* Inject the single <style id="grt-style"> block once: window-control hover/focus
   rules (inline styles can't express :hover/:focus-visible) and the .grt-max
   content scale-up rules used while maximized. */
function injectGrtStyle(){
    if(document.getElementById("grt-style"))return;
    var s=document.createElement("style");s.id="grt-style";
    s.textContent=
        ".grt-ctl{background:transparent;border:none;padding:4px 10px;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:3px;color:#f3f1ff;}"+
        ".grt-ctl:focus-visible{outline:2px solid #9ec5ff;outline-offset:-2px;}"+
        /* Master on/off toggle (item 3). Narrower padding so the fourth control still
           fits the 300px title bar with no wrapping and no width change. The OFF state
           is unmistakable: a red-tinted button with a light-red glyph (#ff9b9b on the
           header's own #1a1535 is ~8:1, well past 4.5:1), next to the dimmed body and
           the red panel border. :hover is declared LAST so it still wins at equal
           specificity in both states. */
        ".grt-ctl-power{padding:4px 7px;}"+
        ".grt-ctl-power[aria-pressed=\"true\"]{color:#f3f1ff;}"+
        ".grt-ctl-power[aria-pressed=\"false\"]{background:rgba(196,43,28,0.38);color:#ff9b9b;}"+
        ".grt-ctl:hover{background:rgba(255,255,255,0.14);}"+
        ".grt-ctl-close:hover{background:#c42b1c;}"+
        ".grt-lbl{font-size:11px;font-weight:bold;margin-bottom:4px;color:#eef0ff;text-shadow:0 1px 2px rgba(0,0,0,0.7);}"+
        /* The two rules that styled the timings textarea - its ::placeholder colour and
           its maximized min-height/font-size - are gone with the box itself. Nothing
           else in the panel used them. */
        ".grt-max #grt-content{font-size:12px;}"+
        ".grt-max #grt-content button{font-size:11px;}"+
        ".grt-max .grt-lbl{font-size:13px;}";
    document.head.appendChild(s);
}

/* ═══ INIT ═══ */
buildPanel();
startRouteWatcher();
try{var sc=JSON.parse(localStorage.getItem("groot_carrier")||"{}");if(sc.c&&(Date.now()-sc.t)<3600000){ST.carrier=sc.c;ST.sdtH=sc.h;uStat("Carrier: "+sc.c+" (restored)");}}catch(e){}
console.log("[Groot] Route Watcher + Shiva carrier engine (RLB1<30h / AZNG>=30h)");
})();
