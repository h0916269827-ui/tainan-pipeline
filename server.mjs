import http from 'node:http';
import {readFileSync} from 'node:fs';
import {randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const groups=['main','b1','g2','g1','fy1','ys'];
const fields=['manholeStatus','pipeStatus','manholeEditColor','pipeEditStyle','pipeDirection','manholeNames'];
export function validateState(s){
 if(!s || s._projectId!=='tainan-pipeline')throw Error('工程資料識別不符');
 for(const g of groups){
  if(!Array.isArray(s['_feat_'+g]))throw Error('缺少群組幾何資料：'+g);
  for(const f of s['_feat_'+g])if(f?.type!=='Feature'||!f.geometry||!f.properties)throw Error('幾何資料不完整');
  for(const f of fields){const v=s[f+(g==='main'?'':'_'+g)];if(!v||typeof v!=='object'||Array.isArray(v))throw Error('缺少群組編輯資料');}
 }
 return s;
}
export function seal(data,key){
 const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);
 return Buffer.concat([iv,c.update(JSON.stringify(data)),c.final(),c.getAuthTag()]).toString('base64url');
}
export function unseal(value,key){
 try{const b=Buffer.from(value||'','base64url'),d=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),b.subarray(0,12));d.setAuthTag(b.subarray(-16));const p=JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]));return p.exp>Date.now()?p:null;}catch{return null;}
}
const safeJSON=x=>JSON.stringify(x).replace(/</g,'\\u003c');
export function createApp(cfg,fetcher=fetch){
 if(!/^https:\/\//.test(cfg.origin)||!/^\w[\w-]*\/[\w.-]+$/.test(cfg.repo)||!/^[a-f0-9]{64}$/i.test(cfg.key)||!cfg.clientId||!cfg.clientSecret||!cfg.ownerId)throw Error('請設定 HTTPS 網址、GitHub 儲存庫、OAuth 與 SESSION_KEY');
 const input=readFileSync(cfg.html),template=(String(cfg.html).endsWith('.gz')?gunzipSync(input):input).toString('utf8'),client=readFileSync(new URL('./client.js',import.meta.url),'utf8');
 const endpoint=`https://api.github.com/repos/${cfg.repo}/contents/project_working_state.json`;
 const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 const cookie=(res,name,data,age)=>res.setHeader('Set-Cookie',`${name}=${data?seal(data,cfg.key):''}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`);
 const redirect=(res,to)=>{res.writeHead(302,{Location:to});res.end();};
 async function github(url,token,options={}){
  const r=await fetcher(url,{...options,signal:AbortSignal.timeout(20000),headers:{Accept:'application/vnd.github+json','User-Agent':'tainan-pipeline','X-GitHub-Api-Version':'2022-11-28',...(token?{Authorization:'Bearer '+token}:{}),...options.headers}});
  const body=await r.json();return {status:r.status,body};
 }
 async function read(token){
  // Public visitors read the public file directly rather than sharing an
  // anonymous API quota with every service on the hosting platform.
  if(!token){
   const rawBase=`https://raw.githubusercontent.com/${cfg.repo}/${encodeURIComponent(cfg.branch||'main')}/`;
   const r=await fetcher(rawBase+'project_working_state.json?t='+Date.now(),{signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache'}});
   if(r.status===404){
    const probe=await fetcher(rawBase+'README.md',{signal:AbortSignal.timeout(20000)});
    if(!probe.ok)throw Error('公開儲存庫無法讀取');
    return {sha:null,state:null};
   }
   if(!r.ok)throw Error('公開資料讀取失敗');
   const bytes=Buffer.from(await r.arrayBuffer());
   return {sha:createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'),state:validateState(JSON.parse(bytes.toString('utf8')))};
  }
  const r=await github(endpoint+'?ref='+encodeURIComponent(cfg.branch||'main'),token);
  if(r.status===404){
   const repo=await github(`https://api.github.com/repos/${cfg.repo}`,token);
   if(repo.status!==200)throw Error('儲存庫不存在或無法存取，不能初始化');
   return {sha:null,state:null};
  }
  if(r.status!==200)throw Error('GitHub 讀取失敗，請稍後重試');
  let content=r.body.content;
  if(!content){const blob=await github(`https://api.github.com/repos/${cfg.repo}/git/blobs/${r.body.sha}`,token);if(blob.status!==200)throw Error('資料讀取失敗');content=blob.body.content;}
  return {sha:r.body.sha,state:validateState(JSON.parse(Buffer.from(content,'base64').toString('utf8')))};
 }
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  try{
   const url=new URL(req.url,cfg.origin),cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')));
   const session=unseal(cookies.session,cfg.key),owner=session?.id===String(cfg.ownerId);
   if(req.method==='GET'&&url.pathname==='/auth/login'){
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
    cookie(res,'oauth',{state,verifier,exp:Date.now()+600000},600);
    return redirect(res,'https://github.com/login/oauth/authorize?'+new URLSearchParams({client_id:cfg.clientId,redirect_uri:cfg.origin+'/auth/callback',scope:'public_repo',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}));
   }
   if(req.method==='GET'&&url.pathname==='/auth/callback'){
    const pending=unseal(cookies.oauth,cfg.key);cookie(res,'oauth',null,0);
    if(!pending||pending.state!==url.searchParams.get('state')||!url.searchParams.get('code'))return json(res,400,{error:'登入驗證失敗，請重新登入'});
    const r=await fetcher('https://github.com/login/oauth/access_token',{method:'POST',signal:AbortSignal.timeout(20000),headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:cfg.clientId,client_secret:cfg.clientSecret,code:url.searchParams.get('code'),redirect_uri:cfg.origin+'/auth/callback',code_verifier:pending.verifier})});
    const auth=await r.json();if(!r.ok||!auth.access_token)return json(res,401,{error:'GitHub 登入未成功'});
    const user=await github('https://api.github.com/user',auth.access_token);
    if(user.status!==200||String(user.body.id)!==String(cfg.ownerId))return json(res,403,{error:'此帳號只有瀏覽權限'});
    cookie(res,'session',{id:String(user.body.id),token:auth.access_token,exp:Date.now()+8*3600000},8*3600);return redirect(res,'/');
   }
   if(req.method==='POST'){
    if(req.headers.origin!==cfg.origin)return json(res,403,{error:'來源驗證失敗'});
    if(url.pathname==='/auth/logout'){cookie(res,'session',null,0);return json(res,200,{ok:true});}
    if(url.pathname==='/api/state'){
     if(!owner)return json(res,401,{error:'請先以擁有者帳號登入'});
     if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'需要 JSON'});
     const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)return json(res,413,{error:'編輯資料超過 8 MB'});chunks.push(chunk);}
     let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));validateState(input.state);}catch(e){return json(res,400,{error:e.message});}
     const current=await read(session.token);
     if(input.baseSha!==current.sha)return json(res,409,{error:'另一台電腦已有更新，未覆蓋雲端。請先匯出目前修改，再載入最新版。'});
     if(!current.sha&&input.initialize!==true)return json(res,400,{error:'請明確確認以目前畫面建立雲端版本'});
     const state={...input.state,_exportedSnapshot:true,_savedAt:new Date().toISOString()};
     const saved=await github(endpoint,session.token,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'儲存工程編輯 '+state._savedAt,branch:cfg.branch||'main',content:Buffer.from(JSON.stringify(state)).toString('base64'),...(current.sha?{sha:current.sha}:{})})});
     if([409,422].includes(saved.status))return json(res,409,{error:'版本衝突，未覆蓋雲端；請先匯出修改再載入最新版'});
     if(![200,201].includes(saved.status))return json(res,502,{error:'GitHub 未確認儲存成功，修改仍留在畫面，請重試'});
     return json(res,200,{sha:saved.body.content.sha,savedAt:state._savedAt});
    }
   }
   if(req.method==='GET'&&url.pathname==='/health')return json(res,200,{ok:true});
   if(req.method==='GET'&&url.pathname==='/'){
    const current=await read(owner?session.token:null);
    let html=template;
    if(current.state)html=html.replace(/\/\*__STATE_START__\*\/[\s\S]*?\/\*__STATE_END__\*\//,()=> '/*__STATE_START__*/'+safeJSON({...current.state,_exportedSnapshot:true})+'/*__STATE_END__*/');
    html=html.replace('connect-src data: blob:',"connect-src 'self' data: blob:");
    const boot={owner,sha:current.sha,savedAt:current.state?._savedAt||null};
    html=html.replace("document.getElementById('share-loading').style.display='none';",()=>`const CLOUD_BOOT=${safeJSON(boot)};\n${client}\ndocument.getElementById('share-loading').style.display='none';`);
    if(!html.includes('const CLOUD_BOOT='))throw Error('部署檔格式不符');
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html);
   }
   json(res,404,{error:'找不到頁面'});
  }catch(error){console.error('Cloud request failed:',error.name,error.message);json(res,503,{error:'目前無法讀取或儲存雲端資料，請稍後重試。未使用舊資料覆蓋雲端。'});}
 };
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const e=process.env;
 const app=createApp({origin:e.APP_ORIGIN,repo:e.GITHUB_REPO,branch:e.GITHUB_BRANCH||'main',key:e.SESSION_KEY,clientId:e.GITHUB_CLIENT_ID,clientSecret:e.GITHUB_CLIENT_SECRET,ownerId:e.GITHUB_OWNER_ID,html:e.HTML_PATH||new URL('./index.html.gz',import.meta.url)});
 http.createServer(app).listen(Number(e.PORT||3000),'0.0.0.0');
}

