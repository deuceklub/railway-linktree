import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4kb' }));

const PORT = process.env.PORT || 3000;
const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN;
const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

// Changing a project's default URL requires this PIN (the page itself is public).
const DEFAULTS_PIN = process.env.DEFAULTS_PIN;
// Saved defaults live on a Railway volume mounted here so they survive redeploys.
const DATA_DIR = process.env.DATA_DIR || '/data';
const DEFAULTS_FILE = path.join(DATA_DIR, 'defaults.json');

interface DomainEntry {
  domain: string;
}

interface ServiceInstance {
  serviceName: string;
  domains: {
    customDomains: DomainEntry[];
    serviceDomains: DomainEntry[];
  };
}

interface Environment {
  name: string;
  serviceInstances: {
    edges: { node: ServiceInstance }[];
  };
}

interface Project {
  id: string;
  name: string;
  description: string | null;
  environments: {
    edges: { node: Environment }[];
  };
}

interface WorkspacesResponse {
  data: { me: { workspaces: { id: string; name: string }[] } };
  errors?: { message: string }[];
}

interface WorkspaceProjectsResponse {
  data: { workspace: { projects: { edges: { node: Project }[] } } };
  errors?: { message: string }[];
}

interface SiteUrl {
  url: string;
  service: string;
  env: string;
  custom: boolean;
}

interface ProjectLink {
  id: string;
  name: string;
  description: string | null;
  urls: SiteUrl[];
  railwayUrl: string;
}

async function gql<T>(query: string, token: string): Promise<T> {
  const response = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`Railway API error: ${response.status} ${response.statusText}`);
  const json = (await response.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`Railway API error: ${json.errors[0].message}`);
  return json.data;
}

// Workspace tokens are rejected by the account-scoped `me` query, which is what
// caused "Not Authorized". Prefer an explicit WORKSPACE_ID, then the token-scoped
// `apiToken` lookup, and only fall back to `me` for personal account tokens.
async function getWorkspaceIds(token: string): Promise<string[]> {
  const configured = (process.env.WORKSPACE_ID ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length) return configured;

  try {
    const t = await gql<{ apiToken: { workspaces: { id: string }[] } | null }>(
      `{ apiToken { workspaces { id } } }`,
      token
    );
    const ids = t.apiToken?.workspaces?.map((w) => w.id) ?? [];
    if (ids.length) return ids;
  } catch {
    // fall through to the account-token lookup
  }

  const me = await gql<WorkspacesResponse['data']>(`{ me { workspaces { id name } } }`, token);
  return me.me.workspaces.map((w) => w.id);
}

// Comma-separated project names to leave off the public page, e.g. HIDE_PROJECTS="personal-finance,health-hub"
const HIDDEN = new Set(
  (process.env.HIDE_PROJECTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Every public URL in a project, best candidates first: production before other
// environments, then a service named like the project, then custom domains.
function collectUrls(project: Project): SiteUrl[] {
  const found: (SiteUrl & { rank: number })[] = [];
  const seen = new Set<string>();

  for (const { node: env } of project.environments.edges) {
    const isProd = env.name.toLowerCase() === 'production';
    for (const { node: inst } of env.serviceInstances.edges) {
      const nameMatch = norm(inst.serviceName) === norm(project.name);
      const add = (domain: string, custom: boolean) => {
        const url = `https://${domain}`;
        if (seen.has(url)) return;
        seen.add(url);
        found.push({
          url,
          service: inst.serviceName,
          env: env.name,
          custom,
          rank: (isProd ? 0 : 4) + (nameMatch ? 0 : 2) + (custom ? 0 : 1),
        });
      };
      inst.domains.customDomains.forEach((d) => add(d.domain, true));
      inst.domains.serviceDomains.forEach((d) => add(d.domain, false));
    }
  }

  return found
    .sort((a, b) => a.rank - b.rank || a.url.localeCompare(b.url))
    .map(({ rank: _rank, ...rest }) => rest);
}

async function fetchRailwayProjects(): Promise<ProjectLink[]> {
  if (!RAILWAY_API_TOKEN) {
    throw new Error('RAILWAY_API_TOKEN environment variable is not set');
  }

  // Step 1: find the workspaces this token can see
  const workspaceIds = await getWorkspaceIds(RAILWAY_API_TOKEN);

  // Step 2: fetch projects from all workspaces in parallel
  const projectsPerWorkspace = await Promise.all(
    workspaceIds.map((id) =>
      gql<WorkspaceProjectsResponse['data']>(
        `{ workspace(workspaceId: "${id}") { projects { edges { node {
          id name description
          environments { edges { node { name serviceInstances { edges { node {
            serviceName
            domains { customDomains { domain } serviceDomains { domain } }
          } } } } } }
        } } } } }`,
        RAILWAY_API_TOKEN!
      )
    )
  );

  const allProjects = projectsPerWorkspace
    .flatMap((d) => d.workspace.projects.edges.map((e) => e.node))
    .filter((p) => !HIDDEN.has(p.name.toLowerCase()));

  const projects = allProjects.map((node) => ({
    id: node.id,
    name: node.name,
    description: node.description,
    urls: collectUrls(node),
    railwayUrl: `https://railway.com/project/${node.id}`,
  }));

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Saved defaults (projectId -> chosen URL) ----

const defaults = new Map<string, string>();

try {
  const raw = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8')) as Record<string, string>;
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') defaults.set(k, v);
} catch {
  // no saved defaults yet, or the volume is not mounted
}

function saveDefaults(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DEFAULTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(defaults), null, 2));
  fs.renameSync(tmp, DEFAULTS_FILE);
}

// The saved choice if it still exists, otherwise the best-ranked URL.
function pickDefault(p: ProjectLink): SiteUrl | null {
  const saved = defaults.get(p.id);
  return p.urls.find((u) => u.url === saved) ?? p.urls[0] ?? null;
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- Page ----

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const CLIENT_JS = `
(function () {
  var data = JSON.parse(document.getElementById('lt-data').textContent);
  var byId = {};
  data.forEach(function (p) { byId[p.id] = p; });

  var sheet = document.getElementById('sheet');
  var rows = document.getElementById('sheet-rows');
  var title = document.getElementById('sheet-title');
  var msg = document.getElementById('sheet-msg');
  var pin = document.getElementById('pin');
  var current = null;

  try { pin.value = sessionStorage.getItem('lt_pin') || ''; } catch (e) {}

  function closeSheet() { sheet.hidden = true; document.body.classList.remove('lock'); }

  function drawRows() {
    rows.innerHTML = '';
    current.urls.forEach(function (u) {
      var row = document.createElement('div');
      row.className = 'row';

      var info = document.createElement('div');
      info.className = 'row-info';
      var label = document.createElement('div');
      label.className = 'row-label';
      label.textContent = u.service + ' \\u00b7 ' + u.env;
      var host = document.createElement('div');
      host.className = 'row-host';
      host.textContent = u.url.replace('https://', '');
      info.appendChild(label);
      info.appendChild(host);

      var open = document.createElement('a');
      open.href = u.url;
      open.target = '_blank';
      open.rel = 'noopener';
      open.className = 'row-btn';
      open.textContent = 'Open';

      var set = document.createElement('button');
      set.className = 'row-btn';
      var isDef = u.url === current.def;
      set.textContent = isDef ? 'Default \\u2713' : 'Set default';
      set.disabled = isDef;
      set.addEventListener('click', function () { save(u.url); });

      row.appendChild(info);
      row.appendChild(open);
      row.appendChild(set);
      rows.appendChild(row);
    });
  }

  function openSheet(id) {
    current = byId[id];
    title.textContent = current.name;
    msg.textContent = '';
    drawRows();
    sheet.hidden = false;
    document.body.classList.add('lock');
  }

  async function save(url) {
    msg.textContent = 'Saving...';
    try {
      var r = await fetch('/api/default', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: current.id, url: url, pin: pin.value })
      });
      var j = {};
      try { j = await r.json(); } catch (e) {}
      if (!r.ok) { msg.textContent = j.error || ('Failed (' + r.status + ')'); return; }
      try { sessionStorage.setItem('lt_pin', pin.value); } catch (e) {}
      current.def = j.url;
      var link = document.getElementById('open-' + current.id);
      if (link && j.url) link.href = j.url;
      drawRows();
      msg.textContent = 'Default saved.';
    } catch (e) {
      msg.textContent = 'Network error. Try again.';
    }
  }

  document.querySelectorAll('[data-pick]').forEach(function (b) {
    b.addEventListener('click', function () { openSheet(b.getAttribute('data-pick')); });
  });
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  document.getElementById('sheet-backdrop').addEventListener('click', closeSheet);
  document.getElementById('sheet-auto').addEventListener('click', function () { save(null); });
})();
`;

function renderPage(projects: ProjectLink[], error?: string): string {
  const clientData = projects.map((p) => ({
    id: p.id,
    name: p.name,
    def: pickDefault(p)?.url ?? null,
    urls: p.urls,
  }));
  const dataJson = JSON.stringify(clientData).replace(/</g, '\\u003c');

  const links = error
    ? `<div class="error">Failed to load projects: ${escapeHtml(error)}</div>`
    : projects
        .map((p) => {
          const def = pickDefault(p);
          const action = def
            ? `<a class="visit-btn" id="open-${escapeHtml(p.id)}" href="${escapeHtml(def.url)}" target="_blank" rel="noopener">Open App ↗</a>${
                p.urls.length > 1
                  ? `<button class="more-btn" data-pick="${escapeHtml(p.id)}">▾ ${p.urls.length} URLs</button>`
                  : ''
              }`
            : `<span class="no-url">No public URL</span>`;
          return `
    <div class="card">
      <div class="card-header">
        <h2>${escapeHtml(p.name)}</h2>
        <a class="railway-badge" href="${escapeHtml(p.railwayUrl)}" target="_blank" rel="noopener">Railway ↗</a>
      </div>
      ${p.description ? `<p class="description">${escapeHtml(p.description)}</p>` : ''}
      <div class="actions">${action}</div>
    </div>`;
        })
        .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>My Railway Projects</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0b0d0e;
      color: #e1e4e8;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 3rem 1rem;
    }

    body.lock { overflow: hidden; }

    header {
      text-align: center;
      margin-bottom: 2.5rem;
    }

    header h1 {
      font-size: 2rem;
      font-weight: 700;
      background: linear-gradient(135deg, #7c4dff, #00c6ff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.4rem;
    }

    header p {
      color: #6e7681;
      font-size: 0.9rem;
    }

    .grid {
      width: 100%;
      max-width: 680px;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 1.25rem 1.5rem;
      transition: border-color 0.15s;
    }

    .card:hover { border-color: #7c4dff; }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.5rem;
    }

    .card-header h2 {
      font-size: 1.1rem;
      font-weight: 600;
    }

    .railway-badge {
      font-size: 0.75rem;
      color: #8b949e;
      text-decoration: none;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 2px 8px;
      white-space: nowrap;
      transition: color 0.15s, border-color 0.15s;
    }

    .railway-badge:hover { color: #7c4dff; border-color: #7c4dff; }

    .description {
      font-size: 0.875rem;
      color: #8b949e;
      margin-bottom: 0.75rem;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.25rem;
    }

    .visit-btn {
      display: inline-block;
      background: #7c4dff;
      color: #fff;
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.4rem 1rem;
      border-radius: 8px;
      transition: background 0.15s;
    }

    .visit-btn:hover { background: #6a3fd9; }

    .more-btn {
      background: transparent;
      color: #8b949e;
      border: 1px solid #30363d;
      border-radius: 8px;
      font-size: 0.8rem;
      padding: 0.4rem 0.75rem;
      cursor: pointer;
    }

    .more-btn:hover { color: #7c4dff; border-color: #7c4dff; }

    .no-url {
      font-size: 0.8rem;
      color: #484f58;
    }

    .error {
      background: #1f1117;
      border: 1px solid #8b1a1a;
      color: #f85149;
      border-radius: 8px;
      padding: 1rem 1.25rem;
      font-size: 0.9rem;
    }

    footer {
      margin-top: 3rem;
      color: #484f58;
      font-size: 0.8rem;
    }

    footer a { color: #484f58; }

    /* bottom sheet */
    .sheet[hidden] { display: none; }
    .sheet { position: fixed; inset: 0; z-index: 10; display: flex; align-items: flex-end; justify-content: center; }
    .sheet-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.6); }
    .sheet-panel {
      position: relative;
      width: 100%;
      max-width: 680px;
      max-height: 80vh;
      overflow-y: auto;
      background: #161b22;
      border: 1px solid #30363d;
      border-bottom: none;
      border-radius: 16px 16px 0 0;
      padding: 1.25rem 1.25rem 1.75rem;
    }
    .sheet-title { font-size: 1.05rem; font-weight: 600; margin-bottom: 0.75rem; }
    .row { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0; border-top: 1px solid #21262d; }
    .row-info { flex: 1; min-width: 0; }
    .row-label { font-size: 0.9rem; }
    .row-host { font-size: 0.75rem; color: #6e7681; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-btn {
      background: transparent;
      color: #e1e4e8;
      border: 1px solid #30363d;
      border-radius: 8px;
      font-size: 0.78rem;
      padding: 0.35rem 0.6rem;
      text-decoration: none;
      cursor: pointer;
      white-space: nowrap;
    }
    .row-btn:disabled { color: #3fb950; border-color: #238636; cursor: default; }
    .pin-row { margin-top: 0.9rem; }
    .pin-row input {
      width: 100%;
      background: #0b0d0e;
      color: #e1e4e8;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 0.55rem 0.75rem;
      font-size: 1rem;
    }
    .sheet-msg { min-height: 1.2rem; margin-top: 0.5rem; font-size: 0.8rem; color: #8b949e; }
    .sheet-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .sheet-actions button {
      flex: 1;
      background: transparent;
      color: #8b949e;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 0.55rem;
      font-size: 0.85rem;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <header>
    <h1>My Railway Projects</h1>
    <p>Updated on every page load</p>
  </header>
  <div class="grid">
    ${links}
  </div>
  <footer>Powered by <a href="https://railway.com" target="_blank" rel="noopener">Railway</a></footer>

  <div class="sheet" id="sheet" hidden>
    <div class="sheet-backdrop" id="sheet-backdrop"></div>
    <div class="sheet-panel">
      <div class="sheet-title" id="sheet-title"></div>
      <div id="sheet-rows"></div>
      <div class="pin-row">
        <input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN to change default" />
      </div>
      <div class="sheet-msg" id="sheet-msg"></div>
      <div class="sheet-actions">
        <button id="sheet-auto" type="button">Use automatic</button>
        <button id="sheet-close" type="button">Close</button>
      </div>
    </div>
  </div>

  <script id="lt-data" type="application/json">${dataJson}</script>
  <script>${CLIENT_JS}</script>
</body>
</html>`;
}

// ---- Routes ----

// Cache for a minute so page loads don't hammer the API, and keep serving the last
// good list if Railway has a hiccup. A restart clears the cache.
const CACHE_MS = 60_000;
let cache: { at: number; projects: ProjectLink[] } | null = null;

async function getProjects(): Promise<ProjectLink[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.projects;
  try {
    const projects = await fetchRailwayProjects();
    cache = { at: Date.now(), projects };
    return projects;
  } catch (err) {
    console.error('Failed to refresh projects:', err instanceof Error ? err.message : err);
    if (cache) return cache.projects;
    throw err;
  }
}

// Lightweight route for Railway's healthcheck; does not call the Railway API.
app.get('/healthz', (_req, res) => {
  res.status(200).send('ok');
});

const failures = new Map<string, { count: number; resetAt: number }>();

app.post('/api/default', async (req, res) => {
  if (!DEFAULTS_PIN) {
    res.status(403).json({ error: 'Changing defaults is turned off (no PIN configured).' });
    return;
  }

  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const f = failures.get(ip);
  if (f && f.resetAt > now && f.count >= 5) {
    res.status(429).json({ error: 'Too many wrong PINs. Try again in a few minutes.' });
    return;
  }

  const { projectId, url, pin } = (req.body ?? {}) as { projectId?: unknown; url?: unknown; pin?: unknown };

  if (typeof pin !== 'string' || !safeEqual(pin, DEFAULTS_PIN)) {
    const live = f && f.resetAt > now ? f : { count: 0, resetAt: now + 10 * 60_000 };
    live.count += 1;
    failures.set(ip, live);
    res.status(403).json({ error: 'Wrong PIN.' });
    return;
  }
  failures.delete(ip);

  try {
    const projects = await getProjects();
    const project = typeof projectId === 'string' ? projects.find((p) => p.id === projectId) : undefined;
    if (!project) {
      res.status(404).json({ error: 'Unknown project.' });
      return;
    }

    const previous = defaults.get(project.id);
    if (url === null) {
      defaults.delete(project.id);
    } else if (typeof url === 'string' && project.urls.some((u) => u.url === url)) {
      defaults.set(project.id, url);
    } else {
      res.status(400).json({ error: 'That URL does not belong to this project.' });
      return;
    }

    try {
      saveDefaults();
    } catch (err) {
      // roll back so memory matches what is actually stored
      if (previous === undefined) defaults.delete(project.id);
      else defaults.set(project.id, previous);
      console.error('Failed to save defaults:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Could not save. Storage is not available.' });
      return;
    }

    res.json({ url: pickDefault(project)?.url ?? null });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unexpected error.' });
  }
});

app.get('/', async (_req, res) => {
  try {
    const projects = await getProjects();
    res.send(renderPage(projects));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).send(renderPage([], message));
  }
});

app.listen(PORT, () => {
  console.log(`Railway Linktree running on port ${PORT}`);
});
