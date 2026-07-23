// HiyakuAI — hiyaku-generate Edge Function  v10 (2026-07-16)
// Modes: 'generate' | 'generic_cv' | 'extract' (text and/or screenshots/PDF) | 'parse_cert' | 'assess'
// JWT verification: ON. Secret: ANTHROPIC_API_KEY.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// userContent may be a string OR an array of content blocks (for vision/PDF)
async function callClaude(apiKey: string, model: string, system: string, userContent: any, maxTokens: number) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }] }),
  });
  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, data };
}

function parseModelJson(data: any) {
  const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  try {
    return { parsed: JSON.parse(text.replace(/```json|```/g, "").trim()), raw: text };
  } catch {
    return { parsed: null, raw: text };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY secret not set" }, 500);

    const body = await req.json();
    const mode = body.mode || "generate";
    const model = body.model || "claude-sonnet-4-6";

    // ---------------- EXTRACT MODE ----------------
    if (mode === "extract") {
      const { rawPosting, files } = body;
      const hasFiles = Array.isArray(files) && files.length > 0;
      if (!rawPosting && !hasFiles) {
        return json({ error: "Provide rawPosting text and/or files (screenshots/PDF) for extract mode" }, 400);
      }

      const IMG = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      const blocks: any[] = [];

      if (hasFiles) {
        if (files.length > 8) return json({ error: "Please upload at most 8 files at once." }, 400);
        for (const f of files) {
          if (!f?.base64 || !f?.mimeType) return json({ error: "Each file needs base64 and mimeType" }, 400);
          if (IMG.includes(f.mimeType)) {
            blocks.push({ type: "image", source: { type: "base64", media_type: f.mimeType, data: f.base64 } });
          } else if (f.mimeType === "application/pdf") {
            blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.base64 } });
          } else {
            return json({ error: `Unsupported file type: ${f.mimeType}. Use PNG, JPEG, GIF, WebP or PDF.` }, 400);
          }
        }
      }

      const system = `You extract structured fields from a job posting. The posting may be supplied as pasted text, as one or more screenshots or PDF pages, or both.
STRICT RULES:
- Use ONLY information literally present in the supplied text and files. NEVER infer, guess, or invent.
- If several images are given, treat them as consecutive parts of ONE posting, in the order supplied.
- For any field not present, use exactly the string "Not stated".
- Keep the candidate-facing lists (qualifications, expectations) as concise bullet lines separated by newlines, preserving the posting's meaning.
- salaryRange: quote the posting's own figures and currency verbatim if present, else "Not stated".
- postingText: transcribe the posting's full readable text faithfully, preserving its wording and structure. Do not summarise, add, or omit content. If the images are unreadable, use "Not stated".
- Respond ONLY with valid JSON, no markdown fences, exactly this shape:
{"company":"","roleTitle":"","location":"","qualifications":"","expectations":"","howToApply":"","salaryRange":"","postingText":""}`;

      const instruction = hasFiles
        ? `The attached ${blocks.length} file(s) contain a job posting.${rawPosting ? " Additional pasted text follows." : ""}${rawPosting ? "\n\nPASTED TEXT:\n" + rawPosting : ""}\n\nExtract now. JSON only.`
        : `JOB POSTING TEXT:\n${rawPosting}\n\nExtract now. JSON only.`;

      const content: any = hasFiles ? [...blocks, { type: "text", text: instruction }] : instruction;

      const r = await callClaude(apiKey, model, system, content, 4000);
      if (!r.ok) return json({ error: r.data?.error?.message || "Anthropic API error", raw: r.data }, r.status);
      const { parsed, raw } = parseModelJson(r.data);
      if (!parsed) return json({ error: "Model did not return clean JSON", raw }, 502);
      return json(parsed);
    }

    if (mode === "parse_cert") {
      const { fileBase64, mimeType } = body;
      if (!fileBase64 || !mimeType) return json({ error: "fileBase64 and mimeType are required" }, 400);

      const IMG = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      let block: any;
      if (IMG.includes(mimeType)) {
        block = { type: "image", source: { type: "base64", media_type: mimeType, data: fileBase64 } };
      } else if (mimeType === "application/pdf") {
        block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } };
      } else {
        return json({ error: `Unsupported file type for parsing: ${mimeType}. Use PDF, JPEG, PNG, GIF or WebP.` }, 400);
      }

      const system = `You extract factual details from a certificate, licence, diploma or qualification document.
STRICT RULES:
- Report ONLY what is visibly present in the document. NEVER infer or invent.
- Omit any field that is not shown; do not write placeholders.
- If the file is unreadable or is not a credential, respond exactly: "Unable to read a credential from this file."
- Output concise plain-text lines, only for fields present: Credential / title; Issuing organisation; Recipient name; Date issued; Expiry / valid-until; Credential ID / number; Level or grade; Distinctions or notes.`;

      const content = [block, { type: "text", text: "Extract the credential details now, following the rules." }];
      const r = await callClaude(apiKey, model, system, content, 700);
      if (!r.ok) return json({ error: r.data?.error?.message || "Anthropic API error", raw: r.data }, r.status);
      const text = (r.data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      return json({ parsedText: text });
    }

    // ---------------- ASSESS MODE (suitability: profile vs job) ----------------
    if (mode === "assess") {
      const { jobDescription, referenceCv, headline, about, links, certificates, extraNotes, sections } = body;

      if (!jobDescription || !String(jobDescription).trim()) {
        return json({ error: "jobDescription is required for assess mode" }, 400);
      }
      const corpus = [
        referenceCv, headline, about, extraNotes,
        ...(sections || []).map((s: any) => s?.content),
        ...(certificates || []).map((c: any) => `${c.name || ""} ${c.note || ""} ${c.parsed_text || ""}`),
      ].filter((x) => x && String(x).trim()).join(" ");
      if (!corpus.trim()) {
        return json({ error: "Your Library is empty - add a reference CV or fill some profile sections first." }, 400);
      }

      const system = `You are a rigorous, impartial executive-search assessor. You judge how suitable a candidate is for a specific job posting, comparing the candidate's Library (their verified profile) against the job's stated requirements.

TRUTH RULES (ABSOLUTE):
- The candidate's Library below is the ONLY evidence about the candidate. The job posting is the ONLY evidence about the role. NEVER infer, guess or invent facts on either side.
- Every strength you list MUST cite concrete evidence from the Library (role, achievement, credential). If the Library has no evidence for a job requirement, that requirement is a gap - say so plainly.
- If the posting does not state a requirement (e.g. no seniority or location given), do not treat it as met or unmet; simply do not score it.
- Be honest and critical. An inflated score misleads the candidate into wasted applications. A "stretch" or "not_recommended" verdict is a valid, useful outcome.

SCORING:
- score: integer 0-100 reflecting how much of the job's STATED requirements are evidenced in the Library, weighted by importance (must-have qualifications weigh more than nice-to-haves).
- verdict mapping (apply consistently): 80-100 "strong_fit"; 60-79 "good_fit"; 40-59 "stretch"; 0-39 "not_recommended".

OUTPUT:
- summary: 2-4 plain sentences: should the candidate apply, and why. Mention seniority/level match and domain match explicitly.
- strengths: 3-8 bullets, each "requirement -> evidence" (job requirement, then the specific Library evidence meeting it).
- gaps: 0-8 bullets, each a stated job requirement with no (or weak) Library evidence, and how serious it is. If none, return an empty array.
- emphasis: 2-5 bullets: what to foreground in the CV/letter IF applying (only Library-evidenced points).
- Plain ASCII punctuation only. No em dashes, bullets characters or decorative symbols.
- Respond ONLY with valid JSON, no markdown fences, exactly this shape:
{"verdict":"strong_fit|good_fit|stretch|not_recommended","score":0,"summary":"","strengths":[""],"gaps":[""],"emphasis":[""]}`;

      const sectionBlock = (sections || [])
        .filter((s: any) => s && s.content && String(s.content).trim())
        .map((s: any) => `[${s.title}]\n${s.content}`)
        .join("\n\n") || "(none)";

      const userMsg = `The materials below are the candidate's complete profile and the ONLY source of truth about the candidate.

=== REFERENCE CV ===
${referenceCv || "(none)"}

=== LINKEDIN HEADLINE ===
${headline || "(not provided)"}

=== LINKEDIN ABOUT ===
${about || "(not provided)"}

=== LINKEDIN PROFILE SECTIONS ===
${sectionBlock}

=== ONLINE SOURCES ===
${(links || []).map((l: any) => `- ${l.label}: ${l.url} [${l.category}]`).join("\n") || "(none)"}

=== CERTIFICATES / QUALIFICATIONS (name, note, parsed contents) ===
${(certificates || []).map((c: any) => `- ${c.name}${c.note ? " - " + c.note : ""}${c.parsed_text ? "\n  Parsed details: " + String(c.parsed_text).replace(/\n/g, "\n  ") : ""}`).join("\n") || "(none)"}

=== EXTRA NOTES FROM CANDIDATE ===
${extraNotes || "(none)"}

=== TARGET JOB POSTING (the ONLY source of truth about the role) ===
${jobDescription}

Assess the candidate's suitability for this job now. JSON only.`;

      const r = await callClaude(apiKey, model, system, userMsg, 2000);
      if (!r.ok) return json({ error: r.data?.error?.message || "Anthropic API error", raw: r.data }, r.status);
      const { parsed, raw } = parseModelJson(r.data);
      if (!parsed || !parsed.verdict) return json({ error: "Model did not return clean JSON", raw }, 502);
      return json(parsed);
    }

    // ---------------- GENERATE MODE ----------------
    if (mode === "generic_cv") {
      const { referenceCv, headline, about, links, certificates, extraNotes, sections } = body;

      const corpus = [
        referenceCv, headline, about, extraNotes,
        ...(sections || []).map((x: any) => x?.content),
        ...(certificates || []).map((c: any) => `${c.name || ""} ${c.note || ""} ${c.parsed_text || ""}`),
      ].filter((x) => x && String(x).trim()).join(" ");
      if (!corpus.trim()) return json({ error: "Your Library is empty - add a reference CV or fill some profile sections first." }, 400);

      const system = `You are an elite executive-career writer. You produce a candidate's definitive GENERIC master CV: not tailored to any single job, but a complete, polished, role-agnostic executive CV suitable for sending to search firms or attaching to speculative approaches.

TRUTH RULES:
- The candidate's Library below is the ONLY source of truth. Use ONLY facts present there. NEVER invent numbers, employers, dates, degrees, awards, recommendations or claims.
- Do not target any particular employer or vacancy. Do not add an objective aimed at a specific company.
- Include every substantive role, board position, qualification and language evidenced in the Library, but compress older roles to a single line each. Achievement-led, never duty-led.

FORMATTING RULES (ATS-safe, plain and professional):
- Use ONLY plain ASCII punctuation. NEVER use em dashes, en dashes, middots, bullet characters, curly/smart quotes, arrows, or any decorative symbol.
- Bullets: begin each with a plain hyphen and a space ("- "). No nested bullets.
- Section headings: standard names only (Professional Summary, Core Competencies, Professional Experience, Board and Governance, Education, Certifications, Languages).
- Write "and" instead of "&". Dates as "Month YYYY" or "YYYY", plain hyphen for ranges.
- One achievement per bullet, roughly 10-25 words. Single column, no tables, no text boxes.
- Contact details as plain text lines at the top.

STRUCTURE:
- Start with the candidate's name, then contact details, then a short positioning line if one is evidenced.
- Then: Professional Summary; Core Competencies; Professional Experience (reverse chronological, achievements as bullets); Board and Governance (if evidenced); Education and Certifications; Languages (if evidenced).
LENGTH DISCIPLINE (STRICT - the CV must fit exactly two A4 pages):
- Total body content: 700-850 words. Never exceed 850 words.
- Professional Summary: 45-70 words, 3-4 lines, no bullets.
- Core Competencies: ONE compact block, 12-16 items separated by commas. Not a bulleted list.
- Professional Experience: reverse chronological.
  - Two most recent roles: 3-4 bullets each.
  - Next two roles: 2-3 bullets each.
  - All older roles: exactly ONE line each (title, employer, location, dates, single outcome clause).
- Each bullet: ONE line of 12-22 words. Never wrap past two lines. No sub-bullets.
- Board and Governance: one line per seat.
- Education, Certifications, Languages: one line each, comma-separated where possible. No bullets.
- Omit any line that does not add distinct evidence. Do not repeat an achievement in both the summary and a bullet.
- No filler: no "References available on request", no soft-skill claims, no duty descriptions.
- Respond ONLY with valid JSON, no markdown fences, exactly this shape:
{"cv":"<markdown>"}`;

      const sectionBlock = (sections || [])
        .filter((x: any) => x && x.content && String(x.content).trim())
        .map((x: any) => `[${x.title}]\n${x.content}`)
        .join("\n\n") || "(none)";

      const userMsg = `The materials below are the candidate's complete profile and the ONLY source of truth.

=== REFERENCE CV ===
${referenceCv || "(none)"}

=== LINKEDIN HEADLINE ===
${headline || "(not provided)"}

=== LINKEDIN ABOUT ===
${about || "(not provided)"}

=== LINKEDIN PROFILE SECTIONS ===
${sectionBlock}

=== ONLINE SOURCES ===
${(links || []).map((l: any) => `- ${l.label}: ${l.url} [${l.category}]`).join("\n") || "(none)"}

=== CERTIFICATES / QUALIFICATIONS (name, note, parsed contents) ===
${(certificates || []).map((c: any) => `- ${c.name}${c.note ? " - " + c.note : ""}${c.parsed_text ? "\n  Parsed details: " + String(c.parsed_text).replace(/\n/g, "\n  ") : ""}`).join("\n") || "(none)"}

=== EXTRA NOTES FROM CANDIDATE ===
${extraNotes || "(none)"}

Produce the generic master CV now. JSON only.`;

      const r = await callClaude(apiKey, model, system, userMsg, 4000);
      if (!r.ok) return json({ error: r.data?.error?.message || "Anthropic API error", raw: r.data }, r.status);
      const { parsed, raw } = parseModelJson(r.data);
      if (!parsed || !parsed.cv) return json({ cv: raw });
      return json(parsed);
    }

    const { jobDescription, referenceCv, headline, about, links, certificates, extraNotes, sections } = body;

    const corpus = [
      referenceCv, headline, about, extraNotes,
      ...(sections || []).map((s: any) => s?.content),
      ...(certificates || []).map((c: any) => `${c.name || ""} ${c.note || ""} ${c.parsed_text || ""}`),
      ...(links || []).map((l: any) => l?.label),
    ].filter((x) => x && String(x).trim()).join(" ");

    if (!jobDescription) return json({ error: "jobDescription is required" }, 400);
    if (!corpus.trim()) return json({ error: "Your Library is empty — add a reference CV or fill some profile sections first." }, 400);

    const system = `You are an elite executive-career writer. You tailor CVs and cover letters for a senior C-suite candidate.

TRUTH RULES:
- The candidate's Library below is the ONLY source of truth: reference CV, LinkedIn sections, links, certificates and their parsed details, and notes. Use ONLY facts present there. NEVER invent numbers, employers, dates, degrees, awards, recommendations or claims.
- If the job asks for something not evidenced in the materials, do not fabricate it; optionally note it in fitNotes.
- Mirror the job description's genuine keywords where the candidate's real experience supports them (ATS-aware).

FORMATTING RULES (ATS-safe, plain and professional):
- Use ONLY plain ASCII punctuation. NEVER use em dashes, en dashes, middots, bullets characters, curly/smart quotes, arrows, or any decorative symbol.
- Replace: em dash or en dash -> a plain hyphen "-" with spaces, or restructure the sentence. Curly quotes -> straight quotes. Middot separators -> commas.
- Bullets: begin each with a plain hyphen and a space ("- "). No nested bullets.
- Section headings: use standard, conventional names only (Professional Summary, Core Competencies, Professional Experience, Board and Governance, Education, Certifications). Do not invent creative headings.
- Write "and" instead of "&". Write "percent" instead of "%" in prose.
- Dates: a consistent "Month YYYY" or "YYYY" format, with a plain hyphen for ranges (e.g. "January 2018 - March 2023").
- Keep one achievement per bullet, roughly 10-25 words. Single column, no tables, no text boxes, no graphics.
- Contact details in the body text at the top, never as a header/footer construct.

STRUCTURE:
- CV: concise, achievement-led, markdown headings.

LENGTH DISCIPLINE (STRICT - the CV must fit exactly two A4 pages):
- Total body content: 700-850 words. Never exceed 850 words.
- Professional Summary: 45-70 words, 3-4 lines, no bullets.
- Core Competencies: ONE compact block, 12-16 items separated by commas. Not a bulleted list.
- Professional Experience: reverse chronological.
  - Two most recent roles: 3-4 bullets each.
  - Next two roles: 2-3 bullets each.
  - All older roles: exactly ONE line each (title, employer, location, dates, single outcome clause).
- Each bullet: ONE line of 12-22 words. Never wrap past two lines. No sub-bullets.
- Board and Governance: one line per seat.
- Education, Certifications, Languages: one line each, comma-separated where possible. No bullets.
- Omit any line that does not add distinct evidence. Do not repeat an achievement in both the summary and a bullet.
- No filler: no "References available on request", no soft-skill claims, no duty descriptions.
- Cover letter: max 350 words, specific to this company and role, confident and warm, no cliches. Plain paragraphs.
- Respond ONLY with valid JSON, no markdown fences, in exactly this shape:
{"cv":"<markdown>","coverLetter":"<markdown>","fitNotes":"<short bullet list: strengths for this role, gaps/risks, suggested emphasis>"}`;

    const sectionBlock = (sections || [])
      .filter((s: any) => s && s.content && String(s.content).trim())
      .map((s: any) => `[${s.title}]\n${s.content}`)
      .join("\n\n") || "(none)";

    const userMsg = `The materials below are the candidate's complete profile and the ONLY source of truth.

=== REFERENCE CV ===
${referenceCv || "(none)"}

=== LINKEDIN HEADLINE ===
${headline || "(not provided)"}

=== LINKEDIN ABOUT ===
${about || "(not provided)"}

=== LINKEDIN PROFILE SECTIONS (Experience, Education, Skills, Recommendations, Publications, Honors & Awards, Languages, Interests) ===
${sectionBlock}

=== ONLINE SOURCES ===
${(links || []).map((l: any) => `- ${l.label}: ${l.url} [${l.category}]`).join("\n") || "(none)"}

=== CERTIFICATES / QUALIFICATIONS (name, note, and parsed contents) ===
${(certificates || []).map((c: any) => `- ${c.name}${c.note ? " — " + c.note : ""}${c.parsed_text ? "\n  Parsed details: " + String(c.parsed_text).replace(/\n/g, "\n  ") : ""}`).join("\n") || "(none)"}

=== EXTRA NOTES FROM CANDIDATE ===
${extraNotes || "(none)"}

=== TARGET JOB DESCRIPTION ===
${jobDescription}

Produce the tailored CV, cover letter and fit notes now. JSON only.`;

    const r = await callClaude(apiKey, model, system, userMsg, 4000);
    if (!r.ok) return json({ error: r.data?.error?.message || "Anthropic API error", raw: r.data }, r.status);
    const { parsed, raw } = parseModelJson(r.data);
    if (!parsed) {
      return json({ cv: raw, coverLetter: "", fitNotes: "Model did not return clean JSON — raw output placed in CV field. Regenerate if needed." });
    }
    return json(parsed);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
