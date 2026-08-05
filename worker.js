const VERSION = "1.6.9";
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
      if (request.method === "POST" && match) return applyAnimationPass(decodeURIComponent(match[1]),env);

      match = path.match(/^\/api\/migrations\/([^/]+)\/suppress-broken-widgets$/);
      if (request.method === "POST" && match) return suppressBrokenWidgets(decodeURIComponent(match[1]),env);

      return json({success:false,error:"Route not found."},404);
    } catch (error) {
      return json({success:false,error:error instanceof Error ? error.message : String(error)},500);
    }
  }
};

async function getPages(jobId,env){
  const job=await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if(!job) return {error:json({success:false,error:"Migration job not found."},404)};
  const result=await env.DB.prepare("SELECT id,source_url,output_path FROM migration_pages WHERE job_id=? AND status='captured' ORDER BY source_url").bind(jobId).all();
  const pages=result.results||[];
  if(!pages.length) return {error:json({success:false,error:"No generated pages are available."},409)};
  return {job,pages};
}

async function applyAnimationPass(jobId,env){
  const state=await getPages(jobId,env); if(state.error)return state.error;
  const processed=[],warnings=[];
  for(const page of state.pages){
    const outputPath=page.output_path||"index.html";
    const key=`${state.job.output_prefix}/site/${outputPath}`;
    try{
      const object=await env.STORAGE.get(key); if(!object?.body)throw new Error(`Generated page missing: ${key}`);
      let html=await object.text();
      html=removeAnimationPass(html);
      html=appendToBody(html,animationPayload());
      await env.STORAGE.put(key,html,{httpMetadata:{contentType:"text/html; charset=utf-8"},customMetadata:{jobId,pageId:page.id,sourceUrl:page.source_url,version:VERSION,lastStaticPass:"animations"}});
      processed.push({pageId:page.id,sourceUrl:page.source_url,outputPath,r2Key:key});
    }catch(error){warnings.push({pageId:page.id,sourceUrl:page.source_url,error:error instanceof Error?error.message:String(error)})}
  }
  const success=warnings.length===0;
  await updateStage(env,jobId,success?"duda_animations_finalised":"duda_animations_finalised_with_warnings",success?99:98);
  return json({success,jobId,currentStage:success?"duda_animations_finalised":"duda_animations_finalised_with_warnings",pagesProcessed:processed.length,pages:processed,warnings});
}

async function suppressBrokenWidgets(jobId,env){
  const state=await getPages(jobId,env); if(state.error)return state.error;
  const processed=[],warnings=[],riskyWidgets=[];
  for(const page of state.pages){
    const outputPath=page.output_path||"index.html";
    const key=`${state.job.output_prefix}/site/${outputPath}`;
    try{
      const object=await env.STORAGE.get(key); if(!object?.body)throw new Error(`Generated page missing: ${key}`);
      let html=await object.text();
      html=removeImageSliderPass(html);
      const widgets=findImageSliderWidgets(html,page.source_url,outputPath);
      riskyWidgets.push(...widgets);
      html=appendToBody(html,widgetFallbackPayload());
      await env.STORAGE.put(key,html,{httpMetadata:{contentType:"text/html; charset=utf-8"},customMetadata:{jobId,pageId:page.id,sourceUrl:page.source_url,version:VERSION,lastStaticPass:"widget-fallback"}});
      processed.push({pageId:page.id,sourceUrl:page.source_url,outputPath,r2Key:key,detectedImageSliders:widgets.length});
    }catch(error){warnings.push({pageId:page.id,sourceUrl:page.source_url,error:error instanceof Error?error.message:String(error)})}
  }

  const report={version:VERSION,jobId,generatedAt:new Date().toISOString(),summary:{pagesScanned:processed.length,detectedRiskyWidgets:riskyWidgets.length,pageWarnings:warnings.length},widgets:riskyWidgets,warnings};
  const reportKey=`${state.job.output_prefix}/site/widget-risk-report.json`;
  await env.STORAGE.put(reportKey,JSON.stringify(report,null,2),{httpMetadata:{contentType:"application/json; charset=utf-8"},customMetadata:{jobId,generatedBy:`static-site-migrator-${VERSION}`}});

  const success=warnings.length===0;
  const stage=success?"problem_widgets_guarded":"problem_widgets_guarded_with_warnings";
  await updateStage(env,jobId,stage,success?99:98);
  return json({success,jobId,currentStage:stage,progressPercent:success?99:98,pagesProcessed:processed.length,detectedRiskyWidgets:riskyWidgets.length,reportKey,pages:processed,widgets:riskyWidgets,warnings});
}

function findImageSliderWidgets(html,sourceUrl,outputPath){
  const found=[];
  const regex=/<div\b([^>]*class=["'][^"']*\bdmImageSlider\b[^"']*["'][^>]*)>/gi;
  let match;
  while((match=regex.exec(html))){
    const attrs=match[1]||"";
    const id=(attrs.match(/\bid=["']([^"']+)["']/i)||[])[1]||null;
    const widgetType=(attrs.match(/\bdata-widget-type=["']([^"']+)["']/i)||[])[1]||"imageSlider";
    found.push({pageUrl:sourceUrl,outputPath,widgetId:id,widgetType,risk:"dynamic Duda image slider; runtime image validation required",fallback:"hide section only when no active image can load"});
  }
  return found;
}

function removeAnimationPass(html){
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-animation-final-v16[67]["'][^>]*>[\s\S]*?<\/style>/gi,"")
    .replace(/<script\b[^>]*id=["']static-migrator-animation-final-v16[67]-script["'][^>]*>[\s\S]*?<\/script>/gi,"");
}

function animationPayload(){return `
<style id="static-migrator-animation-final-v167">[data-static-migrator-animation-fixed="true"]{opacity:1!important;visibility:visible!important;transform:none!important;translate:none!important;animation:none!important;transition:none!important}</style>
<script id="static-migrator-animation-final-v167-script">(function(){function insideWidget(el){return !!el.closest('[class*="hero" i],[class*="banner" i],[class*="carousel" i],[class*="slider" i],[class*="slideshow" i],[data-widget-type*="slider" i],[data-widget-type*="gallery" i]')}function hidden(el){if(el.hidden||el.getAttribute('aria-hidden')==='true')return true;var s=String(el.getAttribute('style')||'').toLowerCase();return /display\\s*:\\s*none|visibility\\s*:\\s*hidden/.test(s)}function run(){document.querySelectorAll('[data-anim-extended]').forEach(function(el){if(insideWidget(el)||hidden(el))return;el.setAttribute('data-static-migrator-animation-fixed','true');el.style.setProperty('opacity','1','important');el.style.setProperty('visibility','visible','important');el.style.setProperty('transform','none','important');el.style.setProperty('translate','none','important');el.style.setProperty('animation','none','important');el.style.setProperty('transition','none','important')})}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run();window.addEventListener('load',run,{once:true})})();</script>`}

function removeImageSliderPass(html){
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-dm-image-slider-v168["'][^>]*>[\s\S]*?<\/style>/gi,"")
    .replace(/<script\b[^>]*id=["']static-migrator-dm-image-slider-v168-script["'][^>]*>[\s\S]*?<\/script>/gi,"")
    .replace(/<style\b[^>]*id=["']static-migrator-widget-fallback-v169["'][^>]*>[\s\S]*?<\/style>/gi,"")
    .replace(/<script\b[^>]*id=["']static-migrator-widget-fallback-v169-script["'][^>]*>[\s\S]*?<\/script>/gi,"");
}

function widgetFallbackPayload(){return `
<style id="static-migrator-widget-fallback-v169">
[data-static-migrator-widget-hidden="true"]{display:none!important}
</style>
<script id="static-migrator-widget-fallback-v169-script">
(function(){
  var warnings=[];
  function imageLoads(url){return new Promise(function(resolve){if(!url)return resolve(false);var img=new Image();var done=false;function finish(value){if(done)return;done=true;resolve(value)}img.onload=function(){finish(img.naturalWidth>0)};img.onerror=function(){finish(false)};img.src=url;setTimeout(function(){finish(false)},5000)})}
  function backgroundUrl(el){if(!el)return null;var value=getComputedStyle(el).backgroundImage||el.style.backgroundImage||'';var match=value.match(/url\\(["']?(.*?)["']?\\)/i);return match?match[1]:null}
  function hideBroken(slider,reason){var target=slider;var row=slider.closest('.dmRespRow,[data-element-type="row"],.dmRespColsWrapper');if(row&&row.querySelectorAll('.dmWidget,[data-widget-type]').length<=1)target=row;target.setAttribute('data-static-migrator-widget-hidden','true');warnings.push({widgetId:slider.id||null,widgetType:'imageSlider',reason:reason})}
  async function validate(slider){var slides=Array.from(slider.querySelectorAll('ul.slides>li'));var active=slides.find(function(li){return li.classList.contains('flex-active-slide')})||slides.find(function(li){return li.style.display!=='none'&&li.getAttribute('aria-hidden')!=='true'})||slides[0];if(!active)return hideBroken(slider,'no slide markup');var cover=active.querySelector('.dmCoverImgContainer');var img=active.querySelector('img');var candidates=[];if(img){candidates.push(img.currentSrc||img.getAttribute('src'));candidates.push(img.getAttribute('data-src'));candidates.push(img.getAttribute('data-lazy-src'))}candidates.push(backgroundUrl(cover));candidates=Array.from(new Set(candidates.filter(Boolean)));for(var i=0;i<candidates.length;i++){if(await imageLoads(candidates[i]))return}hideBroken(slider,'active slide image failed to load')}
  async function run(){var sliders=Array.from(document.querySelectorAll('.dmImageSlider[data-widget-type="imageSlider"],.dmImageSlider'));for(var i=0;i<sliders.length;i++)await validate(sliders[i]);window.__STATIC_MIGRATOR_WIDGET_WARNINGS__=warnings;if(warnings.length)console.warn('Static migrator hid broken widgets',warnings)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run();
})();
</script>`}

function appendToBody(html,payload){return /<\/body>/i.test(html)?html.replace(/<\/body>/i,`${payload}\n</body>`):`${html}\n${payload}`}
async function updateStage(env,jobId,stage,progress){await env.DB.prepare("UPDATE migration_jobs SET current_stage=?,progress_percent=?,updated_at=? WHERE id=?").bind(stage,progress,new Date().toISOString(),jobId).run()}

async function servePreview(jobId,requestedPath,env){
  const job=await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();if(!job)return new Response("Preview job not found.",{status:404});
  let path;try{path=decodeURIComponent(requestedPath||"/").replace(/^\/+/,"")}catch{return new Response("Invalid preview path.",{status:400})}
  if(!path)path="index.html";if(path.endsWith("/"))path+="index.html";if(path.includes("..")||path.includes("\\"))return new Response("Invalid preview path.",{status:400});
  const choices=[path];if(!/\.[a-z0-9]{1,10}$/i.test(path))choices.push(`${path}/index.html`);let object=null,resolved=null;
  for(const choice of choices){object=await env.STORAGE.get(`${job.output_prefix}/site/${choice}`);if(object?.body){resolved=choice;break}}
  if(!object?.body||!resolved)return new Response("Preview file not found.",{status:404});
  const type=object.httpMetadata?.contentType||contentType(resolved);const headers=new Headers({"Content-Type":type,"Cache-Control":"no-store","X-Robots-Tag":"noindex,nofollow"});const prefix=`/preview/${encodeURIComponent(jobId)}`;
  if(/text\/html/i.test(type))return new Response(prefixUrls(await object.text(),prefix),{status:200,headers});if(/text\/css/i.test(type))return new Response(prefixCss(await object.text(),prefix),{status:200,headers});return new Response(object.body,{status:200,headers});
}
function prefixUrls(html,prefix){let out=html.replace(/\b(href|src|poster|data-src|data-image-url)\s*=\s*(["'])\/(?!\/|preview\/)(.*?)\2/gi,(_,attr,quote,value)=>`${attr}=${quote}${prefix}/${value}${quote}`);out=out.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi,(whole,quote,value)=>`srcset=${quote}${value.split(",").map(item=>{const p=item.trim().split(/\s+/);if(p[0]?.startsWith("/")&&!p[0].startsWith("//")&&!p[0].startsWith("/preview/"))p[0]=`${prefix}${p[0]}`;return p.join(" ")}).join(", ")}${quote}`);return prefixCss(out,prefix)}
function prefixCss(value,prefix){return value.replace(/url\(\s*(["']?)\/(?!\/|preview\/)(.*?)\1\s*\)/gi,(_,quote,path)=>`url(${quote}${prefix}/${path}${quote})`)}
function contentType(path){const p=path.toLowerCase();for(const [e,t] of [[".html","text/html; charset=utf-8"],[".css","text/css; charset=utf-8"],[".js","application/javascript"],[".json","application/json"],[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".webp","image/webp"],[".svg","image/svg+xml"],[".woff2","font/woff2"],[".woff","font/woff"]])if(p.endsWith(e))return t;return "application/octet-stream"}
function json(data,status=200){return Response.json(data,{status,headers:CORS})}
