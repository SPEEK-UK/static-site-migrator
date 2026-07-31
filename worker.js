const VERSION = "1.1.0";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/138.0.0.0 Safari/537.36";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

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

      if (request.method === "POST" && pathname === "/api/migrations") {
        return await createMigration(request, env);
      }

      const processMatch = pathname.match(/^\/api\/migrations\/([^/]+)\/process$/);
      if (request.method === "POST" && processMatch) {
        return await processMigration(decodeURIComponent(processMatch[1]), env);
      }

      const captureMatch = pathname.match(/^\/api\/migrations\/([^/]+)\/capture-pages$/);
      if (request.method === "POST" && captureMatch) {
        return await capturePages(decodeURIComponent(captureMatch[1]), env);
      }

      const jobMatch = pathname.match(/^\/api\/migrations\/([^/]+)$/);
      if (request.method === "GET" && jobMatch) {
        return await getMigration(decodeURIComponent(jobMatch[1]), env);
      }

      return json({ success: false, error: "Route not found." }, 404);
    } catch (error) {
      console.error(error);
      return json({ success: false, error: errorMessage(error) }, 500);
    }
  },
};

async function createMigration(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "The request body must be valid JSON." }, 400);
  }

  const sourceUrl = normaliseSourceUrl(body?.sourceUrl);
  if (!sourceUrl) {
    return json({ success: false, error: "Provide a valid sourceUrl using HTTP or HTTPS." }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const outputPrefix = `migrations/${id}`;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO migration_jobs (
        id, source_url, source_hostname, status, current_stage,
        progress_percent, discovered_pages, captured_pages,
        downloaded_assets, warning_count, error_count,
        output_prefix, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, sourceUrl.href, sourceUrl.hostname, "queued", "created",
      0, 0, 0, 0, 0, 0, outputPrefix, now, now
    ),
    eventStatement(env, id, "info", "created", "Migration job created.", { sourceUrl: sourceUrl.href }, now),
  ]);

  return json({
    success: true,
    job: {
      id,
      sourceUrl: sourceUrl.href,
      status: "queued",
      currentStage: "created",
      progressPercent: 0,
      createdAt: now,
    },
  }, 201);
}

async function getMigration(id, env) {
  const job = await getJob(id, env);
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const [pages, events] = await Promise.all([
    env.DB.prepare(`SELECT * FROM migration_pages WHERE job_id = ? ORDER BY source_url`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM migration_events WHERE job_id = ? ORDER BY created_at, id`).bind(id).all(),
  ]);

  return json({
    success: true,
    job,
    pages: pages.results || [],
    events: (events.results || []).map((event) => ({
      ...event,
      details: parseJson(event.details_json),
      details_json: undefined,
    })),
  });
}

async function processMigration(id, env) {
  const job = await getJob(id, env);
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const existing = await env.DB.prepare(`SELECT COUNT(*) AS count FROM migration_pages WHERE job_id = ?`).bind(id).first();
  if (Number(existing?.count || 0) > 0) {
    return json({
      success: false,
      error: "Page discovery has already run. Use the capture-pages endpoint to continue.",
    }, 409);
  }

  const startedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status = ?, current_stage = ?, progress_percent = ?, updated_at = ?
      WHERE id = ?
    `).bind("processing", "discovering", 10, startedAt, id),
    eventStatement(env, id, "info", "discovering", "Homepage discovery started.", null, startedAt),
  ]);

  try {
    const result = await renderedHtml(env, job.source_url);
    const sourceUrl = new URL(job.source_url);
    const pages = discoverInternalPages(result.html, sourceUrl);
    const homepageKey = `${job.output_prefix}/pages/home/index.html`;

    await putHtml(env, homepageKey, result.html, { jobId: id, sourceUrl: job.source_url });

    const now = new Date().toISOString();
    const statements = pages.map((pageUrl) => {
      const isHomepage = comparableUrl(pageUrl) === comparableUrl(job.source_url);
      return env.DB.prepare(`
        INSERT INTO migration_pages (
          id, job_id, source_url, final_url, output_path, title,
          http_status, status, html_r2_key, error_message,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), id, pageUrl,
        isHomepage ? result.meta?.url || job.source_url : null,
        outputPath(pageUrl),
        isHomepage ? result.meta?.title || null : null,
        isHomepage ? Number(result.meta?.status || 200) : null,
        isHomepage ? "captured" : "discovered",
        isHomepage ? homepageKey : null,
        null, now, now
      );
    });

    statements.push(eventStatement(
      env, id, "info", "discovery_complete",
      "Homepage captured and internal pages discovered.",
      { discoveredPages: pages.length, capturedPages: 1, htmlLength: result.html.length, homepageKey },
      now
    ));

    await env.DB.batch(statements);
    await env.DB.prepare(`
      UPDATE migration_jobs
      SET status = ?, current_stage = ?, progress_percent = ?,
          discovered_pages = ?, captured_pages = ?, updated_at = ?
      WHERE id = ?
    `).bind("processing", "discovery_complete", 25, pages.length, 1, now, id).run();

    return json({
      success: true,
      jobId: id,
      status: "processing",
      currentStage: "discovery_complete",
      progressPercent: 25,
      discoveredPages: pages.length,
      capturedPages: 1,
      htmlLength: result.html.length,
      homepageR2Key: homepageKey,
      internalPages: pages,
    });
  } catch (error) {
    return await failStage(env, id, "discovery_failed", error);
  }
}

async function capturePages(id, env) {
  const job = await getJob(id, env);
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const pending = await env.DB.prepare(`
    SELECT * FROM migration_pages
    WHERE job_id = ? AND status IN ('discovered', 'failed')
    ORDER BY source_url
  `).bind(id).all();

  const pages = pending.results || [];
  if (!pages.length) {
    const totals = await pageTotals(id, env);
    return json({
      success: true,
      jobId: id,
      message: "There are no remaining pages to capture.",
      totalPages: totals.total,
      capturedPages: totals.captured,
      failedPages: totals.failed,
    });
  }

  const startedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status = ?, current_stage = ?, progress_percent = ?, updated_at = ?
      WHERE id = ?
    `).bind("processing", "capturing_pages", 30, startedAt, id),
    eventStatement(env, id, "info", "capturing_pages", "Capture of remaining pages started.", { pendingPages: pages.length }, startedAt),
  ]);

  const captured = [];
  const failed = [];

  for (const page of pages) {
    const pageStartedAt = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE migration_pages
      SET status = ?, error_message = NULL, updated_at = ?
      WHERE id = ?
    `).bind("capturing", pageStartedAt, page.id).run();

    try {
      const result = await renderedHtml(env, page.source_url);
      const key = `${job.output_prefix}/pages/${page.output_path || "index.html"}`;
      await putHtml(env, key, result.html, { jobId: id, pageId: page.id, sourceUrl: page.source_url });

      const now = new Date().toISOString();
      await env.DB.prepare(`
        UPDATE migration_pages
        SET final_url = ?, title = ?, http_status = ?, status = ?,
            html_r2_key = ?, error_message = NULL, updated_at = ?
        WHERE id = ?
      `).bind(
        result.meta?.url || page.source_url,
        result.meta?.title || null,
        Number(result.meta?.status || 200),
        "captured", key, now, page.id
      ).run();

      captured.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        title: result.meta?.title || null,
        status: Number(result.meta?.status || 200),
        htmlLength: result.html.length,
        htmlR2Key: key,
      });
    } catch (error) {
      const message = errorMessage(error);
      await env.DB.prepare(`
        UPDATE migration_pages
        SET status = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `).bind("failed", message, new Date().toISOString(), page.id).run();
      failed.push({ pageId: page.id, sourceUrl: page.source_url, error: message });
    }
  }

  const totals = await pageTotals(id, env);
  const allCaptured = totals.total > 0 && totals.captured === totals.total;
  const status = allCaptured ? "processing" : "failed";
  const stage = allCaptured ? "pages_captured" : "page_capture_incomplete";
  const progress = allCaptured ? 45 : 40;
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status = ?, current_stage = ?, progress_percent = ?, captured_pages = ?,
          error_count = error_count + ?, updated_at = ?
      WHERE id = ?
    `).bind(status, stage, progress, totals.captured, failed.length, now, id),
    eventStatement(
      env, id, failed.length ? "warning" : "info", stage,
      failed.length ? "Page capture completed with errors." : "All discovered pages were captured.",
      { totalPages: totals.total, capturedPages: totals.captured, failedPages: totals.failed },
      now
    ),
  ]);

  return json({
    success: failed.length === 0,
    jobId: id,
    status,
    currentStage: stage,
    progressPercent: progress,
    totalPages: totals.total,
    capturedPages: totals.captured,
    failedPages: totals.failed,
    captured,
    failed,
  });
}

async function renderedHtml(env, url) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await env.BROWSER.quickAction("content", {
        url,
        userAgent: USER_AGENT,
        gotoOptions: { waitUntil: "networkidle2", timeout: 45000 },
      });

      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error(`Browser Run returned invalid JSON: ${text.slice(0, 250)}`);
      }

      if (!result.success) {
        throw new Error(result?.errors?.[0]?.message || result?.error || "Browser Run failed.");
      }
      if (typeof result.result !== "string" || result.result.length < 100) {
        throw new Error("Browser Run did not return usable rendered HTML.");
      }

      return { html: result.result, meta: result.meta || {} };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 1500);
    }
  }

  throw lastError || new Error("Browser Run failed.");
}

function discoverInternalPages(html, sourceUrl) {
  const urls = new Set([comparableUrl(sourceUrl.href)]);
  const pattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const href = match[2]?.trim();
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;

    try {
      const url = new URL(href, sourceUrl.href);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      if (normaliseHostname(url.hostname) !== normaliseHostname(sourceUrl.hostname)) continue;
      if (/\.(?:css|js|json|jpe?g|png|gif|webp|svg|ico|pdf|zip|mp3|mp4|woff2?|ttf|otf)$/i.test(url.pathname)) continue;
      url.hash = "";
      removeTracking(url);
      urls.add(comparableUrl(url.href));
    } catch {
      // Ignore malformed links.
    }
  }

  return [...urls].sort();
}

function outputPath(pageUrl) {
  const url = new URL(pageUrl);
  if (url.pathname === "/" && !url.search) return "index.html";

  let path = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9/_-]/g, "-")
    .replace(/-+/g, "-") || "home";

  if (url.search) path += `--${hash(url.search)}`;
  return `${path}/index.html`;
}

async function getJob(id, env) {
  return await env.DB.prepare(`SELECT * FROM migration_jobs WHERE id = ?`).bind(id).first();
}

async function pageTotals(id, env) {
  const row = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN status = 'captured' THEN 1 ELSE 0 END) AS captured,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COUNT(*) AS total
    FROM migration_pages WHERE job_id = ?
  `).bind(id).first();

  return {
    captured: Number(row?.captured || 0),
    failed: Number(row?.failed || 0),
    total: Number(row?.total || 0),
  };
}

function eventStatement(env, jobId, level, stage, message, details, createdAt) {
  return env.DB.prepare(`
    INSERT INTO migration_events
      (job_id, level, stage, message, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    jobId, level, stage, message,
    details == null ? null : JSON.stringify(details),
    createdAt
  );
}

async function failStage(env, id, stage, error) {
  const now = new Date().toISOString();
  const message = errorMessage(error);

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status = ?, current_stage = ?, error_count = error_count + 1, updated_at = ?
      WHERE id = ?
    `).bind("failed", stage, now, id),
    eventStatement(env, id, "error", stage, message, null, now),
  ]);

  return json({ success: false, jobId: id, currentStage: stage, error: message }, 500);
}

async function putHtml(env, key, html, metadata) {
  const result = await env.STORAGE.put(key, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: metadata,
  });
  if (result === null) throw new Error(`R2 did not store the object: ${key}`);
}

function normaliseSourceUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    removeTracking(url);
    return url;
  } catch {
    return null;
  }
}

function comparableUrl(value) {
  const url = new URL(value);
  url.hash = "";
  removeTracking(url);
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

function normaliseHostname(value) {
  return value.toLowerCase().replace(/^www\./, "");
}

function removeTracking(url) {
  for (const key of [
    "utm_source", "utm_medium", "utm_campaign", "utm_term",
    "utm_content", "utm_id", "gclid", "fbclid",
  ]) {
    url.searchParams.delete(key);
  }
}

function hash(value) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function validateBindings(env) {
  const missing = [];
  if (!env.BROWSER) missing.push("BROWSER");
  if (!env.DB) missing.push("DB");
  if (!env.STORAGE) missing.push("STORAGE");
  if (missing.length) throw new Error(`Missing Cloudflare binding(s): ${missing.join(", ")}`);
}

function parseJson(value) {
  if (value == null || value === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unexpected server error.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS_HEADERS });
}
