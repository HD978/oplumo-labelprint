// Explicit operator-run migration of local Sites assets to one authenticated tenant.
// Private artwork is read from disk, never committed to the public source repo.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [source,apiOrigin,workspaceId]=process.argv.slice(2);
if(!source||!apiOrigin||!workspaceId||!process.env.STUDIO_EMAIL||!process.env.STUDIO_PASSWORD)throw Error('Usage: STUDIO_EMAIL / STUDIO_PASSWORD in environment; node scripts/v2/migrate-sites.mjs <public-directory> <https-api-origin> <workspace-id>');
const origin=new URL(apiOrigin).origin;
async function req(route,method='GET',body){const response=await fetch(`${origin}${route}`,{method,headers:{Origin:process.env.STUDIO_APP_ORIGIN??origin,...(cookie?{Cookie:cookie,'X-Workspace-ID':workspaceId}:{}),...(typeof body==='string'?{'Content-Type':'application/json'}:{})},body});if(!response.ok)throw Error(`${route}: ${response.status} ${await response.text()}`);return response;}
let cookie='';const login=await req('/api/auth/login','POST',JSON.stringify({email:process.env.STUDIO_EMAIL,password:process.env.STUDIO_PASSWORD}));cookie=login.headers.get('set-cookie')?.split(';')[0]??'';if(!cookie)throw Error('No login session');
const docs=JSON.parse(await readFile(path.join(source,'seed-templates.json'),'utf8'));
const catalogue=JSON.parse(await readFile(path.join(source,'source-catalogue.json'),'utf8'));
const uploaded=new Map();
async function asset(url,name){if(uploaded.has(url))return uploaded.get(url);const resolved=path.resolve(source,`.${url}`);if(!resolved.startsWith(path.resolve(source)+path.sep))throw Error('Unsafe asset path');const form=new FormData();form.append('file',new File([await readFile(resolved)],name??path.basename(resolved)));const result=await (await req('/api/assets','POST',form)).json();uploaded.set(url,result.id);return result.id;}
for(const doc of docs){for(const el of doc.elements){if(el.type==='image'&&el.src.startsWith('/label-assets/'))el.src=`asset:${await asset(el.src)}`;}await req(`/api/templates/${encodeURIComponent(doc.id)}`,'PUT',JSON.stringify(doc));}
for(const file of catalogue)if(file.url)await asset(file.url,file.name);
console.log(`Imported ${docs.length} template drafts and ${uploaded.size} assets into the selected workspace. Review and publish explicitly; shelf lives are not inferred.`);
