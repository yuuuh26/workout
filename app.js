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
function localTodayString() {
    const now=new Date(),pad=n=>String(n).padStart(2,'0');
    return `${now.getFullYear()}/${pad(now.getMonth()+1)}/${pad(now.getDate())}`;
}
function refreshTodayMarkers() {
    const today=localTodayString();
    document.querySelectorAll('#historyList .history-item').forEach(el=>{
        const matches=el.dataset.recordDate===today;
        el.classList.toggle('is-today',matches);
        const badge=el.querySelector('.today-badge');
        if(badge) badge.hidden=!matches;
    });
}
let todayRefreshTimer;
function scheduleTodayRefresh() {
    clearTimeout(todayRefreshTimer);
    const now=new Date(),midnight=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
    todayRefreshTimer=setTimeout(()=>{
        refreshTodayMarkers();
        scheduleTodayRefresh();
    },Math.max(1000,midnight.getTime()-now.getTime()+1000));
}
window.addEventListener('focus',()=>{refreshTodayMarkers();scheduleTodayRefresh();});
document.addEventListener('visibilitychange',()=>{
    if(!document.hidden){refreshTodayMarkers();scheduleTodayRefresh();}
});
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
        const el=document.createElement('div');el.className='history-item';el.dataset.recordDate=r.date;
        const content=document.createElement('div');content.className='history-content';
        const meta=document.createElement('div');meta.className='history-meta';
        const data=document.createElement('div');data.className='history-data';
        const dateLabel=document.createElement('span');dateLabel.className='history-date';dateLabel.textContent='📅 '+r.date;
        const badge=document.createElement('span');badge.className='today-badge';badge.textContent='今日';badge.hidden=true;
        dateLabel.append(badge);
        const timeLabel=document.createElement('span');timeLabel.textContent='⏰ '+r.time;
        meta.append(dateLabel,timeLabel);
        for(const text of ['💪 '+r.menu,r.count+' 回']) {
            const span=document.createElement('span');span.textContent=text;data.append(span);
        }
        content.append(meta,data);
        const del=document.createElement('button');del.className='btn-item-delete';del.textContent='🗑️';del.setAttribute('aria-label',r.menu+' '+r.date+' '+r.time+'の記録を削除');del.onclick=()=>deleteHistoryItem(i);
        el.append(content,del);$('historyList').append(el);
    });
    refreshTodayMarkers();
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
    refreshExportSelection();
}
function resetDate() { $('recordDate').value='';$('dateDetails').open=false; }
$('resetDate').onclick=resetDate;
$('dateDetails').ontoggle=()=>{if(!$('dateDetails').open) $('recordDate').value='';};
function saveRecord() { return action(async()=> {
    const count=Number($('countInput').value), menu=$('workoutSelect').value;
    if(!Numb --- TRUNCATED --- 22,328 chars