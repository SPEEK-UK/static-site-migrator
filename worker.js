const VERSION = "1.6.1";
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

      let match = pathname.match(/^\/api\/migrations\/([^/]+)\/rewrite-pages$/);
      if (request.method === "POST" && match) return rewritePages(decodeURIComponent(match[1]), env, false);

      match = pathname.match(/^\/api\/migrations\/([^/]+)\/stabilise-conservative$/);
      if (request.method === "POST" && match) return rewritePages(decodeURIComponent(match[1]), env, true);

      match = pathname.match(/^\/api\/migrations\/([^/]+)$/);
      if (request.method === "GET" && match) return getMigration(decodeURIComponent(match[1]), env);

      return json({ success: false, error: "Route not found." }, 404);
    } catch (error) {
      console.error(error);
      return json({ success: false, error: errorMessage(error) }, 500);
    }
  },
};

async function rewritePages(jobId, env, conservative) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id = ?").bind(jobId).first();
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const [pagesResult, assetsResult] = await Promise.all([
    env.DB.prepare(`SELECT * FROM migration_pages WHERE job_id = ? AND status = 'captured' AND html_r2_key IS NOT NULL ORDER BY source_url`).bind(jobId).all(),
    env.DB.prepare(`SELECT * FROM migration_assets WHERE job_id = ? ORDER BY source_url`).bind(jobId).all(),
  ]);
  const pages = pagesResult.results || [];
  const assets = assetsResult.results || [];
  if (!pages.length) return json({ success: false, error: "No captured pages are available." }, 409);

  const downloaded = assets.filter((a) => a.status === "downloaded" && a.output_path && a.r2_key);
  const blocked = assets.filter((a) => a.status === "blocked");
  const assetMap = new Map(downloaded.map((a) => [normaliseUrl(a.source_url), `/${a.output_path}`]));
  const pageMap = new Map(pages.map((p) => [normaliseComparableUrl(p.source_url), outputPathToPublicUrl(p.output_path)]));
  const stage = conservative ? "stabilising_conservatively" : "rewriting_pages";
  const started = now();

  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status='processing', current_stage=?, progress_percent=?, updated_at=? WHERE id=?`)
      .bind(stage, conservative ? 86 : 75, started, jobId),
    eventStatement(env, jobId, "info", stage,
      conservative ? "Conservative in-place widget stabilisation started." : "Static HTML and CSS rewriting started.",
      { pages: pages.length, downloadedAssets: downloaded.length, blockedAssets: blocked.length }, started),
  ]);

  const cssWarnings = [];
  let rewrittenStylesheets = 0;
  for (const asset of downloaded.filter((a) => a.asset_type === "stylesheet")) {
    try {
      const object = await env.STORAGE.get(asset.r2_key);
      if (!object?.body) throw new Error(`Stylesheet missing from R2: ${asset.r2_key}`);
      const rewritten = rewriteCss(await object.text(), asset.source_url, assetMap);
      await env.STORAGE.put(asset.r2_key, rewritten.css, {
        httpMetadata: { contentType: asset.content_type || "text/css; charset=utf-8" },
        customMetadata: { jobId, assetId: asset.id, sourceUrl: asset.source_url, rewritten: "true" },
      });
      rewrittenStylesheets += 1;
    } catch (error) {
      cssWarnings.push({ assetId: asset.id, sourceUrl: asset.source_url, error: errorMessage(error) });
    }
  }

  const results = [];
  const warnings = [];
  for (const page of pages) {
    try {
      const object = await env.STORAGE.get(page.html_r2_key);
      if (!object?.body) throw new Error(`Captured HTML missing from R2: ${page.html_r2_key}`);
      const base = rewriteHtml(await object.text(), page.source_url, assetMap, pageMap);
      const stabilised = conservative ? addConservativeStabiliser(base.html) : { html: base.html, injected: false };
      const key = `${job.output_prefix}/site/${page.output_path || "index.html"}`;
      await env.STORAGE.put(key, stabilised.html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          rewritten: "true",
          conservativeStabilisation: conservative ? "true" : "false",
          version: VERSION,
        },
      });
      results.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        outputPath: page.output_path,
        r2Key: key,
        assetReplacements: base.assetReplacements,
        internalLinkReplacements: base.internalLinkReplacements,
        removedRuntimeBlocks: base.removedRuntimeBlocks,
        conservativeStabiliserInjected: stabilised.injected,
        htmlLength: stabilised.html.length,
      });
    } catch (error) {
      warnings.push({ pageId: page.id, sourceUrl: page.source_url, error: errorMessage(error) });
    }
  }

  const finished = now();
  const finalStage = conservative ? "conservative_stabilisation_complete" : "pages_rewritten";
  const success = warnings.length === 0;
  const report = {
    version: VERSION,
    mode: conservative ? "conservative-in-place" : "baseline-rewrite",
    jobId,
    generatedAt: finished,
    pages: results,
    downloadedAssets: downloaded.length,
    blockedAssets: blocked.length,
    warnings: { pages: warnings, css: cssWarnings },
  };
  const reportKey = `${job.output_prefix}/site/${conservative ? "conservative-stabilisation-report.json" : "migration-manifest.json"}`;
  await env.STORAGE.put(reportKey, JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId, generatedBy: `static-site-migrator-${VERSION}` },
  });

  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status='processing', current_stage=?, progress_percent=?, warning_count=warning_count+?, updated_at=? WHERE id=?`)
      .bind(finalStage, conservative ? 92 : 82, warnings.length + cssWarnings.length, finished, jobId),
    eventStatement(env, jobId, success ? "info" : "warning", finalStage,
      conservative
        ? "Layout-preserving widget and animation stabilisation completed without restructuring page markup."
        : "Captured pages were restored to the baseline static-site structure.",
      { pages: results.length, rewrittenStylesheets, pageWarnings: warnings.length, cssWarnings: cssWarnings.length, reportKey }, finished),
  ]);

  return json({
    success,
    jobId,
    status: "processing",
    currentStage: finalStage,
    progressPercent: conservative ? 92 : 82,
    pagesProcessed: results.length,
    rewrittenStylesheets,
    downloadedAssets: downloaded.length,
    blockedAssets: blocked.length,
    reportKey,
    pages: results,
    warnings,
    cssWarnings,
  });
}

function addConservativeStabiliser(html) {
  const marker = "static-migrator-conservative-v1";
  if (html.includes(marker)) return { html, injected: false };

  const payload = `
<style id="${marker}">
/* Layout-preserving overrides: no display, position, width, grid or flex changes. */
html.static-migrator-ready [style*="opacity: 0"],
html.static-migrator-ready [style*="opacity:0"],
html.static-migrator-ready .dmAnimation,
html.static-migrator-ready .dmNewParagraph[data-anim-desktop],
html.static-migrator-ready [data-anim-desktop],
html.static-migrator-ready [data-animation],
html.static-migrator-ready .wow,
html.static-migrator-ready .animated {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  animation: none !important;
  transition: none !important;
}
html.static-migrator-ready .skrollable,
html.static-migrator-ready .skrollable-before,
html.static-migrator-ready .skrollable-after {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
}
html.static-migrator-ready [data-static-migrator-active-slide="true"] {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  z-index: 2 !important;
}
</style>
<script id="${marker}-script">
(function () {
  function visibleImage(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.matches('img[src], source[srcset], [style*="background-image"], [data-image-url], [data-src]')) return true;
    return !!el.querySelector('img[src], source[srcset], [style*="background-image"], [data-image-url], [data-src]');
  }

  function finishAnimations(root) {
    var selectors = [
      '[data-anim-desktop]', '[data-animation]', '.dmAnimation', '.wow', '.animated',
      '.skrollable', '.skrollable-before', '.skrollable-after'
    ];
    root.querySelectorAll(selectors.join(',')).forEach(function (el) {
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('transform', 'none', 'important');
      el.style.setProperty('animation', 'none', 'important');
      el.style.setProperty('transition', 'none', 'important');
    });
  }

  function stabiliseWidgets(root) {
    var widgetSelector = [
      '[class*="carousel" i]', '[class*="slider" i]', '[class*="slideshow" i]',
      '[data-widget-type*="slider" i]', '[data-widget-type*="gallery" i]',
      '[data-element-type*="slider" i]', '[data-element-type*="gallery" i]'
    ].join(',');

    root.querySelectorAll(widgetSelector).forEach(function (widget) {
      var candidates = Array.from(widget.children).filter(visibleImage);
      if (!candidates.length) {
        candidates = Array.from(widget.querySelectorAll('[class*="slide" i], [class*="item" i], li')).filter(visibleImage);
      }
      if (!candidates.length) return;

      var active = candidates.find(function (el) {
        return el.classList.contains('active') || el.getAttribute('aria-hidden') === 'false' || el.getAttribute('data-active') === 'true';
      }) || candidates[0];

      active.setAttribute('data-static-migrator-active-slide', 'true');
      active.style.setProperty('opacity', '1', 'important');
      active.style.setProperty('visibility', 'visible', 'important');
      active.style.setProperty('transform', 'none', 'important');

      var image = active.matches('img') ? active : active.querySelector('img');
      if (image) {
        var lazy = image.getAttribute('data-src') || image.getAttribute('data-lazy-src') || image.getAttribute('data-original');
        if (lazy && (!image.getAttribute('src') || image.getAttribute('src').indexOf('data:image') === 0)) image.setAttribute('src', lazy);
      }
    });
  }

  function run() {
    document.documentElement.classList.add('static-migrator-ready');
    finishAnimations(document);
    stabiliseWidgets(document);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
  window.addEventListener('load', run, { once: true });
  setTimeout(run, 500);
  setTimeout(run, 1500);
})();
</script>`;

  if (/<\/body>/i.test(html)) return { html: html.replace(/<\/body>/i, `${payload}\n</body>`), injected: true };
  return { html: `${html}\n${payload}`, injected: true };
}

function rewriteHtml(html, pageUrl, assetMap, pageMap) {
  let output = cleanMalformedQuotedUrls(html);
  let assetReplacements = 0;
  let internalLinkReplacements = 0;
  let removedRuntimeBlocks = 0;

  const ordered = [...assetMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [sourceUrl, localPath] of ordered) {
    for (const variant of unique([sourceUrl, sourceUrl.replace(/&/g, "&amp;"), encodeURI(sourceUrl)])) {
      const result = replaceAllCount(output, variant, localPath);
      output = result.text;
      assetReplacements += result.count;
    }
  }

  output = output.replace(/\bhref\s*=\s*(["'])(.*?)\1/gi, (match, quote, value) => {
    try {
      const url = new URL(decodeHtml(value), pageUrl);
      url.hash = "";
      const local = pageMap.get(normaliseComparableUrl(url.href));
      if (!local) return match;
      internalLinkReplacements += 1;
      return `href=${quote}${local}${quote}`;
    } catch { return match; }
  });

  const patterns = [
    /<script\b[^>]*>[\s\S]*?runtime-service-worker\.js[\s\S]*?<\/script>/gi,
    /<script\b[^>]*src=["'][^"']*sp-2\.0\.0-dm-0\.1\.min\.js[^"']*["'][^>]*><\/script>/gi,
    /<script\b[^>]*id=["']d_track_campaign["'][^>]*>[\s\S]*?<\/script>/gi,
  ];
  for (const pattern of patterns) {
    const before = output;
    output = output.replace(pattern, "");
    if (output !== before) removedRuntimeBlocks += 1;
  }
  if (!/<!doctype\s+html/i.test(output)) output = `<!DOCTYPE html>\n${output}`;
  return { html: output, assetReplacements, internalLinkReplacements, removedRuntimeBlocks };
}

function rewriteCss(css, stylesheetUrl, assetMap) {
  let replacements = 0;
  const output = css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, quote, value) => {
    const cleaned = decodeHtml(String(value || "").trim());
    if (!cleaned || /^(data:|blob:|#)/i.test(cleaned)) return match;
    try {
      const local = assetMap.get(normaliseUrl(new URL(cleaned, stylesheetUrl).href));
      if (!local) return match;
      replacements += 1;
      return `url("${local}")`;
    } catch { return match; }
  });
  return { css: output, replacements };
}

async function servePreview(jobId, requestedPath, env) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id = ?").bind(jobId).first();
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
  let object = null, resolved = null;
  for (const candidate of candidates) {
    object = await env.STORAGE.get(`${job.output_prefix}/site/${candidate}`);
    if (object?.body) { resolved = candidate; break; }
  }
  if (!object?.body || !resolved) return new Response("Preview file not found.", { status: 404 });

  const type = object.httpMetadata?.contentType || guessContentType(resolved);
  const headers = new Headers({ "Content-Type": type, "Cache-Control": "no-store, max-age=0", "X-Robots-Tag": "noindex, nofollow" });
  const prefix = `/preview/${encodeURIComponent(jobId)}`;
  if (/text\/html/i.test(type)) return new Response(prefixPreviewHtmlUrls(await object.text(), prefix), { status: 200, headers });
  if (/text\/css/i.test(type)) return new Response(prefixPreviewCssUrls(await object.text(), prefix), { status: 200, headers });
  return new Response(object.body, { status: 200, headers });
}

function prefixPreviewHtmlUrls(html, prefix) {
  let output = html.replace(/\b(href|src|poster|data-src|data-image-url)\s*=\s*(["'])\/(?!\/|preview\/)(.*?)\2/gi,
    (_, attr, quote, value) => `${attr}=${quote}${prefix}/${value}${quote}`);
  output = output.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (match, quote, value) => {
    const rewritten = value.split(",").map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      if (parts[0]?.startsWith("/") && !parts[0].startsWith("//") && !parts[0].startsWith("/preview/")) parts[0] = `${prefix}${parts[0]}`;
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

async function getMigration(jobId, env) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id = ?").bind(jobId).first();
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);
  return json({ success: true, job });
}

function cleanMalformedQuotedUrls(value) {
  return value
    .replace(/https:\/\/[^\s"'<>]+\/%22(https%3A%2F%2F[^"'<>]+)%22/gi, (_, encoded) => {
      try { return decodeURIComponent(encoded); } catch { return encoded; }
    })
    .replace(/https:\/\/[^\s"'<>]+\/%22(https:\/\/[^"'<>]+)%22/gi, "$1");
}
function outputPathToPublicUrl(path) {
  if (!path || path === "index.html") return "/";
  return `/${path.replace(/\/index\.html$/i, "").replace(/^\/+/, "")}/`;
}
function normaliseUrl(value) { const u = new URL(value); u.hash = ""; return u.href; }
function normaliseComparableUrl(value) {
  const u = new URL(value); u.hash = "";
  for (const key of ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","gclid","fbclid"]) u.searchParams.delete(key);
  if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
  return u.href;
}
function replaceAllCount(input, search, replacement) {
  if (!search || !input.includes(search)) return { text: input, count: 0 };
  const parts = input.split(search); return { text: parts.join(replacement), count: parts.length - 1 };
}
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function decodeHtml(value) {
  return value.replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">");
}
function eventStatement(env, jobId, level, stage, message, details, createdAt) {
  return env.DB.prepare(`INSERT INTO migration_events(job_id,level,stage,message,details_json,created_at) VALUES(?,?,?,?,?,?)`)
    .bind(jobId, level, stage, message, details == null ? null : JSON.stringify(details), createdAt);
}
function hasFileExtension(path) { return /\.[a-zA-Z0-9]{1,10}$/.test(path.split("?")[0]); }
function guessContentType(path) {
  const p = path.toLowerCase();
  const types = [[".html","text/html; charset=utf-8"],[".css","text/css; charset=utf-8"],[".js","application/javascript; charset=utf-8"],[".json","application/json; charset=utf-8"],[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".gif","image/gif"],[".webp","image/webp"],[".svg","image/svg+xml"],[".ico","image/x-icon"],[".woff2","font/woff2"],[".woff","font/woff"],[".ttf","font/ttf"],[".otf","font/otf"]];
  for (const [ext,type] of types) if (p.endsWith(ext)) return type;
  return "application/octet-stream";
}
function validateBindings(env) {
  const missing = []; if (!env.DB) missing.push("DB"); if (!env.STORAGE) missing.push("STORAGE");
  if (missing.length) throw new Error(`Missing Cloudflare binding(s): ${missing.join(", ")}`);
}
function now() { return new Date().toISOString(); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error || "Unexpected server error."); }
function json(data, status = 200) { return Response.json(data, { status, headers: CORS }); }
