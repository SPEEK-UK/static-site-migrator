const VERSION = "1.9.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/138.0.0.0 Safari/537.36";

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      validateBindings(env);

      if (request.method === "GET" && path === "/") {
        return json({
          success: true,
          service: "Static Site Migrator Engine",
          version: VERSION,
          status: "online",
        });
      }

      const previewMatch = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (request.method === "GET" && previewMatch) {
        return servePreview(
          decodeURIComponent(previewMatch[1]),
          previewMatch[2] || "/",
          env,
        );
      }

      const authError = authorise(request, env);
      if (authError) return authError;

      if (request.method === "POST" && path === "/api/migrations") {
        return createMigration(request, url, env, ctx);
      }

      let match = path.match(/^\/api\/migrations\/([^/]+)$/);
      if (request.method === "GET" && match) {
        return readMigration(decodeURIComponent(match[1]), url, env);
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/run$/);
      if (request.method === "POST" && match) {
        return runNextStep(decodeURIComponent(match[1]), env);
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/process$/);
      if (request.method === "POST" && match) {
        return responseFromResult(
          await discoverHomepage(decodeURIComponent(match[1]), env),
        );
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/capture-pages$/);
      if (request.method === "POST" && match) {
        return responseFromResult(
          await capturePages(decodeURIComponent(match[1]), env),
        );
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/inventory-assets$/);
      if (request.method === "POST" && match) {
        return responseFromResult(
          await inventoryAssets(decodeURIComponent(match[1]), env),
        );
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/download-assets$/);
      if (request.method === "POST" && match) {
        const limit = clamp(Number(url.searchParams.get("limit") || 15), 1, 25);
        return responseFromResult(
          await downloadAssets(decodeURIComponent(match[1]), env, limit),
        );
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/rewrite-pages$/);
      if (request.method === "POST" && match) {
        return responseFromResult(
          await rewritePages(decodeURIComponent(match[1]), env),
        );
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/fix-duda-animations$/);
      if (request.method === "POST" && match) {
        return responseFromResult(
          await applyAnimationPass(decodeURIComponent(match[1]), env),
        );
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/apply-overrides$/);
      if (request.method === "POST" && match) {
        return applyManualOverrides(
          decodeURIComponent(match[1]),
          request,
          env,
        );
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/overrides$/);
      if (request.method === "GET" && match) {
        return getManualOverrides(decodeURIComponent(match[1]), env);
      }

      return json({ success: false, error: "Route not found." }, 404);
    } catch (error) {
      console.error(error);
      return json({ success: false, error: errorMessage(error) }, 500);
    }
  },
};

function authorise(request, env) {
  if (!env.MIGRATOR_API_KEY) return null;

  const bearer = request.headers
    .get("Authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const apiKey = request.headers.get("X-API-Key")?.trim();

  if (bearer === env.MIGRATOR_API_KEY || apiKey === env.MIGRATOR_API_KEY) {
    return null;
  }

  return json({ success: false, error: "Unauthorised." }, 401);
}

async function createMigration(request, requestUrl, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "A JSON request body is required." }, 400);
  }

  const source = normaliseSourceUrl(body?.sourceUrl || body?.source_url);
  if (!source) {
    return json(
      { success: false, error: "sourceUrl must be a valid HTTP or HTTPS URL." },
      400,
    );
  }

  const id = crypto.randomUUID();
  const createdAt = now();
  const outputPrefix = `migrations/${id}`;
  const projectName = sanitiseProjectName(
    body?.projectName || body?.cloudflare_project_name || source.hostname,
  );

  const settings = {
    sourceUrl: source.href,
    crawlDepth: clamp(numberOrDefault(body?.crawlDepth ?? body?.crawl_depth, 3), 1, 10),
    maxPages: clamp(numberOrDefault(body?.maxPages ?? body?.max_pages, 50), 1, 500),
    preserveSliders: Boolean(
      body?.preserveSliders ?? body?.preserve_sliders ?? true,
    ),
    flattenAnimations: Boolean(
      body?.flattenAnimations ?? body?.flatten_animations ?? true,
    ),
    formEndpoint: body?.formEndpoint || body?.form_endpoint || null,
    base44JobId: body?.base44JobId || body?.base44_job_id || null,
    autoStart: body?.autoStart !== false,
  };

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO migration_jobs (
        id, source_url, source_hostname, status, current_stage,
        progress_percent, discovered_pages, captured_pages,
        downloaded_assets, warning_count, error_count,
        output_prefix, pages_project_name, deployment_url,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, 'queued', 'created', 0, 0, 0, 0, 0, 0, ?, ?, NULL, ?, ?, NULL)
    `).bind(
      id,
      source.href,
      source.hostname,
      outputPrefix,
      projectName,
      createdAt,
      createdAt,
    ),
    eventStatement(
      env,
      id,
      "info",
      "created",
      "Migration job created from Base44.",
      settings,
      createdAt,
    ),
  ]);

  if (settings.autoStart && ctx?.waitUntil) {
    ctx.waitUntil(runPipeline(id, env));
  }

  const origin = requestUrl.origin;
  return json(
    {
      success: true,
      job: {
        id,
        sourceUrl: source.href,
        status: "queued",
        currentStage: "created",
        progressPercent: 0,
        projectName,
        createdAt,
        statusUrl: `${origin}/api/migrations/${id}`,
        runUrl: `${origin}/api/migrations/${id}/run`,
        previewUrl: `${origin}/preview/${id}/`,
      },
    },
    201,
  );
}

async function readMigration(jobId, requestUrl, env) {
  const job = await getJob(jobId, env);
  if (!job) {
    return json({ success: false, error: "Migration job not found." }, 404);
  }

  const [pagesResult, assetsResult, eventsResult] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM migration_pages WHERE job_id=? ORDER BY source_url, created_at",
    ).bind(jobId).all(),
    env.DB.prepare(
      "SELECT * FROM migration_assets WHERE job_id=? ORDER BY asset_type, source_url",
    ).bind(jobId).all(),
    env.DB.prepare(
      "SELECT * FROM migration_events WHERE job_id=? ORDER BY created_at, id",
    ).bind(jobId).all(),
  ]);

  const origin = requestUrl.origin;
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
    links: {
      status: `${origin}/api/migrations/${jobId}`,
      run: `${origin}/api/migrations/${jobId}/run`,
      preview: `${origin}/preview/${jobId}/`,
      overrides: `${origin}/api/migrations/${jobId}/overrides`,
    },
  });
}

async function runPipeline(jobId, env) {
  for (let pass = 0; pass < 20; pass += 1) {
    const job = await getJob(jobId, env);
    if (!job || job.status === "completed" || job.status === "failed") return;

    const result = await advanceJob(job, env);
    if (!result.success && !result.continueOnWarning) return;
    if (result.completed) return;

    await sleep(250);
  }
}

async function runNextStep(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) {
    return json({ success: false, error: "Migration job not found." }, 404);
  }

  const result = await advanceJob(job, env);
  return responseFromResult(result);
}

async function advanceJob(job, env) {
  const stage = String(job.current_stage || "created");

  if (job.status === "completed" || stage === "completed") {
    return {
      success: true,
      completed: true,
      jobId: job.id,
      status: "completed",
      currentStage: "completed",
      progressPercent: 100,
      message: "Migration is already complete.",
    };
  }

  if (["created", "queued", "discovering", "discovery_failed"].includes(stage)) {
    return discoverHomepage(job.id, env);
  }

  if ([
    "discovery_complete",
    "capturing_pages",
    "page_capture_incomplete",
  ].includes(stage)) {
    return capturePages(job.id, env);
  }

  if (["pages_captured", "inventorying_assets"].includes(stage)) {
    return inventoryAssets(job.id, env);
  }

  if ([
    "assets_inventoried",
    "downloading_assets",
  ].includes(stage)) {
    return downloadAssets(job.id, env, 15);
  }

  if ([
    "assets_downloaded",
    "assets_downloaded_with_warnings",
    "rewriting_pages",
  ].includes(stage)) {
    return rewritePages(job.id, env);
  }

  if ([
    "pages_rewritten",
    "pages_rewritten_with_warnings",
    "fixing_duda_animations",
  ].includes(stage)) {
    const settings = await getJobSettings(job.id, env);
    if (settings.flattenAnimations === false) {
      return completeMigration(job.id, env, "Animations left unchanged by request.");
    }
    return applyAnimationPass(job.id, env);
  }

  if ([
    "duda_animations_finalised",
    "duda_animations_finalised_with_warnings",
    "manual_overrides_applied",
    "manual_overrides_applied_with_warnings",
  ].includes(stage)) {
    return completeMigration(job.id, env);
  }

  return {
    success: false,
    jobId: job.id,
    currentStage: stage,
    error: `The runner does not recognise the current stage: ${stage}`,
  };
}

async function discoverHomepage(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) return notFoundResult();

  const existing = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM migration_pages WHERE job_id=?",
  ).bind(jobId).first();

  if (Number(existing?.count || 0) > 0) {
    const totals = await pageTotals(jobId, env);
    await updateJobStage(
      env,
      jobId,
      "processing",
      totals.captured >= totals.total && totals.total > 0
        ? "pages_captured"
        : "discovery_complete",
      totals.captured >= totals.total && totals.total > 0 ? 45 : 25,
    );
    return {
      success: true,
      jobId,
      status: "processing",
      currentStage:
        totals.captured >= totals.total && totals.total > 0
          ? "pages_captured"
          : "discovery_complete",
      progressPercent:
        totals.captured >= totals.total && totals.total > 0 ? 45 : 25,
      discoveredPages: totals.total,
      capturedPages: totals.captured,
      message: "Discovery had already completed; the runner resumed the existing job.",
    };
  }

  const startedAt = now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='processing', current_stage='discovering', progress_percent=10,
          updated_at=? WHERE id=?
    `).bind(startedAt, jobId),
    eventStatement(
      env,
      jobId,
      "info",
      "discovering",
      "Homepage discovery started.",
      null,
      startedAt,
    ),
  ]);

  try {
    const settings = await getJobSettings(jobId, env);
    const result = await renderedHtml(env, job.source_url);
    const sourceUrl = new URL(job.source_url);
    const pages = discoverInternalPages(result.html, sourceUrl)
      .slice(0, settings.maxPages || 50);
    const homepageKey = `${job.output_prefix}/pages/home/index.html`;

    await putHtml(env, homepageKey, result.html, {
      jobId,
      sourceUrl: job.source_url,
    });

    const createdAt = now();
    const statements = pages.map((pageUrl) => {
      const isHomepage = comparableUrl(pageUrl) === comparableUrl(job.source_url);
      return env.DB.prepare(`
        INSERT INTO migration_pages (
          id, job_id, source_url, final_url, output_path, title,
          http_status, status, html_r2_key, error_message,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        jobId,
        pageUrl,
        isHomepage ? result.meta?.url || job.source_url : null,
        outputPath(pageUrl),
        isHomepage ? result.meta?.title || null : null,
        isHomepage ? Number(result.meta?.status || 200) : null,
        isHomepage ? "captured" : "discovered",
        isHomepage ? homepageKey : null,
        null,
        createdAt,
        createdAt,
      );
    });

    statements.push(
      eventStatement(
        env,
        jobId,
        "info",
        "discovery_complete",
        "Homepage captured and internal pages discovered.",
        {
          discoveredPages: pages.length,
          capturedPages: 1,
          htmlLength: result.html.length,
          homepageKey,
        },
        createdAt,
      ),
    );

    await env.DB.batch(statements);
    await env.DB.prepare(`
      UPDATE migration_jobs
      SET status='processing', current_stage='discovery_complete',
          progress_percent=25, discovered_pages=?, captured_pages=1,
          updated_at=? WHERE id=?
    `).bind(pages.length, createdAt, jobId).run();

    return {
      success: true,
      jobId,
      status: "processing",
      currentStage: "discovery_complete",
      progressPercent: 25,
      discoveredPages: pages.length,
      capturedPages: 1,
      internalPages: pages,
    };
  } catch (error) {
    return failStage(env, jobId, "discovery_failed", error);
  }
}

async function capturePages(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) return notFoundResult();

  await dedupePages(jobId, env);

  const pendingResult = await env.DB.prepare(`
    SELECT * FROM migration_pages
    WHERE job_id=? AND status IN ('discovered', 'failed')
    ORDER BY source_url, created_at
  `).bind(jobId).all();
  const pages = pendingResult.results || [];

  if (!pages.length) {
    const totals = await pageTotals(jobId, env);
    const complete = totals.total > 0 && totals.captured === totals.total;
    if (complete) {
      await updateJobStage(env, jobId, "processing", "pages_captured", 45, {
        discovered_pages: totals.total,
        captured_pages: totals.captured,
      });
    }
    return {
      success: complete,
      continueOnWarning: !complete,
      jobId,
      status: complete ? "processing" : "failed",
      currentStage: complete ? "pages_captured" : "page_capture_incomplete",
      progressPercent: complete ? 45 : 40,
      totalPages: totals.total,
      capturedPages: totals.captured,
      failedPages: totals.failed,
      message: complete
        ? "All discovered pages are captured."
        : "No pending pages remain, but one or more pages failed.",
    };
  }

  const startedAt = now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='processing', current_stage='capturing_pages',
          progress_percent=30, updated_at=? WHERE id=?
    `).bind(startedAt, jobId),
    eventStatement(
      env,
      jobId,
      "info",
      "capturing_pages",
      "Capture of remaining pages started.",
      { pendingPages: pages.length },
      startedAt,
    ),
  ]);

  const captured = [];
  const failed = [];

  for (let index = 0; index < pages.length; index += 1) {
    if (index > 0) await sleep(1500);
    const page = pages[index];

    try {
      const result = await renderedHtml(env, page.source_url);
      const key = `${job.output_prefix}/pages/${page.output_path || "index.html"}`;
      await putHtml(env, key, result.html, {
        jobId,
        pageId: page.id,
        sourceUrl: page.source_url,
      });

      const updatedAt = now();
      await env.DB.prepare(`
        UPDATE migration_pages
        SET final_url=?, title=?, http_status=?, status='captured',
            html_r2_key=?, error_message=NULL, updated_at=?
        WHERE id=?
      `).bind(
        result.meta?.url || page.source_url,
        result.meta?.title || null,
        Number(result.meta?.status || 200),
        key,
        updatedAt,
        page.id,
      ).run();

      captured.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        htmlR2Key: key,
      });
    } catch (error) {
      const message = errorMessage(error);
      await env.DB.prepare(`
        UPDATE migration_pages
        SET status='failed', error_message=?, updated_at=? WHERE id=?
      `).bind(message, now(), page.id).run();
      failed.push({ pageId: page.id, sourceUrl: page.source_url, error: message });
    }
  }

  const totals = await pageTotals(jobId, env);
  const allCaptured = totals.total > 0 && totals.captured === totals.total;
  const stage = allCaptured ? "pages_captured" : "page_capture_incomplete";
  const updatedAt = now();

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status=?, current_stage=?, progress_percent=?,
          discovered_pages=?, captured_pages=?, error_count=error_count+?,
          updated_at=? WHERE id=?
    `).bind(
      allCaptured ? "processing" : "failed",
      stage,
      allCaptured ? 45 : 40,
      totals.total,
      totals.captured,
      failed.length,
      updatedAt,
      jobId,
    ),
    eventStatement(
      env,
      jobId,
      failed.length ? "warning" : "info",
      stage,
      allCaptured
        ? "All discovered pages were captured."
        : "Page capture completed with errors.",
      {
        totalPages: totals.total,
        capturedPages: totals.captured,
        failedPages: totals.failed,
      },
      updatedAt,
    ),
  ]);

  return {
    success: allCaptured,
    continueOnWarning: false,
    jobId,
    status: allCaptured ? "processing" : "failed",
    currentStage: stage,
    progressPercent: allCaptured ? 45 : 40,
    totalPages: totals.total,
    capturedPages: totals.captured,
    failedPages: totals.failed,
    captured,
    failed,
  };
}

async function inventoryAssets(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) return notFoundResult();

  const pagesResult = await env.DB.prepare(`
    SELECT * FROM migration_pages
    WHERE job_id=? AND status='captured' AND html_r2_key IS NOT NULL
    ORDER BY source_url
  `).bind(jobId).all();
  const pages = pagesResult.results || [];

  if (!pages.length) {
    return {
      success: false,
      statusCode: 409,
      error: "No captured pages are available.",
    };
  }

  const startedAt = now();
  await updateJobStage(env, jobId, "processing", "inventorying_assets", 50);
  await addEvent(
    env,
    jobId,
    "info",
    "inventorying_assets",
    "Asset inventory started.",
    { capturedPages: pages.length },
    startedAt,
  );

  const assetMap = new Map();
  const pageResults = [];

  for (const page of pages) {
    const object = await env.STORAGE.get(page.html_r2_key);
    if (!object?.body) {
      throw new Error(`Captured HTML is missing from R2: ${page.html_r2_key}`);
    }

    const references = extractAssets(await object.text(), page.source_url);
    pageResults.push({
      pageId: page.id,
      sourceUrl: page.source_url,
      referencesFound: references.length,
    });

    for (const asset of references) {
      if (!assetMap.has(asset.sourceUrl)) {
        assetMap.set(asset.sourceUrl, { ...asset, pageId: page.id });
      }
    }
  }

  const assets = [...assetMap.values()].sort((a, b) =>
    a.sourceUrl.localeCompare(b.sourceUrl),
  );
  const createdAt = now();

  await env.DB.prepare(
    "DELETE FROM migration_assets WHERE job_id=? AND status IN ('discovered','failed','blocked')",
  ).bind(jobId).run();

  for (let index = 0; index < assets.length; index += 50) {
    const batch = assets.slice(index, index + 50).map((asset) =>
      env.DB.prepare(`
        INSERT INTO migration_assets (
          id, job_id, page_id, source_url, asset_type, content_type,
          output_path, r2_key, byte_size, http_status, status,
          error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        jobId,
        asset.pageId,
        asset.sourceUrl,
        asset.assetType,
        null,
        asset.outputPath,
        null,
        null,
        null,
        "discovered",
        null,
        createdAt,
        createdAt,
      ),
    );
    if (batch.length) await env.DB.batch(batch);
  }

  const assetsByType = countBy(assets, (asset) => asset.assetType);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='processing', current_stage='assets_inventoried',
          progress_percent=55, downloaded_assets=0, updated_at=? WHERE id=?
    `).bind(createdAt, jobId),
    eventStatement(
      env,
      jobId,
      "info",
      "assets_inventoried",
      "Asset inventory created from captured pages.",
      {
        capturedPages: pages.length,
        uniqueAssets: assets.length,
        assetsByType,
      },
      createdAt,
    ),
  ]);

  return {
    success: true,
    jobId,
    status: "processing",
    currentStage: "assets_inventoried",
    progressPercent: 55,
    capturedPages: pages.length,
    uniqueAssets: assets.length,
    assetsByType,
    pageResults,
  };
}

async function downloadAssets(jobId, env, limit) {
  const job = await getJob(jobId, env);
  if (!job) return notFoundResult();

  const rowsResult = await env.DB.prepare(`
    SELECT * FROM migration_assets
    WHERE job_id=? AND status='discovered'
    ORDER BY CASE asset_type
      WHEN 'stylesheet' THEN 1
      WHEN 'script' THEN 2
      WHEN 'font' THEN 3
      WHEN 'image' THEN 4
      ELSE 5 END,
      source_url
    LIMIT ?
  `).bind(jobId, limit).all();
  const rows = rowsResult.results || [];
  const before = await assetTotals(jobId, env);

  if (!rows.length) {
    const stage = before.blocked > 0
      ? "assets_downloaded_with_warnings"
      : "assets_downloaded";
    await updateJobStage(env, jobId, "processing", stage, 70, {
      downloaded_assets: before.downloaded,
    });

    return {
      success: true,
      continueOnWarning: before.blocked > 0,
      jobId,
      status: "processing",
      currentStage: stage,
      progressPercent: 70,
      totalAssets: before.total,
      downloadedAssets: before.downloaded,
      blockedAssets: before.blocked,
      remainingAssets: 0,
      message: "Asset download queue is complete.",
    };
  }

  const startedAt = now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='processing', current_stage='downloading_assets',
          progress_percent=60, updated_at=? WHERE id=?
    `).bind(startedAt, jobId),
    eventStatement(
      env,
      jobId,
      "info",
      "downloading_assets",
      "Asset download batch started.",
      { batchSize: rows.length, pendingBeforeBatch: before.remaining },
      startedAt,
    ),
  ]);

  const downloaded = [];
  const blocked = [];

  for (const asset of rows) {
    try {
      const result = await fetchAsset(asset.source_url, job.source_url);
      const key = `${job.output_prefix}/site/${asset.output_path}`;
      const stored = await env.STORAGE.put(key, result.body, {
        httpMetadata: {
          contentType: result.contentType || "application/octet-stream",
        },
        customMetadata: {
          jobId,
          assetId: asset.id,
          sourceUrl: asset.source_url,
        },
      });
      if (stored === null) throw new Error(`R2 refused to store asset: ${key}`);

      await env.DB.prepare(`
        UPDATE migration_assets
        SET content_type=?, r2_key=?, byte_size=?, http_status=?,
            status='downloaded', error_message=NULL, updated_at=?
        WHERE id=?
      `).bind(
        result.contentType,
        key,
        result.byteSize,
        result.status,
        now(),
        asset.id,
      ).run();

      downloaded.push({
        assetId: asset.id,
        sourceUrl: asset.source_url,
        outputPath: asset.output_path,
        r2Key: key,
        byteSize: result.byteSize,
        contentType: result.contentType,
      });
    } catch (error) {
      const message = errorMessage(error);
      await env.DB.prepare(`
        UPDATE migration_assets
        SET status='blocked', error_message=?, updated_at=? WHERE id=?
      `).bind(message, now(), asset.id).run();
      blocked.push({
        assetId: asset.id,
        sourceUrl: asset.source_url,
        error: message,
      });
    }
  }

  const totals = await assetTotals(jobId, env);
  const queueComplete = totals.remaining === 0;
  const stage = queueComplete
    ? totals.blocked > 0
      ? "assets_downloaded_with_warnings"
      : "assets_downloaded"
    : "downloading_assets";
  const progress = queueComplete
    ? 70
    : Math.min(69, 60 + Math.floor((totals.downloaded / Math.max(1, totals.total)) * 9));
  const updatedAt = now();

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='processing', current_stage=?, progress_percent=?,
          downloaded_assets=?, warning_count=warning_count+?, updated_at=?
      WHERE id=?
    `).bind(
      stage,
      progress,
      totals.downloaded,
      blocked.length,
      updatedAt,
      jobId,
    ),
    eventStatement(
      env,
      jobId,
      blocked.length ? "warning" : "info",
      stage,
      blocked.length
        ? "Asset download batch completed with blocked assets."
        : "Asset download batch completed.",
      {
        attempted: rows.length,
        downloadedInBatch: downloaded.length,
        blockedInBatch: blocked.length,
        totalAssets: totals.total,
        downloadedAssets: totals.downloaded,
        blockedAssets: totals.blocked,
        remainingAssets: totals.remaining,
      },
      updatedAt,
    ),
  ]);

  return {
    success: true,
    continueOnWarning: blocked.length > 0,
    jobId,
    status: "processing",
    currentStage: stage,
    progressPercent: progress,
    attemptedAssets: rows.length,
    downloadedInBatch: downloaded.length,
    blockedInBatch: blocked.length,
    totalAssets: totals.total,
    downloadedAssets: totals.downloaded,
    blockedAssets: totals.blocked,
    remainingAssets: totals.remaining,
    downloaded,
    blocked,
    runAgain: totals.remaining > 0,
  };
}

async function rewritePages(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) return notFoundResult();

  const [pagesResult, assetsResult] = await Promise.all([
    env.DB.prepare(`
      SELECT * FROM migration_pages
      WHERE job_id=? AND status='captured' AND html_r2_key IS NOT NULL
      ORDER BY source_url
    `).bind(jobId).all(),
    env.DB.prepare(
      "SELECT * FROM migration_assets WHERE job_id=? ORDER BY source_url",
    ).bind(jobId).all(),
  ]);

  const pages = pagesResult.results || [];
  const assets = assetsResult.results || [];

  if (!pages.length) {
    return {
      success: false,
      statusCode: 409,
      error: "No captured pages are available.",
    };
  }

  const downloadedAssets = assets.filter(
    (asset) => asset.status === "downloaded" && asset.output_path && asset.r2_key,
  );
  const blockedAssets = assets.filter((asset) => asset.status === "blocked");

  const assetMap = new Map();
  for (const asset of downloadedAssets) {
    assetMap.set(normaliseUrl(asset.source_url), `/${asset.output_path}`);
  }

  const pageMap = new Map();
  for (const page of pages) {
    pageMap.set(
      normaliseComparableUrl(page.source_url),
      outputPathToPublicUrl(page.output_path),
    );
  }

  const startedAt = now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='processing', current_stage='rewriting_pages',
          progress_percent=75, updated_at=? WHERE id=?
    `).bind(startedAt, jobId),
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
      startedAt,
    ),
  ]);

  const rewrittenCss = [];
  const cssWarnings = [];

  for (const asset of downloadedAssets.filter(
    (item) => item.asset_type === "stylesheet",
  )) {
    try {
      const object = await env.STORAGE.get(asset.r2_key);
      if (!object?.body) {
        throw new Error(`Stylesheet missing from R2: ${asset.r2_key}`);
      }

      const rewritten = rewriteCss(
        await object.text(),
        asset.source_url,
        assetMap,
      );
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
      if (!capturedObject?.body) {
        throw new Error(`Captured HTML missing from R2: ${page.html_r2_key}`);
      }

      const originalHtml = await capturedObject.text();
      const result = rewriteHtml(
        originalHtml,
        page.source_url,
        assetMap,
        pageMap,
      );
      const finalKey = `${job.output_prefix}/site/${page.output_path || "index.html"}`;

      await env.STORAGE.put(finalKey, result.html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          rewritten: "true",
          version: VERSION,
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
    warnings: { css: cssWarnings, pages: pageWarnings },
  };

  const manifestKey = `${job.output_prefix}/site/migration-manifest.json`;
  await env.STORAGE.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      jobId,
      generatedBy: `static-site-migrator-${VERSION}`,
    },
  });

  const successful = pageWarnings.length === 0;
  const stage = successful
    ? "pages_rewritten"
    : "pages_rewritten_with_warnings";
  const updatedAt = now();

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='processing', current_stage=?, progress_percent=?,
          warning_count=warning_count+?, updated_at=? WHERE id=?
    `).bind(
      stage,
      successful ? 82 : 80,
      cssWarnings.length + pageWarnings.length,
      updatedAt,
      jobId,
    ),
    eventStatement(
      env,
      jobId,
      successful ? "info" : "warning",
      stage,
      successful
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
      updatedAt,
    ),
  ]);

  return {
    success: successful,
    continueOnWarning: true,
    jobId,
    status: "processing",
    currentStage: stage,
    progressPercent: successful ? 82 : 80,
    rewrittenPages: rewrittenPages.length,
    rewrittenStylesheets: rewrittenCss.length,
    downloadedAssets: downloadedAssets.length,
    blockedAssets: blockedAssets.length,
    manifestKey,
    pages: rewrittenPages,
    cssWarnings,
    pageWarnings,
  };
}

async function applyAnimationPass(jobId, env) {
  const state = await loadGeneratedPages(jobId, env);
  if (state.errorResult) return state.errorResult;

  const startedAt = now();
  await updateJobStage(env, jobId, "processing", "fixing_duda_animations", 90);
  await addEvent(
    env,
    jobId,
    "info",
    "fixing_duda_animations",
    "Duda animation final-state pass started.",
    { pages: state.pages.length },
    startedAt,
  );

  const processed = [];
  const warnings = [];

  for (const page of state.pages) {
    const outputPath = page.output_path || "index.html";
    const key = `${state.job.output_prefix}/site/${outputPath}`;

    try {
      const object = await env.STORAGE.get(key);
      if (!object?.body) throw new Error(`Generated page missing: ${key}`);

      let html = await object.text();
      html = removeAnimationPayload(html);
      html = appendToBody(html, animationPayload());

      await env.STORAGE.put(key, html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          version: VERSION,
          lastStaticPass: "animations",
        },
      });

      processed.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        outputPath,
      });
    } catch (error) {
      warnings.push({
        pageId: page.id,
        sourceUrl: page.source_url,
        error: errorMessage(error),
      });
    }
  }

  const success = warnings.length === 0;
  const stage = success
    ? "duda_animations_finalised"
    : "duda_animations_finalised_with_warnings";
  await updateJobStage(env, jobId, "processing", stage, success ? 95 : 94, {
    warning_increment: warnings.length,
  });
  await addEvent(
    env,
    jobId,
    success ? "info" : "warning",
    stage,
    success
      ? "Duda animation final-state pass completed."
      : "Duda animation final-state pass completed with warnings.",
    { pagesProcessed: processed.length, warnings: warnings.length },
    now(),
  );

  return {
    success,
    continueOnWarning: true,
    jobId,
    status: "processing",
    currentStage: stage,
    progressPercent: success ? 95 : 94,
    pagesProcessed: processed.length,
    pages: processed,
    warnings,
  };
}

async function completeMigration(jobId, env, note = null) {
  const completedAt = now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='completed', current_stage='completed', progress_percent=100,
          updated_at=?, completed_at=? WHERE id=?
    `).bind(completedAt, completedAt, jobId),
    eventStatement(
      env,
      jobId,
      "info",
      "completed",
      "Migration pipeline completed.",
      note ? { note } : null,
      completedAt,
    ),
  ]);

  return {
    success: true,
    completed: true,
    jobId,
    status: "completed",
    currentStage: "completed",
    progressPercent: 100,
  };
}

async function loadGeneratedPages(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) return { errorResult: notFoundResult() };

  const result = await env.DB.prepare(`
    SELECT id, source_url, output_path
    FROM migration_pages
    WHERE job_id=? AND status='captured'
    ORDER BY source_url
  `).bind(jobId).all();
  const pages = result.results || [];

  if (!pages.length) {
    return {
      errorResult: {
        success: false,
        statusCode: 409,
        error: "No generated pages are available.",
      },
    };
  }

  return { job, pages };
}

async function applyManualOverrides(jobId, request, env) {
  const state = await loadGeneratedPages(jobId, env);
  if (state.errorResult) return responseFromResult(state.errorResult);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "A JSON request body is required." }, 400);
  }

  const incoming = Array.isArray(body?.overrides) ? body.overrides : [];
  if (!incoming.length) {
    return json({ success: false, error: "Provide at least one override." }, 400);
  }

  const pagePaths = new Set(
    state.pages.map((page) => page.output_path || "index.html"),
  );
  const overrides = [];

  for (const item of incoming) {
    const page = String(item?.page || "").replace(/^\/+/, "");
    const widgetId = String(item?.widgetId || "").trim();
    const action = String(item?.action || "hide").toLowerCase();
    const scope = String(item?.scope || "widget").toLowerCase();
    const note = String(item?.note || "").slice(0, 500);

    if (!pagePaths.has(page)) {
      return json({ success: false, error: `Unknown generated page: ${page}` }, 400);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(widgetId)) {
      return json({ success: false, error: `Invalid widgetId: ${widgetId}` }, 400);
    }
    if (action !== "hide") {
      return json({ success: false, error: `Unsupported action: ${action}` }, 400);
    }
    if (!["widget", "row"].includes(scope)) {
      return json({ success: false, error: `Unsupported scope: ${scope}` }, 400);
    }

    overrides.push({ page, widgetId, action, scope, note });
  }

  const grouped = new Map();
  for (const rule of overrides) {
    if (!grouped.has(rule.page)) grouped.set(rule.page, []);
    grouped.get(rule.page).push(rule);
  }

  const processed = [];
  const warnings = [];

  for (const page of state.pages) {
    const outputPath = page.output_path || "index.html";
    const pageRules = grouped.get(outputPath) || [];
    if (!pageRules.length) continue;

    const key = `${state.job.output_prefix}/site/${outputPath}`;
    try {
      const object = await env.STORAGE.get(key);
      if (!object?.body) throw new Error(`Generated page missing: ${key}`);

      let html = await object.text();
      html = removeOverridePayload(html);
      html = appendToBody(html, overridePayload(pageRules));

      await env.STORAGE.put(key, html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: {
          jobId,
          pageId: page.id,
          sourceUrl: page.source_url,
          version: VERSION,
          manualOverrides: String(pageRules.length),
        },
      });

      processed.push({
        pageId: page.id,
        outputPath,
        overridesApplied: pageRules.length,
      });
    } catch (error) {
      warnings.push({
        pageId: page.id,
        outputPath,
        error: errorMessage(error),
      });
    }
  }

  const report = {
    version: VERSION,
    jobId,
    updatedAt: now(),
    overrides,
    warnings,
  };
  const reportKey = `${state.job.output_prefix}/site/manual-overrides.json`;
  await env.STORAGE.put(reportKey, JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId, generatedBy: `static-site-migrator-${VERSION}` },
  });

  const success = warnings.length === 0;
  const stage = success
    ? "manual_overrides_applied"
    : "manual_overrides_applied_with_warnings";
  await updateJobStage(env, jobId, "processing", stage, success ? 99 : 98, {
    warning_increment: warnings.length,
  });

  return json({
    success,
    jobId,
    currentStage: stage,
    progressPercent: success ? 99 : 98,
    overridesApplied: overrides.length,
    pagesProcessed: processed.length,
    reportKey,
    pages: processed,
    warnings,
  });
}

async function getManualOverrides(jobId, env) {
  const job = await getJob(jobId, env);
  if (!job) {
    return json({ success: false, error: "Migration job not found." }, 404);
  }

  const key = `${job.output_prefix}/site/manual-overrides.json`;
  const object = await env.STORAGE.get(key);
  if (!object?.body) {
    return json({ success: true, jobId, overrides: [] });
  }

  return new Response(await object.text(), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function servePreview(jobId, requestedPath, env) {
  const job = await getJob(jobId, env);
  if (!job) return new Response("Preview job not found.", { status: 404 });

  let path;
  try {
    path = decodeURIComponent(requestedPath || "/").replace(/^\/+/, "");
  } catch {
    return new Response("Invalid preview path.", { status: 400 });
  }

  if (!path) path = "index.html";
  if (path.endsWith("/")) path += "index.html";
  if (path.includes("..") || path.includes("\\")) {
    return new Response("Invalid preview path.", { status: 400 });
  }

  const choices = [path];
  if (!hasFileExtension(path)) choices.push(`${path}/index.html`);

  let object = null;
  let resolved = null;
  for (const choice of choices) {
    object = await env.STORAGE.get(`${job.output_prefix}/site/${choice}`);
    if (object?.body) {
      resolved = choice;
      break;
    }
  }

  if (!object?.body || !resolved) {
    return new Response("Preview file not found.", { status: 404 });
  }

  const type = object.httpMetadata?.contentType || contentType(resolved);
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex,nofollow",
  });
  const prefix = `/preview/${encodeURIComponent(jobId)}`;

  if (/text\/html/i.test(type)) {
    return new Response(prefixUrls(await object.text(), prefix), {
      status: 200,
      headers,
    });
  }
  if (/text\/css/i.test(type)) {
    return new Response(prefixCss(await object.text(), prefix), {
      status: 200,
      headers,
    });
  }
  return new Response(object.body, { status: 200, headers });
}

async function renderedHtml(env, url) {
  let lastError;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
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
        throw new Error(
          result?.errors?.[0]?.message || result?.error || "Browser Run failed.",
        );
      }
      if (typeof result.result !== "string" || result.result.length < 100) {
        throw new Error("Browser Run did not return usable rendered HTML.");
      }

      return { html: result.result, meta: result.meta || {} };
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        const delay = /rate limit|429/i.test(errorMessage(error))
          ? 5000 * attempt
          : 2000 * attempt;
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error("Browser Run failed.");
}

async function fetchAsset(url, referer) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      Referer: referer,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const body = await response.arrayBuffer();
  if (!body.byteLength) throw new Error("Downloaded asset is zero bytes.");

  return {
    body,
    byteSize: body.byteLength,
    status: response.status,
    contentType: response.headers.get("content-type") || contentType(url),
  };
}

function discoverInternalPages(html, sourceUrl) {
  const urls = new Set([comparableUrl(sourceUrl.href)]);
  const pattern = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match;

  while ((match = pattern.exec(html)) !== null) {
    const href = decodeHtml(match[2]?.trim() || "");
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) continue;

    try {
      const url = new URL(href, sourceUrl.href);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      if (normaliseHostname(url.hostname) !== normaliseHostname(sourceUrl.hostname)) {
        continue;
      }
      if (/\.(?:css|js|json|jpe?g|png|gif|webp|svg|ico|pdf|zip|mp3|mp4|woff2?|ttf|otf)$/i.test(url.pathname)) {
        continue;
      }
      url.hash = "";
      removeTracking(url);
      urls.add(comparableUrl(url.href));
    } catch {
      // Ignore malformed links.
    }
  }

  return [...urls].sort();
}

function extractAssets(html, pageUrl) {
  const assets = [];
  const seen = new Set();

  const add = (rawValue, hint = null) => {
    const value = decodeHtml(String(rawValue || "").trim());
    if (!value || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) {
      return;
    }
    if (value.includes("${")) return;

    try {
      const url = new URL(value, pageUrl);
      url.hash = "";
      if (!/^https?:$/.test(url.protocol) || seen.has(url.href)) return;

      const assetType = hint || assetKind(url);
      if (!assetType) return;

      seen.add(url.href);
      assets.push({
        sourceUrl: url.href,
        assetType,
        outputPath: assetOutputPath(url, assetType),
      });
    } catch {
      // Ignore malformed references.
    }
  };

  let match;

  const linkPattern = /<link\b[^>]*>/gi;
  while ((match = linkPattern.exec(html)) !== null) {
    const tag = match[0];
    const href = attributeValue(tag, "href");
    const rel = String(attributeValue(tag, "rel") || "").toLowerCase();
    if (!href) continue;
    if (rel.includes("stylesheet")) add(href, "stylesheet");
    else if (rel.includes("icon")) add(href, "image");
    else if (rel.includes("preload")) add(href, assetKind(new URL(href, pageUrl)));
  }

  const scriptPattern = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  while ((match = scriptPattern.exec(html)) !== null) add(match[2], "script");

  const mediaPattern = /<(?:img|source|video|audio|iframe)\b[^>]*>/gi;
  while ((match = mediaPattern.exec(html)) !== null) {
    const tag = match[0];
    for (const attribute of ["src", "poster", "data-src", "data-image-url"]) {
      const value = attributeValue(tag, attribute);
      if (value) add(value, attribute === "poster" ? "image" : null);
    }
    const srcset = attributeValue(tag, "srcset");
    if (srcset) {
      for (const candidate of srcset.split(",")) {
        add(candidate.trim().split(/\s+/)[0], "image");
      }
    }
  }

  const cssUrlPattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  while ((match = cssUrlPattern.exec(html)) !== null) add(match[2]);

  return assets;
}

function attributeValue(tag, attribute) {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"),
  );
  return match?.[2] || null;
}

function assetKind(url) {
  const path = url.pathname.toLowerCase();
  if (/\.css$/.test(path)) return "stylesheet";
  if (/\.m?js$/.test(path)) return "script";
  if (/\.(?:woff2?|ttf|otf|eot)$/.test(path)) return "font";
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|avif)$/.test(path)) return "image";
  if (/\.(?:mp4|webm|mov|m4v)$/.test(path)) return "video";
  if (/\.(?:mp3|wav|ogg|m4a)$/.test(path)) return "audio";
  if (/\.(?:pdf|zip|docx?|xlsx?|pptx?)$/.test(path)) return "download";
  return "other";
}

function assetOutputPath(url, assetType) {
  const typeFolder = {
    stylesheet: "assets/css",
    script: "assets/js",
    font: "assets/fonts",
    image: "assets/images",
    video: "assets/video",
    audio: "assets/audio",
    download: "assets/downloads",
    other: "assets/other",
  }[assetType] || "assets/other";

  let filename = decodeURIComponent(url.pathname.split("/").pop() || "asset")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!filename || filename === ".") filename = "asset";
  if (!/\.[A-Za-z0-9]{1,8}$/.test(filename)) {
    filename += extensionForType(assetType);
  }

  const suffix = shortHash(url.href);
  const dot = filename.lastIndexOf(".");
  filename = dot > 0
    ? `${filename.slice(0, dot)}-${suffix}${filename.slice(dot)}`
    : `${filename}-${suffix}`;

  return `${typeFolder}/${filename}`;
}

function extensionForType(assetType) {
  return {
    stylesheet: ".css",
    script: ".js",
    font: ".woff2",
    image: ".bin",
    video: ".bin",
    audio: ".bin",
    download: ".bin",
    other: ".bin",
  }[assetType] || ".bin";
}

function rewriteHtml(html, pageUrl, assetMap, pageMap) {
  let output = cleanMalformedQuotedUrls(html);
  let assetReplacements = 0;
  let internalLinkReplacements = 0;
  let removedRuntimeBlocks = 0;

  const orderedAssets = [...assetMap.entries()].sort(
    (a, b) => b[0].length - a[0].length,
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
    },
  );

  const removePatterns = [
    /<script\b[^>]*>[\s\S]*?runtime-service-worker\.js[\s\S]*?<\/script>/gi,
    /<script\b[^>]*src=["'][^"']*sp-2\.0\.0-dm-0\.1\.min\.js[^"']*["'][^>]*><\/script>/gi,
    /<script\b[^>]*id=["']d_track_campaign["'][^>]*>[\s\S]*?<\/script>/gi,
  ];

  for (const pattern of removePatterns) {
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
    },
  );
  return { css: output, replacements };
}

function animationPayload() {
  return `
<style id="static-migrator-animation-final-v190">
[data-static-migrator-animation-fixed="true"]{
  opacity:1!important;
  visibility:visible!important;
  transform:none!important;
  translate:none!important;
  animation:none!important;
  transition:none!important
}
</style>
<script id="static-migrator-animation-final-v190-script">
(function(){
  function insideSlider(el){
    return !!el.closest('[class*="hero" i],[class*="banner" i],[class*="carousel" i],[class*="slider" i],[class*="slideshow" i],[data-widget-type*="slider" i],[data-widget-type*="gallery" i]');
  }
  function deliberatelyHidden(el){
    if(el.hidden||el.getAttribute('aria-hidden')==='true')return true;
    var s=String(el.getAttribute('style')||'').toLowerCase();
    return /display\\s*:\\s*none|visibility\\s*:\\s*hidden/.test(s);
  }
  function run(){
    document.querySelectorAll('[data-anim-extended]').forEach(function(el){
      if(insideSlider(el)||deliberatelyHidden(el))return;
      el.setAttribute('data-static-migrator-animation-fixed','true');
      el.style.setProperty('opacity','1','important');
      el.style.setProperty('visibility','visible','important');
      el.style.setProperty('transform','none','important');
      el.style.setProperty('translate','none','important');
      el.style.setProperty('animation','none','important');
      el.style.setProperty('transition','none','important');
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run();
  window.addEventListener('load',run,{once:true});
})();
</script>`;
}

function removeAnimationPayload(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-animation-final-v\d+["'][^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*id=["']static-migrator-animation-final-v\d+-script["'][^>]*>[\s\S]*?<\/script>/gi, "");
}

function overridePayload(overrides) {
  const encoded = JSON.stringify(overrides).replace(/</g, "\\u003c");
  return `
<style id="static-migrator-manual-overrides-v190">
[data-static-migrator-manual-hidden="true"]{display:none!important}
</style>
<script id="static-migrator-manual-overrides-v190-script">
(function(){
  var rules=${encoded};
  function run(){
    rules.forEach(function(rule){
      var el=document.getElementById(rule.widgetId);
      if(!el){console.warn('Override target not found',rule);return;}
      var target=rule.scope==='row'
        ? (el.closest('.dmRespRow,[data-element-type="row"],.dmRespColsWrapper')||el)
        : el;
      target.setAttribute('data-static-migrator-manual-hidden','true');
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run();
})();
</script>`;
}

function removeOverridePayload(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-manual-overrides-v\d+["'][^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*id=["']static-migrator-manual-overrides-v\d+-script["'][^>]*>[\s\S]*?<\/script>/gi, "");
}

function appendToBody(html, payload) {
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${payload}\n</body>`)
    : `${html}\n${payload}`;
}

function prefixUrls(html, prefix) {
  let output = html.replace(
    /\b(href|src|poster|data-src|data-image-url)\s*=\s*(["'])\/(?!\/|preview\/)(.*?)\2/gi,
    (_, attribute, quote, value) =>
      `${attribute}=${quote}${prefix}/${value}${quote}`,
  );

  output = output.replace(
    /\bsrcset\s*=\s*(["'])(.*?)\1/gi,
    (whole, quote, value) => `srcset=${quote}${value
      .split(",")
      .map((item) => {
        const parts = item.trim().split(/\s+/);
        if (
          parts[0]?.startsWith("/") &&
          !parts[0].startsWith("//") &&
          !parts[0].startsWith("/preview/")
        ) {
          parts[0] = `${prefix}${parts[0]}`;
        }
        return parts.join(" ");
      })
      .join(", ")}${quote}`,
  );

  return prefixCss(output, prefix);
}

function prefixCss(value, prefix) {
  return value.replace(
    /url\(\s*(["']?)\/(?!\/|preview\/)(.*?)\1\s*\)/gi,
    (_, quote, path) => `url(${quote}${prefix}/${path}${quote})`,
  );
}

function cleanMalformedQuotedUrls(value) {
  return value
    .replace(
      /https:\/\/[^\s"'<>]+\/%22(https%3A%2F%2F[^"'<>]+)%22/gi,
      (_, encoded) => {
        try {
          return decodeURIComponent(encoded);
        } catch {
          return encoded;
        }
      },
    )
    .replace(/https:\/\/[^\s"'<>]+\/%22(https:\/\/[^"'<>]+)%22/gi, "$1");
}

async function getJob(jobId, env) {
  return env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?")
    .bind(jobId)
    .first();
}

async function getJobSettings(jobId, env) {
  const event = await env.DB.prepare(`
    SELECT details_json FROM migration_events
    WHERE job_id=? AND stage='created'
    ORDER BY created_at ASC, id ASC LIMIT 1
  `).bind(jobId).first();

  const details = parseJson(event?.details_json) || {};
  return {
    crawlDepth: clamp(numberOrDefault(details.crawlDepth, 3), 1, 10),
    maxPages: clamp(numberOrDefault(details.maxPages, 50), 1, 500),
    preserveSliders: details.preserveSliders !== false,
    flattenAnimations: details.flattenAnimations !== false,
    formEndpoint: details.formEndpoint || null,
    base44JobId: details.base44JobId || null,
  };
}

async function pageTotals(jobId, env) {
  const row = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN status='captured' THEN 1 ELSE 0 END) AS captured,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      COUNT(*) AS total
    FROM migration_pages WHERE job_id=?
  `).bind(jobId).first();

  return {
    captured: Number(row?.captured || 0),
    failed: Number(row?.failed || 0),
    total: Number(row?.total || 0),
  };
}

async function assetTotals(jobId, env) {
  const row = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN status='downloaded' THEN 1 ELSE 0 END) AS downloaded,
      SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN status='discovered' THEN 1 ELSE 0 END) AS remaining,
      COUNT(*) AS total
    FROM migration_assets WHERE job_id=?
  `).bind(jobId).first();

  return {
    downloaded: Number(row?.downloaded || 0),
    blocked: Number(row?.blocked || 0),
    remaining: Number(row?.remaining || 0),
    total: Number(row?.total || 0),
  };
}

async function dedupePages(jobId, env) {
  const rows = await env.DB.prepare(`
    SELECT id, source_url, status, created_at
    FROM migration_pages WHERE job_id=?
    ORDER BY source_url, CASE status WHEN 'captured' THEN 0 ELSE 1 END, created_at
  `).bind(jobId).all();

  const seen = new Set();
  const duplicateIds = [];
  for (const row of rows.results || []) {
    const key = comparableUrl(row.source_url);
    if (seen.has(key)) duplicateIds.push(row.id);
    else seen.add(key);
  }

  for (const id of duplicateIds) {
    await env.DB.prepare("DELETE FROM migration_pages WHERE id=?").bind(id).run();
  }
}

async function updateJobStage(
  env,
  jobId,
  status,
  stage,
  progress,
  extra = {},
) {
  const warningIncrement = Number(extra.warning_increment || 0);
  const discoveredPages = extra.discovered_pages;
  const capturedPages = extra.captured_pages;
  const downloadedAssets = extra.downloaded_assets;

  await env.DB.prepare(`
    UPDATE migration_jobs
    SET status=?, current_stage=?, progress_percent=?,
        warning_count=warning_count+?,
        discovered_pages=COALESCE(?, discovered_pages),
        captured_pages=COALESCE(?, captured_pages),
        downloaded_assets=COALESCE(?, downloaded_assets),
        updated_at=?
    WHERE id=?
  `).bind(
    status,
    stage,
    progress,
    warningIncrement,
    discoveredPages ?? null,
    capturedPages ?? null,
    downloadedAssets ?? null,
    now(),
    jobId,
  ).run();
}

async function addEvent(env, jobId, level, stage, message, details, createdAt) {
  await eventStatement(
    env,
    jobId,
    level,
    stage,
    message,
    details,
    createdAt || now(),
  ).run();
}

function eventStatement(env, jobId, level, stage, message, details, createdAt) {
  return env.DB.prepare(`
    INSERT INTO migration_events (
      job_id, level, stage, message, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    jobId,
    level,
    stage,
    message,
    details == null ? null : JSON.stringify(details),
    createdAt,
  );
}

async function failStage(env, jobId, stage, error) {
  const updatedAt = now();
  const message = errorMessage(error);
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE migration_jobs
      SET status='failed', current_stage=?, error_count=error_count+1,
          updated_at=? WHERE id=?
    `).bind(stage, updatedAt, jobId),
    eventStatement(env, jobId, "error", stage, message, null, updatedAt),
  ]);

  return { success: false, jobId, status: "failed", currentStage: stage, error: message };
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

function normaliseComparableUrl(value) {
  return comparableUrl(value);
}

function normaliseUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function outputPath(pageUrl) {
  const url = new URL(pageUrl);
  if (url.pathname === "/" && !url.search) return "index.html";

  let path = url.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9/_-]/g, "-")
    .replace(/-+/g, "-") || "home";

  if (url.search) path += `--${shortHash(url.search)}`;
  return `${path}/index.html`;
}

function outputPathToPublicUrl(outputPathValue) {
  if (!outputPathValue || outputPathValue === "index.html") return "/";
  return `/${outputPathValue
    .replace(/\/index\.html$/i, "")
    .replace(/^\/+/, "")}/`;
}

function normaliseHostname(value) {
  return String(value || "").toLowerCase().replace(/^www\./, "");
}

function removeTracking(url) {
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
}

function shortHash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function countBy(values, selector) {
  const output = {};
  for (const value of values) {
    const key = selector(value);
    output[key] = (output[key] || 0) + 1;
  }
  return output;
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
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function hasFileExtension(path) {
  return /\.[a-zA-Z0-9]{1,10}$/.test(path.split("?")[0]);
}

function contentType(path) {
  const pathname = (() => {
    try {
      return new URL(path, "https://example.invalid").pathname.toLowerCase();
    } catch {
      return String(path || "").toLowerCase();
    }
  })();

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
    [".avif", "image/avif"],
    [".svg", "image/svg+xml"],
    [".ico", "image/x-icon"],
    [".woff2", "font/woff2"],
    [".woff", "font/woff"],
    [".ttf", "font/ttf"],
    [".otf", "font/otf"],
    [".mp4", "video/mp4"],
    [".webm", "video/webm"],
    [".mp3", "audio/mpeg"],
    [".pdf", "application/pdf"],
  ];

  for (const [extension, type] of types) {
    if (pathname.endsWith(extension)) return type;
  }
  return "application/octet-stream";
}

function sanitiseProjectName(value) {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 58);
  return cleaned || "static-site";
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value)));
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error || "Unexpected server error.");
}

function notFoundResult() {
  return {
    success: false,
    statusCode: 404,
    error: "Migration job not found.",
  };
}

function responseFromResult(result) {
  return json(result, result?.statusCode || (result?.success === false ? 500 : 200));
}

function validateBindings(env) {
  const missing = [];
  if (!env.BROWSER) missing.push("BROWSER");
  if (!env.DB) missing.push("DB");
  if (!env.STORAGE) missing.push("STORAGE");
  if (missing.length) {
    throw new Error(`Missing Cloudflare binding(s): ${missing.join(", ")}`);
  }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}
