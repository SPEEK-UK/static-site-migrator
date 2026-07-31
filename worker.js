const VERSION = "1.6.6";
const CORS = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type"};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null,{status:204,headers:CORS});
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/,"") || "/";
    try {
      if (!env.DB || !env.STORAGE) throw new Error("Missing DB or STORAGE binding.");
      if (request.method === "GET" && path === "/") return json({success:true,version:VERSION,status:"online"});

      const preview = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (request.method === "GET" && preview) {
        return servePreview(decodeURIComponent(preview[1]),preview[2]||"/",env);
      }

      const fix = path.match(/^\/api\/migrations\/([^/]+)\/fix-animations-only$/);
      if (request.method === "POST" && fix) {
        return fixAnimationsOnly(decodeURIComponent(fix[1]),env);
      }

      return json({success:false,error:"Route not found."},404);
    } catch (error) {
      return json({success:false,error:error instanceof Error ? error.message : String(error)},500);
    }
  }
};

async function fixAnimationsOnly(jobId,env) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if (!job) return json({success:false,error:"Migration job not found."},404);

  const query = await env.DB.prepare("SELECT id,source_url,output_path FROM migration_pages WHERE job_id=? AND status='captured' ORDER BY source_url").bind(jobId).all();
  const pages = query.results || [];
  if (!pages.length) return json({success:false,error:"No generated pages are available."},409);

  const processed=[];
  const warnings=[];

  for (const page of pages) {
    const outputPath=page.output_path||"index.html";
    const key=`${job.output_prefix}/site/${outputPath}`;
    try {
      const object=await env.STORAGE.get(key);
      if (!object?.body) throw new Error(`Generated page missing: ${key}`);
      let html=await object.text();
      html=removeAnimationPayload(html);
      html=injectAnimationPayload(html);
      await env.STORAGE.put(key,html,{
        httpMetadata:{contentType:"text/html; charset=utf-8"},
        customMetadata:{jobId,pageId:page.id,sourceUrl:page.source_url,version:VERSION,animationFinalState:"true"}
      });
      processed.push({pageId:page.id,sourceUrl:page.source_url,outputPath,r2Key:key,htmlLength:html.length});
    } catch (error) {
      warnings.push({pageId:page.id,sourceUrl:page.source_url,error:error instanceof Error?error.message:String(error)});
    }
  }

  const success=warnings.length===0;
  const stage=success?"animations_finalised":"animations_finalised_with_warnings";
  await env.DB.prepare("UPDATE migration_jobs SET current_stage=?,progress_percent=?,updated_at=? WHERE id=?")
    .bind(stage,success?99:98,new Date().toISOString(),jobId).run();

  return json({success,jobId,currentStage:stage,progressPercent:success?99:98,pagesProcessed:processed.length,pages:processed,warnings});
}

function removeAnimationPayload(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-animation-final-v166["'][^>]*>[\s\S]*?<\/style>/gi,"")
    .replace(/<script\b[^>]*id=["']static-migrator-animation-final-v166-script["'][^>]*>[\s\S]*?<\/script>/gi,"");
}

function injectAnimationPayload(html) {
  const payload=`
<style id="static-migrator-animation-final-v166">
/* Animation-final-state correction only. Hero, carousel and slider widgets are excluded. */
[data-static-migrator-animation-fixed="true"] {
  opacity:1!important;
  visibility:visible!important;
  transform:none!important;
  translate:none!important;
  animation:none!important;
  transition:none!important;
}
</style>
<script id="static-migrator-animation-final-v166-script">
(function(){
  function insideWidget(el){
    return !!el.closest('[class*="hero" i],[class*="banner" i],[class*="carousel" i],[class*="slider" i],[class*="slideshow" i],[data-widget-type*="slider" i],[data-widget-type*="gallery" i]');
  }

  function explicitlyHidden(el){
    if(el.hidden || el.getAttribute('aria-hidden')==='true') return true;
    var cls=String(el.className||'').toLowerCase();
    if(/(^|\\s)(hidden|hide|is-hidden|dmhide|display-none)(\\s|$)/.test(cls)) return true;
    var inline=String(el.getAttribute('style')||'').toLowerCase();
    return /display\\s*:\\s*none|visibility\\s*:\\s*hidden/.test(inline);
  }

  function looksAnimated(el){
    if(el.matches('[data-anim-desktop],[data-animation],.dmAnimation,.skrollable,.skrollable-before,.skrollable-after,.wow,.animated')) return true;
    var inline=String(el.getAttribute('style')||'').toLowerCase();
    return /transform\\s*:|translate[xyz]?\\s*\\(|opacity\\s*:\\s*0(?:\\D|$)/.test(inline);
  }

  function fix(el){
    if(!el || insideWidget(el) || explicitlyHidden(el) || !looksAnimated(el)) return;
    el.setAttribute('data-static-migrator-animation-fixed','true');
    el.style.setProperty('opacity','1','important');
    el.style.setProperty('visibility','visible','important');
    el.style.setProperty('transform','none','important');
    el.style.setProperty('translate','none','important');
    el.style.setProperty('animation','none','important');
    el.style.setProperty('transition','none','important');
  }

  function run(){
    document.querySelectorAll('[data-anim-desktop],[data-animation],.dmAnimation,.skrollable,.skrollable-before,.skrollable-after,.wow,.animated,[style*="transform" i],[style*="translate" i],[style*="opacity: 0" i],[style*="opacity:0" i]').forEach(fix);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run,{once:true});
  else run();
  window.addEventListener('load',run,{once:true});
})();
</script>`;

  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i,`${payload}\n</body>`) : `${html}\n${payload}`;
}

async function servePreview(jobId,requestedPath,env) {
  const job=await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if (!job) return new Response("Preview job not found.",{status:404});
  let path;
  try { path=decodeURIComponent(requestedPath||"/").replace(/^\/+/,""); }
  catch { return new Response("Invalid preview path.",{status:400}); }
  if (!path) path="index.html";
  if (path.endsWith("/")) path+="index.html";
  if (path.includes("..")||path.includes("\\")) return new Response("Invalid preview path.",{status:400});

  const choices=[path];
  if (!/\.[a-z0-9]{1,10}$/i.test(path)) choices.push(`${path}/index.html`);
  let object=null,resolved=null;
  for (const choice of choices) {
    object=await env.STORAGE.get(`${job.output_prefix}/site/${choice}`);
    if (object?.body) { resolved=choice; break; }
  }
  if (!object?.body||!resolved) return new Response("Preview file not found.",{status:404});

  const type=object.httpMetadata?.contentType||contentType(resolved);
  const headers=new Headers({"Content-Type":type,"Cache-Control":"no-store","X-Robots-Tag":"noindex,nofollow"});
  const prefix=`/preview/${encodeURIComponent(jobId)}`;
  if (/text\/html/i.test(type)) return new Response(prefixUrls(await object.text(),prefix),{status:200,headers});
  if (/text\/css/i.test(type)) return new Response(prefixCss(await object.text(),prefix),{status:200,headers});
  return new Response(object.body,{status:200,headers});
}

function prefixUrls(html,prefix) {
  let out=html.replace(/\b(href|src|poster|data-src|data-image-url)\s*=\s*(["'])\/(?!\/|preview\/)(.*?)\2/gi,(_,attr,quote,value)=>`${attr}=${quote}${prefix}/${value}${quote}`);
  out=out.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi,(whole,quote,value)=>`srcset=${quote}${value.split(",").map(item=>{const p=item.trim().split(/\s+/);if(p[0]?.startsWith("/")&&!p[0].startsWith("//")&&!p[0].startsWith("/preview/"))p[0]=`${prefix}${p[0]}`;return p.join(" ")}).join(", ")}${quote}`);
  return prefixCss(out,prefix);
}
function prefixCss(value,prefix){return value.replace(/url\(\s*(["']?)\/(?!\/|preview\/)(.*?)\1\s*\)/gi,(_,quote,path)=>`url(${quote}${prefix}/${path}${quote})`)}
function contentType(path){const p=path.toLowerCase();for(const [e,t] of [[".html","text/html; charset=utf-8"],[".css","text/css; charset=utf-8"],[".js","application/javascript"],[".json","application/json"],[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".webp","image/webp"],[".svg","image/svg+xml"],[".woff2","font/woff2"],[".woff","font/woff"]])if(p.endsWith(e))return t;return "application/octet-stream"}
function json(data,status=200){return Response.json(data,{status,headers:CORS})}
