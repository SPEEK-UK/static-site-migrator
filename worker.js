const VERSION = "1.5.0";

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
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    try {
      validateBindings(env);

      if (request.method === "GET" && pathname === "/") {
        return json({ success: true, service: "Static Site Migrator Engine", version: VERSION, status: "online" });
      }

      const previewMatch = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (request.method === "GET" && previewMatch) {
        return await servePreview(decodeURIComponent(previewMatch[1]), previewMatch[2] || "/", env);
      }

      let match = pathname.match(/^\/api\/migrations\/([^/]+)\/rewrite-pages$/);
      if (request.method === "POST" && match) {
        return await rewritePages(decodeURIComponent(match[1]), env);
      }

      match = pathname.match(/^\/api\/migrations\/([^/]+)$/);
      if (request.method === "GET" && match) {
        return await getMigration(decodeURIComponent(match[1]), env);
      }

      return json({ success: false, error: "Route not found." }, 404);
    } catch (error) {
      console.error(error);
      return json({ success: false, error: errorMessage(error) }, 500);
    }
  },
};

async function servePreview(jobId, requestedPath, env) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id = ?").bind(jobId).first();
  if (!job) return new Response("Preview job not found.", { status: 404 });

  let relativePath;
  try { relativePath = decodeURIComponent(requestedPath || "/"); }
  catch { return new Response("Invalid preview path.", { status: 400 }); }

  relativePath = relativePath.replace(/^\/+/, "");
  if (!relativePath) relativePath = "index.html";
  if (relativePath.endsWith("/")) relativePath += "index.html";
  if (relativePath.includes("..") || relativePath.includes("\\")) return new Response("Invalid preview path.", { status: 400 });

  const candidates = [relativePath];
  if (!hasFileExtension(relativePath)) candidates.push(`${relativePath}/index.html`);

  let object = null;
  let resolvedPath = null;
  for (const candidate of candidates) {
    const key = `${job.output_prefix}/site/${candidate}`;
    object = await env.STORAGE.get(key);
    if (object && object.body) { resolvedPath = candidate; break; }
  }

  if (!object || !object.body || !resolvedPath) return new Response("Preview file not found.", { status: 404 });

  const contentType = object.httpMetadata?.contentType || guessContentType(resolvedPath);
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
  });
  const previewPrefix = `/preview/${encodeURIComponent(jobId)}`;

  if (/text\/html/i.test(contentType)) {
    let html = await object.text();
    html = prefixPreviewHtmlUrls(html, previewPrefix);
    return new Response(html, { status: 200, headers });
  }
  if (/text\/css/i.test(contentType)) {
    let css = await object.text();
    css = prefixPreviewCssUrls(css, previewPrefix);
    return new Response(css, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

function prefixPreviewHtmlUrls(html, prefix) {
  let output = html.replace(/\b(href|src|poster|data-src|data-image-url)\s*=\s*(["'])\/(?!\/|preview\/)(.*?)\2/gi,
    (_, attribute, quote, value) => `${attribute}=${quote}${prefix}/${value}${quote}`);
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
  const [pagesResult, assetsResult, eventsResult] = await Promise.all([
    env.DB.prepare("SELECT * FROM migration_pages WHERE job_id = ? ORDER BY source_url").bind(jobId).all(),
    env.DB.prepare("SELECT * FROM migration_assets WHERE job_id = ? ORDER BY asset_type, source_url").bind(jobId).all(),
    env.DB.prepare("SELECT * FROM migration_events WHERE job_id = ? ORDER BY created_at, id").bind(jobId).all(),
  ]);
  return json({
    success: true,
    job,
    pages: pagesResult.results || [],
    assets: assetsResult.results || [],
    events: (eventsResult.results || []).map((event) => ({ ...event, details: parseJson(event.details_json), details_json: undefined })),
  });
}

async function rewritePages(jobId, env) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id = ?").bind(jobId).first();
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const [pagesResult, assetsResult] = await Promise.all([
    env.DB.prepare(`SELECT * FROM migration_pages WHERE job_id = ? AND status = 'captured' AND html_r2_key IS NOT NULL ORDER BY source_url`).bind(jobId).all(),
    env.DB.prepare(`SELECT * FROM migration_assets WHERE job_id = ? ORDER BY source_url`).bind(jobId).all(),
  ]);

  const pages = pagesResult.results || [];
  const assets = assetsResult.results || [];
  if (!pages.length) return json({ success: false, error: "No captured pages are available." }, 409);

  const downloadedAssets = assets.filter((asset) => asset.status === "downloaded" && asset.output_path && asset.r2_key);
  const blockedAssets = assets.filter((asset) => asset.status === "blocked");

  const assetMap = new Map();
  for (const asset of downloadedAssets) assetMap.set(normaliseUrl(asset.source_url), `/${asset.output_path}`);

  const pageMap = new Map();
  for (const page of pages) pageMap.set(normaliseComparableUrl(page.source_url), outputPathToPublicUrl(page.output_path));

  const startedAt = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status = ?, current_stage = ?, progress_percent = ?, updated_at = ? WHERE id = ?`).bind("processing", "rewriting_pages", 75, startedAt, jobId),
    eventStatement(env, jobId, "info", "rewriting_pages", "Static HTML and CSS rewriting started.", { capturedPages: pages.length, downloadedAssets: downloadedAssets.length, blockedAssets: blockedAssets.length }, startedAt),
  ]);

  const rewrittenCss = [];
  const cssWarnings = [];
  for (const asset of downloadedAssets.filter((item) => item.asset_type === "stylesheet")) {
    try {
      const object = await env.STORAGE.get(asset.r2_key);
      if (!object || !object.body) throw new Error(`Stylesheet missing from R2: ${asset.r2_key}`);
      const originalCss = await object.text();
      const rewritten = rewriteCss(originalCss, asset.source_url, assetMap);
      await env.STORAGE.put(asset.r2_key, rewritten.css, {
        httpMetadata: { contentType: asset.content_type || "text/css; charset=utf-8" },
        customMetadata: { jobId, assetId: asset.id, sourceUrl: asset.source_url, rewritten: "true" },
      });
      rewrittenCss.push({ assetId: asset.id, outputPath: asset.output_path, replacements: rewritten.replacements });
    } catch (error) {
      cssWarnings.push({ assetId: asset.id, sourceUrl: asset.source_url, error: errorMessage(error) });
    }
  }

  const rewrittenPages = [];
  const pageWarnings = [];
  for (const page of pages) {
    try {
      const capturedObject = await env.STORAGE.get(page.html_r2_key);
      if (!capturedObject || !capturedObject.body) throw new Error(`Captured HTML missing from R2: ${page.html_r2_key}`);
      const originalHtml = await capturedObject.text();
      const result = rewriteHtml(originalHtml, page.source_url, assetMap, pageMap);
      const finalKey = `${job.output_prefix}/site/${page.output_path || "index.html"}`;
      await env.STORAGE.put(finalKey, result.html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: { jobId, pageId: page.id, sourceUrl: page.source_url, rewritten: "true" },
      });
      rewrittenPages.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        outputPath: page.output_path,
        r2Key: finalKey,
        assetReplacements: result.assetReplacements,
        internalLinkReplacements: result.internalLinkReplacements,
        removedRuntimeBlocks: result.removedRuntimeBlocks,
        htmlLength: result.html.length,
      });
    } catch (error) {
      pageWarnings.push({ pageId: page.id, sourceUrl: page.source_url, error: errorMessage(error) });
    }
  }

  const manifest = {
    version: VERSION,
    jobId,
    sourceUrl: job.source_url,
    generatedAt: now(),
    pages: rewrittenPages,
    assets: downloadedAssets.map((asset) => ({ sourceUrl: asset.source_url, outputPath: asset.output_path, assetType: asset.asset_type, contentType: asset.content_type, byteSize: asset.byte_size, r2Key: asset.r2_key })),
    blockedAssets: blockedAssets.map((asset) => ({ sourceUrl: asset.source_url, assetType: asset.asset_type, reason: asset.error_message })),
    warnings: { css: cssWarnings, pages: pageWarnings },
  };

  const manifestKey = `${job.output_prefix}/site/migration-manifest.json`;
  await env.STORAGE.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId, generatedBy: `static-site-migrator-${VERSION}` },
  });

  const completedSuccessfully = pageWarnings.length === 0;
  const warningCount = blockedAssets.length + cssWarnings.length + pageWarnings.length;
  const completedAt = now();
  const stage = completedSuccessfully ? "pages_rewritten" : "pages_rewritten_with_warnings";

  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status = ?, current_stage = ?, progress_percent = ?, warning_count = warning_count + ?, updated_at = ? WHERE id = ?`).bind("processing", stage, completedSuccessfully ? 82 : 80, cssWarnings.length + pageWarnings.length, completedAt, jobId),
    eventStatement(env, jobId, completedSuccessfully ? "info" : "warning", stage,
      completedSuccessfully ? "Captured pages and stylesheets were rewritten into the final static-site structure." : "Static-site rewriting completed with warnings.",
      { rewrittenPages: rewrittenPages.length, rewrittenStylesheets: rewrittenCss.length, blockedAssets: blockedAssets.length, cssWarnings: cssWarnings.length, pageWarnings: pageWarnings.length, manifestKey }, completedAt),
  ]);

  return json({
    success: completedSuccessfully,
    jobId,
    status: "processing",
    currentStage: stage,
    progressPercent: completedSuccessfully ? 82 : 80,
    rewrittenPages: rewrittenPages.length,
    rewrittenStylesheets: rewrittenCss.length,
    downloadedAssets: downloadedAssets.length,
    blockedAssets: blockedAssets.length,
    warningCount,
    manifestKey,
    pages: rewrittenPages,
    cssWarnings,
    pageWarnings,
  });
}

function rewriteHtml(html, pageUrl, assetMap, pageMap) {
  let output = cleanMalformedQuotedUrls(html);
  let assetReplacements = 0, internalLinkReplacements = 0, removedRuntimeBlocks = 0;
  const orderedAssets = [...assetMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [sourceUrl, localPath] of orderedAssets) {
    const variants = unique([sourceUrl, sourceUrl.replace(/&/g, "&amp;"), encodeURI(sourceUrl)]);
    for (const variant of variants) {
      const result = replaceAllCount(output, variant, localPath);
      output = result.text;
      assetReplacements += result.count;
    }
  }

  output = output.replace(/\b(href)\s*=\s*(["'])(.*?)\2/gi, (match, attribute, quote, value) => {
    try {
      const url = new URL(decodeHtml(value), pageUrl);
      url.hash = "";
      const local = pageMap.get(normaliseComparableUrl(url.href));
      if (!local) return match;
      internalLinkReplacements += 1;
      return `${attribute}=${quote}${local}${quote}`;
    } catch { return match; }
  });

  const serviceWorkerPattern = /<script\b[^>]*>[\s\S]*?runtime-service-worker\.js[\s\S]*?<\/script>/gi;
  const beforeServiceWorker = output;
  output = output.replace(serviceWorkerPattern, "");
  if (output !== beforeServiceWorker) removedRuntimeBlocks += 1;

  const analyticsPatterns = [
    /<script\b[^>]*src=["'][^"']*sp-2\.0\.0-dm-0\.1\.min\.js[^"']*["'][^>]*><\/script>/gi,
    /<script\b[^>]*id=["']d_track_campaign["'][^>]*>[\s\S]*?<\/script>/gi,
  ];
  for (const pattern of analyticsPatterns) {
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
      const absolute = normaliseUrl(new URL(cleaned, stylesheetUrl).href);
      const local = assetMap.get(absolute);
      if (!local) return match;
      replacements += 1;
      return `url("${local}")`;
    } catch { return match; }
  });
  return { css: output, replacements };
}

function cleanMalformedQuotedUrls(value) {
  return value
    .replace(/https:\/\/[^\s"'<>]+\/%22(https%3A%2F%2F[^"'<>]+)%22/gi, (_, encoded) => { try { return decodeURIComponent(encoded); } catch { return encoded; } })
    .replace(/https:\/\/[^\s"'<>]+\/%22(https:\/\/[^"'<>]+)%22/gi, "$1");
}

function outputPathToPublicUrl(outputPath) {
  if (!outputPath || outputPath === "index.html") return "/";
  return `/${outputPath.replace(/\/index\.html$/i, "").replace(/^\/+/, "")}/`;
}
function normaliseUrl(value) { const url = new URL(value); url.hash = ""; return url.href; }
function normaliseComparableUrl(value) {
  const url = new URL(value); url.hash = "";
  for (const key of ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id","gclid","fbclid"]) url.searchParams.delete(key);
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}
function replaceAllCount(input, search, replacement) {
  if (!search || !input.includes(search)) return { text: input, count: 0 };
  const parts = input.split(search);
  return { text: parts.join(replacement), count: parts.length - 1 };
}
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function decodeHtml(value) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}
function eventStatement(env, jobId, level, stage, message, details, createdAt) {
  return env.DB.prepare(`INSERT INTO migration_events (job_id, level, stage, message, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(jobId, level, stage, message, details == null ? null : JSON.stringify(details), createdAt);
}
function hasFileExtension(path) { return /\.[a-zA-Z0-9]{1,10}$/.test(path.split("?")[0]); }
function guessContentType(path) {
  const lower = path.toLowerCase();
  const types = [[".html","text/html; charset=utf-8"],[".css","text/css; charset=utf-8"],[".js","application/javascript; charset=utf-8"],[".json","application/json; charset=utf-8"],[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".gif","image/gif"],[".webp","image/webp"],[".svg","image/svg+xml"],[".ico","image/x-icon"],[".woff2","font/woff2"],[".woff","font/woff"],[".ttf","font/ttf"],[".otf","font/otf"],[".mp4","video/mp4"],[".webm","video/webm"],[".mp3","audio/mpeg"]];
  for (const [extension, type] of types) if (lower.endsWith(extension)) return type;
  return "application/octet-stream";
}
function validateBindings(env) {
  const missing = [];
  if (!env.DB) missing.push("DB");
  if (!env.STORAGE) missing.push("STORAGE");
  if (missing.length) throw new Error(`Missing Cloudflare binding(s): ${missing.join(", ")}`);
}
function parseJson(value) { if (value == null || value === "") return null; try { return JSON.parse(value); } catch { return value; } }
function now() { return new Date().toISOString(); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error || "Unexpected server error."); }
function json(data, status = 200) { return Response.json(data, { status, headers: CORS }); }
