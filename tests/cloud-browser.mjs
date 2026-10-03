import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import site from '../cloudflare/dist/site-worker.mjs';
import {digest} from '../js/snapshot.mjs';
const origin='https://workout-backups.dengana-10011212.workers.dev',key='A'.repeat(43);
const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON;'+readFileSync(new URL('../cloudflare/shared-schema.sql',import.meta.url),'utf8'));
const wrap=(query,params=[])=>({bind(...args){return wrap(query,args)},async first(){return sql.prepare(query).get(...params)||null},async all(){return {results:sql.prepare(query).all(...params)}},run(){sql.prepare(query).run(...params)}});
const DB={prepare:wrap,async batch(st){sql.exec('BEGIN');try{st.forEach(s=>s.run());sql.exec('COMMIT');return [];}catch(e){sql.exec('ROLLBACK');throw e;}}};
const env={DB,DB_TABLE_PREFIX:'workout',BACKUP_TOKEN_SHA256:await digest(key)};
const browser=await chromium.launch({headless:true});
try{
  const ctx=await browser.newContext({timezoneId:'Asia/Tokyo',viewport:{width:390,height:844},serviceWorkers:'block'});
  let failNetwork=false,ambiguous=false,hold=null,resolveHeld,started=false;const puts=[];
  await ctx.route(origin+'/**',async route=>{
    const r=route.request(),path=new URL(r.url()).pathname;
    if(failNetwork&&path.startsWith('/v1/')){await route.abort('failed');return;}
    const req=new Request(r.url(),{method:r.method(),headers:await r.allHeaders(),body:['GET','HEAD'].includes(r.method())?undefined:r.postData()});
    if(r.method()==='PUT'){
      puts.push(JSON.parse(r.postData()));started=true;
      if(hold)await hold;
    }
    const response=await site.fetch(req,env);
    if(ambiguous&&r.method()==='PUT'){ambiguous=false;failNetwork=true;await route.abort('failed');return;}
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());
  await p.goto(origin);await p.waitForFunction(()=>window.__WORKOUT_CLOUD_READY__);
  assert.equal(await p.evaluate(()=>mode),'indexeddb');assert.equal(puts.length,0);
  await p.locator('#dataSettings summary').first().click();
  const seed={format:'yuu-workout-backup',version:1,menus:['腕立て','逆手懸垂','<b>種目</b>'],history:[{date:'2026/10/01',time:'18:00',menu:'腕立て',count:24,id:1,custom:{x:'keep'}},{date:'2026/10/02',time:'18:00',menu:'逆手懸垂',count:14,id:1}]};
  await p.locator('#restoreFile').setInputFiles({name:'existing.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(seed))});
  await p.waitForFunction(()=>state.history.length===2);assert.equal(puts.length,0);
  await p.locator('#recoveryKey').fill(key);await p.locator('#deviceName').fill('Pixel test');await p.locator('#cloudLoginButton').click();
  await p.waitForFunction(()=>document.getElementById('cloudPending').textContent==='なし'&&document.getElementById('cloudStatus').textContent.includes('クラウド保存済み'));
  assert.equal(puts.length,1);assert.equal(JSON.parse(puts[0].backup_json).history[0].custom.x,'keep');
  assert.equal(await p.locator('#recoveryKey').inputValue(),'');
  assert.ok(!JSON.stringify(await p.evaluate(()=>WorkoutCloud.meta())).includes(key));
  async function add(count){await p.locator('#countInput').fill(String(count));await p.evaluate(()=>saveRecord());}
  async function drained(){for(let i=0;i<300;i++){const m=await p.evaluate(()=>WorkoutCloud.meta());if(m.queue.length===0&&m.sentRevision>=m.revision)return;await p.waitForTimeout(20);}throw Error('queue did not drain');}
  for(let i=1;i<=4;i++){await add(i+24);await drained();}
  assert.equal(puts.length,5);assert.equal(sql.prepare('SELECT count(*) AS n FROM workout_backups').get().n,3);
  hold=new Promise(r=>resolveHeld=r);started=false;await add(40);
  await p.waitForFunction(()=>document.getElementById('cloudStatus').textContent.startsWith('送信中'));
  await add(41);assert.equal((await p.evaluate(()=>WorkoutCloud.meta())).queue.length,2);
  hold=null;resolveHeld();await drained();assert.equal(puts.length,7);
  // Failure after the server committed: same operation survives restart.
  ambiguous=true;await add(42);
  await p.waitForFunction(()=>document.getElementById('cloudStatus').textContent.includes('通信'));
  const pendingId=(await p.evaluate(()=>WorkoutCloud.meta())).queue[0].id;
  await p.evaluate(()=>Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true}));
  await add(43);await add(44);assert.equal((await p.evaluate(()=>WorkoutCloud.meta())).queue.length,3);
  await p.reload();await p.waitForFunction(()=>window.__WORKOUT_CLOUD_READY__);
  assert.equal((await p.evaluate(()=>WorkoutCloud.meta())).queue[0].id,pendingId);
  failNetwork=false;await p.evaluate(()=>window.dispatchEvent(new Event('online')));await drained();
  assert.equal(puts.filter(x=>x.backup_id===pendingId).length,2);
  const saved=sql.prepare('SELECT record_count FROM workout_backups ORDER BY source_revision DESC LIMIT 1').get();
  assert.equal(saved.record_count,await p.evaluate(()=>state.history.length));
  // Merely viewing and reopening never creates another generation.
  const sent=puts.length;await p.reload();await p.waitForFunction(()=>window.__WORKOUT_CLOUD_READY__);
  await p.waitForTimeout(150);assert.equal(puts.length,sent);
  await p.locator('#dataSettings summary').first().click();await p.locator('#cloudHistoryButton').click();await p.waitForFunction(()=>document.querySelectorAll('#cloudHistory button').length===3);
  const before=await p.evaluate(()=>WorkoutCloud.capture());await p.locator('#cloudHistory button').last().click();for(let i=0;i<200;i++){const safety=await p.evaluate(()=>WorkoutCloud.readRecord('restoreSafety'));if(safety?.data.history.length===before.history.length)break;await p.waitForTimeout(20);}await drained();
  assert.deepEqual((await p.evaluate(()=>WorkoutCloud.readRecord('restoreSafety'))).data,before);
  assert.equal(await p.locator('#bestGrid b').count(),0);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await p.screenshot({path:'/tmp/workout-cloud-mobile.png',fullPage:true});
  // A new device with existing cloud data must not send its empty defaults.
  const ctx2=await browser.newContext({serviceWorkers:'block'});await ctx2.route(origin+'/**',async route=>{
    const r=route.request(),res=await site.fetch(new Request(r.url(),{method:r.method(),headers:await r.allHeaders(),body:['GET','HEAD'].includes(r.method())?undefined:r.postData()}),env);
    await route.fulfill({status:res.status,headers:Object.fromEntries(res.headers),body:Buffer.from(await res.arrayBuffer())});
  });
  const q=await ctx2.newPage();await q.goto(origin);await q.waitForFunction(()=>window.__WORKOUT_CLOUD_READY__);
  await q.locator('#dataSettings summary').first().click();await q.locator('#recoveryKey').fill(key);await q.locator('#cloudLoginButton').click();
  await q.waitForFunction(()=>document.getElementById('cloudStatus').textContent.includes('履歴から復元'));
  await q.locator('#cloudSave').click();await q.waitForFunction(()=>document.getElementById('cloudStatus').textContent.includes('空の初期データ'));
  assert.equal(sql.prepare('SELECT count(*) AS n FROM workout_backups').get().n,3);
  assert.deepEqual(errors,[]);
  console.log('PASS cloud browser: exact migration, every record, 3 generations, concurrent edits, durable offline queue, ambiguous retry ID, no read-only upload, restore safety, empty-device protection, CSP/XSS, mobile width');
}finally{await browser.close();}
