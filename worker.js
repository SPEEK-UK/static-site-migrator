const VERSION = "1.7.0";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (!env.DB || !env.STORAGE) {
        throw new Error("Missing DB or STORAGE binding.");
      }

      if (request.method === "GET" && path === "/") {
        return json({ success: true, version: VERSION, status: "online" });
      }

      const preview = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (request.method === "GET" && preview) {
        return servePreview(
          decodeURIComponent(preview[1]),
          preview[2] || "/",
          env,
        );
      }

      let match = path.match(
        /^\/api\/migrations\/([^/]+)\/fix-duda-animations$/,
      );
      if (request.method === "POST" && match) {
        return applyAnimationPass(decodeURIComponent(match[1]), env);
      }

      match = path.match(
        /^\/api\/migrations\/([^/]+)\/apply-overrides$/,
      );
      if (request.method === "POST" && match) {
        return applyManualOverrides(
          decodeURIComponent(match[1]),
          request,
          env,
        );
      }

      match = path.match(
        /^\/api\/migrations\/([^/]+)\/overrides$/,
      );
      if (request.method === "GET" && match) {
        return getManualOverrides(decodeURIComponent(match[1]), env);
      }

      return json({ success: false, error: "Route not found." }, 404);
    } catch (error) {
      return json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  },
};

async function getMigration(jobId, env) {
  const job = await env.DB.prepare(
    "SELECT * FROM migration_jobs WHERE id=?",
  )
    .bind(jobId)
    .first();

  if (!job) {
    return { error: json({ success: false, error: "Migration job not found." }, 404) };
  }

  const result = await env.DB.prepare(
    "SELECT id,source_url,output_path FROM migration_pages WHERE job_id=? AND status='captured' ORDER BY source_url",
  )
    .bind(jobId)
    .all();

  const pages = result.results || [];
  if (!pages.length) {
    return {
      error: json(
        { success: false, error: "No generated pages are available." },
        409,
      ),
    };
  }

  return { job, pages };
}

async function applyAnimationPass(jobId, env) {
  const state = await getMigration(jobId, env);
  if (state.error) return state.error;

  const processed = [];
  const warnings = [];

  for (const page of state.pages) {
    const outputPath = page.output_path || "index.html";
    const key = `${state.job.output_prefix}/site/${outputPath}`;

    try {
      const object = await env.STORAGE.get(key);
      if (!object?.body) throw new Error(`Generated page missing: ${key}`);

      let html = await object.text();
      html = removeAnimationPayload(html);
      html = appendToBody(html, animationPayload());

      await env.STORAGE.put(key, html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          version: VERSION,
          lastStaticPass: "animations",
        },
      });

      processed.push({ pageId: page.id, sourceUrl: page.source_url, outputPath });
    } catch (error) {
      warnings.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const success = warnings.length === 0;
  await updateStage(
    env,
    jobId,
    success ? "duda_animations_finalised" : "duda_animations_finalised_with_warnings",
    success ? 99 : 98,
  );

  return json({
    success,
    jobId,
    pagesProcessed: processed.length,
    pages: processed,
    warnings,
  });
}

async function applyManualOverrides(jobId, request, env) {
  const state = await getMigration(jobId, env);
  if (state.error) return state.error;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "A JSON request body is required." }, 400);
  }

  const incoming = Array.isArray(body?.overrides) ? body.overrides : [];
  if (!incoming.length) {
    return json({ success: false, error: "Provide at least one override." }, 400);
  }

  const pagePaths = new Set(
    state.pages.map((page) => page.output_path || "index.html"),
  );

  const overrides = [];
  for (const item of incoming) {
    const page = String(item?.page || "").replace(/^\/+/, "");
    const widgetId = String(item?.widgetId || "").trim();
    const action = String(item?.action || "hide").toLowerCase();
    const scope = String(item?.scope || "widget").toLowerCase();
    const note = String(item?.note || "").slice(0, 500);

    if (!pagePaths.has(page)) {
      return json({ success: false, error: `Unknown generated page: ${page}` }, 400);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(widgetId)) {
      return json({ success: false, error: `Invalid widgetId: ${widgetId}` }, 400);
    }
    if (action !== "hide") {
      return json({ success: false, error: `Unsupported action: ${action}` }, 400);
    }
    if (!new Set(["widget", "row"]).has(scope)) {
      return json({ success: false, error: `Unsupported scope: ${scope}` }, 400);
    }

    overrides.push({ page, widgetId, action, scope, note });
  }

  const grouped = new Map();
  for (const override of overrides) {
    if (!grouped.has(override.page)) grouped.set(override.page, []);
    grouped.get(override.page).push(override);
  }

  const processed = [];
  const warnings = [];

  for (const page of state.pages) {
    const outputPath = page.output_path || "index.html";
    const pageOverrides = grouped.get(outputPath) || [];
    if (!pageOverrides.length) continue;

    const key = `${state.job.output_prefix}/site/${outputPath}`;

    try {
      const object = await env.STORAGE.get(key);
      if (!object?.body) throw new Error(`Generated page missing: ${key}`);

      let html = await object.text();
      html = removeManualOverridePayload(html);
      html = appendToBody(html, manualOverridePayload(pageOverrides));

      await env.STORAGE.put(key, html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          version: VERSION,
          manualOverrides: String(pageOverrides.length),
        },
      });

      processed.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        outputPath,
        overridesApplied: pageOverrides.length,
      });
    } catch (error) {
      warnings.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report = {
    version: VERSION,
    jobId,
    updatedAt: new Date().toISOString(),
    overrides,
    warnings,
  };

  const reportKey = `${state.job.output_prefix}/site/manual-overrides.json`;
  await env.STORAGE.put(reportKey, JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId, generatedBy: `static-site-migrator-${VERSION}` },
  });

  const success = warnings.length === 0;
  const stage = success ? "manual_overrides_applied" : "manual_overrides_applied_with_warnings";
  await updateStage(env, jobId, stage, success ? 99 : 98);

  return json({
    success,
    jobId,
    currentStage: stage,
    progressPercent: success ? 99 : 98,
    overridesApplied: overrides.length,
    pagesProcessed: processed.length,
    reportKey,
    pages: processed,
    warnings,
  });
}

async function getManualOverrides(jobId, env) {
  const state = await getMigration(jobId, env);
  if (state.error) return state.error;

  const key = `${state.job.output_prefix}/site/manual-overrides.json`;
  const object = await env.STORAGE.get(key);

  if (!object?.body) {
    return json({ success: true, jobId, overrides: [] });
  }

  return new Response(await object.text(), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function manualOverridePayload(overrides) {
  const encoded = JSON.stringify(overrides).replace(/</g, "\\u003c");
  return `
<style id="static-migrator-manual-overrides-v170">
[data-static-migrator-manual-hidden="true"]{display:none!important}
</style>
<script id="static-migrator-manual-overrides-v170-script">
(function(){
  var overrides=${encoded};
  function run(){
    overrides.forEach(function(rule){
      var el=document.getElementById(rule.widgetId);
      if(!el){console.warn('Static migrator override target not found',rule);return}
      var target=el;
      if(rule.scope==='row'){
        target=el.closest('.dmRespRow,[data-element-type="row"],.dmRespColsWrapper')||el;
      }
      target.setAttribute('data-static-migrator-manual-hidden','true');
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run();
})();
</script>`;
}

function removeManualOverridePayload(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-manual-overrides-v170["'][^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*id=["']static-migrator-manual-overrides-v170-script["'][^>]*>[\s\S]*?<\/script>/gi, "");
}

function removeAnimationPayload(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-animation-final-v16[67]["'][^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*id=["']static-migrator-animation-final-v16[67]-script["'][^>]*>[\s\S]*?<\/script>/gi, "");
}

function animationPayload() {
  return `
<style id="static-migrator-animation-final-v167">
[data-static-migrator-animation-fixed="true"]{opacity:1!important;visibility:visible!important;transform:none!important;translate:none!important;animation:none!important;transition:none!important}
</style>
<script id="static-migrator-animation-final-v167-script">
(function(){
  function insideWidget(el){return !!el.closest('[class*="hero" i],[class*="banner" i],[class*="carousel" i],[class*="slider" i],[class*="slideshow" i],[data-widget-type*="slider" i],[data-widget-type*="gallery" i]')}
  function hidden(el){if(el.hidden||el.getAttribute('aria-hidden')==='true')return true;var s=String(el.getAttribute('style')||'').toLowerCase();return /display\\s*:\\s*none|visibility\\s*:\\s*hidden/.test(s)}
  function run(){document.querySelectorAll('[data-anim-extended]').forEach(function(el){if(insideWidget(el)||hidden(el))return;el.setAttribute('data-static-migrator-animation-fixed','true');el.style.setProperty('opacity','1','important');el.style.setProperty('visibility','visible','important');el.style.setProperty('transform','none','important');el.style.setProperty('translate','none','important');el.style.setProperty('animation','none','important');el.style.setProperty('transition','none','important')})}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run();
  window.addEventListener('load',run,{once:true});
})();
</script>`;
}

function appendToBody(html, payload) {
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${payload}\n</body>`)
    : `${html}\n${payload}`;
}

async function updateStage(env, jobId, stage, progress) {
  await env.DB.prepare(
    "UPDATE migration_jobs SET current_stage=?,progress_percent=?,updated_at=? WHERE id=?",
  )
    .bind(stage, progress, new Date().toISOString(), jobId)
    .run();
}

async function servePreview(jobId, requestedPath, env) {
  const job = await env.DB.prepare(
    "SELECT * FROM migration_jobs WHERE id=?",
  )
    .bind(jobId)
    .first();

  if (!job) return new Response("Preview job not found.", { status: 404 });

  let path;
  try {
    path = decodeURIComponent(requestedPath || "/").replace(/^\/+/, "");
  } catch {
    return new Response("Invalid preview path.", { status: 400 });
  }

  if (!path) path = "index.html";
  if (path.endsWith("/")) path += "index.html";
  if (path.includes("..") || path.includes("\\")) {
    return new Response("Invalid preview path.", { status: 400 });
  }

  const choices = [path];
  if (!/\.[a-z0-9]{1,10}$/i.test(path)) choices.push(`${path}/index.html`);

  let object = null;
  let resolved = null;
  for (const choice of choices) {
    object = await env.STORAGE.get(`${job.output_prefix}/site/${choice}`);
    if (object?.body) {
      resolved = choice;
      break;
    }
  }

  if (!object?.body || !resolved) {
    return new Response("Preview file not found.", { status: 404 });
  }

  const type = object.httpMetadata?.contentType || contentType(resolved);
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex,nofollow",
  });
  const prefix = `/preview/${encodeURIComponent(jobId)}`;

  if (/text\/html/i.test(type)) {
    return new Response(prefixUrls(await object.text(), prefix), {
      status: 200,
      headers,
    });
  }
  if (/text\/css/i.test(type)) {
    return new Response(prefixCss(await object.text(), prefix), {
      status: 200,
      headers,
    });
  }
  return new Response(object.body, { status: 200, headers });
}

function prefixUrls(html, prefix) {
  let out = html.replace(
    /\b(href|src|poster|data-src|data-image-url)\s*=\s*(["'])\/(?!\/|preview\/)(.*?)\2/gi,
    (_, attr, quote, value) => `${attr}=${quote}${prefix}/${value}${quote}`,
  );

  out = out.replace(
    /\bsrcset\s*=\s*(["'])(.*?)\1/gi,
    (whole, quote, value) =>
      `srcset=${quote}${value
        .split(",")
        .map((item) => {
          const parts = item.trim().split(/\s+/);
          if (
            parts[0]?.startsWith("/") &&
            !parts[0].startsWith("//") &&
            !parts[0].startsWith("/preview/")
          ) {
            parts[0] = `${prefix}${parts[0]}`;
          }
          return parts.join(" ");
        })
        .join(", ")}${quote}`,
  );

  return prefixCss(out, prefix);
}

function prefixCss(value, prefix) {
  return value.replace(
    /url\(\s*(["']?)\/(?!\/|preview\/)(.*?)\1\s*\)/gi,
    (_, quote, path) => `url(${quote}${prefix}/${path}${quote})`,
  );
}

function contentType(path) {
  const lower = path.toLowerCase();
  const types = [
    [".html", "text/html; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".js", "application/javascript"],
    [".json", "application/json"],
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".webp", "image/webp"],
    [".svg", "image/svg+xml"],
    [".woff2", "font/woff2"],
    [".woff", "font/woff"],
  ];

  for (const [extension, type] of types) {
    if (lower.endsWith(extension)) return type;
  }
  return "application/octet-stream";
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}
