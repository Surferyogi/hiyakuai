// hiyaku-inbox — Gmail job-alert ingestion for HiyakuAI  v2 (2026-08-05)
// Phase 1. Separate from hiyaku-generate, which is untouched and keeps verify_jwt on.
//
// Deployed with --no-verify-jwt. Access is controlled by a shared secret header.
// This function can ONLY write to hiyaku_inbox_jobs / hiyaku_inbox_runs.
// It never writes to hiyaku_applications, hiyaku_profile, hiyaku_sections,
// hiyaku_links or hiyaku_certificates.
//
// Actions:
//   status  -> { watermark, lastRun }
//   ingest  -> parse alert emails into staged job rows
//   digest  -> return un-alerted "look" rows and stamp alerted_at
//
// Required secret: HIYAKU_INBOX_SECRET
// Optional secrets: HIYAKU_OWNER_USER_ID, HIYAKU_INBOX_MODEL
// Uses existing secret: ANTHROPIC_API_KEY
// Auto-provided by Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

// Environment is read lazily, per request, NOT at module scope. Reading at
// module scope froze an empty ANTHROPIC_API_KEY into the isolate on cold start
// and produced a 401 on every call. hiyaku-generate reads inside its handler,
// which is why it was unaffected. Values are trimmed: a trailing newline in a
// pasted secret is invisible and produces the same 401.
const env = (k: string, fallback = "") => {
  const v = Deno.env.get(k);
  return v === undefined || v === null ? fallback : String(v).trim();
};
const MODEL_DEFAULT = "claude-sonnet-4-6";

const SOURCES = ["linkedin", "glassdoor", "mycareersfuture"];

const JSON_HEADERS = { "Content-Type": "application/json" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// ---------------------------------------------------------------- PostgREST

async function pg(
  path: string,
  init: RequestInit & { prefer?: string } = {},
): Promise<Response> {
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const headers: Record<string, string> = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };
  if (init.prefer) headers["Prefer"] = init.prefer;
  return await fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, { ...init, headers });
}

async function pgJson(path: string, init: RequestInit & { prefer?: string } = {}) {
  const res = await pg(path, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// Single-user app. Prefer the explicit secret; otherwise fall back to the sole
// row in hiyaku_profile. Refuse to guess if that is ambiguous.
async function resolveUserId(): Promise<string> {
  const ownerEnv = env("HIYAKU_OWNER_USER_ID");
  if (ownerEnv) return ownerEnv;
  const rows = await pgJson("hiyaku_profile?select=user_id&limit=2");
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(
      "cannot resolve owner user_id: set HIYAKU_OWNER_USER_ID secret",
    );
  }
  return rows[0].user_id;
}

// ---------------------------------------------------------------- utilities

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Non-reversible fingerprint of a secret. Lets us tell whether a value has
// changed between deploys without ever exposing it.
async function fingerprint(value: string): Promise<string> {
  if (!value) return "";
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function makeDedupKey(company: string, title: string): string {
  return `${norm(company)}|${norm(title)}`;
}

// Restores the exact original URL for a token. The model never sees or emits
// a URL, so nothing can be truncated or reconstructed. An unknown token
// resolves to empty rather than to a guess.
function resolveToken(v: string, map: Record<string, string>): string {
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  const key = (v.match(/L\d+/i) || [""])[0].toUpperCase();
  return key && map[key] ? map[key] : "";
}

function notStated(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return s === "" || s === "not stated" || s === "n/a" || s === "null";
}

function clean(v: unknown): string {
  return notStated(v) ? "" : String(v).trim();
}

// ------------------------------------------------------------ rule triage
//
// Deliberately permissive. The expensive error for a C-suite search is the
// false negative, so "skip" requires an unambiguous signal. Everything not
// clearly senior and not clearly junior lands in "maybe".

const SENIOR_PATTERNS = [
  /\bchief\b/i, /\bceo\b/i, /\bcoo\b/i, /\bcto\b/i, /\bcfo\b/i,
  /\bpresident\b/i, /\bmanaging director\b/i, /\bgeneral manager\b/i,
  /\bcountry (manager|director|head|lead)\b/i,
  /\bregional (director|head|lead|manager|vice president)\b/i,
  /\bhead of\b/i, /\bvice president\b/i, /\bsvp\b/i, /\bevp\b/i, /\bvp\b/i,
  /\bpartner\b/i, /\bboard member\b/i, /\bsite director\b/i,
  /\bglobal (head|director|lead)\b/i,
];

// Junior markers OVERRIDE senior markers. A real C-suite title never contains
// these words, whereas a senior word can appear as a department name:
// "Associate/Analyst, Corporate Account Services, Group COO" matched \bcoo\b
// and was wrongly promoted to "look".
const JUNIOR_PATTERNS = [
  /\bintern(ship)?\b/i, /\btrainee\b/i, /\bapprentice\b/i, /\bgraduate\b/i,
  /\bjunior\b/i, /\bassistant\b/i, /\bexecutive assistant\b/i,
  /\bfresh\b/i, /\bentry.?level\b/i, /\bpart.?time\b/i,
  /\bcoordinator\b/i, /\bclerk\b/i, /\btechnician\b/i, /\bofficer\b/i,
  /\bassociate\b/i, /\banalyst\b/i, /\brepresentative\b/i,
  /\bconsultant\b/i, /\bexecutive,/i, /\bsupervisor\b/i,
];

function triageRecord(
  rec: Record<string, unknown>,
  allowedLocations: string[],
): { triage: string; reason: string } {
  const title = String(rec.role_title || "");
  const location = String(rec.location || "");
  const reasons: string[] = [];

  // Location NEVER causes a skip.
  // Glassdoor reports Singapore districts rather than the country: Tuas,
  // Tampines New Town, Old Kallang Airport Estate, North-East. Matching those
  // against a country name binned 50 out of 50 valid roles. Location is now a
  // positive signal only; it can add to the reason, never remove a record.
  const locMatch = allowedLocations.length > 0 &&
    allowedLocations.some((l) => norm(location).includes(norm(l)));

  const senior = SENIOR_PATTERNS.some((p) => p.test(title));
  const junior = JUNIOR_PATTERNS.some((p) => p.test(title));

  if (junior) {
    return { triage: "skip", reason: `title indicates junior level: ${title}` };
  }
  if (senior) {
    reasons.push("senior title pattern matched");
    if (locMatch) reasons.push(`location matched: ${location}`);
    if (typeof rec.alumni_count === "number" && (rec.alumni_count as number) > 0) {
      reasons.push(`${rec.alumni_count} alumni at company`);
    }
    if (rec.salary_basis === "posted" && !notStated(rec.salary_text)) {
      reasons.push(`posted salary ${rec.salary_text}`);
    }
    return { triage: "look", reason: reasons.join("; ") };
  }
  return {
    triage: "maybe",
    reason: "title does not clearly indicate level from email alone",
  };
}

// ------------------------------------------------------- MyCareersFuture API
//
// Verified public, unauthenticated. Landing pages are client-rendered and
// return an empty shell, so the API is the only way to resolve the full text.

function mcfUuidFromUrl(url: string): string {
  // MyCareersFuture links arrive wrapped in an AWS tracking redirect with the
  // real URL percent-encoded inside, so the UUID is mid-string, not at the end.
  // Decode where possible, then take the first 32-hex run. The wrapper's own
  // identifiers are dash-separated and never produce a 32-character run.
  let u = url;
  try { u = decodeURIComponent(url); } catch (_e) { /* keep raw */ }
  const m = u.match(/[0-9a-f]{32}/i);
  return m ? m[0] : "";
}

async function enrichFromMcf(url: string) {
  const uuid = mcfUuidFromUrl(url);
  if (!uuid) return null;
  try {
    const res = await fetch(`https://api.mycareersfuture.gov.sg/v2/jobs/${uuid}`);
    if (!res.ok) return null;
    const j = await res.json();
    const sal = j?.salary;
    const salaryText = sal && sal.minimum && sal.maximum
      ? `SGD ${sal.minimum}-${sal.maximum} ${sal?.type?.salaryType ?? ""}`.trim()
      : "";
    return {
      external_id: uuid,
      company: j?.postedCompany?.name ?? "",
      role_title: j?.title ?? "",
      full_text: stripHtml(j?.description ?? ""),
      full_text_source: "mcf_api",
      salary_text: salaryText,
      salary_basis: salaryText ? "posted" : "not_stated",
      job_url: j?.metadata?.jobDetailsUrl ?? url,
      min_years: j?.minimumYearsExperience ?? null,
      position_levels: (j?.positionLevels ?? []).map((p: { position: string }) =>
        p.position
      ),
    };
  } catch (_e) {
    return null;
  }
}

// ------------------------------------------------------------ AI extraction
//
// One call per email. Extraction only: it converts a digest into an array of
// jobs and is forbidden from inferring anything not present in the text.

const EXTRACT_SYSTEM = `You extract job listings from a job-alert email.

ABSOLUTE RULES
- Extract ONLY what is literally present in the email text. Never infer,
  complete, expand or guess any field.
- If a field is not present, return the exact string "Not stated".
  Never substitute a plausible value.
- Do not merge two listings. Do not invent listings. Do not drop listings.
- Links appear as short tokens like [[L7]]. Return the token EXACTLY as it
  appears next to that listing, for example "L7". Never return a URL, never
  invent a token, never reuse a token from a different listing.
- Ignore everything that is not a job listing: headers, footers, unsubscribe
  links, promotional blocks, "see more jobs", profile prompts, adverts.

SALARY
- salary_text: copy verbatim, including currency and any qualifier.
- salary_basis: "platform_estimate" if the email labels it an estimate
  (for example "Glassdoor Est."), "posted" if presented as the employer's
  figure, "not_stated" if absent.

Return ONLY a JSON array. No prose, no markdown fences.
Each element:
{
  "company": string,
  "role_title": string,
  "location": string,
  "is_remote": true | false | null,
  "salary_text": string,
  "salary_basis": "posted" | "platform_estimate" | "not_stated",
  "employer_rating": number | null,
  "alumni_count": number | null,
  "easy_apply": true | false | null,
  "posted_age_text": string,
  "job_url_token": string,
  "raw_snippet": string
}
"job_url_token" is the token beside that listing, for example "L7", or
"Not stated" if the listing has no token.
"is_remote" is null unless the email states it.
"alumni_count" is the number of your contacts or alumni at that company if the
email shows one, otherwise null.
"raw_snippet" is the verbatim block of text this listing came from.
If the email contains no job listings, return [].`;

async function extractJobs(emailText: string): Promise<Record<string, unknown>[]> {
  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is empty at request time");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env("HIYAKU_INBOX_MODEL", MODEL_DEFAULT),
      max_tokens: 8000,
      system: EXTRACT_SYSTEM,
      messages: [{ role: "user", content: emailText.slice(0, 120000) }],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n")
    .replace(/```json|```/g, "")
    .trim();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

// ------------------------------------------------------------------ ingest

async function handleIngest(userId: string, body: Record<string, unknown>) {
  const emails = Array.isArray(body.emails) ? body.emails : [];
  const mode = body.mode === "backlog" ? "backlog" : "daily";
  const maxJobs = Number.isFinite(body.maxJobs as number)
    ? Number(body.maxJobs)
    : 60;
  const dryRun = body.dryRun === true;
  const allowedLocations = Array.isArray(body.allowedLocations)
    ? (body.allowedLocations as string[])
    : [];
  const enrichMcf = body.enrichMcf !== false;

  const stats = {
    emails_seen: emails.length,
    jobs_parsed: 0,
    jobs_inserted: 0,
    jobs_duplicate: 0,
    jobs_enriched: 0,
    ai_calls: 0,
  };
  const errors: string[] = [];
  const preview: Record<string, unknown>[] = [];
  let watermark: string | null = null;

  const seenKeys = new Set<string>();
  const rows: Record<string, unknown>[] = [];

  for (const raw of emails) {
    const e = raw as Record<string, unknown>;
    const source = String(e.source ?? "").toLowerCase();
    if (!SOURCES.includes(source)) {
      errors.push(`unknown source "${source}" on message ${e.messageId ?? "?"}`);
      continue;
    }
    const emailDate = clean(e.date);
    if (emailDate && (!watermark || emailDate > watermark)) watermark = emailDate;

    const text = clean(e.text) || stripHtml(clean(e.html));
    if (!text) {
      errors.push(`empty body on message ${e.messageId ?? "?"}`);
      continue;
    }

    const linkMap: Record<string, string> = {};
    if (Array.isArray(e.links)) {
      for (const l of e.links as { t: string; u: string }[]) {
        if (l && l.t && l.u) linkMap[String(l.t).toUpperCase()] = String(l.u);
      }
    }

    let jobs: Record<string, unknown>[] = [];
    try {
      jobs = await extractJobs(text);
      stats.ai_calls += 1;
    } catch (err) {
      errors.push(`extract failed on ${e.messageId ?? "?"}: ${String(err)}`);
      continue;
    }

    for (const j of jobs) {
      if (rows.length >= maxJobs) break;
      stats.jobs_parsed += 1;

      const rec: Record<string, unknown> = {
        user_id: userId,
        source,
        email_message_id: clean(e.messageId),
        email_subject: clean(e.subject),
        email_date: emailDate || null,
        raw_snippet: clean(j.raw_snippet),
        company: clean(j.company),
        role_title: clean(j.role_title),
        location: clean(j.location),
        is_remote: typeof j.is_remote === "boolean" ? j.is_remote : null,
        salary_text: clean(j.salary_text),
        salary_basis: ["posted", "platform_estimate", "not_stated"].includes(
            String(j.salary_basis),
          )
          ? String(j.salary_basis)
          : "not_stated",
        employer_rating: typeof j.employer_rating === "number"
          ? j.employer_rating
          : null,
        alumni_count: typeof j.alumni_count === "number" ? j.alumni_count : null,
        easy_apply: typeof j.easy_apply === "boolean" ? j.easy_apply : null,
        posted_age_text: clean(j.posted_age_text),
        job_url: resolveToken(clean(j.job_url_token) || clean(j.job_url), linkMap),
        external_id: "",
        full_text: "",
        full_text_source: "none",
        triage_basis: "email_snippet",
        triage_by: "rule",
      };

      if (!rec.company && !rec.role_title) continue;

      if (
        enrichMcf && source === "mycareersfuture" &&
        String(rec.job_url).includes("mycareersfuture")
      ) {
        const enriched = await enrichFromMcf(String(rec.job_url));
        if (enriched) {
          rec.external_id = enriched.external_id;
          rec.company = enriched.company || rec.company;
          rec.role_title = enriched.role_title || rec.role_title;
          rec.full_text = enriched.full_text;
          rec.full_text_source = enriched.full_text_source;
          rec.job_url = enriched.job_url;
          if (enriched.salary_text) {
            rec.salary_text = enriched.salary_text;
            rec.salary_basis = enriched.salary_basis;
          }
          rec.triage_basis = "full_text";
          stats.jobs_enriched += 1;
        }
      }

      const t = triageRecord(rec, allowedLocations);
      rec.triage = t.triage;
      rec.triage_reason = t.reason;

      const key = makeDedupKey(String(rec.company), String(rec.role_title));
      rec.dedup_key = key;
      if (seenKeys.has(key)) {
        stats.jobs_duplicate += 1;
        continue;
      }
      seenKeys.add(key);
      rows.push(rec);
      if (dryRun) preview.push(rec);
    }
    if (rows.length >= maxJobs) break;
  }

  if (!dryRun && rows.length > 0) {
    const inserted = await pgJson(
      "hiyaku_inbox_jobs?on_conflict=user_id,dedup_key",
      {
        method: "POST",
        body: JSON.stringify(rows),
        prefer: "resolution=ignore-duplicates,return=representation",
      },
    );
    stats.jobs_inserted = Array.isArray(inserted) ? inserted.length : 0;
    stats.jobs_duplicate += rows.length - stats.jobs_inserted;
  }

  if (!dryRun) {
    await pg("hiyaku_inbox_runs", {
      method: "POST",
      body: JSON.stringify([{
        user_id: userId,
        mode,
        finished_at: new Date().toISOString(),
        emails_seen: stats.emails_seen,
        jobs_parsed: stats.jobs_parsed,
        jobs_inserted: stats.jobs_inserted,
        jobs_duplicate: stats.jobs_duplicate,
        jobs_enriched: stats.jobs_enriched,
        ai_calls: stats.ai_calls,
        watermark,
        error: errors.join(" | ").slice(0, 2000),
      }]),
      prefer: "return=minimal",
    });
  }

  return json({
    ok: true,
    dryRun,
    mode,
    maxJobs,
    watermark,
    ...stats,
    errors,
    preview: dryRun ? preview : undefined,
  });
}

// ------------------------------------------------------------------ digest

async function handleDigest(userId: string, body: Record<string, unknown>) {
  const includeMaybe = body.includeMaybe === true;
  const dryRun = body.dryRun === true;
  const buckets = includeMaybe ? "(look,maybe)" : "(look)";

  const rows = await pgJson(
    `hiyaku_inbox_jobs?user_id=eq.${userId}&alerted_at=is.null` +
      `&state=eq.new&triage=in.${buckets}` +
      `&select=id,source,company,role_title,location,is_remote,salary_text,` +
      `salary_basis,employer_rating,alumni_count,posted_age_text,job_url,` +
      `triage,triage_reason,triage_basis,full_text_source` +
      `&order=triage.asc,created_at.desc&limit=100`,
  );

  const list = Array.isArray(rows) ? rows : [];
  if (!dryRun && list.length > 0) {
    const ids = list.map((r: { id: string }) => r.id).join(",");
    await pg(`hiyaku_inbox_jobs?id=in.(${ids})`, {
      method: "PATCH",
      body: JSON.stringify({ alerted_at: new Date().toISOString() }),
      prefer: "return=minimal",
    });
  }
  return json({ ok: true, dryRun, count: list.length, jobs: list });
}

// -------------------------------------------------------------------- ping
//
// Minimal live call to Anthropic: 1 token, no Library data, no email content.
// Returns the HTTP status and the raw error body so an auth failure can be
// distinguished from a model, quota or network problem.

async function handlePing() {
  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ ok: false, error: "ANTHROPIC_API_KEY is empty" });
  const model = env("HIYAKU_INBOX_MODEL", MODEL_DEFAULT);
  let status = 0;
  let body = "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    status = res.status;
    body = (await res.text()).slice(0, 400);
  } catch (err) {
    return json({ ok: false, error: `network: ${String(err)}` });
  }
  return json({
    ok: status === 200,
    status,
    model,
    keyFingerprint: await fingerprint(apiKey),
    keyLength: apiKey.length,
    response: body,
  });
}

// ------------------------------------------------------------------ status

async function handleStatus(userId: string) {
  const runs = await pgJson(
    `hiyaku_inbox_runs?user_id=eq.${userId}&order=started_at.desc&limit=1`,
  );
  const counts = await pgJson(
    `hiyaku_inbox_jobs?user_id=eq.${userId}&select=id&state=eq.new&limit=1000`,
  );
  const last = Array.isArray(runs) && runs.length ? runs[0] : null;
  // Diagnostics report presence and length only. No secret value is ever
  // returned, logged or echoed.
  const anthropicKey = env("ANTHROPIC_API_KEY");
  return json({
    ok: true,
    lastRun: last,
    watermark: last?.watermark ?? null,
    newJobs: Array.isArray(counts) ? counts.length : 0,
    diagnostics: {
      anthropicKeyPresent: anthropicKey.length > 0,
      anthropicKeyLength: anthropicKey.length,
      anthropicKeyPrefixOk: anthropicKey.startsWith("sk-ant-"),
      anthropicKeyFingerprint: await fingerprint(anthropicKey),
      model: env("HIYAKU_INBOX_MODEL", MODEL_DEFAULT),
      serviceKeyPresent: env("SUPABASE_SERVICE_ROLE_KEY").length > 0,
      supabaseUrlPresent: env("SUPABASE_URL").length > 0,
    },
  });
}

// -------------------------------------------------------------------- entry

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");

  const inboxSecret = env("HIYAKU_INBOX_SECRET");
  if (!inboxSecret) {
    return json({ ok: false, error: "HIYAKU_INBOX_SECRET not configured" }, 500);
  }
  if ((req.headers.get("x-hiyaku-secret") ?? "").trim() !== inboxSecret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "POST only" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (_e) {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  try {
    const userId = await resolveUserId();
    switch (String(body.action ?? "")) {
      case "status":
        return await handleStatus(userId);
      case "ingest":
        return await handleIngest(userId, body);
      case "digest":
        return await handleDigest(userId, body);
      case "ping":
        return await handlePing();
      default:
        return json(
          { ok: false, error: "action must be status, ping, ingest or digest" },
          400,
        );
    }
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});
