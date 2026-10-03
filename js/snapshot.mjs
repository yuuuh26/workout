export const APP_ID='workout';
// 8 MiB covers many years of text-only training records; D1 rows are chunked.
export const MAX_BYTES=8*1024*1024;
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function digest(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export function validateData(s){
  if(!s||s.format!=='yuu-workout-backup'||s.version!==1||!Array.isArray(s.menus)||!s.menus.every(v=>typeof v==='string')||!Array.isArray(s.history))throw Error('筋トレのJSONバックアップを選んでください');
  for(const r of s.history){
    if(!r||typeof r.menu!=='string'||!Number.isFinite(r.count)||r.count<=0||!Number.isFinite(r.id))throw Error('読み取れない筋トレ記録があります');
    const m=/^(\d{4})\/(\d{2})\/(\d{2})$/.exec(r.date),t=/^(\d{2}):(\d{2})$/.exec(r.time);
    if(!m||!t)throw Error('記録の日時を確認してください');
    const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+t[1],+t[2]));
    if(d.getUTCFullYear()!==+m[1]||d.getUTCMonth()!==+m[2]-1||d.getUTCDate()!==+m[3]||d.getUTCHours()!==+t[1]||d.getUTCMinutes()!==+t[2])throw Error('記録の日時を確認してください');
  }
  if(new TextEncoder().encode(JSON.stringify(s)).length>MAX_BYTES)throw Error('クラウドバックアップは8MBまでです。端末データは保持しています');
  return s;
}
export function parseSnapshot(text){if(typeof text!=='string'||new TextEncoder().encode(text).length>MAX_BYTES)throw Error('クラウドバックアップは8MBまでです');return validateData(JSON.parse(text));}
export async function createBackup(entry,deviceId=null){
  const backup_json=JSON.stringify(validateData(entry.data));
  return {backup_id:entry.id,app_id:APP_ID,schema_version:1,created_at:entry.createdAt,device_id:deviceId,record_count:entry.data.history.length,source_revision:entry.revision,backup_json,sha256:await digest(backup_json),byte_length:new TextEncoder().encode(backup_json).length};
}
export async function validateBackup(v){
  if(!v||!uuid.test(v.backup_id)||v.app_id!==APP_ID||v.schema_version!==1||!iso(v.created_at)||(v.device_id!==null&&!uuid.test(v.device_id))||!integer(v.record_count)||!integer(v.source_revision)||!integer(v.byte_length)||!/^[0-9a-f]{64}$/.test(v.sha256))throw Error('バックアップ情報が不正です');
  const s=parseSnapshot(v.backup_json);
  if(s.history.length!==v.record_count||new TextEncoder().encode(v.backup_json).length!==v.byte_length||await digest(v.backup_json)!==v.sha256)throw Error('バックアップの照合に失敗しました');
  return s;
}
