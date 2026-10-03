const CACHE='workout-shell-v2.0.0';
const FILES=['/','/index.html','/app.js?v=2.0.0','/js/cloud.mjs?v=2.0.0','/js/snapshot.mjs','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('workout-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  // Neither authenticated data nor any API response enters the shell cache.
  if(event.request.method!=='GET'||url.origin!==location.origin||url.pathname.startsWith('/v1/'))return;
  if(!FILES.includes(url.pathname+url.search)&&!FILES.includes(url.pathname))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(c=>c.put(event.request,copy)));}
    return response;
  }).catch(()=>caches.match(event.request).then(r=>r||Promise.reject(Error('Offline')))));
});
