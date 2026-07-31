const VERSION = "1.6.5";

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

      let match = pathname.match(/^\/api\/migrations\/([^/]+)\/finalise-static$/);
      if (request.method === "POST" && match) {
        return finaliseStatic(decodeURIComponent(match[1]), env);
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

async function finaliseStatic(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const [pagesResult, assetsResult] = await Promise.all([
    env.DB.prepare(`
      SELECT * FROM migration_pages
      WHERE job_id = ? AND status = 'captured' AND html_r2_key IS NOT NULL
      ORDER BY source_url
    `).bind(jobId).all(),
    env.DB.prepare(`
      SELECT * FROM migration_assets
      WHERE job_id = ?
      ORDER BY source_url
    `).bind(jobId).all(),
  ]);

  const pages = pagesResult.results || [];
  const assets = assetsResult.results || [];
  if (!pages.length) return json({ success: false, error: "No captured pages are available." }, 409);

  const downloaded = assets.filter((asset) =>
    asset.status === "downloaded" && asset.output_path && asset.r2_key
  );
  const blocked = assets.filter((asset) => asset.status === "blocked");

  const assetMap = new Map();
  for (const asset of downloaded) {
    assetMap.set(normaliseUrl(asset.source_url), `/${asset.output_path}`);
  }

  const pageMap = new Map();
  for (const page of pages) {
    pageMap.set(normaliseComparableUrl(page.source_url), outputPathToPublicUrl(page.output_path));
  }

  const startedAt = now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='processing', current_stage=?, progress_percent=?, updated_at=?
      WHERE id=?
    `).bind("finalising_static", 97, startedAt, jobId),
    eventStatement(
      env,
      jobId,
      "info",
      "finalising_static",
      "Final static pages are being rebuilt from untouched captured HTML.",
      { pages: pages.length, downloadedAssets: downloaded.length },
      startedAt
    ),
  ]);

  const cssWarnings = [];
  let rewrittenStylesheets = 0;

  for (const asset of downloaded.filter((item) => item.asset_type === "stylesheet")) {
    try {
      const object = await env.STORAGE.get(asset.r2_key);
      if (!object?.body) throw new Error(`Stylesheet missing from R2: ${asset.r2_key}`);

      const result = rewriteCss(await object.text(), asset.source_url, assetMap);
      await env.STORAGE.put(asset.r2_key, result.css, {
        httpMetadata: { contentType: asset.content_type || "text/css; charset=utf-8" },
        customMetadata: {
          jobId,
          assetId: asset.id,
          sourceUrl: asset.source_url,
          rewritten: "true",
          version: VERSION,
        },
      });
      rewrittenStylesheets += 1;
    } catch (error) {
      cssWarnings.push({ assetId: asset.id, sourceUrl: asset.source_url, error: errorMessage(error) });
    }
  }

  const processed = [];
  const warnings = [];

  for (const page of pages) {
    try {
      const captured = await env.STORAGE.get(page.html_r2_key);
      if (!captured?.body) throw new Error(`Captured HTML missing from R2: ${page.html_r2_key}`);

      const rewritten = rewriteHtml(await captured.text(), page.source_url, assetMap, pageMap);
      const frozen = freezeInitialWidgetState(rewritten.html);
      const outputPath = page.output_path || "index.html";
      const key = `${job.output_prefix}/site/${outputPath}`;

      await env.STORAGE.put(key, frozen.html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          finalStatic: "true",
          version: VERSION,
        },
      });

      processed.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        outputPath,
        r2Key: key,
        assetReplacements: rewritten.assetReplacements,
        internalLinkReplacements: rewritten.internalLinkReplacements,
        scriptsRemoved: frozen.scriptsRemoved,
        htmlLength: frozen.html.length,
      });
    } catch (error) {
      warnings.push({ pageId: page.id, sourceUrl: page.source_url, error: errorMessage(error) });
    }
  }

  const completedAt = now();
  const success = warnings.length === 0;
  const stage = success ? "final_static_ready" : "final_static_ready_with_warnings";
  const reportKey = `${job.output_prefix}/site/final-static-report.json`;

  const report = {
    version: VERSION,
    jobId,
    generatedAt: completedAt,
    pages: processed,
    rewrittenStylesheets,
    downloadedAssets: downloaded.length,
    blockedAssets: blocked.length,
    warnings: { pages: warnings, css: cssWarnings },
  };

  await env.STORAGE.put(reportKey, JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId, generatedBy: `static-site-migrator-${VERSION}` },
  });

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='processing', current_stage=?, progress_percent=?,
          warning_count=warning_count+?, updated_at=?
      WHERE id=?
    `).bind(stage, success ? 99 : 98, warnings.length + cssWarnings.length, completedAt, jobId),
    eventStatement(
      env,
      jobId,
      success ? "info" : "warning",
      stage,
      success
        ? "Final layout-preserving static pages were rebuilt from the original captured state."
        : "Final static generation completed with warnings.",
      { pagesProcessed: processed.length, warnings: warnings.length, cssWarnings: cssWarnings.length, reportKey },
      completedAt
    ),
  ]);

  return json({
    success,
    jobId,
    status: "processing",
    currentStage: stage,
    progressPercent: success ? 99 : 98,
    pagesProcessed: processed.length,
    rewrittenStylesheets,
    downloadedAssets: downloaded.length,
    blockedAssets: blocked.length,
    reportKey,
    pages: processed,
    warnings,
    cssWarnings,
  });
}

function rewriteHtml(html, pageUrl, assetMap, pageMap) {
  let output = cleanMalformedQuotedUrls(html);
  let assetReplacements = 0;
  let internalLinkReplacements = 0;

  const orderedAssets = [...assetMap.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [sourceUrl, localPath] of orderedAssets) {
    for (const variant of unique([
      sourceUrl,
      sourceUrl.replace(/&/g, "&amp;"),
      encodeURI(sourceUrl),
    ])) {
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
    } catch {
      return match;
    }
  });

  const removablePatterns = [
    /<script\b[^>]*>[\s\S]*?runtime-service-worker\.js[\s\S]*?<\/script>/gi,
    /<script\b[^>]*src=["'][^"']*sp-2\.0\.0-dm-0\.1\.min\.js[^"']*["'][^>]*><\/script>/gi,
    /<script\b[^>]*id=["']d_track_campaign["'][^>]*>[\s\S]*?<\/script>/gi,
  ];

  for (const pattern of removablePatterns) output = output.replace(pattern, "");

  if (!/<!doctype\s+html/i.test(output)) output = `<!DOCTYPE html>\n${output}`;
  return { html: output, assetReplacements, internalLinkReplacements };
}

function freezeInitialWidgetState(html) {
  let output = removeMigratorPayloads(html);
  let scriptsRemoved = 0;

  output = output.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
    const haystack = `${attrs}\n${body}`.toLowerCase();
    const isData = /(application\/ld\+json|type=["']application\/json)/i.test(attrs);
    const widgetController = /(
      carousel|slideshow|slider|swiper|slick|owlcarousel|flexslider|
      dmwidgetgallery|widgetgallery|gallerywidget|rotator|slideinterval|
      activeindex|nextslide|prevslide
    )/ix.test(haystack.replace(/\s+/g, " "));

    if (widgetController && !isData) {
      scriptsRemoved += 1;
      return "";
    }
    return full;
  });

  const style = `
<style id="static-migrator-final-v165">
/* Preserve captured layout and the slide that was visible at capture time. */
[data-anim-desktop], [data-animation], .dmAnimation,
.skrollable, .skrollable-before, .skrollable-after,
.wow, .animated {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  animation: none !important;
  transition: none !important;
}
[class*="hero" i], [class*="banner" i],
[class*="carousel" i], [class*="slider" i], [class*="slideshow" i] {
  visibility: visible !important;
}
[class*="carousel" i] .active,
[class*="carousel" i] .current,
[class*="slider" i] .active,
[class*="slider" i] .current,
[class*="slideshow" i] .active,
[class*="slideshow" i] .current,
[class*="hero" i] [aria-hidden="false"],
[class*="banner" i] [aria-hidden="false"] {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  z-index: 2 !important;
}
</style>`;

  if (!output.includes("static-migrator-final-v165")) {
    output = /<\/head>/i.test(output)
      ? output.replace(/<\/head>/i, `${style}\n</head>`)
      : `${style}\n${output}`;
  }

  return { html: output, scriptsRemoved };
}

function removeMigratorPayloads(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-[^"']+["'][^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*id=["']static-migrator-[^"']+["'][^>]*>[\s\S]*?<\/script>/gi, "");
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
    } catch {
      return match;
    }
  });
  return { css: output, replacements };
}

async function servePreview(jobId, requestedPath, env) {
  const job = await getJob(jobId, env);
  if (!job) return new Response("Preview job not found.", { status: 404 });

  let path;
  try {
    path = decodeURIComponent(requestedPath || "/");
  } catch {
    return new Response("Invalid preview path.", { status: 400 });
  }

  path = path.replace(/^\/+/, "");
  if (!path) path = "index.html";
  if (path.endsWith("/")) path += "index.html";
  if (path.includes("..") || path.includes("\\")) {
    return new Response("Invalid preview path.", { status: 400 });
  }

  const candidates = [path];
  if (!hasFileExtension(path)) candidates.push(`${path}/index.html`);

  let object = null;
  let resolved = null;
  for (const candidate of candidates) {
    object = await env.STORAGE.get(`${job.output_prefix}/site/${candidate}`);
    if (object?.body) {
      resolved = candidate;
      break;
    }
  }

  if (!object?.body || !resolved) return new Response("Preview file not found.", { status: 404 });

  const type = object.httpMetadata?.contentType || guessContentType(resolved);
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
  });
  const prefix = `/preview/${encodeURIComponent(jobId)}`;

  if (/text\/html/i.test(type)) {
    return new Response(prefixPreviewHtmlUrls(await object.text(), prefix), { status: 200, headers });
  }
  if (/text\/css/i.test(type)) {
    return new Response(prefixPreviewCssUrls(await object.text(), prefix), { status: 200, headers });
  }
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
  return value.replace(
    /url\(\s*(["']?)\/(?!\/|preview\/)(.*?)\1\s*\)/gi,
    (_, quote, path) => `url(${quote}${prefix}/${path}${quote})`
  );
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

function normaliseUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function normaliseComparableUrl(value) {
  const url = new URL(value);
  url.hash = "";
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id", "gclid", "fbclid"]) {
    url.searchParams.delete(key);
  }
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

function replaceAllCount(input, search, replacement) {
  if (!search || !input.includes(search)) return { text: input, count: 0 };
  const parts = input.split(search);
  return { text: parts.join(replacement), count: parts.length - 1 };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
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

function hasFileExtension(path) {
  return /\.[a-zA-Z0-9]{1,10}$/.test(path.split("?")[0]);
}

function guessContentType(path) {
  const lower = path.toLowerCase();
  const types = [
    [".html", "text/html; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".js", "application/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".webp", "image/webp"],
    [".svg", "image/svg+xml"],
    [".ico", "image/x-icon"],
    [".woff2", "font/woff2"],
    [".woff", "font/woff"],
    [".ttf", "font/ttf"],
    [".otf", "font/otf"],
  ];
  for (const [extension, type] of types) if (lower.endsWith(extension)) return type;
  return "application/octet-stream";
}

function validateBindings(env) {
  const missing = [];
  if (!env.DB) missing.push("DB");
  if (!env.STORAGE) missing.push("STORAGE");
  if (missing.length) throw new Error(`Missing Cloudflare binding(s): ${missing.join(", ")}`);
}

function now() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unexpected server error.");
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}
