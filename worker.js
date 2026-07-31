const VERSION = "1.6.0";

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

      const previewMatch = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (request.method === "GET" && previewMatch) {
        return await servePreview(
          decodeURIComponent(previewMatch[1]),
          previewMatch[2] || "/",
          env
        );
      }

      let match = pathname.match(
        /^\/api\/migrations\/([^/]+)\/stabilise-static$/
      );
      if (request.method === "POST" && match) {
        return await stabiliseStaticSite(decodeURIComponent(match[1]), env);
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

async function stabiliseStaticSite(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) {
    return json({ success: false, error: "Migration job not found." }, 404);
  }

  const pagesResult = await env.DB
    .prepare(`
      SELECT id, source_url, output_path
      FROM migration_pages
      WHERE job_id = ? AND status = 'captured'
      ORDER BY source_url
    `)
    .bind(jobId)
    .all();

  const pages = pagesResult.results || [];
  if (!pages.length) {
    return json({ success: false, error: "No captured pages are available." }, 409);
  }

  const startedAt = now();
  await env.DB.batch([
    env.DB
      .prepare(`
        UPDATE migration_jobs
        SET status = ?, current_stage = ?, progress_percent = ?, updated_at = ?
        WHERE id = ?
      `)
      .bind("processing", "stabilising_static_site", 86, startedAt, jobId),
    eventStatement(
      env,
      jobId,
      "info",
      "stabilising_static_site",
      "Static animation and widget stabilisation started.",
      { pages: pages.length },
      startedAt
    ),
  ]);

  const results = [];
  const warnings = [];
  let totalAnimatedElements = 0;
  let totalCarouselWidgets = 0;
  let totalSlidesRecovered = 0;

  for (const page of pages) {
    const outputPath = page.output_path || "index.html";
    const key = `${job.output_prefix}/site/${outputPath}`;

    try {
      const object = await env.STORAGE.get(key);
      if (!object || !object.body) {
        throw new Error(`Generated page is missing from R2: ${key}`);
      }

      const originalHtml = await object.text();
      const result = stabiliseHtml(originalHtml);

      await env.STORAGE.put(key, result.html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          stabilised: "true",
          stabiliserVersion: VERSION,
        },
      });

      totalAnimatedElements += result.animatedElements;
      totalCarouselWidgets += result.carouselWidgets;
      totalSlidesRecovered += result.slidesRecovered;

      results.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        outputPath,
        r2Key: key,
        animatedElementsStabilised: result.animatedElements,
        carouselWidgetsStabilised: result.carouselWidgets,
        slidesRecovered: result.slidesRecovered,
        injectedFallbackStyles: result.injectedFallbackStyles,
        htmlLength: result.html.length,
      });
    } catch (error) {
      warnings.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        error: errorMessage(error),
      });
    }
  }

  const report = {
    version: VERSION,
    jobId,
    generatedAt: now(),
    pagesExpected: pages.length,
    pagesStabilised: results.length,
    animationsFlattened: totalAnimatedElements,
    carouselWidgetsStabilised: totalCarouselWidgets,
    slidesRecovered: totalSlidesRecovered,
    warnings,
    deploymentReady: warnings.length === 0,
  };

  const reportKey = `${job.output_prefix}/site/migration-quality-report.json`;
  await env.STORAGE.put(reportKey, JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId, generatedBy: `static-site-migrator-${VERSION}` },
  });

  const completedAt = now();
  const stage = warnings.length
    ? "static_stabilised_with_warnings"
    : "static_stabilised";
  const progress = warnings.length ? 88 : 90;

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
        progress,
        warnings.length,
        completedAt,
        jobId
      ),
    eventStatement(
      env,
      jobId,
      warnings.length ? "warning" : "info",
      stage,
      warnings.length
        ? "Static stabilisation completed with warnings."
        : "Static animations and carousel widgets were stabilised.",
      {
        pagesStabilised: results.length,
        animationsFlattened: totalAnimatedElements,
        carouselWidgetsStabilised: totalCarouselWidgets,
        slidesRecovered: totalSlidesRecovered,
        reportKey,
      },
      completedAt
    ),
  ]);

  return json({
    success: warnings.length === 0,
    jobId,
    status: "processing",
    currentStage: stage,
    progressPercent: progress,
    pagesStabilised: results.length,
    animationsFlattened: totalAnimatedElements,
    carouselWidgetsStabilised: totalCarouselWidgets,
    slidesRecovered: totalSlidesRecovered,
    reportKey,
    pages: results,
    warnings,
  });
}

function stabiliseHtml(html) {
  let output = html;
  let animatedElements = 0;
  let carouselWidgets = 0;
  let slidesRecovered = 0;
  let injectedFallbackStyles = false;

  output = output.replace(
    /style\s*=\s*(["'])(.*?)\1/gi,
    (match, quote, styleText) => {
      const result = stabiliseInlineStyle(styleText);
      if (!result.changed) return match;
      animatedElements += 1;
      return `style=${quote}${result.style}${quote}`;
    }
  );

  output = output.replace(
    /class\s*=\s*(["'])(.*?)\1/gi,
    (match, quote, classes) => {
      const cleaned = classes
        .split(/\s+/)
        .filter(Boolean)
        .filter(
          (name) =>
            !/^(?:wow|animated|skrollable|skrollr-before|skrollr-after|dm-animation-|invisible|opacity-0)$/i.test(
              name
            )
        )
        .join(" ");
      return `class=${quote}${cleaned}${quote}`;
    }
  );

  const carouselClassPattern =
    /<(div|section)\b([^>]*class=["'][^"']*(?:dmWidgetCarousel|dmImageSlider|gallery|carousel|slider|slick-slider|swiper-container)[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;

  output = output.replace(
    carouselClassPattern,
    (whole, tagName, attributes, inner) => {
      const imageMatches = [
        ...inner.matchAll(
          /<img\b[^>]*(?:src|data-src)\s*=\s*(["'])(.*?)\1[^>]*>/gi
        ),
      ];

      const uniqueImages = [];
      const seen = new Set();
      for (const imageMatch of imageMatches) {
        const src = imageMatch[2];
        if (!src || seen.has(src)) continue;
        seen.add(src);
        uniqueImages.push(imageMatch[0]);
      }

      if (!uniqueImages.length) return whole;

      carouselWidgets += 1;
      slidesRecovered += uniqueImages.length;

      const slides = uniqueImages
        .map(
          (image, index) =>
            `<div class="ssm-static-slide" data-static-slide="${index + 1}">${forceVisibleImage(image)}</div>`
        )
        .join("");

      return `<${tagName}${attributes} data-ssm-static-carousel="true"><div class="ssm-static-carousel">${slides}</div></${tagName}>`;
    }
  );

  const fallbackCss = `
<style id="ssm-static-stabilisation">
html body [style*="opacity: 0"],
html body [style*="opacity:0"] {
  opacity: 1 !important;
}
html body [style*="translate"],
html body .skrollable,
html body .skrollr-before,
html body .skrollr-after,
html body [class*="dm-animation-"] {
  opacity: 1 !important;
  transform: none !important;
  translate: none !important;
  animation: none !important;
  transition: none !important;
  visibility: visible !important;
}
html body [data-ssm-static-carousel="true"] {
  overflow: visible !important;
  height: auto !important;
  min-height: 1px !important;
  opacity: 1 !important;
  visibility: visible !important;
}
html body .ssm-static-carousel {
  display: grid !important;
  grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
  gap: 16px;
  width: 100%;
  height: auto !important;
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
}
html body .ssm-static-slide {
  display: block !important;
  position: relative !important;
  inset: auto !important;
  width: 100% !important;
  height: auto !important;
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
}
html body .ssm-static-slide img {
  display: block !important;
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
}
</style>`;

  if (!output.includes('id="ssm-static-stabilisation"')) {
    if (/<\/head>/i.test(output)) {
      output = output.replace(/<\/head>/i, `${fallbackCss}\n</head>`);
    } else {
      output = `${fallbackCss}\n${output}`;
    }
    injectedFallbackStyles = true;
  }

  return {
    html: output,
    animatedElements,
    carouselWidgets,
    slidesRecovered,
    injectedFallbackStyles,
  };
}

function stabiliseInlineStyle(styleText) {
  const declarations = styleText
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);

  let changed = false;
  const retained = [];

  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator < 0) {
      retained.push(declaration);
      continue;
    }

    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();

    if (property === "opacity" && /^0(?:\.0+)?(?:\s*!important)?$/i.test(value)) {
      retained.push("opacity: 1 !important");
      changed = true;
      continue;
    }

    if (
      ["transform", "translate", "animation", "animation-name"].includes(property) &&
      /(translate|matrix|scale|rotate|slide|fade|skroll|animation)/i.test(value)
    ) {
      retained.push(
        property === "animation" || property === "animation-name"
          ? `${property}: none !important`
          : `${property}: none !important`
      );
      changed = true;
      continue;
    }

    if (property === "visibility" && /hidden/i.test(value)) {
      retained.push("visibility: visible !important");
      changed = true;
      continue;
    }

    retained.push(`${property}: ${value}`);
  }

  return { style: retained.join("; "), changed };
}

function forceVisibleImage(imageHtml) {
  let output = imageHtml;

  if (/\bstyle\s*=\s*(["'])/i.test(output)) {
    output = output.replace(
      /\bstyle\s*=\s*(["'])(.*?)\1/i,
      (_, quote, style) =>
        `style=${quote}${style}; opacity:1 !important; visibility:visible !important; transform:none !important; display:block !important;${quote}`
    );
  } else {
    output = output.replace(
      /<img\b/i,
      '<img style="opacity:1 !important; visibility:visible !important; transform:none !important; display:block !important;"'
    );
  }

  return output;
}

async function servePreview(jobId, requestedPath, env) {
  const job = await getJob(jobId, env);
  if (!job) return new Response("Preview job not found.", { status: 404 });

  let relativePath;
  try {
    relativePath = decodeURIComponent(requestedPath || "/");
  } catch {
    return new Response("Invalid preview path.", { status: 400 });
  }

  relativePath = relativePath.replace(/^\/+/, "");
  if (!relativePath) relativePath = "index.html";
  if (relativePath.endsWith("/")) relativePath += "index.html";

  if (relativePath.includes("..") || relativePath.includes("\\")) {
    return new Response("Invalid preview path.", { status: 400 });
  }

  const candidates = [relativePath];
  if (!hasFileExtension(relativePath)) {
    candidates.push(`${relativePath}/index.html`);
  }

  let object = null;
  let resolvedPath = null;

  for (const candidate of candidates) {
    object = await env.STORAGE.get(`${job.output_prefix}/site/${candidate}`);
    if (object && object.body) {
      resolvedPath = candidate;
      break;
    }
  }

  if (!object || !object.body || !resolvedPath) {
    return new Response("Preview file not found.", { status: 404 });
  }

  const contentType = object.httpMetadata?.contentType || guessContentType(resolvedPath);
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
  });

  const prefix = `/preview/${encodeURIComponent(jobId)}`;

  if (/text\/html/i.test(contentType)) {
    return new Response(prefixPreviewHtmlUrls(await object.text(), prefix), {
      status: 200,
      headers,
    });
  }

  if (/text\/css/i.test(contentType)) {
    return new Response(prefixPreviewCssUrls(await object.text(), prefix), {
      status: 200,
      headers,
    });
  }

  return new Response(object.body, { status: 200, headers });
}

function prefixPreviewHtmlUrls(html, prefix) {
  let output = html.replace(
    /\b(href|src|poster|data-src|data-image-url)\s*=\s*(["'])\/(?!\/|preview\/)(.*?)\2/gi,
    (_, attribute, quote, value) => `${attribute}=${quote}${prefix}/${value}${quote}`
  );

  output = output.replace(
    /\bsrcset\s*=\s*(["'])(.*?)\1/gi,
    (match, quote, value) => {
      const rewritten = value
        .split(",")
        .map((candidate) => {
          const parts = candidate.trim().split(/\s+/);
          if (
            parts[0]?.startsWith("/") &&
            !parts[0].startsWith("//") &&
            !parts[0].startsWith("/preview/")
          ) {
            parts[0] = `${prefix}${parts[0]}`;
          }
          return parts.join(" ");
        })
        .join(", ");
      return `srcset=${quote}${rewritten}${quote}`;
    }
  );

  return prefixPreviewCssUrls(output, prefix);
}

function prefixPreviewCssUrls(value, prefix) {
  return value.replace(
    /url\(\s*(["']?)\/(?!\/|preview\/)(.*?)\1\s*\)/gi,
    (_, quote, path) => `url(${quote}${prefix}/${path}${quote})`
  );
}

async function getMigration(jobId, env) {
  const job = await getJob(jobId, env);
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

async function getJob(jobId, env) {
  return env.DB
    .prepare("SELECT * FROM migration_jobs WHERE id = ?")
    .bind(jobId)
    .first();
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
    [".mp4", "video/mp4"],
    [".webm", "video/webm"],
    [".mp3", "audio/mpeg"],
  ];

  for (const [extension, type] of types) {
    if (lower.endsWith(extension)) return type;
  }

  return "application/octet-stream";
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
