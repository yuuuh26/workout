import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import api from '../cloudflare/dist/worker.mjs';
import {createBackup,digest} from '../js/snapshot.mjs';
const origin='https://workout-backups.example.test';
const key='A'.repeat(43);
function setup(){
  const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON;'+readFileSync(new URL('../cloudflare/shared-schema.sql',import.meta.url),'utf8'));
  const wrap=(query,params=[])=>({bind(...args){return wrap(query,args)},async first(){return sql.prepare(query).get(...params)||null},async all(){return {results:sql.prepare(query).all(...params)}},run(){sql.prepare(query).run(...params)}});
  const DB={prepare:wrap,async batch(statements){sql.exec('BEGIN');try{for(const s of statements)s.run();sql.exec('COMMIT');return [];}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return {sql,env:{DB,DB_TABLE_PREFIX:'workout',BACKUP_TOKEN_SHA256:null}};
}
function call(env,path,method='GET',body,authorization,cookie){
  return api.fetch(new Request(origin+'/v1/'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(authorization?{Authorization:'Bearer '+authorization}:{}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)}),env);
}
const data=count=>({format:'yuu-workout-backup',version:1,menus:['腕立て','逆手懸垂'],history:[{date:'2026/10/03',time:'20:00',menu:'腕立て',count,id:1,custom:{preserve:true}}]});
async function backup(count){return createBackup({id:crypto.randomUUID(),revision:count,createdAt:new Date().toISOString(),data:data(count)});}
test('authentication, app separation, CSRF, device management and rotation',async()=>{
  const {sql,env}=setup();env.BACKUP_TOKEN_SHA256=await digest(key);
  assert.equal((await call(env,'backups')).status,401);
  const b=await backup(1);
  for(const method of ['GET','PUT','DELETE'])assert.equal((await call(env,'backups/'+b.backup_id,method,method==='PUT'?b:undefined)).status,401);
  assert.equal((await call(env,'session','POST',{deviceName:'test'},'B'.repeat(43))).status,401);
  const r=await call(env,'session','POST',{deviceName:'Pixel test'},key);assert.equal(r.status,200);
  const cookie=r.headers.get('set-cookie').split(';')[0];assert.match(cookie,/^__Host-workout-session=/);assert.match(r.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);
  const session=await r.json();assert.equal((await call(env,'session','GET',undefined,undefined,cookie)).status,200);
  assert.equal((await call(env,'backups','GET',undefined,undefined,cookie.replace('__Host-workout','__Host-sorosoro'))).status,401);
  assert.equal((await call(env,'sessions','POST',{},undefined,cookie)).status,401);
  assert.equal((await api.fetch(new Request(origin+'/v1/session',{method:'POST',headers:{Origin:'https://evil.test',Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({deviceName:'evil'})}),env)).status,403);
  assert.equal((await call(env,'sessions/rename','POST',{sessionId:session.sessionId,deviceName:'Renamed'},key,cookie)).status,200);
  assert.equal((await (await call(env,'session','GET',undefined,undefined,cookie)).json()).deviceName,'Renamed');
  assert.equal((await call(env,'sessions/revoke','POST',{sessionId:session.sessionId},key,cookie)).status,200);
  assert.equal((await call(env,'backups','GET',undefined,undefined,cookie)).status,401);
  const rotate=await call(env,'sessions/rotate','POST',{},key);assert.equal(rotate.status,200);const newKey=(await rotate.json()).recoveryKey;
  assert.equal((await call(env,'session','POST',{deviceName:'old'},key)).status,401);
  assert.equal((await call(env,'session','POST',{deviceName:'new'},newKey)).status,200);
  assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM workout_auth_sessions').all()).includes(cookie.split('=')[1]));
  assert.equal((await api.fetch(new Request(origin+'/v1/backups'),{...env,DB_TABLE_PREFIX:'sorosoro'})).status,500);
});
test('three verified generations, exact restore, idempotency, failed saves preserve history',async()=>{
  const {sql,env}=setup();env.BACKUP_TOKEN_SHA256=await digest(key);
  const all=[];
  for(let i=1;i<=5;i++){
    const b=await backup(i);all.push(b);
    assert.equal((await call(env,'backups/'+b.backup_id,'PUT',b,key)).status,200);
    const saved=await (await call(env,'backups/'+b.backup_id,'GET',undefined,key)).json();
    assert.equal(saved.backup_json,b.backup_json);assert.equal(saved.sha256,b.sha256);
  }
  const list=await (await call(env,'backups','GET',undefined,key)).json();
  assert.deepEqual(list.backups.map(x=>x.source_revision),[5,4,3]);
  const last=all.at(-1);
  assert.equal((await call(env,'backups/'+last.backup_id,'PUT',last,key)).status,200);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM workout_backups').get().n,3);
  const changed={...last,backup_json:JSON.stringify(data(99))};changed.sha256=await digest(changed.backup_json);changed.byte_length=new TextEncoder().encode(changed.backup_json).length;
  assert.equal((await call(env,'backups/'+last.backup_id,'PUT',changed,key)).status,409);
  const corrupt=await backup(6);corrupt.sha256='0'.repeat(64);
  assert.equal((await call(env,'backups/'+corrupt.backup_id,'PUT',corrupt,key)).status,400);
  const badApp={...await backup(6),app_id:'sorosoro'};
  assert.equal((await call(env,'backups/'+badApp.backup_id,'PUT',badApp,key)).status,400);
  const before=sql.prepare('SELECT backup_id FROM workout_backups').all();
  const batch=env.DB.batch;env.DB.batch=async statements=>{if(statements.length>=3)throw Error('disk failed');return batch(statements);};
  const fail=await backup(7);
  assert.equal((await call(env,'backups/'+fail.backup_id,'PUT',fail,key)).status,503);
  env.DB.batch=batch;assert.deepEqual(sql.prepare('SELECT backup_id FROM workout_backups').all(),before);
  assert.throws(()=>sql.exec("DELETE FROM workout_backups"),/protected backup/);
  assert.throws(()=>sql.exec("UPDATE workout_backups SET record_count=0"),/immutable backup/);
  assert.equal((await call(env,'backups/'+all[0].backup_id,'GET',undefined,key)).status,404);
});
