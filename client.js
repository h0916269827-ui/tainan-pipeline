// Injected into the existing map closure; no access token is exposed to the browser.
(()=>{
 document.getElementById('cloud-controls')?.remove();
 if(location.protocol==='file:'){modeBtn.disabled=false;modeBtn.textContent='正常模式';return;}
 const box=document.createElement('div');box.id='cloud-controls';box.style.cssText='padding:12px;border:1px solid #45617c;margin:12px 0;color:#cbdcf0';
 const text=document.createElement('div');text.setAttribute('role','status');box.append(text);
 const button=(label,fn)=>{const b=document.createElement('button');b.type='button';b.className='action-btn';b.textContent=label;b.addEventListener('click',fn);box.append(b);return b;};
 document.getElementById('btn-bake').before(box);
 if(!CLOUD_BOOT.owner){
  text.textContent='公開瀏覽 · 登入後可編輯';
  button('使用 GitHub 登入',()=>location.assign('/auth/login'));
  modeBtn.disabled=true;modeBtn.textContent='登入後可編輯';editMode=false;
  return;
 }
 let sha=CLOUD_BOOT.sha,busy=false,baseline=workEditSignature(),pending=false,failed='';
 function draw(){
  pending=workEditSignature()!==baseline;
  text.textContent=busy?'正在儲存，請勿關閉…':failed||(pending?'有修改，尚未同步':sha?'已同步'+(CLOUD_BOOT.savedAt?' · '+new Date(CLOUD_BOOT.savedAt).toLocaleString():''):'尚未建立雲端版本');
  save.disabled=busy||(!pending&&!!sha);save.textContent=sha?'儲存到雲端':'以目前畫面建立雲端版本';
 }
 const save=button('儲存到雲端',async()=>{
  if(busy)return;
  if(!sha&&!confirm('以目前畫面的人孔、管段與群組資料建立第一份雲端版本？尚未匯入本畫面的其他檔案修改不會包含在內。'))return;
  const state=JSON.parse(JSON.stringify({..._buildFullState(),_projectId:'tainan-pipeline',_exportedSnapshot:true}));
  const sentSignature=workEditSignature(state);busy=true;failed='';draw();
  try{
   const r=await fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseSha:sha,initialize:!sha,state}),signal:AbortSignal.timeout(120000)});
   const result=await r.json();if(!r.ok)throw Error(result.error||'儲存未成功');
   sha=result.sha;CLOUD_BOOT.savedAt=result.savedAt;baseline=sentSignature;
   // Do not mark edits made during the request as saved.
   if(workEditSignature()===sentSignature)workAcceptBaseline();
  }catch(e){failed=e.name==='TimeoutError'?'儲存逾時，結果尚未確認；請保留或匯出目前修改，再載入雲端確認。':e.message;}
  finally{busy=false;draw();}
 });
 button('載入雲端最新版',()=>{if(busy)return;if(workEditSignature()!==baseline&&!confirm('目前有尚未同步的修改。請先匯出單檔 HTML 備份；仍要放棄目前修改並載入雲端？'))return;baseline=workEditSignature();workAcceptBaseline();location.reload();});
 button('登出',async()=>{if(busy)return;if(workEditSignature()!==baseline&&!confirm('尚有未同步修改，確定登出？建議先儲存到雲端或匯出 HTML。'))return;try{const r=await fetch('/auth/logout',{method:'POST'});if(!r.ok)throw Error('登出失敗');baseline=workEditSignature();workAcceptBaseline();location.reload();}catch(e){failed=e.message;draw();}});
 window.addEventListener('beforeunload',e=>{if(busy||workEditSignature()!==baseline){e.preventDefault();e.returnValue='';}});
 setInterval(draw,1500);draw();
})();
