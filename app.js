'use strict';
const defaultMenus = ['逆手懸垂', '腕立て', 'カーフレイズ', 'スクワット'];
const DB_NAME = 'yuu-workout-v1';
const $ = id => document.getElementById(id);
let db, state, mode = 'loading', backupSource = null, busy = false;
let currentDiffDays = 0, currentPeriodText = '記録がありません';
const clone = x => JSON.parse(JSON.stringify(x));
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function message(text) { $('appMessage').textContent = text; }
let toastTimer;
function showToast(text) {
    let toast=$('downloadToast');
    if(!toast){
        toast=document.createElement('div');
        toast.id='downloadToast';
        toast.setAttribute('role','status');
        toast.setAttribute('aria-live','polite');
        Object.assign(toast.style,{
            position:'fixed',
            left:'50%',
            bottom:'28px',
            transform:'translateX(-50%) translateY(12px)',
            background:'#2d3436',
            color:'#fff',
            padding:'12px 18px',
            borderRadius:'12px',
            boxShadow:'0 6px 20px rgba(0,0,0,.18)',
            fontSize:'14px',
            fontWeight:'bold',
            zIndex:'9999',
            opacity:'0',
            transition:'opacity .18s ease, transform .18s ease',
            maxWidth:'calc(100vw - 40px)',
            textAlign:'center',
            pointerEvents:'none'
        });
        document.body.append(toast);
    }
    toast.textContent=text;
    clearTimeout(toastTimer);
    requestAnimationFrame(()=>{toast.style.opacity='1';toast.style.transform='translateX(-50%) translateY(0)';});
    toastTimer=setTimeout(()=>{toast.style.opacity='0';toast.style.transform='translateX(-50%) translateY(12px)';},2600);
}
function validate(s) {
    if (!s || !Array.isArray(s.menus) || !s.menus.every(x=>typeof x==='string') || !Array.isArray(s.history)) throw Error('バックアップの形式が正しくありません。');
    for (const r of s.history) if (!r || typeof r.date!=='string' || typeof r.time!=='string' || typeof r.menu!=='string' || !Number.isFinite(r.count) || r.count<=0 || !Number.isFinite(r.id) || !Number.isFinite(recordTime(r))) throw Error('読み取れない記録があります。元データは変更しません。');
    return s;
}
function recordTime(r) {
    const m=/^(\d{4})\/(\d{2})\/(\d{2})$/.exec(r.date), t=/^(\d{2}):(\d{2})$/.exec(r.time);
    if (!m || !t) return NaN;
    const d=new Date(+m[1],+m[2]-1,+m[3],+t[1],+t[2]);
    return d.getFullYear()===+m[1] && d.getMonth()===+m[2]-1 && d.getDate()===+m[3] && d.getHours()===+t[1] && d.getMinutes()===+t[2] ? d.getTime() : NaN;
}
function legacy() {
    const h=localStorage.getItem('pureLocalHistory'), m=localStorage.getItem('pureLocalMenus');
    return validate({history:h===null?[]:JSON.parse(h),menus:m===null?[...defaultMenus]:JSON.parse(m)});
}
function openDB() { return new Promise((resolve,reject)=> {
    const r=indexedDB.open(DB_NAME,1);
    r.onupgradeneeded=()=>r.result.createObjectStore('data');
    r.onsuccess=()=> { r.result.onversionchange=()=>r.result.close(); resolve(r.result); };
    r.onerror=()=>reject(r.error); r.onblocked=()=>reject(Error('ほかの画面を閉じて再読み込みしてください。'));
}); }
function readDB() { return new Promise((resolve,reject)=> {
    const tx=db.transaction('data','readonly'), r=tx.objectStore('data').get('state');
    tx.oncomplete=()=>resolve(r.result); tx.onabort=tx.onerror=()=>reject(tx.error||Error('保存先を読み込めません。'));
}); }
const CLOUD_DEFAULTS=()=>({revision:0,sentRevision:0,queue:[],lastSaved:null,needsReview:false,checkedExisting:false});
function backupData(s){return {format:'yuu-workout-backup',version:1,menus:clone(s.menus),history:clone(s.history)};}
function cloudEntry(s,revision){return {id:crypto.randomUUID(),revision,createdAt:new Date().toISOString(),data:backupData(s)};}
function writeDB(next, expected, backup, options={}) { return new Promise((resolve,reject)=> {
    const tx=db.transaction('data','readwrite'), store=tx.objectStore('data'), r=store.get('state'),meta=store.get('cloud');
    let failure;
    r.onsuccess=()=> {
        if (!equal(r.result,expected)) { failure=Error('別の画面で更新されました。再読み込みしてから操作してください。'); tx.abort(); return; }
        // Queue the exact saved snapshot in the SAME transaction as the data.
        meta.onsuccess=()=> {
            store.put(next,'state'); if (backup) store.put(backup,'migrationBackup');
            const m=meta.result||CLOUD_DEFAULTS();
            if(options.safety)store.put({data:backupData(options.safety),queue:clone(m.queue),createdAt:new Date().toISOString()},'restoreSafety');
            if(options.replaceQueue)m.queue=[];
            if(options.clearReview)m.needsReview=false;
            if(options.enqueue!==false && !equal(next,expected)){
                m.revision++;
                m.queue.push(cloudEntry(next,m.revision));
            }
            store.put(m,'cloud');
        };
    };
    tx.oncomplete=()=>resolve(); tx.onabort=tx.onerror=()=>reject(failure||tx.error||Error('保存できませんでした。'));
}); }
async function lock(fn) {
    if (!navigator.locks) throw Error('このブラウザでは安全な更新に必要な機能が使えません。Chromeで開いてください。');
    return navigator.locks.request('yuu-workout-write',fn);
}
async function action(fn) {
    if (busy || !state) return;
    busy=true;
    try { await lock(fn); } catch(e) { message(e.message); } finally {busy=false;}
}
async function commit(next,options={}) {
    validate(next);
    if (mode==='indexeddb') await writeDB(next,state,undefined,options);
    else if(mode==='legacy') {
        if (!equal(legacy(),state) || (db && await readDB())) throw Error('保存先が更新されました。再読み込みしてください。');
        // Each existing action changes only one key. Keep legacy updates atomic.
        if (!equal(next.history,state.history) && !equal(next.menus,state.menus)) throw Error('復元する前にIndexedDBへ移行してください。');
        if (!equal(next.history,state.history)) localStorage.setItem('pureLocalHistory',JSON.stringify(next.history));
        if (!equal(next.menus,state.menus)) localStorage.setItem('pureLocalMenus',JSON.stringify(next.menus));
        backupSource=null; $('migrateButton').disabled=true;
    } else throw Error('保存先を確認できません。再読み込みしてください。');
    state=next; render(); message('端末に保存しました。');
    window.dispatchEvent(new Event('workout-change'));
}
function ordered() { return state.history.map((r,i)=>({r,i})).sort((a,b)=>recordTime(b.r)-recordTime(a.r)||a.i-b.i); }
function render() {
    const selected=$('workoutSelect').value;
    $('workoutSelect').replaceChildren(...state.menus.map(m=>new Option(m,m)));
    if(state.menus.includes(selected)) $('workoutSelect').value=selected;
    $('bestGrid').replaceChildren();
    state.menus.forEach(menu=> {
        const el=document.createElement('div'); el.className='best-item';
        const name=document.createElement('span'), value=document.createElement('span');
        name.className='best-name';name.textContent=menu;value.className='best-val';
        value.textContent=state.history.reduce((n,r)=>r.menu===menu?Math.max(n,r.count):n,0)+'回';
        el.append(name,value);$('bestGrid').append(el);
    });
    $('historyList').replaceChildren();
    const rows=ordered();
    if(!rows.length) $('historyList').textContent='まだ記録がありません。';
    rows.forEach(({r,i})=> {
        const el=document.createElement('div');el.className='history-item';
        const content=document.createElement('div');content.className='history-content';
        const meta=document.createElement('div');meta.className='history-meta';
        const data=document.createElement('div');data.className='history-data';
        for(const [parent,values] of [[meta,['📅 '+r.date,'⏰ '+r.time]],[data,['💪 '+r.menu,r.count+' 回']]]) values.forEach(text=>{const span=document.createElement('span');span.textContent=text;parent.append(span);});
        content.append(meta,data);
        const del=document.createElement('button');del.className='btn-item-delete';del.textContent='🗑️';del.setAttribute('aria-label',r.menu+' '+r.date+' '+r.time+'の記録を削除');del.onclick=()=>deleteHistoryItem(i);
        el.append(content,del);$('historyList').append(el);
    });
    if(rows.length) {
        const oldest=rows[rows.length-1].r.date, newest=rows[0].r.date;
        const day=d=>Date.UTC(...d.split('/').map((v,i)=>+v-(i===1?1:0)));
        currentDiffDays=Math.round((day(newest)-day(oldest))/86400000)+1;
        const format=d=>d.replace('/','年').replace('/','月')+'日';
        currentPeriodText=format(oldest)+' 〜 '+format(newest);
    } else {currentDiffDays=0;currentPeriodText='記録がありません';}
    $('dayCounterDisplay').textContent=rows.length?`最初の記録から ${currentDiffDays} 日目`:'現在の保存日数: 0 日間';
    $('periodDisplay').textContent=rows.length?'📅 '+currentPeriodText:currentPeriodText;
    $('dayCounterBox').style.backgroundColor=currentDiffDays>=100?'#fff0f6':'#e3faf2';
    try { if(currentDiffDays>=100 && !localStorage.getItem('alerted100DaysPure')) {
        message('最初の記録から100日以上経過しています。JSONバックアップも保管してください。');
        localStorage.setItem('alerted100DaysPure','true');
    } else if(currentDiffDays<100) localStorage.removeItem('alerted100DaysPure'); } catch (_) { /* Optional reminder must not block saved records. */ }
    $('storageStatus').textContent=mode==='indexeddb'?`保存先: IndexedDB（${state.history.length}件）`:`保存先: 従来方式（${state.history.length}件）`;
    $('migrationPanel').hidden=mode!=='legacy';
}
function resetDate() { $('recordDate').value='';$('dateDetails').open=false; }
$('resetDate').onclick=resetDate;
$('dateDetails').ontoggle=()=>{if(!$('dateDetails').open) $('recordDate').value='';};
function saveRecord() { return action(async()=> {
    const count=Number($('countInput').value), menu=$('workoutSelect').value;
    if(!Number.isSafeInteger(count)||count<=0||!menu) throw Error('種目と1以上の整数の回数を入力してください。');
    const input=$('recordDate').value;
    const now=input&&$('dateDetails').open?new Date(input):new Date();
    if(!Number.isFinite(now.getTime()) || now.getTime()>Date.now()) throw Error('現在以前の日時を指定してください。');
    const pad=n=>String(n).padStart(2,'0');
    let id=Date.now();const ids=new Set(state.history.map(r=>r.id));while(ids.has(id)) id++;
    const r={date:`${now.getFullYear()}/${pad(now.getMonth()+1)}/${pad(now.getDate())}`,time:`${pad(now.getHours())}:${pad(now.getMinutes())}`,menu,count,id};
    const next=clone(state);next.history.unshift(r);await commit(next);$('countInput').value='';resetDate();
}); }
function addNewMenu() { return action(async()=> {
    const name=$('newMenuInput').value.trim();if(!name)return;
    if(state.menus.includes(name)) throw Error('その種目はもうあるよ！👀');
    const next=clone(state);next.menus.push(name);await commit(next);$('newMenuInput').value='';$('workoutSelect').value=name;
}); }
function deleteCurrentMenu() { return action(async()=> {
    const name=$('workoutSelect').value;if(!name||!confirm(`種目リストから「${name}」を削除しますか？`))return;
    const next=clone(state);next.menus=next.menus.filter(m=>m!==name);await commit(next);
}); }
function deleteHistoryItem(i) { return action(async()=> {
    if(!confirm('⚠️ 本当にこの記録を履歴から削除してもよろしいですか？（この操作は取り消せません）'))return;
    const next=clone(state);next.history.splice(i,1);await commit(next);
}); }
function exportText(file=false) {
    if(!state?.history.length) throw Error('出力する記録がまだないよ！👀');
    let text='### 📋 筋トレ実践記録\n';
    if(file)text+=`- **出力日時**: ${new Date().toLocaleString('ja-JP')}\n`;
    text+=`- **対象期間**: ${currentPeriodText}\n- **経過日数**: 最初の記録から ${currentDiffDays} 日目\n\n| 日付 | 時間 | 種目 | 回数 |\n| :--- | :--- | :--- | :--- |\n`;
    for(const {r} of ordered()) text+=`| ${r.date} | ${r.time} | ${r.menu.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\|/g,'&#124;').replace(/[\r\n]+/g,' ')} | ${r.count}回 |\n`;
    return text;
}
function download(text,name,type) {
    const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function exportHistory() { try {await navigator.clipboard.writeText(exportText());alert('見やすいテーブル形式でクリップボードにコピーしたよ！📋✨\nKeepへの保管や、AIへの分析依頼にそのまま使ってね！');} catch(e){message(e.message);} }
function exportMarkdown() {try {const text=exportText(true),rows=ordered(),date=r=>r.date.replaceAll('/','');download(text,`筋トレ記録_${date(rows.at(-1).r)}-${date(rows[0].r)}.md`,'text/markdown;charset=utf-8');showToast('Markdownファイルのダウンロードを開始しました 📄');}catch(e){message(e.message);} }
function downloadBackup(migration=false) {
    try {
        if(!state)throw Error('データを読み込めていません。');
        const source=mode==='legacy'?legacy():clone(state);
        if(!equal(source,state))throw Error('別の画面で更新されました。再読み込みしてください。');
        download(JSON.stringify({format:'yuu-workout-backup',version:1,exportedAt:new Date().toISOString(),...source},null,2),`筋トレバックアップ_${new Date().toISOString().replace(/[:.]/g,'-')}.json`,'application/json');
        if(migration) {backupSource=clone(source);$('migrateButton').disabled=false;}
        message('ダウンロードしたJSONファイルが保存されていることを確認してください。');
    }catch(e){message(e.message);}
}
function migrateStorage() {return action(async()=> {
    if(!backupSource||!equal(legacy(),backupSource))throw Error('データが変わったため、移行前バックアップを再保存してください。');
    db ||= await openDB();
    const existing=await readDB();if(existing)throw Error('すでに移行されています。再読み込みしてください。');
    await writeDB(backupSource,undefined,backupSource,{enqueue:backupSource.history.length>0});
    const saved=await readDB();
    if(!equal(saved,backupSource))throw Error('移行の照合に失敗しました。元データは残っています。');
    state=saved;mode='indexeddb';render();message(`移行と全項目の照合が完了しました（${state.history.length}件）。旧データも残しています。`);await requestPersistence();window.dispatchEvent(new Event('workout-change'));
});}
$('restoreFile').onchange=async e=> {
    const file=e.target.files[0];e.target.value='';if(!file)return;
    let imported;try {const data=JSON.parse(await file.text());if(data.format!=='yuu-workout-backup'||data.version!==1)throw Error('対応するJSONバックアップではありません。');imported=validate({history:data.history,menus:data.menus});}catch(err){message(err.message);return;}
    await action(async()=> {
        if(mode!=='indexeddb')throw Error('復元する前にIndexedDBへ移行してください。');
        if(!confirm(`JSONの${imported.history.length}件を確認しました。現在の${state.history.length}件をバックアップして、JSONの内容に置き換えますか？`))return;
        downloadBackup();await commit(clone(imported),{safety:state,replaceQueue:true,clearReview:true});
    });
};
async function persistentStatus() {try {$('persistentStatus').textContent=navigator.storage?.persisted?(await navigator.storage.persisted()?'保存の保護: 許可済み':'保存の保護: 未許可'):'保存の保護: 未対応';}catch(e){$('persistentStatus').textContent='保存の保護: 確認できません';} }
async function requestPersistence() {try {if(navigator.storage?.persist)await navigator.storage.persist();}catch(e){} await persistentStatus();}
async function init() {
    try {
        try {db=await openDB();}catch(e){
            // Never fall back if a previous migration may exist but its database is inaccessible.
            throw Error('IndexedDBを開けません。データは変更せず停止しました。Chromeの設定を確認して再読み込みしてください。');
        }
        const saved=await readDB();
        if(saved!==undefined){state=validate(saved);mode='indexeddb';}
        else {
            state=legacy();mode='legacy';
            // A new cloud origin has no old records to migrate. Pages retains
            // its original explicit migration flow and old localStorage keys.
            if(location.hostname==='workout-backups.dengana-10011212.workers.dev'&&!localStorage.getItem('pureLocalHistory')&&!localStorage.getItem('pureLocalMenus')){
                await writeDB(state,undefined,undefined,{enqueue:false});mode='indexeddb';
            }
        }
        render();await persistentStatus();
        window.__WORKOUT_READY__=true;window.dispatchEvent(new Event('workout-ready'));
    }catch(e){mode='error';state=null;$('storageStatus').textContent='保存先の読み込みエラー';message(e.message);}
}
function readLocal(key){return new Promise((resolve,reject)=>{const tx=db.transaction('data','readonly'),r=tx.objectStore('data').get(key);tx.oncomplete=()=>resolve(r.result);tx.onerror=tx.onabort=()=>reject(tx.error||Error('端末保存を読み込めません'));});}
async function updateCloud(fn){
    if(mode!=='indexeddb')throw Error('まず保存方式をIndexedDBへ移行してください');
    await new Promise((resolve,reject)=>{const tx=db.transaction('data','readwrite'),s=tx.objectStore('data'),r=s.get('cloud');r.onsuccess=()=>s.put(fn(r.result||CLOUD_DEFAULTS()),'cloud');tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error||Error('送信待ち状態を保存できません'));});
    window.dispatchEvent(new Event('workout-cloud-state'));
}
window.WorkoutCloud={
    capture:async()=>backupData(mode==='indexeddb'?validate(await readDB()):state),
    meta:async()=>(await readLocal('cloud'))||CLOUD_DEFAULTS(),
    updateMeta:updateCloud,
    readRecord:readLocal,
    isIndexedDB:()=>mode==='indexeddb',
    enqueue:async()=>lock(async()=>{
        if(mode!=='indexeddb')throw Error('まず保存方式をIndexedDBへ移行してください');
        const saved=validate(await readDB());
        await updateCloud(m=>{if(!m.queue.length){m.revision++;m.queue.push(cloudEntry(saved,m.revision));}return m;});
        window.dispatchEvent(new Event('workout-change'));
    }),
    restore:async(snapshot,expected)=>{
        if(mode!=='indexeddb')throw Error('まず保存方式をIndexedDBへ移行してください');
        const next=validate({menus:clone(snapshot.menus),history:clone(snapshot.history)});
        await lock(async()=>{
            const saved=validate(await readDB());
            if(!equal(backupData(saved),expected))throw Error('確認中に端末の記録が変更されました。再度確認してください');
            await writeDB(next,saved,undefined,{safety:expected,replaceQueue:true,clearReview:true});
            state=next;render();message('復元しました。端末に保存済みです');window.dispatchEvent(new Event('workout-change'));
        });
    }
};
const actions={saveRecord,exportHistory,exportMarkdown,addNewMenu,deleteCurrentMenu,downloadBackup,requestPersistence,migrateStorage};
for(const el of document.querySelectorAll('[data-action]')){
    const name=el.dataset.action.split('(')[0];
    el.addEventListener('click',()=>name==='downloadBackup'?downloadBackup(el.dataset.action.includes('true')):actions[name]());
}
init();
