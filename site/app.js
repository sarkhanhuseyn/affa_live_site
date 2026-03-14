const app = document.querySelector("#app");
const refreshButton = document.querySelector("#refresh-data");
const dataStatus = document.querySelector("#data-status");

const OPERATOR_STORAGE_KEY = "affa-live-operator-v1";
const OPERATOR_API_URL = "./api/overrides";

let rawDataset = null;
let dataset = null;
let manualDataset = { supplements: [] };
let operatorStore = { matches: {} };

const statusClass = {
  live: "status-live",
  finished: "status-finished",
  scheduled: "status-scheduled",
  halftime: "status-halftime",
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cleanText(value) {
  return String(value || "").trim();
}

function slugify(value) {
  return cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function matchIdentity(match) {
  return [
    match.competition_code,
    match.match_date,
    slugify(match.home_team),
    slugify(match.away_team),
  ].join("|");
}

function emptyLineups() {
  return {
    home: { starter: [], bench: [] },
    away: { starter: [], bench: [] },
  };
}

function getCompetitionBulletins(competitionCode) {
  return (manualDataset.supplements || []).filter((item) => item.competition_code === competitionCode);
}

function buildSupplementalMatches(sourceMatches) {
  const seen = new Set(sourceMatches.map(matchIdentity));
  const supplementalMatches = [];
  (manualDataset.supplements || []).forEach((bulletin) => {
    (bulletin.fixtures || []).forEach((fixture) => {
      const match = {
        id: `manual-${bulletin.competition_code}-${fixture.match_date}-${slugify(fixture.home_team)}-${slugify(fixture.away_team)}`,
        competition_code: bulletin.competition_code,
        match_date: fixture.match_date,
        kickoff_label: fixture.kickoff_label,
        venue: fixture.venue,
        home_team: fixture.home_team,
        away_team: fixture.away_team,
        home_score: 0,
        away_score: 0,
        status: "scheduled",
        phase_label: bulletin.phase_label || "",
        round_label: bulletin.round_label || "",
        group_name: fixture.group_name || "",
        region_name: "",
        lineups: emptyLineups(),
        events: [],
        bulletin_id: bulletin.bulletin_id,
        source_label: bulletin.source_label || "Official bulletin",
      };
      const identity = matchIdentity(match);
      if (!seen.has(identity)) {
        seen.add(identity);
        supplementalMatches.push(match);
      }
    });
  });
  return supplementalMatches;
}

function findFixtureBulletin(match) {
  return getCompetitionBulletins(match.competition_code).find((bulletin) =>
    (bulletin.fixtures || []).some(
      (fixture) =>
        fixture.match_date === match.match_date &&
        cleanText(fixture.home_team) === cleanText(match.home_team) &&
        cleanText(fixture.away_team) === cleanText(match.away_team)
    )
  );
}

function getMatchSuspensions(match) {
  return getCompetitionBulletins(match.competition_code)
    .flatMap((bulletin) => bulletin.suspensions || [])
    .filter((item) => item.team_name === match.home_team || item.team_name === match.away_team);
}

function readOperatorStore() {
  if (operatorStore && operatorStore.matches) {
    return operatorStore;
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(OPERATOR_STORAGE_KEY) || '{"matches":{}}');
    return parsed && parsed.matches ? parsed : { matches: {} };
  } catch (error) {
    return { matches: {} };
  }
}

function writeLocalOperatorStore(store) {
  localStorage.setItem(OPERATOR_STORAGE_KEY, JSON.stringify(store));
}

async function fetchOperatorStore() {
  try {
    const response = await fetch(OPERATOR_API_URL, { cache: "no-store" });
    if (response.ok) {
      const parsed = await response.json();
      const normalized = parsed && parsed.matches ? parsed : { matches: {} };
      writeLocalOperatorStore(normalized);
      return normalized;
    }
  } catch (error) {
    // Fall through to local fallback.
  }
  return readOperatorStore();
}

async function syncOperatorStore({ rerender = true } = {}) {
  const nextStore = await fetchOperatorStore();
  const changed = JSON.stringify(nextStore) !== JSON.stringify(operatorStore);
  operatorStore = nextStore;
  if (rawDataset && changed) {
    dataset = mergeDataset(rawDataset);
    if (rerender) render();
  }
}

function mergeLineups(base = {}, override = {}) {
  return {
    home: {
      starter: override.home?.starter || base.home?.starter || [],
      bench: override.home?.bench || base.home?.bench || [],
    },
    away: {
      starter: override.away?.starter || base.away?.starter || [],
      bench: override.away?.bench || base.away?.bench || [],
    },
  };
}

function mergeMatch(baseMatch, override) {
  if (!override) return baseMatch;
  const merged = { ...baseMatch };
  [
    "status",
    "match_minute",
    "added_time",
    "home_score",
    "away_score",
    "kickoff_label",
    "venue",
    "phase_label",
    "round_label",
  ].forEach((key) => {
    if (override[key] !== undefined && override[key] !== null && override[key] !== "") {
      merged[key] = override[key];
    }
  });
  if (Array.isArray(override.events)) {
    merged.events = override.events;
  }
  if (override.lineups) {
    merged.lineups = mergeLineups(baseMatch.lineups, override.lineups);
  }
  return merged;
}

function buildClubEntries(mergedDataset) {
  const teamsByCompetition = new Map();
  mergedDataset.standings.forEach((row) => {
    const key = row.competition_code;
    if (!teamsByCompetition.has(key)) teamsByCompetition.set(key, new Set());
    teamsByCompetition.get(key).add(row.team_name);
  });
  mergedDataset.matches.forEach((match) => {
    const key = match.competition_code;
    if (!teamsByCompetition.has(key)) teamsByCompetition.set(key, new Set());
    teamsByCompetition.get(key).add(match.home_team);
    teamsByCompetition.get(key).add(match.away_team);
  });

  const clubs = [];
  mergedDataset.competitions.forEach((competition) => {
    const names = [...(teamsByCompetition.get(competition.code) || new Set())].sort((a, b) => a.localeCompare(b));
    names.forEach((teamName) => {
      const standing = mergedDataset.standings.find((row) => row.competition_code === competition.code && row.team_name === teamName) || null;
      const recentMatches = mergedDataset.matches
        .filter((match) => match.competition_code === competition.code && (match.home_team === teamName || match.away_team === teamName))
        .sort((a, b) => b.match_date.localeCompare(a.match_date))
        .slice(0, 5);
      const scorers = mergedDataset.players.filter((row) => row.competition_code === competition.code && row.team_name === teamName);
      clubs.push({
        competition_code: competition.code,
        team_name: teamName,
        standing,
        recent_matches: recentMatches,
        scorers,
      });
    });
  });
  return clubs;
}

function mergeDataset(source) {
  const base = clone(source);
  base.matches = [...base.matches, ...buildSupplementalMatches(base.matches)];
  const store = readOperatorStore();
  base.matches = base.matches.map((match) => mergeMatch(match, store.matches[match.id]));
  base.clubs = buildClubEntries(base);
  return base;
}

function formatDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatShortDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

function statusLabel(match) {
  if (match.status === "finished") return "FT";
  if (match.status === "halftime") return "HT";
  if (match.status === "live") {
    const added = match.added_time ? `+${match.added_time}` : "";
    return match.match_minute ? `${match.match_minute}${added}'` : "LIVE";
  }
  return match.kickoff_label || "NÖVBƏTİ";
}

function liveBadgeLabel(match) {
  if (match.status === "live") return "LIVE";
  if (match.status === "halftime") return "HT";
  if (match.status === "finished") return "FT";
  return "TIME";
}

function unique(values) {
  return [...new Set(values)];
}

function getCompetitions() {
  return dataset?.competitions || [];
}

function getCompetition(code) {
  return getCompetitions().find((item) => item.code === code);
}

function getCompetitionStats(competitionCode) {
  const competitionMatches = dataset.matches.filter((match) => match.competition_code === competitionCode);
  const competitionStandings = dataset.standings.filter((row) => row.competition_code === competitionCode);
  const competitionPlayers = dataset.players.filter((row) => row.competition_code === competitionCode);
  return {
    matches: competitionMatches.length,
    standings: competitionStandings.length,
    players: competitionPlayers.length,
    dates: unique(competitionMatches.map((match) => match.match_date)).length,
    live: competitionMatches.filter((match) => match.status === "live" || match.status === "halftime").length,
    clubs: unique([
      ...competitionMatches.flatMap((match) => [match.home_team, match.away_team]),
      ...competitionStandings.map((row) => row.team_name),
    ]).length,
  };
}

function getCompetitionBulletinStats(competitionCode) {
  const bulletins = getCompetitionBulletins(competitionCode);
  return {
    bulletins: bulletins.length,
    fixtures: bulletins.flatMap((item) => item.fixtures || []).length,
    suspensions: bulletins.flatMap((item) => item.suspensions || []).length,
  };
}

function getFeedBadge(stats) {
  const hasMatches = stats.matches > 0;
  const hasStandings = stats.standings > 0;
  const hasPlayers = stats.players > 0;
  if (hasMatches && hasStandings && hasPlayers) {
    return { label: "Tam məlumat", className: "competition-card__badge--full" };
  }
  if (hasMatches && hasStandings) {
    return { label: "Oyunlar + cədvəl", className: "competition-card__badge--hybrid" };
  }
  if (hasMatches) {
    return { label: "Yalnız oyunlar", className: "competition-card__badge--live" };
  }
  if (hasStandings || hasPlayers) {
    return { label: "Yalnız cədvəl", className: "competition-card__badge--tables" };
  }
  return { label: "Yalnız indeks", className: "competition-card__badge--empty" };
}

function competitionOptionsMarkup(selectedCompetition, route = "all") {
  const includeAll = route === "all";
  const options = [];
  if (includeAll) {
    options.push('<option value="all">Bütün yarışlar</option>');
  }
  getCompetitions().forEach((competition) => {
    const stats = getCompetitionStats(competition.code);
    const badge = getFeedBadge(stats);
    const meta = [];
    if (stats.matches) meta.push(`${stats.matches} oyun`);
    if (stats.standings) meta.push(`${stats.standings} cədvəl sətri`);
    if (stats.players) meta.push(`${stats.players} oyunçu`);
    if (!meta.length) meta.push("Açıq sətir hələ yoxdur");
    options.push(
      `<option value="${competition.code}" ${competition.code === selectedCompetition ? "selected" : ""}>${competition.name} · ${meta.join(" · ")}</option>`
    );
  });
  return options.join("");
}

function getMatches(competitionCode) {
  return dataset.matches.filter((match) => !competitionCode || competitionCode === "all" || match.competition_code === competitionCode);
}

function getStandings(competitionCode) {
  return dataset.standings.filter((row) => !competitionCode || competitionCode === "all" || row.competition_code === competitionCode);
}

function getPlayers(competitionCode) {
  return dataset.players.filter((row) => !competitionCode || competitionCode === "all" || row.competition_code === competitionCode);
}

function getClubEntries(competitionCode) {
  return dataset.clubs.filter((club) => !competitionCode || competitionCode === "all" || club.competition_code === competitionCode);
}

function getMatchById(id) {
  return dataset.matches.find((match) => match.id === id);
}

function currentRoute() {
  return window.location.hash.split("?")[0] || "#/matches";
}

function currentParams() {
  return new URLSearchParams(window.location.hash.split("?")[1] || "");
}

function goTo(route, params) {
  const query = params ? `?${params.toString()}` : "";
  window.location.hash = `${route}${query}`;
}

function renderNavState() {
  const route = currentRoute();
  document.querySelectorAll(".primary-nav a").forEach((link) => {
    const href = link.getAttribute("href");
    const active = href === route || (href === "#/competitions" && route === "#/competition");
    link.classList.toggle("active", active);
  });
}

function compareMatches(a, b) {
  const order = { live: 0, halftime: 1, scheduled: 2, finished: 3 };
  return (
    (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
    String(a.kickoff_label || "").localeCompare(String(b.kickoff_label || "")) ||
    a.home_team.localeCompare(b.home_team)
  );
}

function renderSummary(matches, competitionCode, selectedDate) {
  const liveCount = matches.filter((match) => match.status === "live" || match.status === "halftime").length;
  const teams = unique(getStandings(competitionCode).map((row) => row.team_name));
  const dateCount = unique(getMatches(competitionCode).map((match) => match.match_date)).length;
  return `
    <section class="summary-strip">
      <article class="summary-card"><strong>${selectedDate ? formatShortDate(selectedDate) : "-"}</strong><span>Seçilmiş tarix</span></article>
      <article class="summary-card"><strong>${matches.length}</strong><span>Görünən oyunlar</span></article>
      <article class="summary-card"><strong>${liveCount}</strong><span>Canlı və fasilədə</span></article>
      <article class="summary-card"><strong>${teams.length || dateCount}</strong><span>${teams.length ? "Cədvəldə komandalar" : "Mövcud tarixlər"}</span></article>
    </section>
  `;
}

function renderLandingIntro(matches, selectedCompetition, selectedDate) {
  const totalLive = dataset.matches.filter((match) => match.status === "live" || match.status === "halftime").length;
  const competitionLabel = selectedCompetition === "all" ? "bütün yarışlar" : getCompetition(selectedCompetition)?.name || "seçilmiş yarış";
  return `
    <section class="landing-hero">
      <div class="landing-hero__copy">
        <div class="landing-hero__kicker">AFFA Canlı nəticələr</div>
        <h1>Bu günün oyunları, canlı hesablar və rəsmi yarış məlumatları bir mərkəzdə.</h1>
        <p>${selectedDate ? `${formatDate(selectedDate)}` : "Cari gün"} üzrə ${competitionLabel} üçün təqvim, canlı oyunlar, cədvəllər və operator yeniləmələri burada görünür.</p>
        <div class="landing-hero__actions">
          <a class="button button-primary" href="#/matches?scope=today&competition=all">Bu gün</a>
          <a class="button button-secondary" href="#/competitions">Yarışlara bax</a>
        </div>
      </div>
      <div class="landing-hero__stats">
        <div class="landing-stat"><span>Canlı indi</span><strong>${totalLive}</strong></div>
        <div class="landing-stat"><span>Bu ekranda</span><strong>${matches.length}</strong></div>
        <div class="landing-stat"><span>Yarış sayı</span><strong>${getCompetitions().length}</strong></div>
        <div class="landing-stat"><span>Bülleten</span><strong>${(manualDataset.supplements || []).length}</strong></div>
      </div>
    </section>
  `;
}

function renderCompetitionDirectory(selectedCompetition, route) {
  const cards = getCompetitions()
    .map((competition) => {
      const stats = getCompetitionStats(competition.code);
      const active = competition.code === selectedCompetition ? "competition-card--active" : "";
      const badge = getFeedBadge(stats);
      const tabByRoute = {
        "#/competitions": "overview",
        "#/matches": "matches",
        "#/tables": "table",
        "#/clubs": "clubs",
        "#/players": "players",
      };
      const targetParams = new URLSearchParams();
      targetParams.set("competition", competition.code);
      targetParams.set("tab", tabByRoute[route] || "overview");
      const href = `#/competition?${targetParams.toString()}`;
      return `
        <a class="competition-card ${active}" href="${href}">
          <div class="competition-card__top">
            <strong>${competition.name}</strong>
            <span class="competition-card__badge ${badge.className}">${badge.label}</span>
          </div>
          <div class="competition-card__meta">${competition.category} · ${competition.region}</div>
          <div class="competition-card__stats">
            <span>${stats.matches} matches</span>
            <span>${stats.standings} rows</span>
            <span>${stats.clubs} clubs</span>
          </div>
        </a>
      `;
    })
    .join("");
  return `
    <section class="panel">
      <div class="section-head">
        <div class="section-title">Yarışlar</div>
        <div class="section-meta">AFFA indeksindən ${getCompetitions().length} yarış</div>
      </div>
      <div class="competition-grid">${cards}</div>
    </section>
  `;
}

function renderCompetitions() {
  app.innerHTML = `
    ${renderCompetitionDirectory("", "#/competitions")}
  `;
}

function renderCompetitionDetail() {
  const params = currentParams();
  const selectedCompetition = params.get("competition") || getCompetitions()[0]?.code;
  const selectedTab = params.get("tab") || "overview";
  const competition = getCompetition(selectedCompetition);
  const stats = getCompetitionStats(selectedCompetition);
  const bulletinStats = getCompetitionBulletinStats(selectedCompetition);
  const badge = getFeedBadge(stats);
  const matches = getMatches(selectedCompetition).sort((a, b) => b.match_date.localeCompare(a.match_date));
  const liveMatches = matches.filter((match) => match.status === "live" || match.status === "halftime").sort(compareMatches);
  const standings = getStandings(selectedCompetition);
  const players = getPlayers(selectedCompetition);
  const recentMatches = matches.slice(0, 8);
  const groupedStandings = standings.reduce((acc, row) => {
    if (!acc[row.group_name]) acc[row.group_name] = [];
    acc[row.group_name].push(row);
    return acc;
  }, {});
  const summaryRows = (dataset.import_summary || []).find((row) => row.competition_name === competition?.name);
  const bulletinMarkup = renderOfficialBulletins(selectedCompetition);
  const subnav = [
    ["overview", "Ümumi baxış"],
    ["matches", "Oyunlar"],
    ["table", "Cədvəl"],
    ["clubs", "Klublar"],
    ["players", "Oyunçular"],
  ]
    .map(([key, label]) => {
      const q = new URLSearchParams();
      q.set("competition", selectedCompetition);
      q.set("tab", key);
      return `<a class="${selectedTab === key ? "active" : ""}" href="#/competition?${q.toString()}">${label}</a>`;
    })
    .join("");

  let hubContent = "";
  if (selectedTab === "matches") {
    hubContent = `
      ${bulletinMarkup}
      <section class="table-panel">
        <div class="section-head">
          <div class="section-title">Oyunlar</div>
          <div class="section-meta">${matches.length} oyun</div>
        </div>
        <div class="match-list">
          ${liveMatches.length ? `<div class="group-panel__subhead">Davam edənlər</div>${liveMatches.map(renderMatchRow).join("")}` : ""}
          ${matches.length ? `${liveMatches.length ? '<div class="group-panel__subhead">Bütün oyunlar</div>' : ""}${matches.slice(0, 32).map(renderMatchRow).join("")}` : '<div class="empty-state">Bu yarış üçün təqvim sətirləri tapılmadı.</div>'}
        </div>
      </section>
    `;
  } else if (selectedTab === "table") {
    hubContent = `
      <section class="table-panel">
        <div class="section-head">
          <div class="section-title">Cədvəl</div>
          <div class="section-meta">${Object.keys(groupedStandings).length} qrup</div>
        </div>
        <div class="content-pad">
          ${
            Object.keys(groupedStandings).length
              ? Object.entries(groupedStandings)
                  .map(
                    ([groupName, rows]) => `
                      <div class="group-snippet">
                        <div class="group-snippet__title">${groupName || "Turnir cədvəli"}</div>
                        <div class="table-wrap">
                          <table>
                            <thead><tr><th>#</th><th>Komanda</th><th>O</th><th>TF</th><th>X</th></tr></thead>
                            <tbody>
                              ${rows
                                .sort((a, b) => a.rank - b.rank)
                                .map((row) => `<tr><td>${row.rank}</td><td>${row.team_name}</td><td>${row.played}</td><td>${row.goal_diff}</td><td><strong>${row.points}</strong></td></tr>`)
                                .join("")}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    `
                  )
                  .join("")
              : '<div class="empty-state">Bu yarış üçün cədvəl məlumatı tapılmadı.</div>'
          }
        </div>
      </section>
    `;
  } else if (selectedTab === "clubs") {
    const clubs = getClubEntries(selectedCompetition).slice(0, 24);
    hubContent = `
      <section class="table-panel">
        <div class="section-head">
          <div class="section-title">Klublar</div>
          <div class="section-meta">${clubs.length} klub</div>
        </div>
        <div class="table-wrap">
          ${
            clubs.length
              ? `<table><thead><tr><th>Klub</th><th>Yer</th><th>Xal</th><th></th></tr></thead><tbody>${clubs
                  .map(
                    (club) => `
                      <tr>
                        <td>${club.team_name}</td>
                        <td>${club.standing?.rank ?? "-"}</td>
                        <td>${club.standing?.points ?? "-"}</td>
                        <td><a class="detail-link" href="#/clubs?competition=${selectedCompetition}&club=${encodeURIComponent(club.team_name)}">Klub</a></td>
                      </tr>
                    `
                  )
                  .join("")}</tbody></table>`
              : '<div class="empty-state">Bu yarış üçün klub siyahısı tapılmadı.</div>'
          }
        </div>
      </section>
    `;
  } else if (selectedTab === "players") {
    hubContent = `
      <section class="table-panel">
        <div class="section-head">
          <div class="section-title">Oyunçular</div>
          <div class="section-meta">${players.length} sətir</div>
        </div>
        <div class="table-wrap">
          ${
            players.length
              ? `<table><thead><tr><th>#</th><th>Oyunçu</th><th>Klub</th><th>Qol</th></tr></thead><tbody>${players
                  .map((player) => `<tr><td>${player.rank}</td><td>${player.player_name}</td><td>${player.team_name}</td><td><strong>${player.goals}</strong></td></tr>`)
                  .join("")}</tbody></table>`
              : '<div class="empty-state">Bu yarış üçün açıq oyunçu statistikası yoxdur.</div>'
          }
        </div>
      </section>
    `;
  } else {
    hubContent = `
      ${bulletinMarkup}
      <section class="competition-summary-grid">
        <article class="table-panel">
          <div class="section-head">
            <div class="section-title">Canlı və son oyunlar</div>
            <div class="section-meta">${liveMatches.length} canlı · ${recentMatches.length} göstərilir</div>
          </div>
          <div class="match-list">
            ${liveMatches.length ? `<div class="group-panel__subhead">Davam edənlər</div>${liveMatches.map(renderMatchRow).join("")}` : ""}
            ${recentMatches.length ? `${liveMatches.length ? '<div class="group-panel__subhead">Təqvim</div>' : ""}${recentMatches.map(renderMatchRow).join("")}` : '<div class="empty-state">Bu yarış üçün təqvim sətirləri tapılmadı.</div>'}
          </div>
        </article>
        <article class="table-panel">
          <div class="section-head">
            <div class="section-title">Məlumat əhatəsi</div>
            <div class="section-meta">AFFA idxal vəziyyəti</div>
          </div>
        <div class="content-pad">
          <div class="coverage-list">
              <div class="coverage-row"><strong>Təqvim</strong><span>${stats.matches ? "Var" : "Açıq deyil"}</span></div>
              <div class="coverage-row"><strong>Cədvəl</strong><span>${stats.standings ? "Var" : "Açıq deyil"}</span></div>
              <div class="coverage-row"><strong>Oyunçular</strong><span>${stats.players ? "Var" : "Açıq deyil"}</span></div>
              <div class="coverage-row"><strong>Bülletenlər</strong><span>${bulletinStats.fixtures || bulletinStats.suspensions ? `${bulletinStats.bulletins} əlavə olunub` : "Yoxdur"}</span></div>
              <div class="coverage-row"><strong>Operator qatı</strong><span>Lokal olaraq aktivdir</span></div>
            </div>
          </div>
        </article>
      </section>
      <section class="competition-summary-grid">
        <article class="table-panel">
          <div class="section-head">
            <div class="section-title">Cədvəl görünüşü</div>
            <div class="section-meta">${Object.keys(groupedStandings).length} qrup</div>
          </div>
          <div class="content-pad">
            ${
              Object.keys(groupedStandings).length
                ? Object.entries(groupedStandings)
                    .slice(0, 3)
                    .map(
                      ([groupName, rows]) => `
                        <div class="group-snippet">
                          <div class="group-snippet__title">${groupName || "Turnir cədvəli"}</div>
                          <div class="group-snippet__body">
                            ${rows
                              .sort((a, b) => a.rank - b.rank)
                              .slice(0, 5)
                              .map((row) => `<div class="coverage-row"><strong>${row.rank}. ${row.team_name}</strong><span>${row.points} xal</span></div>`)
                              .join("")}
                          </div>
                        </div>
                      `
                    )
                    .join("")
                : '<div class="empty-state">Bu yarış üçün cədvəl məlumatı tapılmadı.</div>'
            }
          </div>
        </article>
        <article class="table-panel">
          <div class="section-head">
            <div class="section-title">Bombardirlər</div>
            <div class="section-meta">${players.length} sətir</div>
          </div>
          <div class="content-pad">
            ${
              players.length
                ? players
                    .slice(0, 8)
                    .map((player) => `<div class="coverage-row"><strong>${player.player_name}</strong><span>${player.goals} qol · ${player.team_name}</span></div>`)
                    .join("")
                : '<div class="empty-state">Bu yarış üçün açıq oyunçu statistikası yoxdur.</div>'
            }
          </div>
        </article>
      </section>
    `;
  }

  app.innerHTML = `
    <section class="detail-panel competition-header-block">
      <div class="content-pad">
        <div class="competition-breadcrumbs">
          <a href="#/competitions">Yarışlar</a>
          <span>/</span>
          <span>${competition?.name || "Yarış"}</span>
        </div>
        <div class="competition-header-block__top">
          <div>
            <div class="competition-header-block__kicker">${competition?.category || ""} yarış</div>
            <h1 class="competition-header-block__title">${competition?.name || "Yarış"}</h1>
          </div>
          <div class="competition-header-block__actions">
            <a class="detail-link" href="#/matches?scope=all&competition=${selectedCompetition}">Oyunlar</a>
            <a class="detail-link" href="#/tables?competition=${selectedCompetition}">Cədvəl</a>
          </div>
        </div>
      </div>
    </section>
    <section class="detail-panel competition-summary-panel">
      <div class="content-pad">
        <div class="competition-hero">
            <div class="competition-hero__main">
            <div class="competition-hero__badge ${badge.className}">${badge.label}</div>
            <p>
              AFFA public import currently exposes ${stats.matches} matches, ${stats.standings} standings rows, and ${stats.players} player rows for this competition.${bulletinStats.fixtures ? ` An additional official bulletin adds ${bulletinStats.fixtures} scheduled fixtures.` : ""}
            </p>
          </div>
          <div class="competition-hero__stats">
            <div class="stat-box"><span>Oyun günü</span><strong>${stats.dates}</strong></div>
            <div class="stat-box"><span>Canlı indi</span><strong>${stats.live}</strong></div>
            <div class="stat-box"><span>Klub</span><strong>${stats.clubs}</strong></div>
            <div class="stat-box"><span>Bülleten</span><strong>${bulletinStats.bulletins}</strong></div>
            <div class="stat-box"><span>İdxal sətri</span><strong>${summaryRows ? summaryRows.matches + summaryRows.standings + summaryRows.players : 0}</strong></div>
          </div>
        </div>
        ${renderFeedNotice(selectedCompetition)}
      </div>
    </section>
    <section class="panel competition-subnav competition-subnav--sticky">
      <div class="segmented competition-subnav__links">
        ${subnav}
      </div>
    </section>
    ${hubContent}
    <section class="competition-summary-grid">
      <article class="table-panel">
        <div class="section-head">
          <div class="section-title">Tam təqvim</div>
          <div class="section-meta">${matches.length} oyun</div>
        </div>
        <div class="table-wrap">
          ${
            matches.length
              ? `<table><thead><tr><th>Tarix</th><th>Ev</th><th>Hesab</th><th>Səfər</th><th>Tur</th><th></th></tr></thead><tbody>${matches
                  .slice(0, 24)
                  .map(
                    (match) => `
                      <tr class="table-row-link" data-match-link="${encodeURIComponent(match.id)}">
                        <td>${formatDate(match.match_date)}</td>
                        <td>${match.home_team}</td>
                        <td>${match.home_score}-${match.away_score}</td>
                        <td>${match.away_team}</td>
                        <td>${match.round_label || "-"}</td>
                        <td><a class="detail-link" href="#/match?id=${encodeURIComponent(match.id)}">Oyun</a></td>
                      </tr>
                    `
                  )
                  .join("")}</tbody></table>`
              : '<div class="empty-state">Bu yarış üçün təqvim tapılmadı.</div>'
          }
        </div>
      </article>
      <article class="table-panel">
        <div class="section-head">
          <div class="section-title">Yarışı aç</div>
          <div class="section-meta">Ayrı bölmələr</div>
        </div>
        <div class="content-pad competition-links">
          <a class="detail-link" href="#/matches?scope=all&competition=${selectedCompetition}">Oyunlar</a>
          <a class="detail-link" href="#/tables?competition=${selectedCompetition}">Cədvəl</a>
          <a class="detail-link" href="#/clubs?competition=${selectedCompetition}">Klublar</a>
          <a class="detail-link" href="#/players?competition=${selectedCompetition}">Oyunçular</a>
        </div>
      </article>
    </section>
    ${renderCompetitionDirectory(selectedCompetition, "#/competitions")}
  `;

  bindMatchLinks();
  document.querySelectorAll(".table-row-link").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("a, button")) return;
      window.location.hash = `#/match?id=${row.getAttribute("data-match-link")}`;
    });
  });
}

function renderFeedNotice(selectedCompetition) {
  if (!selectedCompetition || selectedCompetition === "all") return "";
  const stats = getCompetitionStats(selectedCompetition);
  const bulletinStats = getCompetitionBulletinStats(selectedCompetition);
  if (stats.matches || stats.standings || stats.players || bulletinStats.fixtures || bulletinStats.suspensions) return "";
  const competition = getCompetition(selectedCompetition);
  return `
    <section class="panel panel-note">
      <strong>${competition?.name || "Seçilmiş yarış"} AFFA-da mövcuddur</strong>
      <span>İctimai səhifə tapıldı, amma idxal zamanı AFFA tərəfindən oxuna bilən təqvim, cədvəl və ya bombardir sətirləri təqdim edilmədi.</span>
    </section>
  `;
}

function renderOfficialBulletins(competitionCode) {
  const bulletins = getCompetitionBulletins(competitionCode);
  if (!bulletins.length) return "";
  const items = bulletins
    .map((bulletin) => {
      const groupedFixtures = (bulletin.fixtures || []).reduce((acc, fixture) => {
        const key = fixture.group_name || "Oyunlar";
        if (!acc[key]) acc[key] = [];
        acc[key].push(fixture);
        return acc;
      }, {});
      return `
        <article class="table-panel bulletin-panel">
          <div class="section-head">
            <div>
              <div class="section-title">${bulletin.title}</div>
              <div class="section-meta">${bulletin.source_label || "Rəsmi bülleten"} · ${formatDate(bulletin.published_date)}</div>
            </div>
            <div class="section-meta">${(bulletin.fixtures || []).length} oyun · ${(bulletin.suspensions || []).length} buraxan</div>
          </div>
          <div class="content-pad bulletin-grid">
            <div class="bulletin-stack">
              ${Object.entries(groupedFixtures)
                .map(
                  ([groupName, rows]) => `
                    <div class="group-snippet">
                      <div class="group-snippet__title">${groupName}</div>
                      <div class="table-wrap">
                        <table>
                          <thead><tr><th>Tur</th><th>Oyun</th><th>Tarix</th><th>Saat</th><th>Stadion</th><th></th></tr></thead>
                          <tbody>
                            ${rows
                              .map((fixture) => {
                                const params = new URLSearchParams();
                                params.set("id", `manual-${bulletin.competition_code}-${fixture.match_date}-${slugify(fixture.home_team)}-${slugify(fixture.away_team)}`);
                                return `
                                  <tr class="table-row-link" data-match-link="${encodeURIComponent(params.get("id"))}">
                                    <td>${bulletin.round_label || "-"}</td>
                                    <td><strong>${fixture.home_team}</strong> - <strong>${fixture.away_team}</strong></td>
                                    <td>${formatDate(fixture.match_date)}</td>
                                    <td>${fixture.kickoff_label || "-"}</td>
                                    <td>${fixture.venue || "-"}</td>
                                    <td><a class="detail-link" href="#/match?${params.toString()}">Oyun</a></td>
                                  </tr>
                                `;
                              })
                              .join("")}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  `
                )
                .join("")}
            </div>
            <aside class="bulletin-side">
              <div class="group-snippet">
                <div class="group-snippet__title">Turu buraxmalı olanlar</div>
                <div class="bulletin-suspensions">
                  ${
                    (bulletin.suspensions || []).length
                      ? bulletin.suspensions
                          .map(
                            (entry) => `
                              <div class="coverage-row">
                                <strong>${entry.person_name}</strong>
                                <span>${entry.team_name}</span>
                                <span>${entry.reason}</span>
                              </div>
                            `
                          )
                          .join("")
                      : '<div class="empty-state">Bu bülletendə buraxmalı siyahısı yoxdur.</div>'
                  }
                </div>
              </div>
            </aside>
          </div>
        </article>
      `;
    })
    .join("");
  return `
    <section class="bulletin-section">
      ${items}
    </section>
  `;
}

function renderFilters(selectedCompetition, selectedDate, scope) {
  const competitionOptions = competitionOptionsMarkup(selectedCompetition, "all");
  const allDates = unique(getMatches(selectedCompetition).map((match) => match.match_date)).sort().reverse();
  const dateOptions = allDates.length
    ? allDates.map((value) => `<option value="${value}" ${value === selectedDate ? "selected" : ""}>${formatDate(value)}</option>`).join("")
    : '<option value="">Tarix yoxdur</option>';
  return `
    <section class="panel toolbar-panel">
      <div class="toolbar-strip">
        <div class="toolbar-cell toolbar-cell--compact">
          <div class="toolbar-label">Aralıq</div>
          <div class="segmented">
            <a href="#/matches?scope=today&competition=${selectedCompetition}&date=${selectedDate || ""}" class="${scope === "today" ? "active" : ""}">Bu gün</a>
            <a href="#/matches?scope=all&competition=${selectedCompetition}&date=${selectedDate || ""}" class="${scope === "all" ? "active" : ""}">Hamısı</a>
          </div>
        </div>
        <div class="toolbar-cell toolbar-cell--grow">
          <div class="toolbar-label">Yarış</div>
          <select id="competition-filter">${competitionOptions}</select>
        </div>
        <div class="toolbar-cell toolbar-cell--compact">
          <div class="toolbar-label">Tarix</div>
          <select id="date-filter" ${allDates.length ? "" : "disabled"}>${dateOptions}</select>
        </div>
      </div>
    </section>
  `;
}

function renderTimelinePreview(match) {
  if (!match.events.length) return '<span class="subtle">Operator hadisəsi yoxdur</span>';
  return match.events
    .slice()
    .sort((a, b) => (a.minute || 0) - (b.minute || 0))
    .slice(-3)
    .map((event) => `<div><strong>${event.minute || ""}'</strong> ${event.player_name || event.note || event.event_type}</div>`)
    .join("");
}

function renderMatchRow(match) {
  return `
    <article class="match-row match-row--clickable" data-match-link="${encodeURIComponent(match.id)}">
      <div class="match-row__status">
        <span class="status-pill ${statusClass[match.status] || "status-scheduled"}">${liveBadgeLabel(match)}</span>
        <span>${statusLabel(match)}</span>
      </div>
      <div class="match-row__teams">
        <div class="team-scoreline"><strong>${match.home_team}</strong><span>${match.home_score}</span></div>
        <div class="team-scoreline"><strong>${match.away_team}</strong><span>${match.away_score}</span></div>
        <div class="match-row__meta">${match.round_label || "Tur"}${match.phase_label ? ` · ${match.phase_label}` : ""}${match.group_name ? ` · ${match.group_name}` : ""}</div>
      </div>
      <div class="match-row__side">
        <div class="timeline-preview">${renderTimelinePreview(match)}</div>
        <div class="match-row__venue">${match.venue || "Stadion gözlənilir"}</div>
      </div>
      <a class="detail-link" href="#/match?id=${encodeURIComponent(match.id)}">Oyun</a>
    </article>
  `;
}

function renderLiveTicker(matches) {
  const liveMatches = matches.filter((match) => match.status === "live" || match.status === "halftime").sort(compareMatches);
  if (!liveMatches.length) return "";
  return `
    <section class="live-ticker">
      ${liveMatches
        .map(
          (match) => `
            <article class="live-ticker__item match-row--clickable" data-match-link="${encodeURIComponent(match.id)}">
              <div class="match-row__status">
                <span class="status-pill ${statusClass[match.status] || "status-scheduled"}">${liveBadgeLabel(match)}</span>
                <span>${statusLabel(match)}</span>
              </div>
              <div class="match-row__teams">
                <div class="team-scoreline"><strong>${match.home_team}</strong><span>${match.home_score}</span></div>
                <div class="team-scoreline"><strong>${match.away_team}</strong><span>${match.away_score}</span></div>
              </div>
              <div class="match-row__side">
                <div class="timeline-preview">${renderTimelinePreview(match)}</div>
                <div class="match-row__venue">${match.venue || "Stadion gözlənilir"}</div>
              </div>
              <a class="detail-link" href="#/match?id=${encodeURIComponent(match.id)}">Oyun</a>
            </article>
          `
        )
        .join("")}
    </section>
  `;
}

function bindMatchLinks() {
  document.querySelectorAll("[data-match-link]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("a, button, select, input, textarea")) return;
      window.location.hash = `#/match?id=${row.getAttribute("data-match-link")}`;
    });
  });
}

function renderMatches() {
  const params = currentParams();
  const selectedCompetition = params.get("competition") || "all";
  const scope = params.get("scope") || "today";
  const allDates = unique(getMatches(selectedCompetition).map((match) => match.match_date)).sort().reverse();
  const todayIso = new Date().toISOString().slice(0, 10);
  const selectedDate = params.get("date") || (scope === "today" && allDates.includes(todayIso) ? todayIso : allDates[0]);
  const filteredMatches = getMatches(selectedCompetition).filter((match) => {
    if (scope === "today") return match.match_date === selectedDate;
    return !selectedDate || match.match_date === selectedDate;
  });
  const grouped = filteredMatches.reduce((acc, match) => {
    const key = match.competition_code;
    if (!acc[key]) acc[key] = [];
    acc[key].push(match);
    return acc;
  }, {});

  app.innerHTML = `
    ${renderLandingIntro(filteredMatches, selectedCompetition, selectedDate)}
    ${renderSummary(filteredMatches, selectedCompetition, selectedDate)}
    ${renderCompetitionDirectory(selectedCompetition === "all" ? "" : selectedCompetition, "#/matches")}
    ${renderFilters(selectedCompetition, selectedDate, scope)}
    ${renderFeedNotice(selectedCompetition)}
    ${renderLiveTicker(filteredMatches)}
    ${
      !filteredMatches.length
        ? '<div class="empty-state">Seçilmiş yarış və tarix üçün oyun tapılmadı.</div>'
        : getCompetitions()
            .filter((competition) => grouped[competition.code])
            .map((competition) => {
              const rows = grouped[competition.code].sort(compareMatches);
              return `
                <section class="group-panel">
                  <div class="group-panel__head">
                    <div class="group-panel__title">${competition.name}</div>
                    <div class="group-panel__meta">${rows.length} oyun · ${selectedDate ? formatDate(selectedDate) : "Bütün tarixlər"}</div>
                  </div>
                  <div class="match-list">${rows.map(renderMatchRow).join("")}</div>
                </section>
              `;
            })
            .join("")
    }
  `;

  document.querySelector("#competition-filter")?.addEventListener("change", (event) => {
    const nextParams = new URLSearchParams();
    nextParams.set("scope", scope);
    nextParams.set("competition", event.target.value);
    goTo("#/matches", nextParams);
  });
  document.querySelector("#date-filter")?.addEventListener("change", (event) => {
    const nextParams = new URLSearchParams();
    nextParams.set("scope", scope);
    nextParams.set("competition", selectedCompetition);
    nextParams.set("date", event.target.value);
    goTo("#/matches", nextParams);
  });
}

function renderTables() {
  const params = currentParams();
  const selectedCompetition = params.get("competition") || getCompetitions().find((competition) => getCompetitionStats(competition.code).standings)?.code || getCompetitions()[0]?.code;
  const standings = getStandings(selectedCompetition);
  const groups = standings.reduce((acc, row) => {
    if (!acc[row.group_name]) acc[row.group_name] = [];
    acc[row.group_name].push(row);
    return acc;
  }, {});

  app.innerHTML = `
    ${renderSummary(getMatches(selectedCompetition), selectedCompetition, unique(getMatches(selectedCompetition).map((match) => match.match_date)).sort().reverse()[0])}
    ${renderCompetitionDirectory(selectedCompetition, "#/tables")}
    <section class="panel toolbar-panel">
      <div class="toolbar-strip">
        <div class="toolbar-cell toolbar-cell--grow">
          <div class="toolbar-label">Yarış</div>
          <select id="competition-filter">${competitionOptionsMarkup(selectedCompetition, "single")}</select>
        </div>
      </div>
    </section>
    ${renderFeedNotice(selectedCompetition)}
    ${Object.entries(groups)
      .map(
        ([groupName, rows]) => `
          <section class="table-panel">
            <div class="section-head">
              <div class="section-title">${groupName || "Turnir cədvəli"}</div>
              <div class="section-meta">${rows[0]?.region_name || ""}</div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>#</th><th>Komanda</th><th>O</th><th>Q</th><th>B</th><th>M</th><th>VQ</th><th>BY</th><th>TF</th><th>X</th></tr>
                </thead>
                <tbody>
                  ${rows
                    .sort((a, b) => a.rank - b.rank)
                    .map(
                      (row) => `
                        <tr>
                          <td>${row.rank}</td>
                          <td><strong>${row.team_name}</strong></td>
                          <td>${row.played}</td>
                          <td>${row.won}</td>
                          <td>${row.drawn}</td>
                          <td>${row.lost}</td>
                          <td>${row.goals_for}</td>
                          <td>${row.goals_against}</td>
                          <td>${row.goal_diff}</td>
                          <td><strong>${row.points}</strong></td>
                        </tr>
                      `
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          </section>
        `
      )
      .join("")}
  `;

  document.querySelector("#competition-filter")?.addEventListener("change", (event) => {
    const nextParams = new URLSearchParams();
    nextParams.set("competition", event.target.value);
    goTo("#/tables", nextParams);
  });
}

function resultCode(teamName, match) {
  const isHome = match.home_team === teamName;
  const goalsFor = isHome ? match.home_score : match.away_score;
  const goalsAgainst = isHome ? match.away_score : match.home_score;
  if (goalsFor > goalsAgainst) return "W";
  if (goalsFor < goalsAgainst) return "L";
  return "D";
}

function renderClubs() {
  const params = currentParams();
  const selectedCompetition = params.get("competition") || getCompetitions().find((competition) => getCompetitionStats(competition.code).clubs)?.code || getCompetitions()[0]?.code;
  const clubs = getClubEntries(selectedCompetition);
  const selectedClubName = params.get("club") || clubs[0]?.team_name;
  const club = clubs.find((entry) => entry.team_name === selectedClubName);

  if (!club) {
    app.innerHTML = `
      ${renderCompetitionDirectory(selectedCompetition, "#/clubs")}
      ${renderFeedNotice(selectedCompetition)}
      <div class="empty-state">Bu yarış üçün klub məlumatı yoxdur.</div>
    `;
    return;
  }

  app.innerHTML = `
    ${renderCompetitionDirectory(selectedCompetition, "#/clubs")}
    <section class="panel toolbar-panel">
      <div class="toolbar-strip">
        <div class="toolbar-cell toolbar-cell--grow">
          <div class="toolbar-label">Yarış</div>
          <select id="competition-filter">${competitionOptionsMarkup(selectedCompetition, "single")}</select>
        </div>
        <div class="toolbar-cell toolbar-cell--grow">
          <div class="toolbar-label">Klub</div>
          <select id="club-filter">
            ${clubs.map((entry) => `<option value="${entry.team_name}" ${entry.team_name === selectedClubName ? "selected" : ""}>${entry.team_name}</option>`).join("")}
          </select>
        </div>
      </div>
    </section>
    ${renderFeedNotice(selectedCompetition)}
    <section class="club-grid">
      <article class="club-panel">
        <div class="section-head">
          <div class="section-title">${club.team_name}</div>
          <div class="section-meta">${club.standing?.group_name || club.standing?.region_name || "Klub səhifəsi"}</div>
        </div>
        <div class="content-pad">
          <div class="stats-grid">
            <div class="stat-box"><span>Yer</span><strong>${club.standing?.rank ?? "-"}</strong></div>
            <div class="stat-box"><span>Xal</span><strong>${club.standing?.points ?? "-"}</strong></div>
            <div class="stat-box"><span>Oyun</span><strong>${club.standing?.played ?? "-"}</strong></div>
            <div class="stat-box"><span>Top fərqi</span><strong>${club.standing?.goal_diff ?? "-"}</strong></div>
          </div>
          <div class="section-head" style="padding-left:0;padding-right:0;background:transparent;border-bottom:0;margin-top:14px;">
            <div class="section-title">Son forma</div>
            <div class="section-meta">${club.recent_matches.length} oyun</div>
          </div>
          <div class="form-pills">
            ${club.recent_matches.map((match) => {
              const code = resultCode(club.team_name, match);
              const pillClass = code === "W" ? "pill-win" : code === "L" ? "pill-loss" : "pill-draw";
              return `<span class="form-pill ${pillClass}">${code}</span>`;
            }).join("")}
          </div>
          <div class="table-wrap" style="margin-top:12px;">
            <table>
              <thead><tr><th>Tarix</th><th>Rəqib</th><th>Hesab</th><th></th></tr></thead>
              <tbody>
                ${club.recent_matches
                  .map((match) => {
                    const opponent = match.home_team === club.team_name ? match.away_team : match.home_team;
                    return `<tr><td>${formatDate(match.match_date)}</td><td>${opponent}</td><td>${match.home_score}-${match.away_score}</td><td><a class="detail-link" href="#/match?id=${encodeURIComponent(match.id)}">Ətraflı</a></td></tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      </article>
      <aside class="club-panel">
        <div class="section-head">
          <div class="section-title">Bombardirlər</div>
          <div class="section-meta">${club.scorers.length} nəfər</div>
        </div>
        <div class="content-pad">
          ${
            club.scorers.length
              ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Oyunçu</th><th>Qol</th></tr></thead><tbody>${club.scorers
                  .map((player) => `<tr><td>${player.rank}</td><td><strong>${player.player_name}</strong></td><td>${player.goals}</td></tr>`)
                  .join("")}</tbody></table></div>`
              : '<div class="empty-state">Bu klub üçün bombardir cədvəli yoxdur.</div>'
          }
        </div>
      </aside>
    </section>
  `;

  document.querySelector("#competition-filter")?.addEventListener("change", (event) => {
    const nextParams = new URLSearchParams();
    nextParams.set("competition", event.target.value);
    goTo("#/clubs", nextParams);
  });
  document.querySelector("#club-filter")?.addEventListener("change", (event) => {
    const nextParams = new URLSearchParams();
    nextParams.set("competition", selectedCompetition);
    nextParams.set("club", event.target.value);
    goTo("#/clubs", nextParams);
  });
}

function renderPlayers() {
  const params = currentParams();
  const selectedCompetition = params.get("competition") || getCompetitions().find((competition) => getCompetitionStats(competition.code).players)?.code || getCompetitions()[0]?.code;
  const players = getPlayers(selectedCompetition);

  app.innerHTML = `
    ${renderCompetitionDirectory(selectedCompetition, "#/players")}
    <section class="panel toolbar-panel">
      <div class="toolbar-strip">
        <div class="toolbar-cell toolbar-cell--grow">
          <div class="toolbar-label">Yarış</div>
          <select id="competition-filter">${competitionOptionsMarkup(selectedCompetition, "single")}</select>
        </div>
      </div>
    </section>
    ${renderFeedNotice(selectedCompetition)}
    <section class="table-panel">
      <div class="section-head">
        <div class="section-title">Oyunçular</div>
        <div class="section-meta">${players.length} bombardir sətri</div>
      </div>
      <div class="table-wrap">
        ${
          players.length
            ? `<table><thead><tr><th>#</th><th>Oyunçu</th><th>Klub</th><th>Qol</th></tr></thead><tbody>${players
                .map((player) => `<tr><td>${player.rank}</td><td><strong>${player.player_name}</strong></td><td>${player.team_name}</td><td>${player.goals}</td></tr>`)
                .join("")}</tbody></table>`
            : '<div class="empty-state">Bu yarış üçün oyunçu cədvəli yoxdur.</div>'
        }
      </div>
    </section>
  `;

  document.querySelector("#competition-filter")?.addEventListener("change", (event) => {
    const nextParams = new URLSearchParams();
    nextParams.set("competition", event.target.value);
    goTo("#/players", nextParams);
  });
}

function renderLineupSide(teamName, squad) {
  const starters = squad.starter.length
    ? squad.starter.map((player) => `<div class="player-row"><div><strong>${player.shirt_number ? `${player.shirt_number} ` : ""}${player.player_name}</strong></div><div class="section-meta">${player.position_label || ""}</div></div>`).join("")
    : '<div class="empty-state">Start heyəti daxil edilməyib.</div>';
  const bench = squad.bench.length
    ? squad.bench.map((player) => `<div class="player-row"><div><strong>${player.shirt_number ? `${player.shirt_number} ` : ""}${player.player_name}</strong></div><div class="section-meta">${player.position_label || ""}</div></div>`).join("")
    : '<div class="empty-state">Ehtiyat heyət daxil edilməyib.</div>';
  return `
    <article class="detail-panel">
      <div class="section-head">
        <div class="section-title">${teamName}</div>
        <div class="section-meta">Operator paneli</div>
      </div>
      <div class="content-pad">
        <div class="section-title">Start heyəti</div>
        <div class="lineup-list">${starters}</div>
        <div class="section-title" style="margin-top:14px;">Ehtiyat heyət</div>
        <div class="lineup-list">${bench}</div>
      </div>
    </article>
  `;
}

function renderMatchDetail() {
  const params = currentParams();
  const match = getMatchById(params.get("id"));
  if (!match) {
    app.innerHTML = '<div class="empty-state">Oyun tapılmadı.</div>';
    return;
  }
  const competition = getCompetition(match.competition_code);
  const orderedEvents = match.events.slice().sort((a, b) => (a.minute || 0) - (b.minute || 0));
  const fixtureBulletin = findFixtureBulletin(match);
  const suspensions = getMatchSuspensions(match);

  app.innerHTML = `
    <section class="detail-layout">
      <article class="detail-panel">
        <div class="section-head">
          <div class="section-title">${competition?.name || match.competition_code}</div>
          <a class="detail-link" href="#/matches?competition=${match.competition_code}&date=${match.match_date}">Geri</a>
        </div>
        <div class="scoreboard">
          <div class="scoreboard__team">${match.home_team}</div>
          <div class="scoreboard__score">${match.home_score} - ${match.away_score}</div>
          <div class="scoreboard__team">${match.away_team}</div>
        </div>
        <div class="content-pad" style="padding-top:0;">
          <div class="detail-meta">${formatDate(match.match_date)} · ${match.round_label || "Tur"} · ${match.venue || "Stadion gözlənilir"} · ${statusLabel(match)} · ${match.phase_label || ""}</div>
        </div>
      </article>
      ${
        fixtureBulletin
          ? `
            <article class="detail-panel">
              <div class="section-head">
                <div class="section-title">Rəsmi bülleten</div>
                <div class="section-meta">${fixtureBulletin.source_label || "AFFA bülleteni"}</div>
              </div>
              <div class="content-pad">
                <div class="coverage-list">
                  <div class="coverage-row"><strong>Bülleten</strong><span>${fixtureBulletin.title}</span></div>
                  <div class="coverage-row"><strong>Dərc edilib</strong><span>${formatDate(fixtureBulletin.published_date)}</span></div>
                  <div class="coverage-row"><strong>Mərhələ</strong><span>${fixtureBulletin.phase_label || "-"}</span></div>
                  <div class="coverage-row"><strong>Tur</strong><span>${fixtureBulletin.round_label || "-"}</span></div>
                </div>
              </div>
            </article>
          `
          : ""
      }
      <section class="two-col">
        ${renderLineupSide(match.home_team, match.lineups.home)}
        ${renderLineupSide(match.away_team, match.lineups.away)}
      </section>
      ${
        suspensions.length
          ? `
            <article class="detail-panel">
              <div class="section-head">
                  <div class="section-title">Bu turu buraxmalı olanlar</div>
                <div class="section-meta">Rəsmi bülleten siyahısı</div>
              </div>
              <div class="content-pad">
                <div class="timeline-list">
                  ${suspensions
                    .map(
                      (entry) => `
                        <div class="event-row">
                          <div>
                            <strong>${entry.person_name}</strong>
                            <div class="section-meta">${entry.team_name}</div>
                          </div>
                          <div class="section-meta">${entry.reason}</div>
                        </div>
                      `
                    )
                    .join("")}
                </div>
              </div>
            </article>
          `
          : ""
      }
      <article class="detail-panel">
        <div class="section-head">
          <div class="section-title">Hadisələr axını</div>
          <div class="section-meta">Ayrı operator paneli</div>
        </div>
        <div class="content-pad">
          ${
            orderedEvents.length
              ? `<div class="timeline-list">${orderedEvents
                  .map(
                    (event) => `
                      <div class="event-row">
                        <div>
                          <strong>${event.player_name || event.note || event.event_type}</strong>
                          <div class="section-meta">${cleanText(event.team_side).toUpperCase()} · ${event.event_type}</div>
                        </div>
                        <div><strong>${event.minute || ""}'</strong></div>
                      </div>
                    `
                  )
                  .join("")}</div>`
              : '<div class="empty-state">Operator panelində hadisə daxil edilməyib.</div>'
          }
        </div>
      </article>
    </section>
  `;
}

function render() {
  renderNavState();
  if (!dataset) {
    app.innerHTML = '<div class="loading-state">AFFA məlumatları yüklənir…</div>';
    return;
  }
  const route = currentRoute();
  if (route === "#/competitions") {
    renderCompetitions();
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  if (route === "#/competition") {
    renderCompetitionDetail();
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  if (route === "#/tables") {
    renderTables();
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  if (route === "#/clubs") {
    renderClubs();
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  if (route === "#/players") {
    renderPlayers();
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  if (route === "#/match") {
    renderMatchDetail();
    window.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  renderMatches();
  bindMatchLinks();
  window.scrollTo({ top: 0, behavior: "auto" });
}

async function loadData() {
  dataStatus.textContent = "AFFA məlumatları yüklənir…";
  const [response, bulletinResponse, nextStore] = await Promise.all([
    fetch("./data/affa.json", { cache: "no-store" }),
    fetch("./data/manual_bulletins.json", { cache: "no-store" }).catch(() => null),
    fetchOperatorStore(),
  ]);
  if (!response.ok) {
    throw new Error(`Məlumat yüklənmədi: ${response.status}`);
  }
  rawDataset = await response.json();
  manualDataset = bulletinResponse && bulletinResponse.ok ? await bulletinResponse.json() : { supplements: [] };
  operatorStore = nextStore;
  dataset = mergeDataset(rawDataset);
  const stamp = new Date(rawDataset.generated_at).toLocaleString();
  const overrideCount = Object.keys(readOperatorStore().matches || {}).length;
  const bulletinCount = (manualDataset.supplements || []).length;
  dataStatus.textContent = `AFFA yenilənməsi ${stamp} · bülleten ${bulletinCount} · operator düzəlişi ${overrideCount}`;
  render();
}

refreshButton.addEventListener("click", () => {
  loadData().catch((error) => {
    dataStatus.textContent = error.message;
    app.innerHTML = `<div class="empty-state">${error.message}</div>`;
  });
});

window.addEventListener("hashchange", render);
window.addEventListener("storage", (event) => {
  if (event.key === OPERATOR_STORAGE_KEY && rawDataset) {
    operatorStore = readOperatorStore();
    dataset = mergeDataset(rawDataset);
    render();
  }
});

if (!window.location.hash) {
  window.location.hash = "#/matches?scope=today&competition=all";
}

loadData().catch((error) => {
  dataStatus.textContent = error.message;
  app.innerHTML = `<div class="empty-state">${error.message}</div>`;
});

window.setInterval(() => {
  if (!rawDataset) return;
  syncOperatorStore({ rerender: true }).catch(() => {});
}, 5000);
