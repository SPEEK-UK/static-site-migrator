const VERSION = "1.6.4";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    try {
      validateBindings(env);

      if (request.method === "GET" && pathname === "/") {
        return json({ success: true, service: "Static Site Migrator Engine", version: VERSION, status: "online" });
      }

      const preview = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (request.method === "GET" && preview) {
        return servePreview(decodeURIComponent(preview[1]), preview[2] || "/", env);
      }

      let match = pathname.match(/^\/api\/migrations\/([^/]+)\/freeze-hero-state$/);
      if (request.method === "POST" && match) {
        return freezeHeroState(decodeURIComponent(match[1]), env);
      }

      match = pathname.match(/^\/api\/migrations\/([^/]+)$/);
      if (request.method === "GET" && match) {
        const job = await getJob(decodeURIComponent(match[1]), env);
        return job ? json({ success: true, job }) : json({ success: false, error: "Migration job not found." }, 404);
      }

      return json({ success: false, error: "Route not found." }, 404);
    } catch (error) {
      console.error(error);
      return json({ success: false, error: errorMessage(error) }, 500);
    }
  },
};

async function freezeHeroState(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const result = await env.DB.prepare(`
    SELECT id, source_url, output_path
    FROM migration_pages
    WHERE job_id = ? AND status = 'captured'
    ORDER BY source_url
  `).bind(jobId).all();

  const pages = result.results || [];
  if (!pages.length) return json({ success: false, error: "No generated pages are available." }, 409);

  const startedAt = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status='processing', current_stage=?, progress_percent=?, updated_at=? WHERE id=?`)
      .bind("freezing_hero_state", 97, startedAt, jobId),
    eventStatement(env, jobId, "info", "freezing_hero_state", "Late-running slider runtime removal started.", { pages: pages.length }, startedAt),
  ]);

  const processed = [];
  const warnings = [];

  for (const page of pages) {
    const outputPath = page.output_path || "index.html";
    const key = `${job.output_prefix}/site/${outputPath}`;

    try {
      const object = await env.STORAGE.get(key);
      if (!object?.body) throw new Error(`Generated page is missing from R2: ${key}`);

      const original = await object.text();
      const fixed = freezeHtml(original);

      await env.STORAGE.put(key, fixed.html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          heroStateFrozen: "true",
          version: VERSION,
        },
      });

      processed.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        outputPath,
        r2Key: key,
        scriptsRemoved: fixed.scriptsRemoved,
        payloadsRemoved: fixed.payloadsRemoved,
        safeguardInjected: fixed.safeguardInjected,
        htmlLength: fixed.html.length,
      });
    } catch (error) {
      warnings.push({ pageId: page.id, sourceUrl: page.source_url, error: errorMessage(error) });
    }
  }

  const completedAt = now();
  const success = warnings.length === 0;
  const stage = success ? "hero_state_frozen" : "hero_state_frozen_with_warnings";
  const reportKey = `${job.output_prefix}/site/hero-freeze-report.json`;

  await env.STORAGE.put(reportKey, JSON.stringify({ version: VERSION, jobId, generatedAt: completedAt, pages: processed, warnings }, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId, generatedBy: `static-site-migrator-${VERSION}` },
  });

  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status='processing', current_stage=?, progress_percent=?, warning_count=warning_count+?, updated_at=? WHERE id=?`)
      .bind(stage, success ? 98 : 97, warnings.length, completedAt, jobId),
    eventStatement(env, jobId, success ? "info" : "warning", stage,
      success ? "Initial rendered hero state was preserved and late-running slider scripts were removed." : "Hero state freeze completed with warnings.",
      { pagesProcessed: processed.length, warnings: warnings.length, reportKey }, completedAt),
  ]);

  return json({
    success,
    jobId,
    status: "processing",
    currentStage: stage,
    progressPercent: success ? 98 : 97,
    pagesProcessed: processed.length,
    reportKey,
    pages: processed,
    warnings,
  });
}

function freezeHtml(html) {
  let output = html;
  let payloadsRemoved = 0;
  let scriptsRemoved = 0;

  const payloadPatterns = [
    /<style\b[^>]*id=["']static-migrator-overlay-v162["'][^>]*>[\s\S]*?<\/style>/gi,
    /<script\b[^>]*id=["']static-migrator-overlay-v162-script["'][^>]*>[\s\S]*?<\/script>/gi,
    /<style\b[^>]*id=["']static-migrator-overlay-v163["'][^>]*>[\s\S]*?<\/style>/gi,
    /<script\b[^>]*id=["']static-migrator-overlay-v163-script["'][^>]*>[\s\S]*?<\/script>/gi,
  ];

  for (const pattern of payloadPatterns) {
    const before = output;
    output = output.replace(pattern, "");
    if (output !== before) payloadsRemoved += 1;
  }

  output = output.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
    const haystack = `${attrs}\n${body}`.toLowerCase();
    const widgetRuntime = /(carousel|slideshow|slider|swiper|slick|owlcarousel|flexslider|dmwidgetgallery|widget.*gallery|gallery.*widget)/i.test(haystack);
    const preserve = /(application\/ld\+json|type=["']application\/json|static-migrator)/i.test(attrs);
    if (widgetRuntime && !preserve) {
      scriptsRemoved += 1;
      return "";
    }
    return full;
  });

  const safeguard = `
<style id="static-migrator-hero-freeze-v164">
/* Preserve the already-rendered static hero/slider state. */
[class*="hero" i],
[class*="banner" i],
[class*="carousel" i],
[class*="slider" i],
[class*="slideshow" i] {
  visibility: visible !important;
}
[class*="hero" i] [aria-hidden="false"],
[class*="banner" i] [aria-hidden="false"],
[class*="carousel" i] .active,
[class*="slider" i] .active,
[class*="slideshow" i] .active,
[class*="carousel" i] .current,
[class*="slider" i] .current,
[class*="slideshow" i] .current {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
}
</style>`;

  let safeguardInjected = false;
  if (!output.includes("static-migrator-hero-freeze-v164")) {
    output = /<\/head>/i.test(output)
      ? output.replace(/<\/head>/i, `${safeguard}\n</head>`)
      : `${safeguard}\n${output}`;
    safeguardInjected = true;
  }

  return { html: output, scriptsRemoved, payloadsRemoved, safeguardInjected };
}

async function servePreview(jobId, requestedPath, env) {
  const job = await getJob(jobId, env);
  if (!job) return new Response("Preview job not found.", { status: 404 });

  let path;
  try { path = decodeURIComponent(requestedPath || "/"); }
  catch { return new Response("Invalid preview path.", { status: 400 }); }

  path = path.replace(/^\/+/, "");
  if (!path) path = "index.html";
  if (path.endsWith("/")) path += "index.html";
  if (path.includes("..") || path.includes("\\")) return new Response("Invalid preview path.", { status: 400 });

  const candidates = [path];
  if (!hasFileExtension(path)) candidates.push(`${path}/index.html`);

  let object = null;
  let resolved = null;
  for (const candidate of candidates) {
    object = await env.STORAGE.get(`${job.output_prefix}/site/${candidate}`);
    if (object?.body) { resolved = candidate; break; }
  }
  if (!object?.body || !resolved) return new Response("Preview file not found.", { status: 404 });

  const type = object.httpMetadata?.contentType || guessContentType(resolved);
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
  });
  const prefix = `/preview/${encodeURIComponent(jobId)}`;

  if (/text\/html/i.test(type)) return new Response(prefixPreviewHtmlUrls(await object.text(), prefix), { status: 200, headers });
  if (/text\/css/i.test(type)) return new Response(prefixPreviewCssUrls(await object.text(), prefix), { status: 200, headers });
  return new Response(object.body, { status: 200, headers });
}

function prefixPreviewHtmlUrls(html, prefix) {
  let output = html.replace(
    /\b(href|src|poster|data-src|data-image-url)\s*=\s*(["'])\/(?!\/|preview\/)(.*?)\2/gi,
    (_, attr, quote, value) => `${attr}=${quote}${prefix}/${value}${quote}`
  );
  output = output.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (match, quote, value) => {
    const rewritten = value.split(",").map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      if (parts[0]?.startsWith("/") && !parts[0].startsWith("//") && !parts[0].startsWith("/preview/")) {
        parts[0] = `${prefix}${parts[0]}`;
      }
      return parts.join(" ");
    }).join(", ");
    return `srcset=${quote}${rewritten}${quote}`;
  });
  return prefixPreviewCssUrls(output, prefix);
}

function prefixPreviewCssUrls(value, prefix) {
  return value.replace(/url\(\s*(["']?)\/(?!\/|preview\/)(.*?)\1\s*\)/gi,
    (_, quote, path) => `url(${quote}${prefix}/${path}${quote})`);
}

async function getJob(jobId, env) {
  return env.DB.prepare("SELECT * FROM migration_jobs WHERE id = ?").bind(jobId).first();
}

function eventStatement(env, jobId, level, stage, message, details, createdAt) {
  return env.DB.prepare(`
    INSERT INTO migration_events(job_id,level,stage,message,details_json,created_at)
    VALUES(?,?,?,?,?,?)
  `).bind(jobId, level, stage, message, details == null ? null : JSON.stringify(details), createdAt);
}

function hasFileExtension(path) { return /\.[a-zA-Z0-9]{1,10}$/.test(path.split("?")[0]); }
function guessContentType(path) {
  const p = path.toLowerCase();
  const types = [[".html","text/html; charset=utf-8"],[".css","text/css; charset=utf-8"],[".js","application/javascript; charset=utf-8"],[".json","application/json; charset=utf-8"],[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".gif","image/gif"],[".webp","image/webp"],[".svg","image/svg+xml"],[".ico","image/x-icon"],[".woff2","font/woff2"],[".woff","font/woff"],[".ttf","font/ttf"],[".otf","font/otf"]];
  for (const [ext, type] of types) if (p.endsWith(ext)) return type;
  return "application/octet-stream";
}
function validateBindings(env) {
  const missing = [];
  if (!env.DB) missing.push("DB");
  if (!env.STORAGE) missing.push("STORAGE");
  if (missing.length) throw new Error(`Missing Cloudflare binding(s): ${missing.join(", ")}`);
}
function now() { return new Date().toISOString(); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error || "Unexpected server error."); }
function json(data, status = 200) { return Response.json(data, { status, headers: CORS }); }
