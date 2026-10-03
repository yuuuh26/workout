import {stripTypeScriptTypes} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const out='cloudflare/dist';
await mkdir(out,{recursive:true});
for(const name of ['worker','sessions','retention','shared-db']){
  let source=await readFile('cloudflare/'+name+'.ts','utf8');
  source=stripTypeScriptTypes(source,{mode:'transform'});
  source=source.replace(/from ['"]\.\/(worker|sessions|retention|shared-db)['"]/g,"from './$1.mjs'").replace("../js/snapshot.mjs","./snapshot.mjs");
  await writeFile(out+'/'+name+'.mjs',source);
}
await writeFile(out+'/snapshot.mjs',await readFile('js/snapshot.mjs'));
await writeFile(out+'/site-worker.mjs',await readFile('cloudflare/site-worker.mjs'));
const files={'index.html':'text/html;charset=utf-8','app.js':'text/javascript;charset=utf-8','js/cloud.mjs':'text/javascript;charset=utf-8','js/snapshot.mjs':'text/javascript;charset=utf-8','sw.js':'text/javascript;charset=utf-8','manifest.webmanifest':'application/manifest+json','icons/icon-192.png':'image/png','icons/icon-512.png':'image/png'};
const assets={};for(const [path,type] of Object.entries(files))assets['/'+path]={type,base64:(await readFile(path)).toString('base64')};
await writeFile(out+'/assets.mjs','export default '+JSON.stringify(assets)+';\n');
console.log('Built Worker modules and public shell assets');
