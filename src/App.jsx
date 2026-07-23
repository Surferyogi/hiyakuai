import React, { useEffect, useMemo, useState } from 'react'
import { supabase, CONFIG_READY } from './supabaseClient.js'
import {
  Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, HeadingLevel, convertInchesToTwip,
} from 'docx'

export const APP_VERSION = 'v2026:07:24-00:59'
const STATUSES = ['draft','submitted','responded','interview','offer','rejected','closed']
const DEFAULT_MODEL = 'claude-sonnet-4-6'

const LINKEDIN_SECTIONS = [
  ['experience', 'Experience'],
  ['education', 'Education'],
  ['skills', 'Skills'],
  ['recommendations', 'Recommendations (what & by whom)'],
  ['publications', 'Publications'],
  ['honors_awards', 'Honors & Awards'],
  ['languages', 'Languages'],
  ['interests', 'Interests'],
]
const sectionTitle = (k) => (LINKEDIN_SECTIONS.find(([key]) => key === k) || [null, k])[1]

const SECTION_PLACEHOLDER = {
  experience: 'Company — Title (dates)\n- achievement\n- achievement',
  education: 'Degree — Institution (year)',
  skills: 'Top skills: … · … · …\nOther: …, …, …',
  recommendations: '"Recommendation text…"\n— Name, Title, Company',
  publications: 'Title — venue/journal (year) — link',
  honors_awards: 'Award / honor — issuer (year)',
  languages: 'English (native/fluent) · Japanese (JLPT) · Korean (TOPIK)',
  interests: 'e.g. photography, golf, travel',
}

// Seed ONLY sections with verified data (from CV v2 + the Skills list finalized in-thread).
// Publications, Recommendations and Interests are intentionally omitted — no verified data.
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : null)

// Replace non-ASCII typographic marks that ATS parsers commonly strip or garble.
// Purely a character swap: no words are added, removed or reworded.
export const sanitizeAts = (s) => {
  if (!s) return s
  return String(s)
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")      // curly single quotes -> '
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')      // curly double quotes -> "
    .replace(/\s*\u2014\s*/g, ' - ')                   // em dash -> spaced hyphen
    .replace(/\u2013/g, '-')                           // en dash -> hyphen
    .replace(/[\u2022\u00B7\u2043\u25CF\u25AA]/g, '-') // bullet chars / middot -> hyphen
    .replace(/[\u2192\u21D2\u27A4\u279C\u25B6]/g, '->')// arrows
    .replace(/\u2026/g, '...')                         // ellipsis
    .replace(/[\u00A0\u2007\u202F]/g, ' ')             // non-breaking spaces
    .replace(/[\u2010\u2011\u2012\u2015]/g, '-')       // other dashes
    .replace(/\u2122|\u00AE|\u00A9/g, '')              // TM, (R), (C)
    .replace(/[ \t]+\n/g, '\n')                        // trailing spaces
    .replace(/[ \t]{2,}/g, ' ')                        // collapse runs of spaces
}

// Remove markdown syntax, leaving clean plain text for pasting into forms/emails.
export const stripMarkdown = (s) => {
  if (!s) return ''
  return sanitizeAts(s)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')          // headings
    .replace(/\*\*(.+?)\*\*/g, '$1')             // bold
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2') // italic
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')       // code
    .replace(/^\s*>\s?/gm, '')                   // blockquote
    .replace(/^\s*[-*+]\s+/gm, '- ')             // normalise bullets
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')   // links
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')          // hr
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Parse inline markdown (**bold**, *italic*) into docx TextRuns.
const mdRuns = (text, base = {}) => {
  const runs = []
  const re = /(\*\*(.+?)\*\*)|(\*(?!\s)(.+?)\*)/g
  let last = 0, m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), ...base }))
    if (m[2] !== undefined) runs.push(new TextRun({ text: m[2], bold: true, ...base }))
    else runs.push(new TextRun({ text: m[4], italics: true, ...base }))
    last = re.lastIndex
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), ...base }))
  return runs.length ? runs : [new TextRun({ text, ...base })]
}

// Build a real OOXML .docx from the CV markdown. ATS-safe: single column,
// standard Calibri, no tables, no text boxes, real bullet lists.
export const mdToDocx = (src) => {
  const lines = sanitizeAts(src || '').split('\n')
  const children = []
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) continue
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const lv = h[1].length
      if (lv === 1) {
        children.push(new Paragraph({
          spacing: { after: 20 },
          keepNext: true,
          children: mdRuns(h[2], { bold: true, size: 34 }),   // 17pt
        }))
      } else if (lv === 2) {
        children.push(new Paragraph({
          spacing: { before: 160, after: 60 },
          keepNext: true,
          border: { bottom: { style: BorderStyle.SINGLE, size: 5, color: '555555', space: 1 } },
          children: mdRuns(h[2].toUpperCase(), { bold: true, size: 20, characterSpacing: 16 }), // 10pt
        }))
      } else {
        children.push(new Paragraph({
          spacing: { before: 100, after: 20 },
          keepNext: true,
          children: mdRuns(h[2], { bold: true, size: 20 }),
        }))
      }
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      children.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 24, line: 264, lineRule: 'auto' },   // ~1.22 line height
        children: mdRuns(line.replace(/^\s*[-*+]\s+/, ''), { size: 20 }),
      }))
      continue
    }
    if (/^\s*[-_*]{3,}\s*$/.test(line)) continue
    children.push(new Paragraph({
      spacing: { after: 50, line: 264, lineRule: 'auto' },
      children: mdRuns(line, { size: 20 }),
    }))
  }
  return new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },  // 10pt
    sections: [{
      properties: { page: { margin: {
        top: convertInchesToTwip(0.47), bottom: convertInchesToTwip(0.47),
        left: convertInchesToTwip(0.51), right: convertInchesToTwip(0.51),
      } } },
      children: children.length ? children : [new Paragraph('')],
    }],
  })
}

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

const safeFile = (s) => String(s || 'document').replace(/[^\w\d\-. ]+/g, '_').slice(0, 60).trim()

// ---- Shared export helpers (used by Applications and the Library) ----
export const exportDocxFile = async (baseName, text, notify) => {
  try {
    if (!text || !text.trim()) { notify('Nothing to export yet.'); return }
    const blob = await Packer.toBlob(mdToDocx(text))
    const fname = `${safeFile(baseName)}.docx`
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
    if (!standalone) { downloadBlob(blob, fname); notify('DOCX downloaded.'); return }
    // Installed PWA: a plain download can strand the user with no way back.
    // Open a small HiyakuAI-owned window that downloads the file and offers a return button.
    const url = URL.createObjectURL(blob)
    const backUrl = window.location.origin + window.location.pathname
    const w = window.open('', '_blank')
    if (!w) { downloadBlob(blob, fname); notify('DOCX downloaded.'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(fname)}</title>
<style>
  body { font-family: -apple-system, Arial, Helvetica, sans-serif; margin: 0; padding: 30px 20px; color: #111; background: #fff; }
  .card { max-width: 460px; margin: 0 auto; text-align: center; }
  h1 { font-size: 1.15rem; margin: 0 0 8px; }
  p { color: #555; font-size: .9rem; line-height: 1.4; margin: 0 0 20px; }
  a.dl, button { font: inherit; font-size: .95rem; padding: 12px 18px; border-radius: 10px; margin: 5px; cursor: pointer; display: inline-block; text-decoration: none; }
  a.dl { background: #0bb389; border: 1px solid #0bb389; color: #fff; font-weight: 700; }
  button { background: #fff; border: 1px solid #999; color: #111; }
</style></head><body>
<div class="card">
  <h1>Your DOCX is ready</h1>
  <p>The download should start automatically. If it does not, tap Download below, then return to HiyakuAI.</p>
  <a class="dl" id="dl" href="${url}" download="${esc(fname)}">Download ${esc(fname)}</a>
  <div><button type="button" onclick="returnToApp()">Return to HiyakuAI</button></div>
</div>
<script>
  function returnToApp(){try{window.close()}catch(e){}setTimeout(function(){location.replace(${JSON.stringify(backUrl)})},250)}
  window.onload = function(){ setTimeout(function(){ try{ document.getElementById('dl').click() }catch(e){} }, 200) }
<\/script>
</body></html>`)
    w.document.close()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
    notify('DOCX ready in the export tab.')
  } catch (e) { notify('DOCX export failed: ' + e.message) }
}

export const exportMdFile = (baseName, text, notify) => {
  if (!text || !text.trim()) { notify('Nothing to export yet.'); return }
  downloadBlob(new Blob([sanitizeAts(text)], { type: 'text/markdown' }), `${safeFile(baseName)}.md`)
  notify('Markdown file downloaded.')
}

export const exportTxtFile = (baseName, text, notify) => {
  if (!text || !text.trim()) { notify('Nothing to export yet.'); return }
  downloadBlob(new Blob([stripMarkdown(text)], { type: 'text/plain' }), `${safeFile(baseName)}.txt`)
  notify('Plain text file downloaded.')
}

export const copyPlain = (text, label, notify) =>
  navigator.clipboard.writeText(stripMarkdown(text))
    .then(() => notify(`${label} copied as plain text.`))

export const copyMd = (text, label, notify) =>
  navigator.clipboard.writeText(sanitizeAts(text) || '')
    .then(() => notify(`${label} copied as markdown.`))

// Professionally typeset PDF via the browser's print dialog (choose "Save as PDF").
export const exportPdf = (title, text, notify) => {
  if (!text || !text.trim()) { notify('Nothing to export yet.'); return }
  const backUrl = window.location.origin + window.location.pathname
  const w = window.open('', '_blank')
  if (!w) { notify('Pop-up blocked - allow pop-ups for this site to export a PDF.'); return }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 12mm 13mm; }
  * { box-sizing: border-box; }
  body { font-family: Calibri, Carlito, Arial, Helvetica, sans-serif; font-size: 10pt;
    line-height: 1.22; color: #000; margin: 0; -webkit-print-color-adjust: exact; }
  .doc { max-width: 190mm; margin: 0 auto; }
  h1 { font-size: 17pt; letter-spacing: .3pt; margin: 0 0 1pt; font-weight: 700; }
  h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: .8pt; margin: 8pt 0 3pt;
    padding-bottom: 1pt; border-bottom: .7pt solid #555; font-weight: 700; }
  h3 { font-size: 10pt; margin: 5pt 0 1pt; font-weight: 700; }
  p { margin: 0 0 2.5pt; text-align: left; orphans: 2; widows: 2; }
  h1 + p { margin-bottom: 4pt; font-size: 9.5pt; }
  ul { margin: 1.5pt 0 4pt; padding-left: 12pt; }
  li { margin: 0 0 1.2pt; padding-left: 1pt; }
  hr { border: 0; border-top: .5pt solid #bbb; margin: 5pt 0; }
  strong { font-weight: 700; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  li, p { break-inside: avoid; page-break-inside: avoid; }
  ul { break-before: avoid; page-break-before: avoid; }
  @media print { .hint { display: none; } }
  .hint { font-family: sans-serif; font-size: 9pt; color: #555; background: #f3f4f6;
          border: 1px solid #ddd; padding: 8px 10px; margin-bottom: 14px; border-radius: 6px; }
  .hint-actions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
  .hint-actions button { font: inherit; font-size: 9pt; padding: 6px 12px; border-radius: 6px; border: 1px solid #999; background: #fff; color: #111; cursor: pointer; }
</style></head><body>
<div class="hint"><div>Use your browser's print dialog and choose <strong>Save as PDF</strong>. Set margins to <strong>None</strong> (the page margins are built in) and disable "Headers and footers" for a clean two-page result.</div><div class="hint-actions"><button type="button" onclick="window.print()">Print / Save as PDF</button><button type="button" onclick="returnToApp()">Return to HiyakuAI</button></div></div>
<div class="doc">${mdToHtml(text)}</div>
<script>function returnToApp(){try{window.close()}catch(e){}setTimeout(function(){location.replace(${JSON.stringify(backUrl)})},250)}window.onload = () => setTimeout(() => window.print(), 300);<\/script>
</body></html>`)
  w.document.close()
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inlineMd = (s) => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')

// Convert the CV markdown into semantic HTML for a professionally typeset PDF.
export const mdToHtml = (src) => {
  const lines = sanitizeAts(src || '').split('\n')
  let html = '', inList = false
  const closeList = () => { if (inList) { html += '</ul>'; inList = false } }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { closeList(); continue }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { closeList(); const lv = Math.min(h[1].length, 3); html += `<h${lv}>${inlineMd(h[2])}</h${lv}>`; continue }
    if (/^\s*[-*+]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true }
      html += `<li>${inlineMd(line.replace(/^\s*[-*+]\s+/, ''))}</li>`; continue
    }
    if (/^\s*[-_*]{3,}\s*$/.test(line)) { closeList(); html += '<hr/>'; continue }
    closeList()
    html += `<p>${inlineMd(line)}</p>`
  }
  closeList()
  return html
}

const fileToB64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(String(r.result).split(',')[1])
  r.onerror = rej
  r.readAsDataURL(blob)
})

// ------------------------------------------------------------------
export default function App() {
  const [session, setSession] = useState(null)
  const [tab, setTab] = useState('apps')
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const notify = (m) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  if (!CONFIG_READY) return <SetupScreen />
  if (!session) return <Login notify={notify} toast={toast} />

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">Hiyaku<span>AI</span></div>
        <div className="muted small">{APP_VERSION}</div>
      </div>
      {toast && <div className="card" style={{ borderColor: 'var(--teal)' }}>{toast}</div>}
      {tab === 'apps' && <Applications session={session} notify={notify} />}
      {tab === 'new' && <NewApplication session={session} notify={notify} done={() => setTab('apps')} />}
      {tab === 'library' && <Library session={session} notify={notify} />}
      {tab === 'settings' && <Settings session={session} notify={notify} />}
      <nav className="tabbar no-print">
        {[['apps', '📋', 'Applications'], ['new', '✨', 'New'], ['library', '📚', 'Library'], ['settings', '⚙️', 'Settings']].map(([k, ico, lbl]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            <span className="ico">{ico}</span>{lbl}
          </button>
        ))}
      </nav>
    </div>
  )
}

// ---------- Setup guard ----------
function SetupScreen() {
  return (
    <div className="center"><div className="card login">
      <h2>HiyakuAI — configuration needed</h2>
      <p className="muted">This build has no Supabase credentials yet (none were assumed or invented).
        Open <code>src/supabaseClient.js</code> and paste your project URL and anon key from the
        Supabase dashboard, then rebuild and redeploy.</p>
      <p className="muted small">{APP_VERSION}</p>
    </div></div>
  )
}

// ---------- Auth ----------
function Login({ notify, toast }) {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [mode, setMode] = useState('signin')
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true)
    const fn = mode === 'signin'
      ? supabase.auth.signInWithPassword({ email, password: pw })
      : supabase.auth.signUp({ email, password: pw })
    const { error } = await fn
    setBusy(false)
    if (error) notify(error.message)
    else if (mode === 'signup') notify('Account created. If email confirmation is enabled, check your inbox; otherwise sign in.')
  }

  return (
    <div className="center"><div className="card login">
      <div className="brand" style={{ marginBottom: 10 }}>Hiyaku<span>AI</span></div>
      <p className="muted">Job Application Studio — private, single user.</p>
      {toast && <p style={{ color: 'var(--warn)' }}>{toast}</p>}
      <label>Email</label>
      <input value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" />
      <label>Password</label>
      <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" />
      <div style={{ marginTop: 14 }} className="row">
        <button onClick={go} disabled={busy || !email || !pw}>{busy && <span className="spin" />}{mode === 'signin' ? 'Sign in' : 'Create account'}</button>
        <button className="ghost" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
          {mode === 'signin' ? 'First time? Create account' : 'Have an account? Sign in'}
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 14 }}>{APP_VERSION}</p>
    </div></div>
  )
}

// ---------- Applications dashboard ----------
function Applications({ session, notify }) {
  const [apps, setApps] = useState([])
  const [filter, setFilter] = useState('all')
  const [openId, setOpenId] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    const { data, error } = await supabase.from('hiyaku_applications')
      .select('*').order('created_at', { ascending: false })
    if (error) notify(error.message); else setApps(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const counts = useMemo(() => {
    const c = { all: apps.length }
    STATUSES.forEach(s => c[s] = apps.filter(a => a.status === s).length)
    return c
  }, [apps])

  const shown = filter === 'all' ? apps : apps.filter(a => a.status === filter)
  const open = apps.find(a => a.id === openId)
  if (open) return <ApplicationDetail app={open} notify={notify} back={() => { setOpenId(null); load() }} />

  return (
    <div>
      <div className="card">
        <h2>Applications</h2>
        <div className="row" style={{ marginTop: 8 }}>
          {['all', ...STATUSES].map(s => (
            <button key={s} className={filter === s ? '' : 'ghost'} style={{ padding: '5px 10px', fontSize: '.75rem' }}
              onClick={() => setFilter(s)}>{s} ({counts[s] ?? 0})</button>
          ))}
        </div>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {!loading && shown.length === 0 && <p className="muted">No applications{filter !== 'all' ? ` with status "${filter}"` : ''} yet. Create one in the ✨ New tab.</p>}
      {shown.map(a => (
        <div key={a.id} className="list-item" onClick={() => setOpenId(a.id)} style={{ cursor: 'pointer' }}>
          <div className="hstack">
            <div>
              <strong>{a.role_title}</strong>
              <div className="muted small">{a.company}{a.source ? ` · via ${a.source}` : ''}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
              <span className={`badge b-${a.status}`}>{a.status}</span>
              {(() => {
                const sv = a.suitability || null
                const sc = sv && Number.isFinite(Number(sv.score)) ? Math.max(0, Math.min(100, Number(sv.score))) : null
                if (sc === null) return <span className="small" style={{ padding: '3px 9px', borderRadius: 999, border: '1px solid var(--line)', color: 'var(--muted)', whiteSpace: 'nowrap' }}>Not assessed</span>
                const color = VERDICT_META[sv.verdict]?.color || 'var(--muted)'
                return <span className="small" style={{ padding: '3px 9px', borderRadius: 999, border: `1px solid ${color}`, color, fontWeight: 700, whiteSpace: 'nowrap' }}>Fit {sc}/100</span>
              })()}
            </div>
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            Created {a.created_at?.slice(0, 10)}{a.date_applied ? ` · Applied ${a.date_applied}` : ''}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------- Application detail ----------
function ApplicationDetail({ app, notify, back }) {
  const [a, setA] = useState(app)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState('cv')  // cv | letter | jd | notes

  const save = async (patch) => {
    setBusy(true)
    const { data, error } = await supabase.from('hiyaku_applications')
      .update(patch).eq('id', a.id).select().single()
    setBusy(false)
    if (error) notify(error.message)
    else { setA(data); notify('Saved.') }
  }

  const copy = (text, label) => copyMd(text, label, notify)
  const copyRaw = (text, label) => copyPlain(text, label, notify)
  const exportDocx = (kind, text) => exportDocxFile(`${kind} - ${a.company}`, text, notify)
  const printDoc = (title, text) => exportPdf(title, text, notify)

  return (
    <div>
      <button className="ghost no-print" onClick={back}>← Back</button>
      <div className="card" style={{ marginTop: 10 }}>
        <div className="hstack">
          <h2>{a.role_title}</h2>
          <span className={`badge b-${a.status}`}>{a.status}</span>
        </div>
        <div className="muted">{a.company}{a.source ? ` · via ${a.source}` : ''}</div>
        <div className="row" style={{ marginTop: 10 }}>
          <div className="grow">
            <label>Status</label>
            <select value={a.status} onChange={e => save({ status: e.target.value })}>
              {STATUSES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="grow">
            <label>Date applied</label>
            <input type="date" value={a.date_applied || ''} onChange={e => save({ date_applied: e.target.value || null })} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row no-print">
          {[['cv', 'Tailored CV'], ['letter', 'Cover letter'], ['suit', 'Suitability'], ['fit', 'Fit notes'], ['jobinfo', 'Job info'], ['jd', 'Job description'], ['notes', 'My notes']].map(([k, l]) => (
            <button key={k} className={view === k ? '' : 'ghost'} style={{ padding: '6px 10px', fontSize: '.78rem' }} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
        {view === 'cv' && <>
          <textarea rows={18} value={a.cv_generated || ''} onChange={e => setA({ ...a, cv_generated: e.target.value })} />
          <div className="row no-print" style={{ marginTop: 8 }}>
            <button onClick={() => save({ cv_generated: a.cv_generated })} disabled={busy}>Save CV</button>
            <button className="ghost" onClick={() => { const c = sanitizeAts(a.cv_generated); setA({ ...a, cv_generated: c }); save({ cv_generated: c }) }} disabled={busy}>Clean punctuation</button>
            <button className="ghost" onClick={() => copyRaw(a.cv_generated, 'CV')}>Copy raw text</button>
            <button className="ghost" onClick={() => copy(a.cv_generated, 'CV')}>Copy markdown</button>
            <button className="ghost" onClick={() => printDoc(`CV - ${a.company}`, a.cv_generated)}>Export PDF</button>
            <button className="ghost" onClick={() => exportDocx('CV', a.cv_generated)}>Export DOCX</button>
            <button className="ghost" onClick={() => exportTxtFile(`CV - ${a.company}`, a.cv_generated, notify)}>TXT</button>
            <button className="ghost" onClick={() => exportMdFile(`CV - ${a.company}`, a.cv_generated, notify)}>MD</button>
          </div>
        </>}
        {view === 'letter' && <>
          <textarea rows={14} value={a.cover_letter_generated || ''} onChange={e => setA({ ...a, cover_letter_generated: e.target.value })} />
          <div className="row no-print" style={{ marginTop: 8 }}>
            <button onClick={() => save({ cover_letter_generated: a.cover_letter_generated })} disabled={busy}>Save letter</button>
            <button className="ghost" onClick={() => { const c = sanitizeAts(a.cover_letter_generated); setA({ ...a, cover_letter_generated: c }); save({ cover_letter_generated: c }) }} disabled={busy}>Clean punctuation</button>
            <button className="ghost" onClick={() => copyRaw(a.cover_letter_generated, 'Cover letter')}>Copy raw text</button>
            <button className="ghost" onClick={() => copy(a.cover_letter_generated, 'Cover letter')}>Copy markdown</button>
            <button className="ghost" onClick={() => printDoc(`Cover letter - ${a.company}`, a.cover_letter_generated)}>Export PDF</button>
            <button className="ghost" onClick={() => exportDocx('Cover letter', a.cover_letter_generated)}>Export DOCX</button>
          </div>
        </>}
        {view === 'suit' && <AssessmentView data={a.suitability} />}
        {view === 'fit' && <div className="md">{a.fit_notes || 'No fit notes.'}</div>}
        {view === 'jobinfo' && <>
          {[['location', 'Location'], ['qualifications', 'Qualifications'], ['expectations', 'Expectations / responsibilities'], ['how_to_apply', 'How to apply'], ['salary_range', 'Salary range']].map(([k, lbl]) => (
            <div key={k}>
              <label>{lbl}</label>
              <textarea rows={k === 'location' || k === 'salary_range' ? 1 : 3}
                value={a[k] || ''} onChange={e => setA({ ...a, [k]: e.target.value })} />
            </div>
          ))}
          <button style={{ marginTop: 8 }} disabled={busy} onClick={() => save({
            location: a.location, qualifications: a.qualifications, expectations: a.expectations,
            how_to_apply: a.how_to_apply, salary_range: a.salary_range,
          })}>Save job info</button>
        </>}
        {view === 'jd' && <div className="md">{a.job_description || 'No job description stored.'}</div>}
        {view === 'notes' && <>
          <textarea rows={8} value={a.notes || ''} onChange={e => setA({ ...a, notes: e.target.value })} />
          <button style={{ marginTop: 8 }} onClick={() => save({ notes: a.notes })} disabled={busy}>Save notes</button>
        </>}
      </div>

      <div className="card no-print">
        <button className="danger" onClick={async () => {
          if (!confirm('Delete this application and its generated documents?')) return
          const { error } = await supabase.from('hiyaku_applications').delete().eq('id', a.id)
          if (error) notify(error.message); else back()
        }}>Delete application</button>
      </div>
    </div>
  )
}

// ---------- Suitability assessment (profile vs job) ----------
// ---- Screen wake lock ------------------------------------------------------
// iOS auto-locks the screen after a short idle timeout, which suspends the page
// and aborts any in-flight fetch. Hold a screen wake lock for the duration of an
// AI call so the phone stays awake. Reference counted so a chained pair of calls
// (extract -> assess) shares one lock. Fails soft: unsupported or denied (older
// iOS, Low Power Mode) simply means no lock, never a broken feature.
let _wakeLock = null
let _wakeCount = 0
const _requestWake = async () => {
  try {
    if (typeof navigator !== 'undefined' && navigator.wakeLock) {
      _wakeLock = await navigator.wakeLock.request('screen')
      if (_wakeLock && _wakeLock.addEventListener) _wakeLock.addEventListener('release', () => { _wakeLock = null })
    }
  } catch { _wakeLock = null }
}
export const acquireWake = async () => { _wakeCount += 1; if (!_wakeLock) await _requestWake() }
export const releaseWake = async () => {
  _wakeCount = Math.max(0, _wakeCount - 1)
  if (_wakeCount === 0 && _wakeLock) { try { await _wakeLock.release() } catch {} _wakeLock = null }
}
// The OS drops the lock whenever the page is hidden; take it back on return.
export const reacquireWake = async () => { if (_wakeCount > 0 && !_wakeLock) await _requestWake() }

// Was the page hidden at any point during the current run? iOS suspends the page
// on screen lock and kills the in-flight fetch, so a failure that coincides with a
// hidden period is retryable. One listener for the whole app.
let _pageHidden = false
export const beginRun = () => { _pageHidden = false }
export const wasHidden = () => _pageHidden
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) _pageHidden = true
    else reacquireWake()
  })
}

const VERDICT_META = {
  strong_fit: { label: 'Strong fit', color: 'var(--ok)' },
  good_fit: { label: 'Good fit', color: 'var(--teal)' },
  stretch: { label: 'Stretch', color: 'var(--warn)' },
  not_recommended: { label: 'Not recommended', color: 'var(--bad)' },
}

// Renders a stored/derived suitability assessment. Used in the New tab and in
// the application detail view. Renders nothing invented: only what the AI
// returned, which itself is restricted to Library + posting evidence.
function AssessmentView({ data }) {
  if (!data) return <p className="muted">No suitability assessment stored for this application.</p>
  const meta = VERDICT_META[data.verdict] || { label: data.verdict || 'Unknown', color: 'var(--muted)' }
  const score = Number.isFinite(Number(data.score)) ? Math.max(0, Math.min(100, Number(data.score))) : null
  const list = (arr) => (Array.isArray(arr) ? arr : []).filter(x => x && String(x).trim())
  const strengths = list(data.strengths), gaps = list(data.gaps), emphasis = list(data.emphasis)
  return (
    <div>
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        <span className="badge" style={{ background: 'transparent', border: `1px solid ${meta.color}`, color: meta.color }}>{meta.label}</span>
        {score !== null && <strong style={{ color: meta.color, fontSize: '1.05rem' }}>{score}/100</strong>}
        {data.assessed_at && <span className="muted small">Assessed {fmtTime(data.assessed_at)}</span>}
      </div>
      {score !== null && (
        <div style={{ marginTop: 8, height: 6, borderRadius: 999, background: 'var(--panel2)', overflow: 'hidden' }}>
          <div style={{ width: `${score}%`, height: '100%', background: meta.color }} />
        </div>
      )}
      {data.summary && <p style={{ marginTop: 10 }}>{data.summary}</p>}
      {strengths.length > 0 && <>
        <label style={{ marginTop: 10 }}>Strengths vs the requirements (Library-evidenced)</label>
        <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {strengths.map((s, i) => <li key={i} style={{ marginBottom: 4 }}>{s}</li>)}
        </ul>
      </>}
      {gaps.length > 0 && <>
        <label style={{ marginTop: 10 }}>Gaps / risks (no Library evidence)</label>
        <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {gaps.map((g, i) => <li key={i} style={{ marginBottom: 4 }}>{g}</li>)}
        </ul>
      </>}
      {emphasis.length > 0 && <>
        <label style={{ marginTop: 10 }}>What to emphasise if applying</label>
        <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {emphasis.map((x, i) => <li key={i} style={{ marginBottom: 4 }}>{x}</li>)}
        </ul>
      </>}
      <p className="muted small" style={{ marginTop: 10 }}>
        Based only on your Library vs the posting's stated requirements. Anything the posting or your Library doesn't state is treated as absent, never guessed.
      </p>
    </div>
  )
}

// ---------- New application + AI extraction + AI generation ----------
const EXTRACT_FIELDS = [
  ['location', 'Location'],
  ['qualifications', 'Qualifications'],
  ['expectations', 'Expectations / responsibilities'],
  ['how_to_apply', 'How to apply'],
  ['salary_range', 'Salary range'],
]

function NewApplication({ session, notify, done }) {
  const [rawPosting, setRawPosting] = useState('')
  const [files, setFiles] = useState([])
  const [company, setCompany] = useState('')
  const [role, setRole] = useState('')
  const [source, setSource] = useState('')
  const [extracted, setExtracted] = useState({ location: '', qualifications: '', expectations: '', how_to_apply: '', salary_range: '' })
  const [didExtract, setDidExtract] = useState(false)
  const [busyExtract, setBusyExtract] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [assessment, setAssessment] = useState(null)
  const [busyAssess, setBusyAssess] = useState(false)

  // Fetch the whole Library once, in the same shape both generate and assess need.
  const fetchLibrary = async () => {
    const [{ data: prof }, { data: links }, { data: certs }, { data: secs }] = await Promise.all([
      supabase.from('hiyaku_profile').select('*').maybeSingle(),
      supabase.from('hiyaku_links').select('*').eq('include_in_prompt', true),
      supabase.from('hiyaku_certificates').select('name,note,parsed_text'),
      supabase.from('hiyaku_sections').select('section_key,content'),
    ])
    const hasContent = !!(prof?.cv_markdown || prof?.linkedin_headline || prof?.linkedin_about || prof?.extra_notes
      || (secs || []).some(s => s.content && s.content.trim())
      || (certs || []).length || (links || []).length)
    return { prof, links: links || [], certs: certs || [], secs: secs || [], hasContent }
  }

  // Suitability check: profile (Library) vs the loaded job. Runs automatically
  // after a successful extraction. Uses ONLY Library facts + the posting.
  const assess = async (postingText) => {
    if (!postingText || !postingText.trim()) return
    setBusyAssess(true); setAssessment(null)
    await acquireWake()
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        beginRun()
        try {
          const lib = await fetchLibrary()
          if (!lib.hasContent) {
            notify('Library is empty — suitability check skipped. Fill your Library first (Library tab).')
            setBusyAssess(false); return
          }
          const model = localStorage.getItem('hiyaku_model') || DEFAULT_MODEL
          const { data, error } = await supabase.functions.invoke('hiyaku-generate', {
            body: {
              mode: 'assess', jobDescription: postingText,
              referenceCv: lib.prof?.cv_markdown, headline: lib.prof?.linkedin_headline,
              about: lib.prof?.linkedin_about, extraNotes: lib.prof?.extra_notes,
              links: lib.links, certificates: lib.certs, model,
              sections: lib.secs.map(s => ({ title: sectionTitle(s.section_key), content: s.content })),
            },
          })
          if (error) throw new Error(error.message)
          if (data.error) throw new Error(data.error)
          setAssessment({ ...data, assessed_at: new Date().toISOString(), model })
          break
        } catch (e) {
          const suspended = wasHidden()
          if (suspended && attempt === 0) { notify('Screen locked during suitability check - resuming automatically.'); continue }
          notify('Suitability check failed: ' + e.message + (suspended ? ' (the screen locked while processing)' : ''))
          break
        }
      }
    } finally {
      await releaseWake()
      setBusyAssess(false)
    }
  }

  const OK_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']

  const addFiles = (list) => {
    const picked = Array.from(list || [])
    if (!picked.length) return
    const good = picked.filter(f => OK_TYPES.includes(f.type))
    if (good.length !== picked.length) notify('Skipped unsupported files. Use PNG, JPEG, GIF, WebP or PDF.')
    setFiles(prev => {
      const next = [...prev, ...good]
      if (next.length > 8) notify('Maximum 8 files - extra files ignored.')
      return next.slice(0, 8)
    })
  }

  const removeFile = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i))

  const onPaste = (e) => {
    const imgs = Array.from(e.clipboardData?.items || [])
      .filter(i => i.type.startsWith('image/'))
      .map(i => i.getAsFile()).filter(Boolean)
    if (imgs.length) { addFiles(imgs); notify('Screenshot pasted from clipboard.') }
  }

  const extract = async () => {
    if (!rawPosting.trim() && !files.length) { notify('Paste the posting text or add a screenshot first.'); return }
    setBusyExtract(true)
    await acquireWake()
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        beginRun()
        try {
          const model = localStorage.getItem('hiyaku_model') || DEFAULT_MODEL
          const payload = { mode: 'extract', rawPosting, model }
          if (files.length) {
            payload.files = await Promise.all(files.map(async f => ({ base64: await fileToB64(f), mimeType: f.type })))
          }
          const { data, error } = await supabase.functions.invoke('hiyaku-generate', { body: payload })
          if (error) throw new Error(error.message)
          if (data.error) throw new Error(data.error)
          const ns = (v) => (v && v !== 'Not stated' ? v : '')
          setCompany(ns(data.company))
          setRole(ns(data.roleTitle))
          setExtracted({
            location: data.location || 'Not stated',
            qualifications: data.qualifications || 'Not stated',
            expectations: data.expectations || 'Not stated',
            how_to_apply: data.howToApply || 'Not stated',
            salary_range: data.salaryRange || 'Not stated',
          })
          const transcript = ns(data.postingText)
          if (transcript && !rawPosting.trim()) {
            setRawPosting(transcript)
            notify('Screenshots read. Posting text transcribed below - verify it, then Generate.')
          } else {
            notify('Details extracted - review and correct anything before generating.')
          }
          setDidExtract(true)
          // Auto-run the suitability check on the posting we just loaded
          // (state updates are async, so pass the effective text explicitly).
          assess(rawPosting.trim() ? rawPosting : transcript)
          break
        } catch (e) {
          const suspended = wasHidden()
          if (suspended && attempt === 0) { notify('Screen locked during extraction - resuming automatically.'); continue }
          notify('Extraction failed: ' + e.message + (suspended ? ' (the screen locked while processing - keep the screen on and retry)' : ''))
          break
        }
      }
    } finally {
      await releaseWake()
      setBusyExtract(false)
    }
  }

  const generate = async () => {
    setBusy(true); setResult(null)
    await acquireWake()
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        beginRun()
        try {
          const { prof, links, certs, secs, hasContent } = await fetchLibrary()
          if (!hasContent) {
            notify('Your Library is empty — add a reference CV or fill some profile sections first (Library tab).'); setBusy(false); return
          }
          const model = localStorage.getItem('hiyaku_model') || DEFAULT_MODEL
          const { data, error } = await supabase.functions.invoke('hiyaku-generate', {
            body: {
              jobDescription: rawPosting, referenceCv: prof.cv_markdown,
              headline: prof.linkedin_headline, about: prof.linkedin_about,
              extraNotes: prof.extra_notes, links, certificates: certs, model,
              sections: secs.map(s => ({ title: sectionTitle(s.section_key), content: s.content })),
            },
          })
          if (error) throw new Error(error.message)
          if (data.error) throw new Error(data.error)
          setResult(data)
          notify('Draft generated — review and edit below, then save.')
          break
        } catch (e) {
          const suspended = wasHidden()
          if (suspended && attempt === 0) { notify('Screen locked during generation - resuming automatically.'); continue }
          notify('Generation failed: ' + e.message + (suspended ? ' (the screen locked while processing - keep the screen on and retry)' : ''))
          break
        }
      }
    } finally {
      await releaseWake()
      setBusy(false)
    }
  }

  const saveApp = async () => {
    setBusy(true)
    const { error } = await supabase.from('hiyaku_applications').insert({
      user_id: session.user.id,
      company, role_title: role, source, job_description: rawPosting,
      location: extracted.location, qualifications: extracted.qualifications,
      expectations: extracted.expectations, how_to_apply: extracted.how_to_apply,
      salary_range: extracted.salary_range,
      cv_generated: result?.cv || '', cover_letter_generated: result?.coverLetter || '',
      fit_notes: result?.fitNotes || '', suitability: assessment || null, status: 'draft',
    })
    setBusy(false)
    if (error) notify(error.message)
    else { notify('Application saved.'); done() }
  }

  return (
    <div>
      <div className="card"
        onPaste={onPaste}
        onDragOver={e => { e.preventDefault() }}
        onDrop={e => { e.preventDefault(); addFiles(e.dataTransfer?.files) }}>
        <h2>New application</h2>
        <label>Paste the full job posting here (any format)</label>
        <textarea rows={10} value={rawPosting} onChange={e => setRawPosting(e.target.value)}
          placeholder="Paste the entire job advert - company blurb, role, requirements, salary, application instructions. Or add screenshots below." />

        <label style={{ marginTop: 10 }}>Screenshots or PDF of the posting (optional, up to 8)</label>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,.pdf" multiple
          onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
        <p className="muted small">You can also drag files onto this card, or press ⌘V to paste a screenshot straight from the clipboard.</p>

        {files.length > 0 && (
          <div className="row" style={{ marginTop: 6 }}>
            {files.map((f, i) => (
              <span key={i} className="badge b-submitted" style={{ textTransform: 'none', padding: '6px 10px' }}>
                {f.type === 'application/pdf' ? '📄' : '🖼'} {f.name.slice(0, 24)}
                <button className="ghost small" style={{ padding: '0 6px', marginLeft: 6 }} onClick={() => removeFile(i)}>✕</button>
              </span>
            ))}
          </div>
        )}

        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={extract} disabled={busyExtract || (!rawPosting.trim() && !files.length)}>
            {busyExtract && <span className="spin" />}Extract details with AI
          </button>
        </div>
        <p className="muted small">The AI reads only what you supply - text and any screenshots. Anything the posting doesn't state is marked "Not stated", never guessed. Screenshots are transcribed into the box above so the tailored CV has the full posting to work from.</p>
      </div>

      {(busyAssess || assessment) && (
        <div className="card" style={{ borderColor: assessment ? (VERDICT_META[assessment.verdict]?.color || 'var(--teal-d)') : 'var(--teal-d)' }}>
          <h3>Suitability check — your profile vs this job</h3>
          {busyAssess
            ? <p className="muted"><span className="spin" /> Assessing your Library against the posting's stated requirements…</p>
            : <AssessmentView data={assessment} />}
          {!busyAssess && assessment && (
            <p className="muted small" style={{ marginTop: 6 }}>This assessment is saved with the application. If you edit the posting or job fields, press "Extract details with AI" again to re-assess.</p>
          )}
        </div>
      )}

      <div className="card">
        <h3>Application details {didExtract ? '(extracted — please verify)' : '(or fill manually)'}</h3>
        <div className="row">
          <div className="grow"><label>Company *</label><input value={company} onChange={e => setCompany(e.target.value)} /></div>
          <div className="grow"><label>Role title *</label><input value={role} onChange={e => setRole(e.target.value)} /></div>
        </div>
        <label>Source (job board, search firm, referral…)</label>
        <input value={source} onChange={e => setSource(e.target.value)} />
        {EXTRACT_FIELDS.map(([k, lbl]) => (
          <div key={k}>
            <label>{lbl}</label>
            <textarea rows={k === 'location' || k === 'salary_range' ? 1 : 3}
              value={extracted[k]} onChange={e => setExtracted({ ...extracted, [k]: e.target.value })} />
          </div>
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={generate} disabled={busy || !rawPosting.trim()}>
            {busy && <span className="spin" />}Generate tailored CV + cover letter
          </button>
          <button className="ghost" onClick={saveApp} disabled={busy || !company || !role}>
            Save without generating
          </button>
        </div>
        <p className="muted small">Generation uses only your Library facts — the AI is instructed to never invent claims.</p>
      </div>

      {result && <>
        <div className="card">
          <h3>Tailored CV (editable)</h3>
          <textarea rows={16} value={result.cv} onChange={e => setResult({ ...result, cv: e.target.value })} />
        </div>
        <div className="card">
          <h3>Cover letter (editable)</h3>
          <textarea rows={12} value={result.coverLetter} onChange={e => setResult({ ...result, coverLetter: e.target.value })} />
        </div>
        <div className="card">
          <h3>Fit notes</h3>
          <div className="md">{result.fitNotes}</div>
        </div>
        <div className="card">
          <button onClick={saveApp} disabled={busy || !company || !role}>
            {busy && <span className="spin" />}Save application
          </button>
          {(!company || !role) && <p className="muted small">Fill Company and Role title to save.</p>}
        </div>
      </>}
    </div>
  )
}

// ---------- Library ----------
function CertItem({ c, parsing, onOpen, onReparse, onDelete, onSaveText }) {
  const [text, setText] = useState(c.parsed_text || '')
  useEffect(() => { setText(c.parsed_text || '') }, [c.parsed_text])
  return (
    <div className="list-item">
      <div className="hstack">
        <div><strong>{c.name}</strong></div>
        <div className="row">
          <button className="ghost small" onClick={() => onOpen(c)}>Open</button>
          <button className="ghost small" onClick={() => onReparse(c)} disabled={parsing}>{parsing ? 'Parsing…' : 'Re-parse'}</button>
          <button className="danger small" onClick={() => onDelete(c)}>✕</button>
        </div>
      </div>
      <label style={{ marginTop: 6 }}>Parsed details (verify — used by the AI)</label>
      <textarea rows={4} value={text} onChange={e => setText(e.target.value)}
        placeholder={parsing ? 'Reading the document…' : 'Not parsed yet — press Re-parse, or type the details manually.'} />
      <button className="ghost small" style={{ marginTop: 6 }} onClick={() => onSaveText(c, text)}>Save details</button>
    </div>
  )
}

function Library({ session, notify }) {
  const [prof, setProf] = useState(null)
  const [profSaved, setProfSaved] = useState(false)
  const [links, setLinks] = useState([])
  const [certs, setCerts] = useState([])
  const [sections, setSections] = useState({})   // section_key -> { content, updated_at }
  const [savedKey, setSavedKey] = useState('')
  const [parsingId, setParsingId] = useState('')
  const [genericCv, setGenericCv] = useState('')
  const [genericAt, setGenericAt] = useState(null)
  const [busyGeneric, setBusyGeneric] = useState(false)
  const [busy, setBusy] = useState(false)
  const [newLink, setNewLink] = useState({ label: '', url: '', category: 'Other' })

  const load = async () => {
    const [{ data: p }, { data: l }, { data: c }, { data: s }] = await Promise.all([
      supabase.from('hiyaku_profile').select('*').maybeSingle(),
      supabase.from('hiyaku_links').select('*').order('created_at'),
      supabase.from('hiyaku_certificates').select('*').order('created_at'),
      supabase.from('hiyaku_sections').select('*'),
    ])
    setProf(p || { cv_markdown: '', linkedin_headline: '', linkedin_about: '', extra_notes: '' })
    setGenericCv(p?.generic_cv || '')
    setGenericAt(p?.generic_cv_updated_at || null)
    setLinks(l || []); setCerts(c || [])
    const map = {}
    LINKEDIN_SECTIONS.forEach(([k]) => { map[k] = { content: '', updated_at: null } })
    ;(s || []).forEach(row => { map[row.section_key] = { content: row.content || '', updated_at: row.updated_at } })
    setSections(map)
  }
  useEffect(() => { load() }, [])

  const saveProfile = async () => {
    setBusy(true)
    const row = { ...prof, user_id: session.user.id }
    const { error } = await supabase.from('hiyaku_profile').upsert(row, { onConflict: 'user_id' })
    setBusy(false)
    if (error) notify(error.message)
    else { setProfSaved(true); setTimeout(() => setProfSaved(false), 2500); notify('Profile saved.'); load() }
  }

  const setSecContent = (key, val) =>
    setSections(prev => ({ ...prev, [key]: { ...prev[key], content: val } }))

  const saveGenericCv = async (text) => {
    const { error } = await supabase.from('hiyaku_profile')
      .update({ generic_cv: text, generic_cv_updated_at: new Date().toISOString() })
      .eq('user_id', session.user.id)
    if (error) { notify('Could not save: ' + error.message); return false }
    setGenericAt(new Date().toISOString())
    return true
  }

  const generateGenericCv = async () => {
    setBusyGeneric(true)
    await acquireWake()
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        beginRun()
        try {
          const secsArr = LINKEDIN_SECTIONS
            .map(([k, title]) => ({ title, content: sections[k]?.content || '' }))
            .filter(x => x.content.trim())
          const model = localStorage.getItem('hiyaku_model') || DEFAULT_MODEL
          const { data, error } = await supabase.functions.invoke('hiyaku-generate', {
            body: {
              mode: 'generic_cv',
              referenceCv: prof.cv_markdown, headline: prof.linkedin_headline,
              about: prof.linkedin_about, extraNotes: prof.extra_notes,
              links: links.filter(l => l.include_in_prompt), certificates: certs, sections: secsArr, model,
            },
          })
          if (error) throw new Error(error.message)
          if (data.error) throw new Error(data.error)
          const cv = data.cv || ''
          setGenericCv(cv)
          const ok = await saveGenericCv(cv)
          notify(ok ? 'Generic CV generated and saved. Review it, then export.' : 'Generated, but saving failed.')
          break
        } catch (e) {
          const suspended = wasHidden()
          if (suspended && attempt === 0) { notify('Screen locked during generation - resuming automatically.'); continue }
          notify('Generic CV failed: ' + e.message + (suspended ? ' (the screen locked while processing)' : ''))
          break
        }
      }
    } finally {
      await releaseWake()
      setBusyGeneric(false)
    }
  }

  const saveSection = async (key) => {
    setBusy(true)
    const { error } = await supabase.from('hiyaku_sections')
      .upsert({ user_id: session.user.id, section_key: key, content: sections[key]?.content || '' },
        { onConflict: 'user_id,section_key' })
    setBusy(false)
    if (error) { notify(error.message); return }
    setSavedKey(key); setTimeout(() => setSavedKey(''), 2500)
    load()
  }

  const saveAllSections = async () => {
    setBusy(true)
    for (const [k] of LINKEDIN_SECTIONS) {
      const content = sections[k]?.content || ''
      if (content.trim()) {
        await supabase.from('hiyaku_sections')
          .upsert({ user_id: session.user.id, section_key: k, content }, { onConflict: 'user_id,section_key' })
      }
    }
    setBusy(false); notify('All non-empty sections saved.'); load()
  }

  const addLink = async () => {
    const label = (newLink.label || '').trim()
    const url = (newLink.url || '').trim()
    if (!label || !url) { notify('Enter both a label and a URL to add a source.'); return }
    const { error } = await supabase.from('hiyaku_links').insert({ label, url, category: newLink.category, user_id: session.user.id })
    if (error) notify('Could not add source: ' + error.message)
    else { setNewLink({ label: '', url: '', category: 'Other' }); notify('Source added.'); load() }
  }

  const parseCertBytes = async (certId, base64, mimeType) => {
    const model = localStorage.getItem('hiyaku_model') || DEFAULT_MODEL
    await acquireWake()
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        beginRun()
        try {
          const { data, error } = await supabase.functions.invoke('hiyaku-generate', {
            body: { mode: 'parse_cert', fileBase64: base64, mimeType, model },
          })
          if (error) throw new Error(error.message)
          if (data.error) throw new Error(data.error)
          await supabase.from('hiyaku_certificates').update({ parsed_text: data.parsedText || '' }).eq('id', certId)
          return
        } catch (e) {
          if (wasHidden() && attempt === 0) continue
          throw e
        }
      }
    } finally { await releaseWake() }
  }

  const uploadCert = async (file) => {
    if (!file) return
    setBusy(true)
    const path = `${session.user.id}/${Date.now()}_${file.name}`
    const { error: upErr } = await supabase.storage.from('hiyaku-certs').upload(path, file)
    if (upErr) { notify(upErr.message); setBusy(false); return }
    const { data: row, error } = await supabase.from('hiyaku_certificates').insert({
      user_id: session.user.id, name: file.name, storage_path: path, mime_type: file.type,
    }).select().single()
    setBusy(false)
    if (error) { notify(error.message); return }
    notify('Certificate uploaded — reading its contents…')
    setParsingId(row.id)
    try {
      const b64 = await fileToB64(file)
      await parseCertBytes(row.id, b64, file.type)
      notify('Certificate parsed. Verify the details below.')
    } catch (e) { notify('Uploaded, but parsing failed: ' + e.message) }
    setParsingId(''); load()
  }

  const reparseCert = async (c) => {
    setParsingId(c.id)
    try {
      const { data, error } = await supabase.storage.from('hiyaku-certs').createSignedUrl(c.storage_path, 120)
      if (error) throw new Error(error.message)
      const resp = await fetch(data.signedUrl)
      const blob = await resp.blob()
      const b64 = await fileToB64(blob)
      await parseCertBytes(c.id, b64, c.mime_type || blob.type)
      notify('Re-parsed. Verify the details.')
    } catch (e) { notify('Re-parse failed: ' + e.message) }
    setParsingId(''); load()
  }

  const saveCertText = async (c, text) => {
    const { error } = await supabase.from('hiyaku_certificates').update({ parsed_text: text }).eq('id', c.id)
    if (error) notify(error.message); else { notify('Details saved.'); load() }
  }

  const openCert = async (c) => {
    const { data, error } = await supabase.storage.from('hiyaku-certs').createSignedUrl(c.storage_path, 300)
    if (error) notify(error.message); else window.open(data.signedUrl, '_blank')
  }

  const delCert = async (c) => {
    if (!confirm(`Delete ${c.name}?`)) return
    await supabase.storage.from('hiyaku-certs').remove([c.storage_path])
    await supabase.from('hiyaku_certificates').delete().eq('id', c.id)
    load()
  }

  if (!prof) return <p className="muted">Loading…</p>

  return (
    <div>
      <div className="card" style={{ borderColor: 'var(--teal-d)' }}>
        <strong>This entire Library is the AI's source of truth.</strong>
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          When you generate an application, HiyakuAI uses everything here — your reference CV, all LinkedIn sections, links, and the parsed contents of your certificates. It never invents facts beyond what you store here.
        </p>
      </div>

      <div className="card">
        <div className="hstack">
          <h2>Generic CV</h2>
          <span className="muted small">{genericAt ? 'Generated ' + fmtTime(genericAt) : 'Not generated yet'}</span>
        </div>
        <p className="muted small">A complete, role-agnostic master CV built from everything in this Library. Not tailored to any posting - use it for search firms and speculative approaches.</p>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={generateGenericCv} disabled={busyGeneric}>
            {busyGeneric && <span className="spin" />}{genericCv ? 'Regenerate generic CV' : 'Generate generic CV'}
          </button>
        </div>
        {genericCv && <>
          <label style={{ marginTop: 10 }}>Generic CV (editable)</label>
          <textarea rows={14} value={genericCv} onChange={e => setGenericCv(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={async () => { const ok = await saveGenericCv(genericCv); if (ok) notify('Generic CV saved.') }} disabled={busyGeneric}>Save</button>
            <button className="ghost" onClick={() => { const c = sanitizeAts(genericCv); setGenericCv(c); saveGenericCv(c) }}>Clean punctuation</button>
          </div>
          <label style={{ marginTop: 10 }}>Export</label>
          <div className="row">
            <button className="ghost" onClick={() => exportPdf('Generic CV', genericCv, notify)}>PDF</button>
            <button className="ghost" onClick={() => exportDocxFile('Generic CV', genericCv, notify)}>DOCX</button>
            <button className="ghost" onClick={() => exportTxtFile('Generic CV', genericCv, notify)}>TXT file</button>
            <button className="ghost" onClick={() => exportMdFile('Generic CV', genericCv, notify)}>MD file</button>
            <button className="ghost" onClick={() => copyPlain(genericCv, 'Generic CV', notify)}>Copy raw text</button>
            <button className="ghost" onClick={() => copyMd(genericCv, 'Generic CV', notify)}>Copy markdown</button>
          </div>
        </>}
      </div>

      <div className="card">
        <h2>Reference profile</h2>
        <label>Standard reference CV (markdown)</label>
        <textarea rows={14} value={prof.cv_markdown} onChange={e => setProf({ ...prof, cv_markdown: e.target.value })} />
        <label>LinkedIn headline</label>
        <textarea rows={2} value={prof.linkedin_headline} onChange={e => setProf({ ...prof, linkedin_headline: e.target.value })} />
        <label>LinkedIn About</label>
        <textarea rows={6} value={prof.linkedin_about} onChange={e => setProf({ ...prof, linkedin_about: e.target.value })} />
        <label>Extra notes for the AI (preferences, constraints, talking points)</label>
        <textarea rows={3} value={prof.extra_notes} onChange={e => setProf({ ...prof, extra_notes: e.target.value })} />
        <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
          <button onClick={saveProfile} disabled={busy}>{busy && <span className="spin" />}Save profile</button>
          <span className="muted small">
            {profSaved ? '✓ Saved' : (prof.updated_at ? 'Last updated ' + fmtTime(prof.updated_at) : 'Not saved yet')}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="hstack">
          <h2>LinkedIn profile sections</h2>
          <button className="ghost small" onClick={saveAllSections} disabled={busy}>Save all sections</button>
        </div>
        <p className="muted small">Fill each in the same style as LinkedIn. The AI uses all of these when tailoring your CV and cover letter. Each section shows when it was last saved.</p>
        {LINKEDIN_SECTIONS.map(([k, title]) => (
          <div key={k} style={{ marginTop: 12 }}>
            <div className="hstack">
              <label style={{ margin: 0 }}>{title}</label>
              <span className="muted small" style={{ color: savedKey === k ? 'var(--ok)' : undefined }}>
                {savedKey === k ? '✓ Saved' : (sections[k]?.updated_at ? 'Updated ' + fmtTime(sections[k].updated_at) : 'Not saved yet')}
              </span>
            </div>
            <textarea rows={k === 'languages' ? 2 : 4} placeholder={SECTION_PLACEHOLDER[k]}
              value={sections[k]?.content || ''} onChange={e => setSecContent(k, e.target.value)} />
            <button className="ghost small" style={{ marginTop: 6 }} onClick={() => saveSection(k)} disabled={busy}>Save {title}</button>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="hstack">
          <h2>Online sources</h2>
        </div>
        {links.map(l => (
          <div key={l.id} className="list-item hstack">
            <div><strong>{l.label}</strong> <span className="muted small">[{l.category}]</span><br />
              <a href={l.url} target="_blank" rel="noreferrer" className="small">{l.url}</a></div>
            <button className="danger small" onClick={async () => { await supabase.from('hiyaku_links').delete().eq('id', l.id); load() }}>✕</button>
          </div>
        ))}
        <label style={{ marginTop: 8 }}>Add a source</label>
        <div className="row">
          <input className="grow" placeholder="Label (e.g. LinkedIn, Publication)" value={newLink.label} onChange={e => setNewLink({ ...newLink, label: e.target.value })} />
          <input className="grow" placeholder="https://…" value={newLink.url} onChange={e => setNewLink({ ...newLink, url: e.target.value })} />
          <select value={newLink.category} onChange={e => setNewLink({ ...newLink, category: e.target.value })} style={{ width: 140 }}>
            {['LinkedIn', 'Publication', 'Portfolio', 'Other'].map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <button style={{ marginTop: 8 }} onClick={addLink}>Add source</button>
      </div>

      <div className="card">
        <h2>Certificates & qualifications</h2>
        <p className="muted small">On upload, the AI reads the file and extracts the details for use in your applications. Verify the parsed text — you can edit it. Only what's visibly in the document is extracted; nothing is invented.</p>
        {certs.map(c => (
          <CertItem key={c.id} c={c} parsing={parsingId === c.id}
            onOpen={openCert} onReparse={reparseCert} onDelete={delCert} onSaveText={saveCertText} />
        ))}
        <label>Upload (PDF / image)</label>
        <input type="file" accept=".pdf,image/*" onChange={e => uploadCert(e.target.files?.[0])} />
      </div>
    </div>
  )
}

// ---------- Settings ----------
function Settings({ session, notify }) {
  const [model, setModel] = useState(localStorage.getItem('hiyaku_model') || DEFAULT_MODEL)

  const exportAll = async () => {
    const [p, l, c, a, s] = await Promise.all([
      supabase.from('hiyaku_profile').select('*'),
      supabase.from('hiyaku_links').select('*'),
      supabase.from('hiyaku_certificates').select('*'),
      supabase.from('hiyaku_applications').select('*'),
      supabase.from('hiyaku_sections').select('*'),
    ])
    const blob = new Blob([JSON.stringify({
      exported_at: new Date().toISOString(), app_version: APP_VERSION,
      profile: p.data, sections: s.data, links: l.data, certificates_metadata: c.data, applications: a.data,
      note: 'Certificate FILES are in Supabase Storage bucket hiyaku-certs and are not inside this JSON.',
    }, null, 2)], { type: 'application/json' })
    const u = URL.createObjectURL(blob)
    const el = document.createElement('a'); el.href = u; el.download = `hiyakuai-backup-${Date.now()}.json`; el.click()
    URL.revokeObjectURL(u)
  }

  return (
    <div>
      <div className="card">
        <h2>Settings</h2>
        <label>AI model (used by the Edge Function)</label>
        <input value={model} onChange={e => { setModel(e.target.value); localStorage.setItem('hiyaku_model', e.target.value) }} />
        <p className="muted small">Default: {DEFAULT_MODEL}. Change only to a valid Anthropic model string.</p>
      </div>
      <div className="card">
        <h2>Backup</h2>
        <button onClick={exportAll}>Export all data (JSON)</button>
        <p className="muted small">Data lives in your Supabase project; this JSON is an additional local backup.</p>
      </div>
      <div className="card">
        <h2>Account</h2>
        <p className="muted small">{session.user.email}</p>
        <button className="ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
      <p className="muted small" style={{ textAlign: 'center' }}>HiyakuAI {APP_VERSION}</p>
    </div>
  )
}
