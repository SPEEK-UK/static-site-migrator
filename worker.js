const VERSION = "1.6.8";
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

      let match = path.match(/^\/api\/migrations\/([^/]+)\/fix-duda-animations$/);
      if (request.method === "POST" && match) return applyPass(decodeURIComponent(match[1]),env,"animations");

      match = path.match(/^\/api\/migrations\/([^/]+)\/freeze-duda-image-sliders$/);
      if (request.method === "POST" && match) return applyPass(decodeURIComponent(match[1]),env,"image-sliders");

      return json({success:false,error:"Route not found."},404);
    } catch (error) {
      return json({success:false,error:error instanceof Error ? error.message : String(error)},500);
    }
  }
};

async function applyPass(jobId,env,mode) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if (!job) return json({success:false,error:"Migration job not found."},404);

  const result = await env.DB.prepare("SELECT id,source_url,output_path FROM migration_pages WHERE job_id=? AND status='captured' ORDER BY source_url").bind(jobId).all();
  const pages = result.results || [];
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
      if (mode === "animations") html=injectAnimationPass(removeAnimationPass(html));
      else html=injectImageSliderPass(removeImageSliderPass(html));
      await env.STORAGE.put(key,html,{
        httpMetadata:{contentType:"text/html; charset=utf-8"},
        customMetadata:{jobId,pageId:page.id,sourceUrl:page.source_url,version:VERSION,lastStaticPass:mode}
      });
      processed.push({pageId:page.id,sourceUrl:page.source_url,outputPath,r2Key:key,htmlLength:html.length});
    } catch (error) {
      warnings.push({pageId:page.id,sourceUrl:page.source_url,error:error instanceof Error?error.message:String(error)});
    }
  }

  const success=warnings.length===0;
  const stage=mode === "animations" ? "duda_animations_finalised" : "duda_image_sliders_frozen";
  await env.DB.prepare("UPDATE migration_jobs SET current_stage=?,progress_percent=?,updated_at=? WHERE id=?")
    .bind(success?stage:`${stage}_with_warnings`,success?99:98,new Date().toISOString(),jobId).run();
  return json({success,jobId,currentStage:success?stage:`${stage}_with_warnings`,progressPercent:success?99:98,pagesProcessed:processed.length,pages:processed,warnings});
}

function removeAnimationPass(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-animation-final-v16[67]["'][^>]*>[\s\S]*?<\/style>/gi,"")
    .replace(/<script\b[^>]*id=["']static-migrator-animation-final-v16[67]-script["'][^>]*>[\s\S]*?<\/script>/gi,"");
}

function injectAnimationPass(html) {
  const payload=`
<style id="static-migrator-animation-final-v167">
[data-static-migrator-animation-fixed="true"]{opacity:1!important;visibility:visible!important;transform:none!important;translate:none!important;animation:none!important;transition:none!important}
</style>
<script id="static-migrator-animation-final-v167-script">
(function(){
  function insideWidget(el){return !!el.closest('[class*="hero" i],[class*="banner" i],[class*="carousel" i],[class*="slider" i],[class*="slideshow" i],[data-widget-type*="slider" i],[data-widget-type*="gallery" i]')}
  function hidden(el){if(el.hidden||el.getAttribute('aria-hidden')==='true')return true;var s=String(el.getAttribute('style')||'').toLowerCase();return /display\\s*:\\s*none|visibility\\s*:\\s*hidden/.test(s)}
  function run(){document.querySelectorAll('[data-anim-extended]').forEach(function(el){if(insideWidget(el)||hidden(el))return;el.setAttribute('data-static-migrator-animation-fixed','true');el.style.setProperty('opacity','1','important');el.style.setProperty('visibility','visible','important');el.style.setProperty('transform','none','important');el.style.setProperty('translate','none','important');el.style.setProperty('animation','none','important');el.style.setProperty('transition','none','important')})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run();window.addEventListener('load',run,{once:true});
})();
</script>`;
  return appendToBody(html,payload);
}

function removeImageSliderPass(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-dm-image-slider-v168["'][^>]*>[\s\S]*?<\/style>/gi,"")
    .replace(/<script\b[^>]*id=["']static-migrator-dm-image-slider-v168-script["'][^>]*>[\s\S]*?<\/script>/gi,"");
}

function injectImageSliderPass(html) {
  const payload=`
<style id="static-migrator-dm-image-slider-v168">
.dmImageSlider[data-static-migrator-frozen="true"] .flexslider{overflow:hidden!important}
.dmImageSlider[data-static-migrator-frozen="true"] ul.slides{position:relative!important;margin:0!important;padding:0!important;transform:none!important}
.dmImageSlider[data-static-migrator-frozen="true"] ul.slides>li{display:none!important}
.dmImageSlider[data-static-migrator-frozen="true"] ul.slides>li[data-static-migrator-active-slide="true"]{display:block!important;width:100%!important;float:none!important;margin:0!important;position:relative!important;opacity:1!important;visibility:visible!important;z-index:2!important;transform:none!important}
.dmImageSlider[data-static-migrator-frozen="true"] li[data-static-migrator-active-slide="true"] .slide-inner{display:block!important;opacity:1!important;visibility:visible!important;transform:none!important;animation:none!important;transition:none!important;z-index:3!important}
.dmImageSlider[data-static-migrator-frozen="true"] li[data-static-migrator-active-slide="true"] .dmCoverImgContainer{display:block!important;width:100%!important;visibility:visible!important}
.dmImageSlider[data-static-migrator-frozen="true"] .flex-control-nav,.dmImageSlider[data-static-migrator-frozen="true"] .flex-direction-nav,.dmImageSlider[data-static-migrator-frozen="true"] .flex-pauseplay{display:none!important}
</style>
<script id="static-migrator-dm-image-slider-v168-script">
(function(){
  function placeholder(el){return (el.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase()==='slide title'}
  function run(){
    document.querySelectorAll('.dmImageSlider[data-widget-type="imageSlider"],.dmImageSlider').forEach(function(slider){
      var slides=Array.from(slider.querySelectorAll('ul.slides>li'));
      if(!slides.length)return;
      var active=slides.find(function(li){return li.classList.contains('flex-active-slide')})||slides.find(function(li){return li.style.display!=='none'&&li.getAttribute('aria-hidden')!=='true'})||slides[0];
      slider.setAttribute('data-static-migrator-frozen','true');
      slides.forEach(function(li){li.removeAttribute('data-static-migrator-active-slide')});
      active.setAttribute('data-static-migrator-active-slide','true');
      active.classList.add('flex-active-slide');
      active.style.setProperty('display','block','important');
      active.style.setProperty('opacity','1','important');
      active.style.setProperty('visibility','visible','important');
      active.style.setProperty('transform','none','important');
      active.style.setProperty('z-index','2','important');

      var cover=active.querySelector('.dmCoverImgContainer');
      var image=active.querySelector('img[src]');
      if(cover&&image){
        var src=image.currentSrc||image.getAttribute('src');
        if(src){cover.style.setProperty('background-image','url("'+src.replace(/"/g,'%22')+'")','important')}
        cover.style.setProperty('display','block','important');
      }
      active.querySelectorAll('.slide-title').forEach(function(title){if(placeholder(title))title.style.setProperty('display','none','important')});
      var inner=active.querySelector('.slide-inner');
      if(inner){inner.style.setProperty('display','block','important');inner.style.setProperty('opacity','1','important');inner.style.setProperty('visibility','visible','important');inner.style.setProperty('transform','none','important');inner.style.setProperty('animation','none','important')}
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run();window.addEventListener('load',run,{once:true});
})();
</script>`;
  return appendToBody(html,payload);
}

function appendToBody(html,payload){return /<\/body>/i.test(html)?html.replace(/<\/body>/i,`${payload}\n</body>`):`${html}\n${payload}`}

async function servePreview(jobId,requestedPath,env) {
  const job=await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if (!job) return new Response("Preview job not found.",{status:404});
  let path;
  try {path=decodeURIComponent(requestedPath||"/").replace(/^\/+/,"")} catch {return new Response("Invalid preview path.",{status:400})}
  if(!path)path="index.html";if(path.endsWith("/"))path+="index.html";if(path.includes("..")||path.includes("\\"))return new Response("Invalid preview path.",{status:400});
  const choices=[path];if(!/\.[a-z0-9]{1,10}$/i.test(path))choices.push(`${path}/index.html`);
  let object=null,resolved=null;for(const choice of choices){object=await env.STORAGE.get(`${job.output_prefix}/site/${choice}`);if(object?.body){resolved=choice;break}}
  if(!object?.body||!resolved)return new Response("Preview file not found.",{status:404});
  const type=object.httpMetadata?.contentType||contentType(resolved);const headers=new Headers({"Content-Type":type,"Cache-Control":"no-store","X-Robots-Tag":"noindex,nofollow"});const prefix=`/preview/${encodeURIComponent(jobId)}`;
  if(/text\/html/i.test(type))return new Response(prefixUrls(await object.text(),prefix),{status:200,headers});if(/text\/css/i.test(type))return new Response(prefixCss(await object.text(),prefix),{status:200,headers});return new Response(object.body,{status:200,headers});
}
function prefixUrls(html,prefix){let out=html.replace(/\b(href|src|poster|data-src|data-image-url)\s*=\s*(["'])\/(?!\/|preview\/)(.*?)\2/gi,(_,attr,quote,value)=>`${attr}=${quote}${prefix}/${value}${quote}`);out=out.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi,(whole,quote,value)=>`srcset=${quote}${value.split(",").map(item=>{const p=item.trim().split(/\s+/);if(p[0]?.startsWith("/")&&!p[0].startsWith("//")&&!p[0].startsWith("/preview/"))p[0]=`${prefix}${p[0]}`;return p.join(" ")}).join(", ")}${quote}`);return prefixCss(out,prefix)}
function prefixCss(value,prefix){return value.replace(/url\(\s*(["']?)\/(?!\/|preview\/)(.*?)\1\s*\)/gi,(_,quote,path)=>`url(${quote}${prefix}/${path}${quote}`)}
function contentType(path){const p=path.toLowerCase();for(const [e,t] of [[".html","text/html; charset=utf-8"],[".css","text/css; charset=utf-8"],[".js","application/javascript"],[".json","application/json"],[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".webp","image/webp"],[".svg","image/svg+xml"],[".woff2","font/woff2"],[".woff","font/woff"]])if(p.endsWith(e))return t;return "application/octet-stream"}
function json(data,status=200){return Response.json(data,{status,headers:CORS})}
