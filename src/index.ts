import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;
const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN;
const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

interface ServiceDomain {
  domain: string;
}

interface CustomDomain {
  domain: string;
}

interface ServiceInstance {
  domains: {
    customDomains: CustomDomain[];
    serviceDomains: ServiceDomain[];
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

interface ProjectsResponse {
  data: {
    me: {
      projects: {
        edges: { node: Project }[];
      };
    };
  };
  errors?: { message: string }[];
}

interface ProjectLink {
  name: string;
  description: string | null;
  url: string | null;
  railwayUrl: string;
}

async function fetchRailwayProjects(): Promise<ProjectLink[]> {
  if (!RAILWAY_API_TOKEN) {
    throw new Error('RAILWAY_API_TOKEN environment variable is not set');
  }

  const query = `
    query {
      me {
        projects {
          edges {
            node {
              id
              name
              description
              environments {
                edges {
                  node {
                    name
                    serviceInstances {
                      edges {
                        node {
                          domains {
                            customDomains {
                              domain
                            }
                            serviceDomains {
                              domain
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RAILWAY_API_TOKEN}`,
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Railway API error: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as ProjectsResponse;

  if (json.errors?.length) {
    throw new Error(`Railway API error: ${json.errors[0].message}`);
  }

  const projects = json.data.me.projects.edges.map(({ node }) => {
    // Find production environment (or first env) to get URL
    const envs = node.environments.edges.map((e) => e.node);
    const prodEnv = envs.find((e) => e.name.toLowerCase() === 'production') ?? envs[0];

    let url: string | null = null;
    if (prodEnv) {
      // Collect all domains from all services in the environment
      for (const { node: instance } of prodEnv.serviceInstances.edges) {
        const custom = instance.domains.customDomains[0]?.domain;
        const railway = instance.domains.serviceDomains[0]?.domain;
        const domain = custom ?? railway;
        if (domain) {
          url = `https://${domain}`;
          break;
        }
      }
    }

    return {
      name: node.name,
      description: node.description,
      url,
      railwayUrl: `https://railway.com/project/${node.id}`,
    };
  });

  // Sort alphabetically
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

function renderPage(projects: ProjectLink[], error?: string): string {
  const links = error
    ? `<div class="error">Failed to load projects: ${escapeHtml(error)}</div>`
    : projects
        .map(
          (p) => `
    <div class="card">
      <div class="card-header">
        <h2>${escapeHtml(p.name)}</h2>
        <a class="railway-badge" href="${p.railwayUrl}" target="_blank" rel="noopener">Railway ↗</a>
      </div>
      ${p.description ? `<p class="description">${escapeHtml(p.description)}</p>` : ''}
      ${
        p.url
          ? `<a class="visit-btn" href="${p.url}" target="_blank" rel="noopener">Open App ↗</a>`
          : `<span class="no-url">No public URL</span>`
      }
    </div>`
        )
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

    .visit-btn {
      display: inline-block;
      margin-top: 0.25rem;
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
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

app.get('/', async (_req, res) => {
  try {
    const projects = await fetchRailwayProjects();
    res.send(renderPage(projects));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).send(renderPage([], message));
  }
});

app.listen(PORT, () => {
  console.log(`Railway Linktree running on port ${PORT}`);
});
