const VERSION = "1.4.0";

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
        return json({
          success: true,
          service: "Static Site Migrator Engine",
          version: VERSION,
          status: "online",
        });
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

async function getMigration(jobId, env) {
  const job = await env.DB
    .prepare("SELECT * FROM migration_jobs WHERE id = ?")
    .bind(jobId)
    .first();

  if (!job) {
    return json({ success: false, error: "Migration job not found." }, 404);
  }

  const [pagesResult, assetsResult, eventsResult] = await Promise.all([
    env.DB
      .prepare("SELECT * FROM migration_pages WHERE job_id = ? ORDER BY source_url")
      .bind(jobId)
      .all(),
    env.DB
      .prepare("SELECT * FROM migration_assets WHERE job_id = ? ORDER BY asset_type, source_url")
      .bind(jobId)
      .all(),
    env.DB
      .prepare("SELECT * FROM migration_events WHERE job_id = ? ORDER BY created_at, id")
      .bind(jobId)
      .all(),
  ]);

  return json({
    success: true,
    job,
    pages: pagesResult.results || [],
    assets: assetsResult.results || [],
    events: (eventsResult.results || []).map((event) => ({
      ...event,
      details: parseJson(event.details_json),
      details_json: undefined,
    })),
  });
}

async function rewritePages(jobId, env) {
  const job = await env.DB
    .prepare("SELECT * FROM migration_jobs WHERE id = ?")
    .bind(jobId)
    .first();

  if (!job) {
    return json({ success: false, error: "Migration job not found." }, 404);
  }

  const [pagesResult, assetsResult] = await Promise.all([
    env.DB
      .prepare(`
        SELECT *
        FROM migration_pages
        WHERE job_id = ?
          AND status = 'captured'
          AND html_r2_key IS NOT NULL
        ORDER BY source_url
      `)
      .bind(jobId)
      .all(),
    env.DB
      .prepare(`
        SELECT *
        FROM migration_assets
        WHERE job_id = ?
        ORDER BY source_url
      `)
      .bind(jobId)
      .all(),
  ]);

  const pages = pagesResult.results || [];
  const assets = assetsResult.results || [];

  if (!pages.length) {
    return json({ success: false, error: "No captured pages are available." }, 409);
  }

  const downloadedAssets = assets.filter(
    (asset) => asset.status === "downloaded" && asset.output_path && asset.r2_key
  );
  const blockedAssets = assets.filter((asset) => asset.status === "blocked");

  const assetMap = new Map();
  for (const asset of downloadedAssets) {
    assetMap.set(normaliseUrl(asset.source_url), `/${asset.output_path}`);
  }

  const pageMap = new Map();
  for (const page of pages) {
    pageMap.set(normaliseComparableUrl(page.source_url), outputPathToPublicUrl(page.output_path));
  }

  const startedAt = now();

  await env.DB.batch([
    env.DB
      .prepare(`
        UPDATE migration_jobs
        SET status = ?, current_stage = ?, progress_percent = ?, updated_at = ?
        WHERE id = ?
      `)
      .bind("processing", "rewriting_pages", 75, startedAt, jobId),
    eventStatement(
      env,
      jobId,
      "info",
      "rewriting_pages",
      "Static HTML and CSS rewriting started.",
      {
        capturedPages: pages.length,
        downloadedAssets: downloadedAssets.length,
        blockedAssets: blockedAssets.length,
      },
      startedAt
    ),
  ]);

  const rewrittenCss = [];
  const cssWarnings = [];

  for (const asset of downloadedAssets.filter((item) => item.asset_type === "stylesheet")) {
    try {
      const object = await env.STORAGE.get(asset.r2_key);
      if (!object || !object.body) {
        throw new Error(`Stylesheet missing from R2: ${asset.r2_key}`);
      }

      const originalCss = await object.text();
      const rewritten = rewriteCss(originalCss, asset.source_url, assetMap);

      await env.STORAGE.put(asset.r2_key, rewritten.css, {
        httpMetadata: {
          contentType: asset.content_type || "text/css; charset=utf-8",
        },
        customMetadata: {
          jobId,
          assetId: asset.id,
          sourceUrl: asset.source_url,
          rewritten: "true",
        },
      });

      rewrittenCss.push({
        assetId: asset.id,
        outputPath: asset.output_path,
        replacements: rewritten.replacements,
      });
    } catch (error) {
      cssWarnings.push({
        assetId: asset.id,
        sourceUrl: asset.source_url,
        error: errorMessage(error),
      });
    }
  }

  const rewrittenPages = [];
  const pageWarnings = [];

  for (const page of pages) {
    try {
      const capturedObject = await env.STORAGE.get(page.html_r2_key);
      if (!capturedObject || !capturedObject.body) {
        throw new Error(`Captured HTML missing from R2: ${page.html_r2_key}`);
      }

      const originalHtml = await capturedObject.text();
      const result = rewriteHtml(
        originalHtml,
        page.source_url,
        assetMap,
        pageMap
      );

      const finalKey = `${job.output_prefix}/site/${page.output_path || "index.html"}`;

      await env.STORAGE.put(finalKey, result.html, {
        httpMetadata: {
          contentType: "text/html; charset=utf-8",
        },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          rewritten: "true",
        },
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
      pageWarnings.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        error: errorMessage(error),
      });
    }
  }

  const manifest = {
    version: VERSION,
    jobId,
    sourceUrl: job.source_url,
    generatedAt: now(),
    pages: rewrittenPages,
    assets: downloadedAssets.map((asset) => ({
      sourceUrl: asset.source_url,
      outputPath: asset.output_path,
      assetType: asset.asset_type,
      contentType: asset.content_type,
      byteSize: asset.byte_size,
      r2Key: asset.r2_key,
    })),
    blockedAssets: blockedAssets.map((asset) => ({
      sourceUrl: asset.source_url,
      assetType: asset.asset_type,
      reason: asset.error_message,
    })),
    warnings: {
      css: cssWarnings,
      pages: pageWarnings,
    },
  };

  const manifestKey = `${job.output_prefix}/site/migration-manifest.json`;
  await env.STORAGE.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
    },
    customMetadata: {
      jobId,
      generatedBy: `static-site-migrator-${VERSION}`,
    },
  });

  const completedSuccessfully = pageWarnings.length === 0;
  const warningCount = blockedAssets.length + cssWarnings.length + pageWarnings.length;
  const completedAt = now();
  const stage = completedSuccessfully
    ? "pages_rewritten"
    : "pages_rewritten_with_warnings";

  await env.DB.batch([
    env.DB
      .prepare(`
        UPDATE migration_jobs
        SET status = ?, current_stage = ?, progress_percent = ?,
            warning_count = warning_count + ?, updated_at = ?
        WHERE id = ?
      `)
      .bind(
        "processing",
        stage,
        completedSuccessfully ? 82 : 80,
        cssWarnings.length + pageWarnings.length,
        completedAt,
        jobId
      ),
    eventStatement(
      env,
      jobId,
      completedSuccessfully ? "info" : "warning",
      stage,
      completedSuccessfully
        ? "Captured pages and stylesheets were rewritten into the final static-site structure."
        : "Static-site rewriting completed with warnings.",
      {
        rewrittenPages: rewrittenPages.length,
        rewrittenStylesheets: rewrittenCss.length,
        blockedAssets: blockedAssets.length,
        cssWarnings: cssWarnings.length,
        pageWarnings: pageWarnings.length,
        manifestKey,
      },
      completedAt
    ),
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
  let assetReplacements = 0;
  let internalLinkReplacements = 0;
  let removedRuntimeBlocks = 0;

  const orderedAssets = [...assetMap.entries()].sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [sourceUrl, localPath] of orderedAssets) {
    const variants = unique([
      sourceUrl,
      sourceUrl.replace(/&/g, "&amp;"),
      encodeURI(sourceUrl),
    ]);

    for (const variant of variants) {
      const result = replaceAllCount(output, variant, localPath);
      output = result.text;
      assetReplacements += result.count;
    }
  }

  output = output.replace(
    /\b(href)\s*=\s*(["'])(.*?)\2/gi,
    (match, attribute, quote, value) => {
      try {
        const url = new URL(decodeHtml(value), pageUrl);
        url.hash = "";
        const local = pageMap.get(normaliseComparableUrl(url.href));
        if (!local) return match;
        internalLinkReplacements += 1;
        return `${attribute}=${quote}${local}${quote}`;
      } catch {
        return match;
      }
    }
  );

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

  if (!/<!doctype\s+html/i.test(output)) {
    output = `<!DOCTYPE html>\n${output}`;
  }

  return {
    html: output,
    assetReplacements,
    internalLinkReplacements,
    removedRuntimeBlocks,
  };
}

function rewriteCss(css, stylesheetUrl, assetMap) {
  let replacements = 0;

  const output = css.replace(
    /url\(\s*(["']?)(.*?)\1\s*\)/gi,
    (match, quote, value) => {
      const cleaned = decodeHtml(String(value || "").trim());
      if (!cleaned || /^(data:|blob:|#)/i.test(cleaned)) return match;

      try {
        const absolute = normaliseUrl(new URL(cleaned, stylesheetUrl).href);
        const local = assetMap.get(absolute);
        if (!local) return match;
        replacements += 1;
        return `url("${local}")`;
      } catch {
        return match;
      }
    }
  );

  return { css: output, replacements };
}

function cleanMalformedQuotedUrls(value) {
  return value
    .replace(/https:\/\/[^\s"'<>]+\/%22(https%3A%2F%2F[^"'<>]+)%22/gi, (_, encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    })
    .replace(/https:\/\/[^\s"'<>]+\/%22(https:\/\/[^"'<>]+)%22/gi, "$1");
}

function outputPathToPublicUrl(outputPath) {
  if (!outputPath || outputPath === "index.html") return "/";
  return `/${outputPath.replace(/\/index\.html$/i, "").replace(/^\/+/, "")}/`;
}

function normaliseUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function normaliseComparableUrl(value) {
  const url = new URL(value);
  url.hash = "";

  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "gclid",
    "fbclid",
  ]) {
    url.searchParams.delete(key);
  }

  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  return url.href;
}

function replaceAllCount(input, search, replacement) {
  if (!search || !input.includes(search)) {
    return { text: input, count: 0 };
  }

  const parts = input.split(search);
  return {
    text: parts.join(replacement),
    count: parts.length - 1,
  };
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

function eventStatement(env, jobId, level, stage, message, details, createdAt) {
  return env.DB
    .prepare(`
      INSERT INTO migration_events (
        job_id, level, stage, message, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(
      jobId,
      level,
      stage,
      message,
      details == null ? null : JSON.stringify(details),
      createdAt
    );
}

function validateBindings(env) {
  const missing = [];
  if (!env.DB) missing.push("DB");
  if (!env.STORAGE) missing.push("STORAGE");

  if (missing.length) {
    throw new Error(`Missing Cloudflare binding(s): ${missing.join(", ")}`);
  }
}

function parseJson(value) {
  if (value == null || value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function now() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error || "Unexpected server error.");
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}
