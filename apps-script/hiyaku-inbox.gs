/**
 * HiyakuAI — Gmail job-alert bridge (Phase 2)
 *
 * Runs inside chowkoksum@gmail.com as a Google Apps Script project.
 * Reads ONLY the label you configure. Never reads the rest of the mailbox.
 * Never deletes, replies to, or modifies mail. It reads, POSTs to the
 * hiyaku-inbox Edge Function, and sends you one digest email.
 *
 * ---------------------------------------------------------------------------
 * ONE-TIME SETUP
 * ---------------------------------------------------------------------------
 * 1. In Gmail, create a label (suggested: HiyakuAI/Alerts) and filters that
 *    apply it to LinkedIn, Glassdoor and MyCareersFuture job alerts.
 *    Bulk-apply it to the last month of alerts for the backlog run.
 * 2. script.google.com -> New project -> paste this file.
 * 3. Project Settings -> Script Properties, add:
 *      FN_URL        https://qdikrhoxkkangkoycagj.supabase.co/functions/v1/hiyaku-inbox
 *      INBOX_SECRET  the same value you set as HIYAKU_INBOX_SECRET in Supabase
 *      LABEL_NAME    HiyakuAI/Alerts
 *      DIGEST_TO     chowkoksum@gmail.com
 *      ALLOWED_LOCATIONS   (leave empty for no location filtering)
 * 4. Run testConnection() first and approve the permission prompt.
 * 5. Run previewBacklog() and read the log before anything is written.
 * 6. Run runBacklog() once, then installDailyTrigger().
 * ---------------------------------------------------------------------------
 */

var BACKLOG_MAX_JOBS = 50;   // confirmed: 50 JOBS, not 50 emails
var DAILY_MAX_JOBS   = 60;
var BATCH_SIZE       = 3;    // emails per POST; each email is one AI call
var MAX_RUNTIME_MS   = 4.5 * 60 * 1000;

// --------------------------------------------------------------- properties

function prop_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === '') ? (fallback === undefined ? '' : fallback) : v;
}

function config_() {
  var c = {
    fnUrl: prop_('FN_URL'),
    secret: prop_('INBOX_SECRET'),
    label: prop_('LABEL_NAME', 'HiyakuAI/Alerts'),
    digestTo: prop_('DIGEST_TO', Session.getActiveUser().getEmail()),
    allowedLocations: prop_('ALLOWED_LOCATIONS', '')
  };
  if (!c.fnUrl) throw new Error('Script Property FN_URL is not set');
  if (!c.secret) throw new Error('Script Property INBOX_SECRET is not set');
  return c;
}

function allowedLocationsArray_(csv) {
  if (!csv) return [];
  return csv.split(',').map(function (s) { return s.trim(); })
            .filter(function (s) { return s.length > 0; });
}

// ------------------------------------------------------------------ transport

function callFn_(payload) {
  var c = config_();
  var res = UrlFetchApp.fetch(c.fnUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-hiyaku-secret': c.secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  var body;
  try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
  if (code !== 200) {
    throw new Error('hiyaku-inbox ' + code + ': ' + text.slice(0, 500));
  }
  return body;
}

// ------------------------------------------------------------ email handling

/**
 * Identify the source from the sender. Anything unrecognised is skipped and
 * reported, never guessed at.
 */
function detectSource_(from) {
  var f = String(from || '').toLowerCase();
  if (f.indexOf('linkedin.') !== -1) return 'linkedin';
  if (f.indexOf('glassdoor.') !== -1) return 'glassdoor';
  if (f.indexOf('mycareersfuture') !== -1) return 'mycareersfuture';
  return '';
}

/**
 * Convert HTML to text while keeping every anchor's href inline, so the
 * landing-page link survives into the extraction step. Links are never
 * rewritten, shortened or repaired.
 */
function htmlToTextWithLinks_(html) {
  if (!html) return '';
  var out = String(html);
  out = out.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  out = out.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    function (m, href, inner) {
      var label = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!label) return ' <' + href + '> ';
      return ' ' + label + ' <' + href + '> ';
    });
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(p|div|li|tr|h[1-6]|table)>/gi, '\n');
  out = out.replace(/<[^>]+>/g, ' ');
  out = out.replace(/&nbsp;/gi, ' ')
           .replace(/&amp;/gi, '&')
           .replace(/&lt;/gi, '<')
           .replace(/&gt;/gi, '>')
           .replace(/&quot;/gi, '"')
           .replace(/&#39;/gi, "'");
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Collect messages from the configured label, newest last, optionally only
 * those newer than the stored watermark.
 */
function collectMessages_(sinceMs, hardLimit) {
  var c = config_();
  var label = GmailApp.getUserLabelByName(c.label);
  if (!label) throw new Error('Gmail label not found: ' + c.label);

  var collected = [];
  var start = 0;
  var page = 50;
  while (collected.length < hardLimit) {
    var threads = label.getThreads(start, page);
    if (!threads.length) break;
    for (var t = 0; t < threads.length; t++) {
      var msgs = threads[t].getMessages();
      for (var m = 0; m < msgs.length; m++) {
        var msg = msgs[m];
        var dt = msg.getDate();
        if (sinceMs && dt.getTime() <= sinceMs) continue;
        var source = detectSource_(msg.getFrom());
        if (!source) {
          Logger.log('SKIPPED unrecognised sender: ' + msg.getFrom());
          continue;
        }
        collected.push({
          messageId: msg.getId(),
          subject: msg.getSubject(),
          date: dt.toISOString(),
          source: source,
          text: htmlToTextWithLinks_(msg.getBody())
        });
        if (collected.length >= hardLimit) break;
      }
      if (collected.length >= hardLimit) break;
    }
    start += page;
  }
  collected.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  return collected;
}

// ----------------------------------------------------------------- sweeping

function sweep_(mode, maxJobs, dryRun) {
  var c = config_();
  var started = Date.now();
  var props = PropertiesService.getScriptProperties();
  var sinceMs = 0;
  if (mode === 'daily') {
    var wm = props.getProperty('WATERMARK_MS');
    sinceMs = wm ? Number(wm) : 0;
  }

  var emails = collectMessages_(sinceMs, 200);
  Logger.log('Messages collected: ' + emails.length);
  if (!emails.length) return { emails: 0, inserted: 0, parsed: 0 };

  var totals = { emails: 0, parsed: 0, inserted: 0, duplicate: 0, enriched: 0, ai: 0 };
  var newestMs = sinceMs;
  var budget = maxJobs;

  for (var i = 0; i < emails.length && budget > 0; i += BATCH_SIZE) {
    if (Date.now() - started > MAX_RUNTIME_MS) {
      Logger.log('Stopping early: runtime budget reached.');
      break;
    }
    var batch = emails.slice(i, i + BATCH_SIZE);
    var resp = callFn_({
      action: 'ingest',
      mode: mode,
      dryRun: !!dryRun,
      maxJobs: budget,
      enrichMcf: true,
      allowedLocations: allowedLocationsArray_(c.allowedLocations),
      emails: batch
    });

    totals.emails    += resp.emails_seen || 0;
    totals.parsed    += resp.jobs_parsed || 0;
    totals.inserted  += resp.jobs_inserted || 0;
    totals.duplicate += resp.jobs_duplicate || 0;
    totals.enriched  += resp.jobs_enriched || 0;
    totals.ai        += resp.ai_calls || 0;
    budget -= (resp.jobs_parsed || 0);

    if (resp.errors && resp.errors.length) Logger.log('Errors: ' + resp.errors.join(' | '));
    if (dryRun && resp.preview) Logger.log(JSON.stringify(resp.preview, null, 2));

    for (var b = 0; b < batch.length; b++) {
      var ms = new Date(batch[b].date).getTime();
      if (ms > newestMs) newestMs = ms;
    }
  }

  if (!dryRun && newestMs > sinceMs) {
    props.setProperty('WATERMARK_MS', String(newestMs));
  }
  Logger.log('Totals: ' + JSON.stringify(totals));
  return totals;
}

// -------------------------------------------------------------------- digest

function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function salaryCell_(job) {
  if (!job.salary_text) return 'Not stated';
  if (job.salary_basis === 'platform_estimate') {
    return escapeHtml_(job.salary_text) + ' <em>(platform estimate, not the employer figure)</em>';
  }
  if (job.salary_basis === 'posted') return escapeHtml_(job.salary_text) + ' <em>(posted)</em>';
  return escapeHtml_(job.salary_text);
}

function buildDigestHtml_(jobs) {
  var rows = jobs.map(function (j) {
    var title = j.job_url
      ? '<a href="' + escapeHtml_(j.job_url) + '">' + escapeHtml_(j.role_title) + '</a>'
      : escapeHtml_(j.role_title);
    var alumni = (j.alumni_count === null || j.alumni_count === undefined)
      ? '&mdash;' : escapeHtml_(j.alumni_count);
    var basis = j.full_text_source === 'mcf_api'
      ? 'full posting' : 'email only';
    return '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #ddd">' + title +
        '<br><small>' + escapeHtml_(j.company) + ' &middot; ' + escapeHtml_(j.location) +
        '</small></td>' +
      '<td style="padding:8px;border-bottom:1px solid #ddd">' + salaryCell_(j) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #ddd;text-align:center">' + alumni + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #ddd"><small>' +
        escapeHtml_(j.triage_reason) + '<br>Basis: ' + basis + '</small></td>' +
      '</tr>';
  }).join('');

  return '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:760px">' +
    '<h2 style="margin-bottom:4px">HiyakuAI &mdash; ' + jobs.length + ' to look at</h2>' +
    '<p style="color:#666;margin-top:0"><strong>Routing only.</strong> These passed a ' +
    'seniority and location filter. They are not suitability assessments. ' +
    'Open a role in HiyakuAI to run the real assessment against your Library.</p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:14px">' +
    '<tr style="text-align:left;background:#f4f4f4">' +
    '<th style="padding:8px">Role</th><th style="padding:8px">Salary</th>' +
    '<th style="padding:8px">Alumni</th><th style="padding:8px">Why flagged</th></tr>' +
    rows + '</table></div>';
}

function sendDigest(dryRun) {
  var c = config_();
  var resp = callFn_({ action: 'digest', includeMaybe: false, dryRun: !!dryRun });
  if (!resp.count) {
    Logger.log('No new look-worthy roles. No digest sent.');
    return 0;
  }
  var html = buildDigestHtml_(resp.jobs);
  if (dryRun) { Logger.log(html); return resp.count; }
  MailApp.sendEmail({
    to: c.digestTo,
    subject: 'HiyakuAI: ' + resp.count + ' role(s) worth a look',
    htmlBody: html
  });
  Logger.log('Digest sent with ' + resp.count + ' roles.');
  return resp.count;
}

// ----------------------------------------------------------- entry points

function testConnection() {
  var resp = callFn_({ action: 'status' });
  Logger.log(JSON.stringify(resp, null, 2));
  var c = config_();
  var label = GmailApp.getUserLabelByName(c.label);
  Logger.log('Label "' + c.label + '": ' + (label ? 'found' : 'NOT FOUND'));
  return resp;
}

function previewBacklog() {
  return sweep_('backlog', BACKLOG_MAX_JOBS, true);
}

function runBacklog() {
  return sweep_('backlog', BACKLOG_MAX_JOBS, false);
}

function previewDigest() {
  return sendDigest(true);
}

function runDaily() {
  sweep_('daily', DAILY_MAX_JOBS, false);
  sendDigest(false);
}

function installDailyTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'runDaily') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  ScriptApp.newTrigger('runDaily').timeBased().atHour(7).everyDays(1).create();
  Logger.log('Daily trigger installed for approximately 07:00 script timezone.');
}

function removeDailyTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'runDaily') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }
  Logger.log('Daily trigger removed.');
}
