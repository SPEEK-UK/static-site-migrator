const VERSION = "1.6.5";
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
      if (request.method === "GET" && preview) return servePreview(decodeURIComponent(preview[1]),preview[2]||"/",env);
      const run = path.match(/^\/api\/migrations\/([^/]+)\/finalise-static$/);
      if (request.method === "POST" && run) return finaliseStatic(decodeURIComponent(run[1]),env);
      return json({success:false,error:"Route not found."},404);
    } catch (error) {
      return json({success:false,error:error instanceof Error ? error.message : String(error)},500);
    }
  }
};

async function finaliseStatic(jobId,env) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if (!job) return json({success:false,error:"Migration job not found."},404);

  const [pageQuery,assetQuery] = await Promise.all([
    env.DB.prepare("SELECT * FROM migration_pages WHERE job_id=? AND status='captured' AND html_r2_key IS NOT NULL ORDER BY source_url").bind(jobId).all(),
    env.DB.prepare("SELECT * FROM migration_assets WHERE job_id=? AND status='downloaded' AND output_path IS NOT NULL ORDER BY source_url").bind(jobId).all()
  ]);
  const pages = pageQuery.results || [];
  const assets = assetQuery.results || [];
  if (!pages.length) return json({success:false,error:"No captured pages are available."},409);

  const assetMap = new Map(assets.map(a=>[normalise(a.source_url),`/${a.output_path}`]));
  const pageMap = new Map(pages.map(p=>[comparable(p.source_url),publicPath(p.output_path)]));
  const processed=[];
  const warnings=[];

  for (const page of pages) {
    try {
      const source = await env.STORAGE.get(page.html_r2_key);
      if (!source?.body) throw new Error(`Captured HTML missing: ${page.html_r2_key}`);
      let html = await source.text();
      let replacements=0;

      for (const [remote,local] of [...assetMap.entries()].sort((a,b)=>b[0].length-a[0].length)) {
        for (const variant of [remote,remote.replace(/&/g,"&amp;"),encodeURI(remote)]) {
          if (!variant || !html.includes(variant)) continue;
          const parts=html.split(variant);
          replacements += parts.length-1;
          html=parts.join(local);
        }
      }

      html=html.replace(/\bhref\s*=\s*(["'])(.*?)\1/gi,(whole,quote,value)=>{
        try {
          const target=new URL(decodeEntities(value),page.source_url);
          target.hash="";
          const local=pageMap.get(comparable(target.href));
          return local ? `href=${quote}${local}${quote}` : whole;
        } catch { return whole; }
      });

      html=removeOldMigratorCode(html);
      html=removeLateSliderScripts(html);
      html=injectFinalCss(html);
      if (!/<!doctype\s+html/i.test(html)) html=`<!DOCTYPE html>\n${html}`;

      const outputPath=page.output_path||"index.html";
      const key=`${job.output_prefix}/site/${outputPath}`;
      await env.STORAGE.put(key,html,{
        httpMetadata:{contentType:"text/html; charset=utf-8"},
        customMetadata:{jobId,pageId:page.id,sourceUrl:page.source_url,version:VERSION,finalStatic:"true"}
      });
      processed.push({pageId:page.id,sourceUrl:page.source_url,outputPath,r2Key:key,assetReplacements:replacements,htmlLength:html.length});
    } catch (error) {
      warnings.push({pageId:page.id,sourceUrl:page.source_url,error:error instanceof Error?error.message:String(error)});
    }
  }

  const success=warnings.length===0;
  const stage=success?"final_static_ready":"final_static_ready_with_warnings";
  const finished=new Date().toISOString();
  await env.DB.prepare("UPDATE migration_jobs SET current_stage=?,progress_percent=?,updated_at=? WHERE id=?")
    .bind(stage,success?99:98,finished,jobId).run();

  return json({success,jobId,currentStage:stage,progressPercent:success?99:98,pagesProcessed:processed.length,pages:processed,warnings});
}

function removeOldMigratorCode(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-[^"']+["'][^>]*>[\s\S]*?<\/style>/gi,"")
    .replace(/<script\b[^>]*id=["']static-migrator-[^"']+["'][^>]*>[\s\S]*?<\/script>/gi,"")
    .replace(/<script\b[^>]*>[\s\S]*?runtime-service-worker\.js[\s\S]*?<\/script>/gi,"")
    .replace(/<script\b[^>]*src=["'][^"']*sp-2\.0\.0-dm-0\.1\.min\.js[^"']*["'][^>]*><\/script>/gi,"");
}

function removeLateSliderScripts(html) {
  const controller=/(carousel|slideshow|slider|swiper|slick|owlcarousel|flexslider|widgetgallery|gallerywidget|slideinterval|activeindex|nextslide|prevslide)/i;
  return html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi,(whole,attrs,body)=>{
    if (/(application\/ld\+json|type=["']application\/json)/i.test(attrs)) return whole;
    return controller.test(`${attrs} ${body}`) ? "" : whole;
  });
}

function injectFinalCss(html) {
  const css=`<style id="static-migrator-final-v165">
[data-anim-desktop],[data-animation],.dmAnimation,.skrollable,.skrollable-before,.skrollable-after,.wow,.animated{opacity:1!important;visibility:visible!important;transform:none!important;animation:none!important;transition:none!important}
[class*="hero" i],[class*="banner" i],[class*="carousel" i],[class*="slider" i],[class*="slideshow" i]{visibility:visible!important}
[class*="carousel" i] .active,[class*="carousel" i] .current,[class*="slider" i] .active,[class*="slider" i] .current,[class*="slideshow" i] .active,[class*="slideshow" i] .current,[class*="hero" i] [aria-hidden="false"],[class*="banner" i] [aria-hidden="false"]{opacity:1!important;visibility:visible!important;transform:none!important;z-index:2!important}
</style>`;
  return /<\/head>/i.test(html)?html.replace(/<\/head>/i,`${css}</head>`):`${css}${html}`;
}

async function servePreview(jobId,requestedPath,env) {
  const job=await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if (!job) return new Response("Preview job not found.",{status:404});
  let path;
  try { path=decodeURIComponent(requestedPath||"/").replace(/^\/+/,""); } catch { return new Response("Invalid preview path.",{status:400}); }
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
function normalise(value){const u=new URL(value);u.hash="";return u.href}
function comparable(value){const u=new URL(value);u.hash="";if(u.pathname!=="/")u.pathname=u.pathname.replace(/\/+$/,"");return u.href}
function publicPath(path){if(!path||path==="index.html")return "/";return `/${path.replace(/\/index\.html$/i,"").replace(/^\/+/,"")}/`}
function decodeEntities(value){return value.replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")}
function contentType(path){const p=path.toLowerCase();for(const [e,t] of [[".html","text/html; charset=utf-8"],[".css","text/css; charset=utf-8"],[".js","application/javascript"],[".json","application/json"],[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".webp","image/webp"],[".svg","image/svg+xml"],[".woff2","font/woff2"],[".woff","font/woff"]])if(p.endsWith(e))return t;return "application/octet-stream"}
function json(data,status=200){return Response.json(data,{status,headers:CORS})}
