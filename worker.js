const VERSION = "1.6.3";
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

      let match = pathname.match(/^\/api\/migrations\/([^/]+)\/restore-overlays-safe$/);
      if (request.method === "POST" && match) {
        return restoreOverlaysSafe(decodeURIComponent(match[1]), env);
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

async function restoreOverlaysSafe(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const pagesResult = await env.DB.prepare(`
    SELECT id, source_url, output_path
    FROM migration_pages
    WHERE job_id = ? AND status = 'captured'
    ORDER BY source_url
  `).bind(jobId).all();

  const pages = pagesResult.results || [];
  if (!pages.length) return json({ success: false, error: "No generated pages are available." }, 409);

  const startedAt = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status='processing', current_stage=?, progress_percent=?, updated_at=? WHERE id=?`)
      .bind("restoring_overlays_safely", 96, startedAt, jobId),
    eventStatement(env, jobId, "info", "restoring_overlays_safely", "Safe overlay restoration started.", { pages: pages.length }, startedAt),
  ]);

  const restored = [];
  const warnings = [];

  for (const page of pages) {
    const outputPath = page.output_path || "index.html";
    const key = `${job.output_prefix}/site/${outputPath}`;

    try {
      const object = await env.STORAGE.get(key);
      if (!object?.body) throw new Error(`Generated page is missing from R2: ${key}`);

      let html = await object.text();
      html = removeOldOverlayPayload(html);
      html = injectSafeOverlayPayload(html);

      await env.STORAGE.put(key, html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          safeOverlayRestoration: "true",
          version: VERSION,
        },
      });

      restored.push({ pageId: page.id, sourceUrl: page.source_url, outputPath, r2Key: key, htmlLength: html.length });
    } catch (error) {
      warnings.push({ pageId: page.id, sourceUrl: page.source_url, error: errorMessage(error) });
    }
  }

  const completedAt = now();
  const success = warnings.length === 0;
  const stage = success ? "safe_overlays_restored" : "safe_overlays_restored_with_warnings";
  const reportKey = `${job.output_prefix}/site/safe-overlay-restoration-report.json`;

  await env.STORAGE.put(reportKey, JSON.stringify({ version: VERSION, jobId, generatedAt: completedAt, pages: restored, warnings }, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId, generatedBy: `static-site-migrator-${VERSION}` },
  });

  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status='processing', current_stage=?, progress_percent=?, warning_count=warning_count+?, updated_at=? WHERE id=?`)
      .bind(stage, success ? 97 : 96, warnings.length, completedAt, jobId),
    eventStatement(env, jobId, success ? "info" : "warning", stage,
      success ? "Visible active-slide overlays were restored without revealing hidden placeholders." : "Safe overlay restoration completed with warnings.",
      { pagesRestored: restored.length, warnings: warnings.length, reportKey }, completedAt),
  ]);

  return json({
    success,
    jobId,
    status: "processing",
    currentStage: stage,
    progressPercent: success ? 97 : 96,
    pagesProcessed: restored.length,
    reportKey,
    pages: restored,
    warnings,
  });
}

function removeOldOverlayPayload(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-overlay-v162["'][^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*id=["']static-migrator-overlay-v162-script["'][^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*id=["']static-migrator-overlay-v163["'][^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*id=["']static-migrator-overlay-v163-script["'][^>]*>[\s\S]*?<\/script>/gi, "");
}

function injectSafeOverlayPayload(html) {
  const payload = `
<style id="static-migrator-overlay-v163">
html.static-migrator-safe-overlays [data-static-migrator-safe-overlay="true"] {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  animation: none !important;
  transition: none !important;
  z-index: 20 !important;
}
</style>
<script id="static-migrator-overlay-v163-script">
(function () {
  var containerSelector = [
    '[class*="hero" i]','[class*="banner" i]','[class*="carousel" i]',
    '[class*="slider" i]','[class*="slideshow" i]',
    '[data-widget-type*="slider" i]','[data-widget-type*="gallery" i]',
    '[data-element-type*="slider" i]','[data-element-type*="gallery" i]'
  ].join(',');

  var overlaySelector = [
    'h1','h2','h3','h4','h5','h6','p','a','button',
    '.dmButton','.dmNewParagraph','.caption','.overlay',
    '[class*="caption" i]','[class*="overlay" i]','[class*="title" i]',
    '[class*="subtitle" i]','[class*="button" i]'
  ].join(',');

  function textIsPlaceholder(el) {
    var text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return text === 'slide title' || text === 'slide description' || text === 'button text' || text === 'title';
  }

  function intentionallyHidden(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    var cls = String(el.className || '').toLowerCase();
    if (/\b(hidden|hide|is-hidden|dmhide|display-none)\b/.test(cls)) return true;
    var inline = String(el.getAttribute('style') || '').toLowerCase();
    if (/display\s*:\s*none/.test(inline)) return true;
    return false;
  }

  function isActiveSlide(el) {
    if (!el || intentionallyHidden(el)) return false;
    return el.classList.contains('active') ||
      el.classList.contains('current') ||
      el.getAttribute('aria-hidden') === 'false' ||
      el.getAttribute('aria-current') === 'true' ||
      el.getAttribute('data-active') === 'true';
  }

  function findActiveScope(container) {
    var slides = Array.from(container.querySelectorAll('[class*="slide" i], [class*="item" i], [role="tabpanel"]'));
    return slides.find(isActiveSlide) || null;
  }

  function restore(el) {
    if (intentionallyHidden(el) || textIsPlaceholder(el)) return;
    var computed = window.getComputedStyle(el);
    if (computed.display === 'none') return;
    el.setAttribute('data-static-migrator-safe-overlay', 'true');
    el.style.setProperty('opacity', '1', 'important');
    el.style.setProperty('visibility', 'visible', 'important');
    el.style.setProperty('transform', 'none', 'important');
    el.style.setProperty('animation', 'none', 'important');
    el.style.setProperty('transition', 'none', 'important');
    el.style.setProperty('z-index', '20', 'important');
  }

  function runOnce() {
    if (document.documentElement.dataset.staticMigratorOverlayDone === 'true') return;
    document.documentElement.dataset.staticMigratorOverlayDone = 'true';
    document.documentElement.classList.add('static-migrator-safe-overlays');

    document.querySelectorAll(containerSelector).forEach(function (container) {
      if (intentionallyHidden(container)) return;
      var scope = findActiveScope(container) || container;
      scope.querySelectorAll(overlaySelector).forEach(restore);

      Array.from(container.children).forEach(function (child) {
        if (child.matches && child.matches(overlaySelector)) restore(child);
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', runOnce, { once: true });
  else runOnce();
})();
</script>`;

  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${payload}\n</body>`)
    : `${html}\n${payload}`;
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
