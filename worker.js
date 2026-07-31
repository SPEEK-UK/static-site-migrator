const VERSION = "1.2.0";

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
        return json({ success: true, service: "Static Site Migrator Engine", version: VERSION, status: "online" });
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

      const inventoryMatch = pathname.match(/^\/api\/migrations\/([^/]+)\/inventory-assets$/);
      if (request.method === "POST" && inventoryMatch) {
        return await inventoryAssets(decodeURIComponent(inventoryMatch[1]), env);
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
  try { body = await request.json(); }
  catch { return json({ success: false, error: "The request body must be valid JSON." }, 400); }

  const sourceUrl = normaliseSourceUrl(body?.sourceUrl);
  if (!sourceUrl) {
    return json({ success: false, error: "Provide a valid sourceUrl using HTTP or HTTPS." }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

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
      0, 0, 0, 0, 0, 0, `migrations/${id}`, now, now
    ),
    eventStatement(env, id, "info", "created", "Migration job created.", { sourceUrl: sourceUrl.href }, now),
  ]);

  return json({ success: true, job: { id, sourceUrl: sourceUrl.href, status: "queued", currentStage: "created", progressPercent: 0, createdAt: now } }, 201);
}

async function getMigration(id, env) {
  const job = await getJob(id, env);
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const [pagesResult, eventsResult, assetSummaryResult] = await Promise.all([
    env.DB.prepare(`SELECT * FROM migration_pages WHERE job_id = ? ORDER BY source_url, created_at`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM migration_events WHERE job_id = ? ORDER BY created_at, id`).bind(id).all(),
    env.DB.prepare(`
      SELECT asset_type, status, COUNT(*) AS asset_count
      FROM migration_assets WHERE job_id = ?
      GROUP BY asset_type, status ORDER BY asset_type, status
    `).bind(id).all(),
  ]);

  return json({
    success: true,
    job,
    pages: pagesResult.results || [],
    assetSummary: assetSummaryResult.results || [],
    events: (eventsResult.results || []).map((event) => ({
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
    return json({ success: false, error: "Page discovery has already run. Use the capture-pages endpoint to continue." }, 409);
  }

  const startedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status = ?, current_stage = ?, progress_percent = ?, updated_at = ? WHERE id = ?`).bind("processing", "discovering", 10, startedAt, id),
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

    statements.push(eventStatement(env, id, "info", "discovery_complete", "Homepage captured and internal pages discovered.", {
      discoveredPages: pages.length,
      capturedPages: 1,
      htmlLength: result.html.length,
      homepageKey,
    }, now));

    await runBatches(env.DB, statements);
    await env.DB.prepare(`
      UPDATE migration_jobs SET status = ?, current_stage = ?, progress_percent = ?,
      discovered_pages = ?, captured_pages = ?, updated_at = ? WHERE id = ?
    `).bind("processing", "discovery_complete", 25, pages.length, 1, now, id).run();

    return json({ success: true, jobId: id, status: "processing", currentStage: "discovery_complete", progressPercent: 25, discoveredPages: pages.length, capturedPages: 1, htmlLength: result.html.length, homepageR2Key: homepageKey, internalPages: pages });
  } catch (error) {
    return await failStage(env, id, "discovery_failed", error);
  }
}

async function capturePages(id, env) {
  const job = await getJob(id, env);
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const removedDuplicates = await removeDuplicatePages(id, env);
  const pendingResult = await env.DB.prepare(`
    SELECT * FROM migration_pages
    WHERE job_id = ? AND status IN ('discovered', 'failed')
    ORDER BY source_url, created_at
  `).bind(id).all();

  const pages = pendingResult.results || [];
  if (!pages.length) {
    const totals = await pageTotals(id, env);
    const allCaptured = totals.total > 0 && totals.captured === totals.total;

    if (allCaptured && job.current_stage !== "pages_captured") {
      await env.DB.prepare(`
        UPDATE migration_jobs SET status = ?, current_stage = ?, progress_percent = ?,
        discovered_pages = ?, captured_pages = ?, updated_at = ? WHERE id = ?
      `).bind("processing", "pages_captured", 45, totals.total, totals.captured, new Date().toISOString(), id).run();
    }

    return json({ success: allCaptured, jobId: id, message: "There are no remaining pages to capture.", removedDuplicatePages: removedDuplicates, totalPages: totals.total, capturedPages: totals.captured, failedPages: totals.failed, currentStage: allCaptured ? "pages_captured" : job.current_stage });
  }

  const startedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status = ?, current_stage = ?, progress_percent = ?, updated_at = ? WHERE id = ?`).bind("processing", "capturing_pages", 30, startedAt, id),
    eventStatement(env, id, "info", "capturing_pages", "Capture of remaining pages started.", { pendingPages: pages.length, removedDuplicatePages: removedDuplicates }, startedAt),
  ]);

  const captured = [];
  const failed = [];

  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (index > 0) await sleep(7000);

    await env.DB.prepare(`UPDATE migration_pages SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?`).bind("capturing", new Date().toISOString(), page.id).run();

    try {
      const result = await renderedHtml(env, page.source_url);
      const key = `${job.output_prefix}/pages/${page.output_path || "index.html"}`;
      await putHtml(env, key, result.html, { jobId: id, pageId: page.id, sourceUrl: page.source_url });

      const now = new Date().toISOString();
      await env.DB.prepare(`
        UPDATE migration_pages SET final_url = ?, title = ?, http_status = ?, status = ?,
        html_r2_key = ?, error_message = NULL, updated_at = ? WHERE id = ?
      `).bind(result.meta?.url || page.source_url, result.meta?.title || null, Number(result.meta?.status || 200), "captured", key, now, page.id).run();

      captured.push({ pageId: page.id, sourceUrl: page.source_url, title: result.meta?.title || null, status: Number(result.meta?.status || 200), htmlLength: result.html.length, htmlR2Key: key });
    } catch (error) {
      const message = errorMessage(error);
      await env.DB.prepare(`UPDATE migration_pages SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`).bind("failed", message, new Date().toISOString(), page.id).run();
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
      UPDATE migration_jobs SET status = ?, current_stage = ?, progress_percent = ?,
      discovered_pages = ?, captured_pages = ?, error_count = error_count + ?, updated_at = ?
      WHERE id = ?
    `).bind(status, stage, progress, totals.total, totals.captured, failed.length, now, id),
    eventStatement(env, id, failed.length && !allCaptured ? "warning" : "info", stage,
      allCaptured ? "All discovered pages were captured." : "Page capture completed with errors. Run the endpoint again to retry failed pages.",
      { totalPages: totals.total, capturedPages: totals.captured, failedPages: totals.failed, removedDuplicatePages: removedDuplicates }, now),
  ]);

  return json({ success: allCaptured, jobId: id, status, currentStage: stage, progressPercent: progress, removedDuplicatePages: removedDuplicates, totalPages: totals.total, capturedPages: totals.captured, failedPages: totals.failed, captured, failed });
}

async function inventoryAssets(id, env) {
  const job = await getJob(id, env);
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const pagesResult = await env.DB.prepare(`
    SELECT * FROM migration_pages
    WHERE job_id = ? AND status = 'captured' AND html_r2_key IS NOT NULL
    ORDER BY source_url
  `).bind(id).all();

  const pages = pagesResult.results || [];
  if (!pages.length) return json({ success: false, error: "No captured pages are available for asset inventory." }, 409);

  const startedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM migration_assets WHERE job_id = ?`).bind(id),
    env.DB.prepare(`UPDATE migration_jobs SET status = ?, current_stage = ?, progress_percent = ?, updated_at = ? WHERE id = ?`).bind("processing", "inventorying_assets", 50, startedAt, id),
    eventStatement(env, id, "info", "inventorying_assets", "Asset inventory started.", { capturedPages: pages.length }, startedAt),
  ]);

  try {
    const assetsByUrl = new Map();
    const pageResults = [];

    for (const page of pages) {
      const object = await env.STORAGE.get(page.html_r2_key);
      if (!object) throw new Error(`Captured HTML is missing from R2: ${page.html_r2_key}`);

      const html = await object.text();
      const references = extractAssetReferences(html, new URL(page.source_url));
      pageResults.push({ pageId: page.id, sourceUrl: page.source_url, referencesFound: references.length });

      for (const reference of references) {
        const key = comparableAssetUrl(reference.url);
        const current = assetsByUrl.get(key);
        if (!current) {
          assetsByUrl.set(key, { ...reference, url: key, pageId: page.id, occurrences: 1 });
        } else {
          current.occurrences += 1;
          if (assetTypePriority(reference.type) > assetTypePriority(current.type)) current.type = reference.type;
        }
      }
    }

    const assets = [...assetsByUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
    const now = new Date().toISOString();
    const statements = assets.map((asset) => env.DB.prepare(`
      INSERT INTO migration_assets (
        id, job_id, page_id, source_url, asset_type, content_type,
        output_path, r2_key, byte_size, http_status, status,
        error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), id, asset.pageId, asset.url, asset.type, null,
      assetOutputPath(asset.url, asset.type), null, null, null,
      "discovered", null, now, now
    ));

    statements.push(eventStatement(env, id, "info", "assets_inventoried", "Asset inventory completed.", {
      capturedPages: pages.length,
      uniqueAssets: assets.length,
      assetsByType: countAssetsByType(assets),
      pageResults,
    }, now));

    await runBatches(env.DB, statements);
    await env.DB.prepare(`
      UPDATE migration_jobs SET status = ?, current_stage = ?, progress_percent = ?,
      downloaded_assets = 0, updated_at = ? WHERE id = ?
    `).bind("processing", "assets_inventoried", 55, now, id).run();

    return json({
      success: true,
      jobId: id,
      status: "processing",
      currentStage: "assets_inventoried",
      progressPercent: 55,
      capturedPages: pages.length,
      uniqueAssets: assets.length,
      assetsByType: countAssetsByType(assets),
      pageResults,
      sampleAssets: assets.slice(0, 25).map((asset) => ({
        sourceUrl: asset.url,
        assetType: asset.type,
        outputPath: assetOutputPath(asset.url, asset.type),
        occurrences: asset.occurrences,
      })),
    });
  } catch (error) {
    return await failStage(env, id, "asset_inventory_failed", error);
  }
}

function extractAssetReferences(html, pageUrl) {
  const references = [];
  const add = (raw, typeHint = null) => {
    const cleaned = decodeHtmlEntities(String(raw || "").trim());
    if (!cleaned || shouldIgnoreAssetReference(cleaned)) return;
    try {
      const url = new URL(cleaned, pageUrl.href);
      if (!["http:", "https:"].includes(url.protocol)) return;
      url.hash = "";
      references.push({ url: url.href, type: typeHint || inferAssetType(url.pathname) });
    } catch {}
  };

  const patterns = [
    { pattern: /\b(?:src|data-src|data-lazy-src|data-original|poster)\s*=\s*(["'])(.*?)\1/gi },
    { pattern: /\b(?:data-bg|data-background|data-image|data-image-url)\s*=\s*(["'])(.*?)\1/gi, type: "image" },
  ];

  for (const item of patterns) {
    let match;
    while ((match = item.pattern.exec(html)) !== null) add(match[2], item.type || null);
  }

  let linkMatch;
  const linkPattern = /<link\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  while ((linkMatch = linkPattern.exec(html)) !== null) {
    const fullTag = linkMatch[0];
    const rel = fullTag.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() || "";
    const as = fullTag.match(/\bas\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase() || "";
    if (rel.includes("stylesheet") || rel.includes("icon") || rel.includes("preload") || rel.includes("modulepreload") || as) {
      add(linkMatch[2], linkAssetType(rel, as, linkMatch[2]));
    }
  }

  let srcsetMatch;
  const srcsetPattern = /\b(?:srcset|data-srcset)\s*=\s*(["'])(.*?)\1/gi;
  while ((srcsetMatch = srcsetPattern.exec(html)) !== null) {
    for (const candidate of srcsetMatch[2].split(",")) add(candidate.trim().split(/\s+/)[0], "image");
  }

  let cssMatch;
  const cssUrlPattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  while ((cssMatch = cssUrlPattern.exec(html)) !== null) add(cssMatch[2], null);

  return references;
}

function linkAssetType(rel, as, href) {
  if (rel.includes("stylesheet") || as === "style") return "stylesheet";
  if (rel.includes("icon") || as === "image") return "image";
  if (as === "font") return "font";
  if (as === "script" || rel.includes("modulepreload")) return "script";
  return inferAssetType(new URL(href, "https://placeholder.invalid").pathname);
}

function shouldIgnoreAssetReference(value) {
  return /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value) || value === "/" || /^\{\{.*\}\}$/.test(value) || /\$\{.*\}/.test(value);
}

function inferAssetType(pathname) {
  const lower = pathname.toLowerCase();
  if (/\.css$/.test(lower)) return "stylesheet";
  if (/\.(?:js|mjs|cjs)$/.test(lower)) return "script";
  if (/\.(?:woff2?|ttf|otf|eot)$/.test(lower)) return "font";
  if (/\.(?:svg|png|jpe?g|gif|webp|avif|bmp|ico|tiff?)$/.test(lower)) return "image";
  if (/\.(?:mp4|webm|mov|m4v|mp3|wav|ogg)$/.test(lower)) return "media";
  if (/\.(?:pdf|docx?|xlsx?|pptx?|zip|csv|txt)$/.test(lower)) return "download";
  return "other";
}

function assetTypePriority(type) {
  return ({ stylesheet: 6, script: 5, font: 4, image: 3, media: 2, download: 1, other: 0 })[type] ?? 0;
}

function comparableAssetUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function assetOutputPath(sourceUrl, type) {
  const url = new URL(sourceUrl);
  const folder = ({ stylesheet: "css", script: "js", font: "fonts", image: "images", media: "media", download: "downloads", other: "other" })[type] || "other";
  let filename = decodeURIComponent(url.pathname.split("/").pop() || "asset").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  if (!filename || filename === ".") filename = "asset";
  if (!filename.includes(".")) filename += defaultExtensionForType(type);
  return `assets/${folder}/${hash(`${url.hostname}${url.pathname}${url.search}`)}-${filename}`;
}

function defaultExtensionForType(type) {
  return ({ stylesheet: ".css", script: ".js", font: ".bin", image: ".img", media: ".media", download: ".bin", other: ".bin" })[type] || ".bin";
}

function countAssetsByType(assets) {
  const counts = {};
  for (const asset of assets) counts[asset.type] = (counts[asset.type] || 0) + 1;
  return counts;
}

async function removeDuplicatePages(jobId, env) {
  const result = await env.DB.prepare(`SELECT * FROM migration_pages WHERE job_id = ? ORDER BY source_url, created_at, id`).bind(jobId).all();
  const groups = new Map();
  for (const row of result.results || []) {
    const key = comparableUrl(row.source_url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const duplicateIds = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = group.find((row) => row.status === "captured") || group[0];
    for (const row of group) if (row.id !== keeper.id) duplicateIds.push(row.id);
  }

  if (!duplicateIds.length) return 0;
  await runBatches(env.DB, duplicateIds.map((pageId) => env.DB.prepare(`DELETE FROM migration_pages WHERE id = ? AND job_id = ?`).bind(pageId, jobId)));
  return duplicateIds.length;
}

async function renderedHtml(env, url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await env.BROWSER.quickAction("content", { url, userAgent: USER_AGENT, gotoOptions: { waitUntil: "networkidle2", timeout: 45000 } });
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); }
      catch { throw new Error(`Browser Run returned invalid JSON: ${text.slice(0, 250)}`); }
      if (!result.success) throw new Error(result?.errors?.[0]?.message || result?.error || "Browser Run failed.");
      if (typeof result.result !== "string" || result.result.length < 100) throw new Error("Browser Run did not return usable rendered HTML.");
      return { html: result.result, meta: result.meta || {} };
    } catch (error) {
      lastError = error;
      if (attempt < 5) await sleep(/rate limit|429/i.test(errorMessage(error)) ? 5000 * attempt : 2000 * attempt);
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
    } catch {}
  }
  return [...urls].sort();
}

function outputPath(pageUrl) {
  const url = new URL(pageUrl);
  if (url.pathname === "/" && !url.search) return "index.html";
  let path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9/_-]/g, "-").replace(/-+/g, "-") || "home";
  if (url.search) path += `--${hash(url.search)}`;
  return `${path}/index.html`;
}

async function getJob(id, env) {
  return await env.DB.prepare(`SELECT * FROM migration_jobs WHERE id = ?`).bind(id).first();
}

async function pageTotals(id, env) {
  const row = await env.DB.prepare(`
    SELECT SUM(CASE WHEN status = 'captured' THEN 1 ELSE 0 END) AS captured,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
    COUNT(*) AS total FROM migration_pages WHERE job_id = ?
  `).bind(id).first();
  return { captured: Number(row?.captured || 0), failed: Number(row?.failed || 0), total: Number(row?.total || 0) };
}

function eventStatement(env, jobId, level, stage, message, details, createdAt) {
  return env.DB.prepare(`INSERT INTO migration_events (job_id, level, stage, message, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(jobId, level, stage, message, details == null ? null : JSON.stringify(details), createdAt);
}

async function failStage(env, id, stage, error) {
  const now = new Date().toISOString();
  const message = errorMessage(error);
  await env.DB.batch([
    env.DB.prepare(`UPDATE migration_jobs SET status = ?, current_stage = ?, error_count = error_count + 1, updated_at = ? WHERE id = ?`).bind("failed", stage, now, id),
    eventStatement(env, id, "error", stage, message, null, now),
  ]);
  return json({ success: false, jobId: id, currentStage: stage, error: message }, 500);
}

async function putHtml(env, key, html, metadata) {
  const result = await env.STORAGE.put(key, html, { httpMetadata: { contentType: "text/html; charset=utf-8" }, customMetadata: metadata });
  if (result === null) throw new Error(`R2 did not store the object: ${key}`);
}

async function runBatches(db, statements, batchSize = 75) {
  for (let index = 0; index < statements.length; index += batchSize) await db.batch(statements.slice(index, index + batchSize));
}

function normaliseSourceUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    removeTracking(url);
    return url;
  } catch { return null; }
}

function comparableUrl(value) {
  const url = new URL(value);
  url.hash = "";
  removeTracking(url);
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

function normaliseHostname(value) { return value.toLowerCase().replace(/^www\./, ""); }
function removeTracking(url) { for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id", "gclid", "fbclid"]) url.searchParams.delete(key); }
function decodeHtmlEntities(value) { return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">"); }
function hash(value) { let result = 2166136261; for (let i = 0; i < value.length; i++) { result ^= value.charCodeAt(i); result = Math.imul(result, 16777619); } return (result >>> 0).toString(36); }
function validateBindings(env) { const missing = []; if (!env.BROWSER) missing.push("BROWSER"); if (!env.DB) missing.push("DB"); if (!env.STORAGE) missing.push("STORAGE"); if (missing.length) throw new Error(`Missing Cloudflare binding(s): ${missing.join(", ")}`); }
function parseJson(value) { if (value == null || value === "") return null; try { return JSON.parse(value); } catch { return value; } }
function errorMessage(error) { return error instanceof Error ? error.message : String(error || "Unexpected server error."); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function json(data, status = 200) { return Response.json(data, { status, headers: CORS_HEADERS }); }
