// Dedicated SQL namespaces let several apps share D1 without sharing records.
const tables = ['auth_sessions','auth_config','auth_attempts','cloud_state','backups','backup_chunks','backup_retention','receipts'];
const tokens = /'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\/|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\b[A-Za-z_][A-Za-z_0-9]*\b/g;
export function namespaceSql(sql:string,prefix:string,extraIdentifiers:string[]=[]):string {
  if(!/^[a-z][a-z_0-9]*$/.test(prefix))throw new Error('Invalid database namespace');
  const names=new Set([...tables,...extraIdentifiers]);
  return sql.replace(tokens,(token)=>{
    if(token.startsWith("'")||token.startsWith('--')||token.startsWith('/*'))return token;
    const quoted=/^["`\[]/.test(token),name=quoted?token.slice(1,-1):token;
    if(!names.has(name.toLowerCase()))return token;
    const scoped=prefix+'_'+name;
    return quoted?token[0]+scoped+token.at(-1):scoped;
  });
}
export function appDatabase(db:any,prefix:string,expectedPrefix:string):any {
  if(prefix!==expectedPrefix)throw new Error('Database namespace does not match this app');
  return {prepare(sql:string){return db.prepare(namespaceSql(sql,prefix));},batch(statements:any[]){return db.batch(statements);}};
}

