// Regenerates the auto-managed sections of README.md from the GitHub API.
// Usage: GITHUB_TOKEN=... node scripts/update-readme.mjs
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(root, "projects.config.json"), "utf8"));
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

async function gh(url) {
  const res = await fetch(url.startsWith("http") ? url : `https://api.github.com${url}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "profile-readme-updater",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function listRepos(user) {
  const repos = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/users/${user}/repos?type=owner&sort=pushed&per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) return repos;
  }
}

const escape = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const month = (iso) => {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const all = await listRepos(config.user);
const exclude = new Set(config.exclude.map((n) => n.toLowerCase()));
const repos = all
  .filter((r) => !r.private && !r.archived && (config.includeForks || !r.fork))
  .filter((r) => !exclude.has(r.name.toLowerCase()))
  .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

// --- Projects table ---------------------------------------------------------
const rows = repos.map((r) => {
  const desc = r.description || config.descriptions[r.name] || "";
  const links = [`[${escape(r.name)}](${r.html_url})`];
  if (r.homepage && !r.homepage.includes("github.com/users/")) links.push(`[live](${r.homepage})`);
  const stars = r.stargazers_count ? ` ⭐ ${r.stargazers_count}` : "";
  return `| ${links.join(" · ")}${stars} | ${escape(desc)} | ${r.language ?? "-"} | ${month(r.pushed_at)} |`;
});
const projects = [
  `| Project | What it is | Language | Last update |`,
  `| --- | --- | --- | --- |`,
  ...rows,
].join("\n");

// --- Language breakdown (by each repo's primary language) ------------------
// Counting repos rather than bytes keeps vendored/forked code from dominating the chart.
const counts = {};
for (const r of repos) if (r.language) counts[r.language] = (counts[r.language] || 0) + 1;
const top = Object.entries(counts)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 8);
const max = Math.max(...top.map(([, n]) => n), 1);
const width = Math.max(...top.map(([l]) => l.length), 1);
const languages = [
  "```text",
  ...top.map(([lang, n]) => {
    const filled = Math.round((n / max) * 20);
    const label = `${n} repo${n === 1 ? "" : "s"}`;
    return `${lang.padEnd(width)}  ${"█".repeat(filled)}${"░".repeat(20 - filled)}  ${label}`;
  }),
  "```",
].join("\n");

const stamp = `<sub>${repos.length} public projects · updated automatically by GitHub Actions on ${new Date()
  .toISOString()
  .slice(0, 10)}</sub>`;

// --- Write back -------------------------------------------------------------
function replaceSection(text, name, body) {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  if (!re.test(text)) throw new Error(`Missing ${name} markers in README.md`);
  return text.replace(re, `$1\n${body}\n$2`);
}

const readmePath = path.join(root, "README.md");
const before = await readFile(readmePath, "utf8");
let after = replaceSection(before, "PROJECTS", projects);
after = replaceSection(after, "LANGUAGES", languages);
// Only bump the date stamp when real content changed, so the bot does not commit daily for nothing.
if (after !== before) after = replaceSection(after, "UPDATED", stamp);

if (after === before) {
  console.log("README.md is already up to date.");
} else {
  await writeFile(readmePath, after);
  console.log(`README.md updated with ${repos.length} projects.`);
}
