const VERSION = "1.8.0";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (!env.DB || !env.STORAGE) throw new Error("Missing DB or STORAGE binding.");

      if (request.method === "GET" && path === "/") {
        return json({ success: true, service: "Static Site Migrator Engine", version: VERSION, status: "online" });
      }

      const preview = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (request.method === "GET" && preview) {
        return servePreview(decodeURIComponent(preview[1]), preview[2] || "/", env);
      }

      if (request.method === "POST" && path === "/api/migrations") {
        return createMigration(request, url, env);
      }

      let match = path.match(/^\/api\/migrations\/([^/]+)$/);
      if (request.method === "GET" && match) {
        return readMigration(decodeURIComponent(match[1]), url, env);
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/apply-overrides$/);
      if (request.method === "POST" && match) {
        return applyManualOverrides(decodeURIComponent(match[1]), request, env);
      }

      match = path.match(/^\/api\/migrations\/([^/]+)\/overrides$/);
      if (request.method === "GET" && match) {
        return getManualOverrides(decodeURIComponent(match[1]), env);
      }

      return json({ success: false, error: "Route not found." }, 404);
    } catch (error) {
      console.error(error);
      return json({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};

async function createMigration(request, requestUrl, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "A JSON request body is required." }, 400); }

  const rawUrl = String(body?.sourceUrl || body?.source_url || "").trim();
  if (!rawUrl) return json({ success: false, error: "sourceUrl is required." }, 400);

  let source;
  try {
    source = new URL(rawUrl);
    if (!/^https?:$/.test(source.protocol)) throw new Error();
    source.hash = "";
  } catch {
    return json({ success: false, error: "sourceUrl must be a valid HTTP or HTTPS URL." }, 400);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const outputPrefix = `migrations/${id}`;
  const projectName = sanitiseProjectName(body?.projectName || body?.cloudflare_project_name || source.hostname);

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO migration_jobs (
      id, source_url, source_hostname, status, current_stage, progress_percent,
      discovered_pages, captured_pages, downloaded_assets, warning_count, error_count,
      output_prefix, pages_project_name, deployment_url, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, 'queued', 'created', 0, 0, 0, 0, 0, 0, ?, ?, NULL, ?, ?, NULL)`)
      .bind(id, source.href, source.hostname, outputPrefix, projectName, createdAt, createdAt),
    env.DB.prepare(`INSERT INTO migration_events (
      job_id, level, stage, message, details_json, created_at
    ) VALUES (?, 'info', 'created', 'Migration job created from Base44.', ?, ?)`)
      .bind(id, JSON.stringify({
        sourceUrl: source.href,
        crawlDepth: numberOrDefault(body?.crawlDepth ?? body?.crawl_depth, 3),
        maxPages: numberOrDefault(body?.maxPages ?? body?.max_pages, 50),
        preserveSliders: Boolean(body?.preserveSliders ?? body?.preserve_sliders ?? true),
        flattenAnimations: Boolean(body?.flattenAnimations ?? body?.flatten_animations ?? true),
        formEndpoint: body?.formEndpoint || body?.form_endpoint || null,
        base44JobId: body?.base44JobId || body?.base44_job_id || null,
      }), createdAt),
  ]);

  const origin = requestUrl.origin;
  return json({
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
      previewUrl: `${origin}/preview/${id}/`,
    },
  }, 201);
}

async function readMigration(jobId, requestUrl, env) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);

  const [pagesResult, assetsResult, eventsResult] = await Promise.all([
    env.DB.prepare("SELECT * FROM migration_pages WHERE job_id=? ORDER BY source_url").bind(jobId).all(),
    env.DB.prepare("SELECT * FROM migration_assets WHERE job_id=? ORDER BY asset_type, source_url").bind(jobId).all(),
    env.DB.prepare("SELECT * FROM migration_events WHERE job_id=? ORDER BY created_at, id").bind(jobId).all(),
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
      preview: `${origin}/preview/${jobId}/`,
      overrides: `${origin}/api/migrations/${jobId}/overrides`,
    },
  });
}

async function loadGeneratedPages(jobId, env) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if (!job) return { error: json({ success: false, error: "Migration job not found." }, 404) };
  const result = await env.DB.prepare("SELECT id,source_url,output_path FROM migration_pages WHERE job_id=? AND status='captured' ORDER BY source_url").bind(jobId).all();
  const pages = result.results || [];
  if (!pages.length) return { error: json({ success: false, error: "No generated pages are available." }, 409) };
  return { job, pages };
}

async function applyManualOverrides(jobId, request, env) {
  const state = await loadGeneratedPages(jobId, env);
  if (state.error) return state.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "A JSON request body is required." }, 400); }

  const incoming = Array.isArray(body?.overrides) ? body.overrides : [];
  if (!incoming.length) return json({ success: false, error: "Provide at least one override." }, 400);

  const pagePaths = new Set(state.pages.map((page) => page.output_path || "index.html"));
  const overrides = [];
  for (const item of incoming) {
    const page = String(item?.page || "").replace(/^\/+/, "");
    const widgetId = String(item?.widgetId || "").trim();
    const action = String(item?.action || "hide").toLowerCase();
    const scope = String(item?.scope || "widget").toLowerCase();
    const note = String(item?.note || "").slice(0, 500);

    if (!pagePaths.has(page)) return json({ success: false, error: `Unknown generated page: ${page}` }, 400);
    if (!/^[A-Za-z0-9_-]+$/.test(widgetId)) return json({ success: false, error: `Invalid widgetId: ${widgetId}` }, 400);
    if (action !== "hide") return json({ success: false, error: `Unsupported action: ${action}` }, 400);
    if (!new Set(["widget", "row"]).has(scope)) return json({ success: false, error: `Unsupported scope: ${scope}` }, 400);
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
        customMetadata: { jobId, pageId: page.id, sourceUrl: page.source_url, version: VERSION, manualOverrides: String(pageRules.length) },
      });
      processed.push({ pageId: page.id, outputPath, overridesApplied: pageRules.length });
    } catch (error) {
      warnings.push({ pageId: page.id, outputPath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const report = { version: VERSION, jobId, updatedAt: new Date().toISOString(), overrides, warnings };
  const reportKey = `${state.job.output_prefix}/site/manual-overrides.json`;
  await env.STORAGE.put(reportKey, JSON.stringify(report, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId, generatedBy: `static-site-migrator-${VERSION}` },
  });

  const success = warnings.length === 0;
  const stage = success ? "manual_overrides_applied" : "manual_overrides_applied_with_warnings";
  await env.DB.prepare("UPDATE migration_jobs SET current_stage=?,progress_percent=?,updated_at=? WHERE id=?")
    .bind(stage, success ? 99 : 98, new Date().toISOString(), jobId).run();

  return json({ success, jobId, currentStage: stage, progressPercent: success ? 99 : 98, overridesApplied: overrides.length, pagesProcessed: processed.length, reportKey, pages: processed, warnings });
}

async function getManualOverrides(jobId, env) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if (!job) return json({ success: false, error: "Migration job not found." }, 404);
  const key = `${job.output_prefix}/site/manual-overrides.json`;
  const object = await env.STORAGE.get(key);
  if (!object?.body) return json({ success: true, jobId, overrides: [] });
  return new Response(await object.text(), { status: 200, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
}

function overridePayload(overrides) {
  const encoded = JSON.stringify(overrides).replace(/</g, "\\u003c");
  return `\n<style id="static-migrator-manual-overrides-v180">[data-static-migrator-manual-hidden="true"]{display:none!important}</style>\n<script id="static-migrator-manual-overrides-v180-script">(function(){var rules=${encoded};function run(){rules.forEach(function(rule){var el=document.getElementById(rule.widgetId);if(!el){console.warn('Override target not found',rule);return}var target=rule.scope==='row'?(el.closest('.dmRespRow,[data-element-type="row"],.dmRespColsWrapper')||el):el;target.setAttribute('data-static-migrator-manual-hidden','true')})}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run()})();</script>`;
}

function removeOverridePayload(html) {
  return html
    .replace(/<style\b[^>]*id=["']static-migrator-manual-overrides-v1(?:70|80)["'][^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*id=["']static-migrator-manual-overrides-v1(?:70|80)-script["'][^>]*>[\s\S]*?<\/script>/gi, "");
}

async function servePreview(jobId, requestedPath, env) {
  const job = await env.DB.prepare("SELECT * FROM migration_jobs WHERE id=?").bind(jobId).first();
  if (!job) return new Response("Preview job not found.", { status: 404 });

  let path;
  try { path = decodeURIComponent(requestedPath || "/").replace(/^\/+/, ""); }
  catch { return new Response("Invalid preview path.", { status: 400 }); }

  if (!path) path = "index.html";
  if (path.endsWith("/")) path += "index.html";
  if (path.includes("..") || path.includes("\\")) return new Response("Invalid preview path.", { status: 400 });

  const choices = [path];
  if (!/\.[a-z0-9]{1,10}$/i.test(path)) choices.push(`${path}/index.html`);
  let object = null;
  let resolved = null;
  for (const choice of choices) {
    object = await env.STORAGE.get(`${job.output_prefix}/site/${choice}`);
    if (object?.body) { resolved = choice; break; }
  }
  if (!object?.body || !resolved) return new Response("Preview file not found.", { status: 404 });

  const type = object.httpMetadata?.contentType || contentType(resolved);
  const headers = new Headers({ "Content-Type": type, "Cache-Control": "no-store", "X-Robots-Tag": "noindex,nofollow" });
  const prefix = `/preview/${encodeURIComponent(jobId)}`;
  if (/text\/html/i.test(type)) return new Response(prefixUrls(await object.text(), prefix), { status: 200, headers });
  if (/text\/css/i.test(type)) return new Response(prefixCss(await object.text(), prefix), { status: 200, headers });
  return new Response(object.body, { status: 200, headers });
}

function prefixUrls(html, prefix) {
  let out = html.replace(/\b(href|src|poster|data-src|data-image-url)\s*=\s*(["'])\/(?!\/|preview\/)(.*?)\2/gi,
    (_, attr, quote, value) => `${attr}=${quote}${prefix}/${value}${quote}`);
  out = out.replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (whole, quote, value) => `srcset=${quote}${value.split(",").map((item) => {
    const parts = item.trim().split(/\s+/);
    if (parts[0]?.startsWith("/") && !parts[0].startsWith("//") && !parts[0].startsWith("/preview/")) parts[0] = `${prefix}${parts[0]}`;
    return parts.join(" ");
  }).join(", ")}${quote}`);
  return prefixCss(out, prefix);
}

function prefixCss(value, prefix) {
  return value.replace(/url\(\s*(["']?)\/(?!\/|preview\/)(.*?)\1\s*\)/gi, (_, quote, path) => `url(${quote}${prefix}/${path}${quote})`);
}

function appendToBody(html, payload) {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${payload}\n</body>`) : `${html}\n${payload}`;
}

function sanitiseProjectName(value) {
  const result = String(value || "migrated-site").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 58);
  return result || "migrated-site";
}
function numberOrDefault(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback; }
function parseJson(value) { try { return value ? JSON.parse(value) : null; } catch { return value; } }
function contentType(path) { const p = path.toLowerCase(); for (const [ext, type] of [[".html","text/html; charset=utf-8"],[".css","text/css; charset=utf-8"],[".js","application/javascript"],[".json","application/json"],[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".webp","image/webp"],[".svg","image/svg+xml"],[".woff2","font/woff2"],[".woff","font/woff"]]) if (p.endsWith(ext)) return type; return "application/octet-stream"; }
function json(data, status = 200) { return Response.json(data, { status, headers: CORS }); }
