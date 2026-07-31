const VERSION = "1.6.2";

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

      let match = pathname.match(/^\/api\/migrations\/([^/]+)\/restore-overlays$/);
      if (request.method === "POST" && match) {
        return await restoreOverlays(decodeURIComponent(match[1]), env);
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

async function restoreOverlays(jobId, env) {
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
    return json({ success: false, error: "No generated pages are available." }, 409);
  }

  const startedAt = now();
  await env.DB.batch([
    env.DB
      .prepare(`
        UPDATE migration_jobs
        SET status = 'processing', current_stage = ?, progress_percent = ?, updated_at = ?
        WHERE id = ?
      `)
      .bind("restoring_overlays", 94, startedAt, jobId),
    eventStatement(
      env,
      jobId,
      "info",
      "restoring_overlays",
      "Targeted hero and carousel overlay restoration started.",
      { pages: pages.length },
      startedAt
    ),
  ]);

  const restored = [];
  const warnings = [];

  for (const page of pages) {
    const outputPath = page.output_path || "index.html";
    const key = `${job.output_prefix}/site/${outputPath}`;

    try {
      const object = await env.STORAGE.get(key);
      if (!object?.body) {
        throw new Error(`Generated page is missing from R2: ${key}`);
      }

      const originalHtml = await object.text();
      const result = injectOverlayRestorer(originalHtml);

      await env.STORAGE.put(key, result.html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          overlayRestoration: "true",
          overlayRestorerVersion: VERSION,
        },
      });

      restored.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        outputPath,
        r2Key: key,
        overlayRestorerInjected: result.injected,
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

  const completedAt = now();
  const success = warnings.length === 0;
  const reportKey = `${job.output_prefix}/site/overlay-restoration-report.json`;
  const report = {
    version: VERSION,
    jobId,
    generatedAt: completedAt,
    pages: restored,
    warnings,
  };

  await env.STORAGE.put(reportKey, JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId, generatedBy: `static-site-migrator-${VERSION}` },
  });

  await env.DB.batch([
    env.DB
      .prepare(`
        UPDATE migration_jobs
        SET status = 'processing', current_stage = ?, progress_percent = ?,
            warning_count = warning_count + ?, updated_at = ?
        WHERE id = ?
      `)
      .bind(
        success ? "overlays_restored" : "overlays_restored_with_warnings",
        success ? 96 : 95,
        warnings.length,
        completedAt,
        jobId
      ),
    eventStatement(
      env,
      jobId,
      success ? "info" : "warning",
      success ? "overlays_restored" : "overlays_restored_with_warnings",
      success
        ? "Hero and carousel overlay visibility was restored without changing page structure."
        : "Overlay restoration completed with warnings.",
      { pagesRestored: restored.length, warnings: warnings.length, reportKey },
      completedAt
    ),
  ]);

  return json({
    success,
    jobId,
    status: "processing",
    currentStage: success ? "overlays_restored" : "overlays_restored_with_warnings",
    progressPercent: success ? 96 : 95,
    pagesProcessed: restored.length,
    reportKey,
    pages: restored,
    warnings,
  });
}

function injectOverlayRestorer(html) {
  const marker = "static-migrator-overlay-v162";
  if (html.includes(marker)) {
    return { html, injected: false };
  }

  const payload = `
<style id="${marker}">
/* Overlay-only recovery. No row, column, flex, grid, width or document-order changes. */
html.static-migrator-overlays-ready [data-static-migrator-overlay="true"] {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
  animation: none !important;
  transition: none !important;
  z-index: 20 !important;
}
html.static-migrator-overlays-ready [data-static-migrator-overlay-container="true"] {
  isolation: isolate;
}
html.static-migrator-overlays-ready [data-static-migrator-active-slide="true"] {
  opacity: 1 !important;
  visibility: visible !important;
  transform: none !important;
}
</style>
<script id="${marker}-script">
(function () {
  var containerSelector = [
    '[class*="hero" i]',
    '[class*="banner" i]',
    '[class*="carousel" i]',
    '[class*="slider" i]',
    '[class*="slideshow" i]',
    '[data-widget-type*="slider" i]',
    '[data-widget-type*="gallery" i]',
    '[data-element-type*="slider" i]',
    '[data-element-type*="gallery" i]'
  ].join(',');

  var overlaySelector = [
    'h1','h2','h3','h4','h5','h6','p','a','button',
    '.dmButton','.dmNewParagraph','.text','.title','.subtitle','.caption','.overlay',
    '[class*="caption" i]','[class*="overlay" i]','[class*="title" i]',
    '[class*="content" i]','[class*="text" i]','[class*="button" i]'
  ].join(',');

  function hasImage(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.matches('img[src], source[srcset], [style*="background-image"], [data-image-url], [data-src]')) return true;
    return !!el.querySelector('img[src], source[srcset], [style*="background-image"], [data-image-url], [data-src]');
  }

  function chooseActiveSlide(container) {
    var candidates = Array.from(container.querySelectorAll(
      '[class*="slide" i], [class*="item" i], [role="tabpanel"], li'
    )).filter(hasImage);

    if (!candidates.length) return null;

    return candidates.find(function (el) {
      return el.classList.contains('active') ||
        el.classList.contains('current') ||
        el.getAttribute('aria-hidden') === 'false' ||
        el.getAttribute('aria-current') === 'true' ||
        el.getAttribute('data-active') === 'true';
    }) || candidates[0];
  }

  function restoreElement(el) {
    if (!el || el.nodeType !== 1) return;
    el.setAttribute('data-static-migrator-overlay', 'true');
    el.style.setProperty('opacity', '1', 'important');
    el.style.setProperty('visibility', 'visible', 'important');
    el.style.setProperty('transform', 'none', 'important');
    el.style.setProperty('animation', 'none', 'important');
    el.style.setProperty('transition', 'none', 'important');
    el.style.setProperty('z-index', '20', 'important');

    var computed = window.getComputedStyle(el);
    if (computed.display === 'none') {
      var tag = el.tagName.toLowerCase();
      el.style.setProperty('display', tag === 'a' || tag === 'button' ? 'inline-block' : 'block', 'important');
    }
  }

  function run() {
    document.documentElement.classList.add('static-migrator-overlays-ready');

    document.querySelectorAll(containerSelector).forEach(function (container) {
      container.setAttribute('data-static-migrator-overlay-container', 'true');
      var activeSlide = chooseActiveSlide(container);
      if (activeSlide) {
        activeSlide.setAttribute('data-static-migrator-active-slide', 'true');
        activeSlide.style.setProperty('opacity', '1', 'important');
        activeSlide.style.setProperty('visibility', 'visible', 'important');
        activeSlide.style.setProperty('transform', 'none', 'important');
      }

      var scope = activeSlide || container;
      scope.querySelectorAll(overlaySelector).forEach(restoreElement);

      /* Hero headings or buttons are often siblings of the slide track. */
      Array.from(container.children).forEach(function (child) {
        if (child.matches && child.matches(overlaySelector) && !hasImage(child)) {
          restoreElement(child);
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
  window.addEventListener('load', run, { once: true });
  setTimeout(run, 300);
  setTimeout(run, 1000);
  setTimeout(run, 2200);
})();
</script>`;

  if (/<\/body>/i.test(html)) {
    return { html: html.replace(/<\/body>/i, `${payload}\n</body>`), injected: true };
  }
  return { html: `${html}\n${payload}`, injected: true };
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
  if (!hasFileExtension(relativePath)) candidates.push(`${relativePath}/index.html`);

  let object = null;
  let resolvedPath = null;
  for (const candidate of candidates) {
    object = await env.STORAGE.get(`${job.output_prefix}/site/${candidate}`);
    if (object?.body) {
      resolvedPath = candidate;
      break;
    }
  }

  if (!object?.body || !resolvedPath) {
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

  output = output.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (match, quote, value) => {
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
  });

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
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);
  return json({ success: true, job });
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
