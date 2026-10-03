import {parseSnapshot,createBackup,validateBackup} from './snapshot.mjs';
const CLOUD_URL='https://workout-backups.dengana-10011212.workers.dev/';
const hosted=location.origin===new URL(CLOUD_URL).origin;
const el=id=>document.getElementById(id),store=window.WorkoutCloud;
let connected=false,timer,running=false,session,historyRows=[],failures=0;
const fmt=v=>v?new Intl.DateTimeFormat('ja-JP',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(v)):'まだ保存していません';
async function api(path,method='GET',body,key){
  const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(key)headers.Authorization='Bearer '+key;
  const r=await fetch('/v1/'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(25000)});
  const data=await r.json();if(!r.ok){const e=Error(data.error||'通信できませんでした');e.status=r.status;throw e;}return data;
}
function status(text){el('cloudStatus').textContent=text;}
async function renderStatus(){
  const m=await store.meta();el('cloudLastSaved').textContent=fmt(m.lastSaved);
  el('cloudPending').textContent=m.queue.length?m.queue.length+'件（端末に保存済み）':'なし';
  el('cloudConnection').textContent=connected?'接続済み：'+(session?.deviceName||'この端末'):'未接続';
  el('cloudLogin').hidden=connected;el('cloudLogout').hidden=!connected;
}
function schedule(delay=0){clearTimeout(timer);timer=setTimeout(()=>send(false).catch(report),delay);renderStatus().catch(report);}
function report(e){status(e instanceof TypeError?'通信失敗：端末データを保持しています':e.message||'通信失敗：端末データを保持しています');}
async function send(manual){
  if(!hosted){status('クラウド版で接続してください');return;}
  if(!connected){status('未接続：端末に保存済み');return;}
  if(!store.isIndexedDB()){status('まず保存方式をIndexedDBへ移行してください');return;}
  if(running)return;
  if(!navigator.onLine){status('オフライン：次回接続時に送信します');return;}
  running=true;
  try{await navigator.locks.request('workout-cloud-send',{ifAvailable:true},async lock=>{
    if(!lock){schedule(1000);return;}
    let m=await store.meta();
    if(m.needsReview&&!manual){status('既存のクラウド履歴あり：復元または手動保存を選んでください');return;}
    if(manual&&m.needsReview){
      const s=await store.capture();
      if(!s.history.length&&!m.revision){status('空の初期データは送信しません。履歴から復元してください');return;}
      if(!confirm('現在の端末の'+s.history.length+'件をクラウドへ保存しますか？保存後は最新3世代を保持します。'))return;
      await store.updateMeta(v=>({...v,needsReview:false}));m=await store.meta();
    }
    if(!m.queue.length){
      if(!manual||m.lastSaved){status(m.lastSaved?'クラウド保存済み：変更はありません':'接続済み：記録すると自動保存します');return;}
      const s=await store.capture();
      if(!s.history.length&&!m.revision){status('空の初期データは送信しません');return;}
      await store.enqueue();
    }
    for(;;){
      m=await store.meta();if(!m.queue.length)break;
      if(m.needsReview)break;
      let entry=m.queue[0];
      // Persist the sending device once. Reauthentication retries the same ID,
      // original device and contents after an ambiguous network response.
      if(entry.deviceId===undefined){
        await store.updateMeta(v=>{const q=v.queue.find(x=>x.id===entry.id);if(q&&q.deviceId===undefined)q.deviceId=session?.sessionId||null;return v;});
        m=await store.meta();entry=m.queue[0];
      }
      const pending=await createBackup(entry,entry.deviceId);
      status('送信中… 端末に保存済み（残り'+m.queue.length+'件）');
      await api('backups/'+pending.backup_id,'PUT',pending);
      const saved=await api('backups/'+pending.backup_id);await validateBackup(saved);
      if(saved.sha256!==pending.sha256||saved.backup_json!==pending.backup_json||saved.source_revision!==pending.source_revision)throw Error('保存内容の照合に失敗しました。端末データを保持しています');
      await store.updateMeta(v=>({...v,sentRevision:Math.max(v.sentRevision,pending.source_revision),queue:v.queue.filter(x=>x.id!==pending.backup_id),lastSaved:saved.received_at}));
      failures=0;await renderStatus();
    }
    status('クラウド保存済み（最新3世代）');
  });}catch(e){
    if(e.status===401){connected=false;status('認証が解除されました：再接続してください');await renderStatus();}
    else if(e.status===400||e.status===409||e.status===413){status(e.message+'。未送信データは端末に保持しています');}
    else{status('通信失敗：端末に保存済み。再試行します');if(++failures<=5)schedule(Math.min(60000,2000*2**failures));}
  }finally{running=false;}
}
async function connect(){
  const key=el('recoveryKey').value.trim(),name=el('deviceName').value.trim();el('recoveryKey').value='';
  session=await api('session','POST',{deviceName:name},key);connected=true;
  const list=await api('backups');historyRows=list.backups;
  await store.updateMeta(v=>({...v,needsReview:historyRows.length>0,checkedExisting:true}));
  await renderStatus();status(historyRows.length?'接続済み：履歴から復元、または手動保存を選んでください':'接続済み：記録すると自動保存します');
  if(!historyRows.length){
    const m=await store.meta(),s=await store.capture();
    if(!m.queue.length&&s.history.length&&!m.lastSaved)await store.enqueue();
    schedule();
  }
}
function download(s,label='backup'){
  const url=URL.createObjectURL(new Blob([JSON.stringify(s,null,2)],{type:'application/json'})),a=document.createElement('a');
  a.href=url;a.download='筋トレ_'+label+'_'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function restore(s,label){
  const current=await store.capture();
  if(!confirm(label+'：記録'+s.history.length+'件・種目'+s.menus.length+'個。\n現在の記録'+current.history.length+'件を端末内に退避し、置き換えますか？'))return;
  // Restoration and sending share this lock, including the confirmation's
  // stale-data check. Edits during a read/confirmation cannot be overwritten.
  await navigator.locks.request('workout-cloud-send',()=>store.restore(s,current));
  status('復元しました。元データは「復元前のデータを書き出す」で保存できます');await renderStatus();schedule();
}
async function loadHistory(){
  const list=await api('backups');historyRows=list.backups;const root=el('cloudHistory');root.replaceChildren();
  if(!historyRows.length){root.textContent='保存履歴はありません';return;}
  for(const row of historyRows){
    const div=document.createElement('div');div.className='cloud-row';
    const label=document.createElement('span');label.textContent=fmt(row.received_at)+' · 記録'+row.record_count+'件';
    const button=document.createElement('button');button.textContent='復元';
    button.onclick=()=>guard(async()=>{const v=await api('backups/'+row.backup_id),s=await validateBackup(v);await restore(s,fmt(row.received_at));});
    div.append(label,button);root.append(div);
  }
}
async function guard(fn){try{await fn();}catch(e){report(e);}}
function managementKey(){const k=el('managementKey').value.trim();el('managementKey').value='';return k;}
async function devices(){
  const data=await api('sessions','POST',{},managementKey()),root=el('cloudDevices');root.replaceChildren();
  for(const s of data.sessions){
    const div=document.createElement('div');div.className='cloud-row';
    const label=document.createElement('span');label.textContent=s.deviceName+(s.current?'（この端末）':'')+'\n作成 '+fmt(s.createdAt)+' / 利用 '+fmt(s.lastUsedAt);
    const rename=document.createElement('button');rename.textContent='名前変更';
    rename.onclick=()=>guard(async()=>{const name=prompt('新しい端末名',s.deviceName);if(!name)return;await api('sessions/rename','POST',{sessionId:s.id,deviceName:name},managementKey());status('端末名を変更しました');label.textContent=name;if(s.current){session.deviceName=name;await renderStatus();}});
    const revoke=document.createElement('button');revoke.textContent='取消';
    revoke.onclick=()=>guard(async()=>{if(!confirm(s.deviceName+'の認証を取り消しますか？'))return;await api('sessions/revoke','POST',{sessionId:s.id},managementKey());div.remove();status('端末の認証を取り消しました');if(s.current){connected=false;await renderStatus();}});
    div.append(label,rename,revoke);root.append(div);
  }
}
async function checkSession(){
  if(!hosted)return;
  try{
    session=await api('session');connected=true;let m=await store.meta();
    if(!m.checkedExisting){const list=await api('backups');historyRows=list.backups;await store.updateMeta(v=>({...v,needsReview:historyRows.length>0,checkedExisting:true}));m=await store.meta();}
    await renderStatus();status(m.needsReview?'既存のクラウド履歴あり：復元または手動保存を選んでください':'接続済み');if(m.queue.length)schedule();
  }catch(e){connected=false;await renderStatus();status(e.status===401?'未接続：復旧キーで接続してください':'通信失敗：端末データを保持しています');}
}
async function init(){
  el('cloudHostedControls').hidden=!hosted;el('cloudMigration').hidden=hosted;
  if(!hosted)status('JSONを書き出してクラウド版へ読み込んでください');
  el('cloudLoginButton').onclick=()=>guard(connect);
  el('cloudSave').onclick=()=>guard(()=>send(true));
  el('cloudExport').onclick=()=>guard(async()=>download(await store.capture()));
  el('cloudSafetyExport').onclick=()=>guard(async()=>{const s=await store.readRecord('restoreSafety');if(!s)throw Error('復元前の退避データはありません');download(s.data,'復元前');});
  el('cloudHistoryButton').onclick=()=>guard(loadHistory);
  el('cloudLogout').onclick=()=>guard(async()=>{await api('session/logout','POST',{});connected=false;await renderStatus();status('ログアウト：端末データは保存済み');});
  el('cloudDevicesButton').onclick=()=>guard(devices);
  el('cloudRevokeAll').onclick=()=>guard(async()=>{if(!confirm('全端末の認証を取り消しますか？'))return;await api('sessions/revoke','POST',{all:true},managementKey());connected=false;el('cloudDevices').replaceChildren();await renderStatus();status('全端末の認証を取り消しました');});
  el('cloudRotate').onclick=()=>guard(async()=>{
    if(!confirm('復旧キーを変更し、全端末の認証を取り消しますか？新しいキーを保存してください。'))return;
    const data=await api('sessions/rotate','POST',{},managementKey());connected=false;await renderStatus();
    el('newKey').value=data.recoveryKey;el('newKeyDialog').showModal();status('新しいキーで再接続してください');
  });
  el('newKeyCopy').onclick=()=>guard(async()=>{await navigator.clipboard.writeText(el('newKey').value);});
  el('newKeyClose').onclick=()=>{el('newKey').value='';el('newKeyDialog').close();};
  el('newKeyDialog').onclose=()=>{el('newKey').value='';};
  window.addEventListener('workout-change',()=>schedule());
  window.addEventListener('workout-cloud-state',()=>renderStatus().catch(report));
  window.addEventListener('online',()=>{failures=0;checkSession();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&hosted)checkSession();});
  await renderStatus();if(hosted)await checkSession();
  window.__WORKOUT_CLOUD_READY__=true;
  if(hosted&&'serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
if(window.__WORKOUT_READY__)init().catch(report);else window.addEventListener('workout-ready',()=>init().catch(report),{once:true});
