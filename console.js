javascript:(function(){
  var STEALTH=true;
  if(STEALTH){
    try{
      window._origAlert = window.alert;
      window.alert = function(){};
      ["log","info","warn","error","debug"].forEach(k=>{
        try{ window["_orig_console_"+k] = console[k]; console[k] = function(){} }catch(e){}
      });
    }catch(e){}
  }

  if(window.FISHBOT9_ON){
    clearInterval(window.FISHBOT9_LOOP);
    window.FISHBOT9_ON=false;
    window.FISHBOT9_PAUSED=false;
    (window._orig_console_log||console.log)("🛑 Bot STOPPED");
    return;
  }

  window.FISHBOT9_ON=true;
  window.FISHBOT9_PAUSED=false;
  (window._orig_console_log||console.log)("🎣 Bot STARTED");

  let scanSpeed = 80;
  let idleTimeout = 900;
  let lastActionTime = Date.now();
  const POINTER_COUNT = 9;

  const modalPath = "#root > div:nth-child(1) > div:nth-child(3) > div > div:nth-child(2) > div > div:nth-child(4) > button.modal-button.modal-button-orange > span";
  const superCastPath = "#root > div:nth-child(1) > div:nth-child(3) > div > div > div.cast-buttons-container > button.game-button.game-button-yellow > span";
  const canvasPath = "#root > div:nth-child(1) > div:nth-child(3) > div > div > div:nth-child(1) > canvas";
  const durabilitySelector = "#root > div:nth-child(1) > div:nth-child(3) > div > div > div.hud-rod-container > div > div:nth-child(2)";

  const rand=(a,b)=>a+Math.random()*(b-a);
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function getCanvas(){ return document.querySelector(canvasPath); }
  function clickModal(){ const s=document.querySelector(modalPath); if(!s)return; const b=s.closest("button"); if(b)b.click(); }
  function getSuperCast(){ const s=document.querySelector(superCastPath); return s?s.closest("button"):null; }
  function fire(el,type,x,y){ el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerType:"mouse",isPrimary:true})); }

  async function superCast(){
    const btn = getSuperCast();
    if(!btn || btn.disabled || btn.getAttribute("aria-disabled")==="true") return;
    fire(btn,"pointerdown",0,0);
    await sleep(rand(60,120));
    fire(btn,"pointerup",0,0);
    btn.click();
  }

  async function multiPointer(){
    const c=getCanvas(); if(!c)return;
    const r=c.getBoundingClientRect();
    const zones=[
      {x1:.05,x2:.30,y1:.18,y2:.38},{x1:.30,x2:.60,y1:.18,y2:.38},{x1:.60,x2:.95,y1:.18,y2:.38},
      {x1:.05,x2:.30,y1:.38,y2:.66},{x1:.30,x2:.60,y1:.38,y2:.66},{x1:.60,x2:.95,y1:.38,y2:.66},
      {x1:.05,x2:.30,y1:.66,y2:.88},{x1:.30,x2:.60,y1:.66,y2:.88},{x1:.60,x2:.95,y1:.66,y2:.88}
    ];
    for(let i=0;i<POINTER_COUNT;i++){
      let z=zones[i];
      let x=rand(r.left+r.width*z.x1, r.left+r.width*z.x2);
      let y=rand(r.top+r.height*z.y1, r.top+r.height*z.y2);
      fire(c,"pointermove",x,y);
      await sleep(rand(30,70));
      if(c.style.cursor==="pointer"){
        fire(c,"pointerdown",x,y);
        await sleep(rand(80,160));
        fire(c,"pointerup",x,y);
        lastActionTime=Date.now();
        return;
      }
      await sleep(rand(40,80));
    }
  }

  // ❗ fungsi baru: 1x klik acak untuk cancel auto-cast
  async function cancelAutoCastOnce(){
    try{
      const c = getCanvas();
      if(!c) return;
      const r = c.getBoundingClientRect();
      const x = rand(r.left+r.width*0.1, r.left+r.width*0.9);
      const y = rand(r.top+r.height*0.1, r.top+r.height*0.9);

      fire(c,"pointermove",x,y);
      await sleep(rand(20,50));
      fire(c,"pointerdown",x,y);
      await sleep(rand(20,50));
      fire(c,"pointerup",x,y);

      (window._orig_console_log||console.log)("🛠️ Cancel auto-cast (1x click)");
    }catch(e){}
  }

  function getDurabilityPercent(){
    const el=document.querySelector(durabilitySelector);
    if(!el) return null;
    const title=el.getAttribute("title")||"";
    const p=title.split("/").map(t=>t.replace(/[^\d]/g,""));
    if(p.length<2) return null;
    const cur=+p[0], max=+p[1];
    if(!cur||!max) return null;
    return (cur/max)*100;
  }

  function checkDurabilityAndToggle(){
    const pct=getDurabilityPercent();
    if(pct===null) return;

    if(!window.FISHBOT9_PAUSED && pct < 40){
      window.FISHBOT9_PAUSED=true;
      (window._orig_console_log||console.log)("⏸️ Paused — durability", pct.toFixed(1)+"%");
      cancelAutoCastOnce(); // << hanya 1x
    }

    if(window.FISHBOT9_PAUSED && pct > 60){
      window.FISHBOT9_PAUSED=false;
      lastActionTime=Date.now();
      (window._orig_console_log||console.log)("▶️ Resumed — durability", pct.toFixed(1)+"%");
    }
  }

  async function loop(){
    if(!window.FISHBOT9_ON) return;
    checkDurabilityAndToggle();

    if(window.FISHBOT9_PAUSED) return;

    clickModal();
    await multiPointer();

    if(Date.now() - lastActionTime >= idleTimeout){
      lastActionTime=Date.now();
      await superCast();
    }
  }

  loop();
  window.FISHBOT9_LOOP=setInterval(loop,scanSpeed);
})();
