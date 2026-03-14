const app = document.querySelector("#operator-app");

const STORAGE_KEY = "affa-live-operator-v1";
const OPERATOR_API_URL = "./api/overrides";
const SESSION_KEY = "affa-live-operator-auth";
const OPERATOR_PIN = "1234";

let dataset = null;
let manualDataset = { supplements: [] };
let operatorStore = { matches: {} };
let selectedMatchId = null;

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
        round_label: bulletin.round_label || "",
        venue: fixture.venue,
        home_team: fixture.home_team,
        away_team: fixture.away_team,
        home_score: 0,
        away_score: 0,
        status: "scheduled",
        match_minute: null,
        added_time: null,
        phase_label: bulletin.phase_label || "",
        events: [],
        lineups: emptyLineups(),
        bulletin_id: bulletin.bulletin_id,
        source_label: bulletin.source_label || "Rəsmi bülleten",
        group_name: fixture.group_name || "",
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

function readStore() {
  if (operatorStore && operatorStore.matches) {
    return clone(operatorStore);
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"matches":{}}');
    return parsed && parsed.matches ? parsed : { matches: {} };
  } catch (error) {
    return { matches: {} };
  }
}

function writeLocalStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

async function persistStore(store) {
  operatorStore = clone(store);
  writeLocalStore(operatorStore);
  try {
    await fetch(OPERATOR_API_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(operatorStore),
    });
  } catch (error) {
    // Keep local fallback even if the shared API is unavailable.
  }
}

async function fetchStore() {
  try {
    const response = await fetch(OPERATOR_API_URL, { cache: "no-store" });
    if (response.ok) {
      const parsed = await response.json();
      const normalized = parsed && parsed.matches ? parsed : { matches: {} };
      writeLocalStore(normalized);
      return normalized;
    }
  } catch (error) {
    // Fall through to local fallback.
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"matches":{}}');
    return parsed && parsed.matches ? parsed : { matches: {} };
  } catch (error) {
    return { matches: {} };
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

function mergeMatch(baseMatch) {
  const override = readStore().matches[baseMatch.id];
  if (!override) return baseMatch;
  const merged = { ...baseMatch };
  ["status", "match_minute", "added_time", "home_score", "away_score", "kickoff_label"].forEach((key) => {
    if (override[key] !== undefined && override[key] !== null && override[key] !== "") {
      merged[key] = override[key];
    }
  });
  merged.events = Array.isArray(override.events) ? override.events : baseMatch.events;
  merged.lineups = override.lineups ? mergeLineups(baseMatch.lineups, override.lineups) : baseMatch.lineups;
  return merged;
}

function getMatches() {
  return dataset.matches.map((match) => mergeMatch(match));
}

function getSelectedMatch() {
  return getMatches().find((match) => match.id === selectedMatchId) || getMatches()[0] || null;
}

function statusButtonClass(currentStatus, value) {
  return currentStatus === value ? "active" : "";
}

function formatDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("az-AZ", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function eventTypeLabel(value) {
  return {
    goal: "Qol",
    "yellow-card": "Sarı vərəqə",
    "red-card": "Qırmızı vərəqə",
    substitution: "Əvəzetmə",
    note: "Qeyd",
  }[value] || value;
}

function teamSideLabel(value) {
  return {
    home: "Ev",
    away: "Səfər",
  }[value] || value;
}

function operatorStatusLabel(value) {
  return {
    scheduled: "Planlandı",
    live: "Canlı",
    halftime: "Fasilə",
    finished: "Bitdi",
  }[value] || value;
}

function statusLabel(match) {
  if (match.status === "finished") return "FT";
  if (match.status === "halftime") return "HT";
  if (match.status === "live") {
    const added = match.added_time ? `+${match.added_time}` : "";
    return match.match_minute ? `${match.match_minute}${added}'` : "CANLI";
  }
  return match.kickoff_label || "NÖVBƏTİ";
}

function badgeClass(status) {
  return status === "live" ? "status-live" : status === "halftime" ? "status-halftime" : status === "finished" ? "status-finished" : "status-scheduled";
}

function renderLock() {
  app.innerHTML = `
    <section class="detail-panel operator-lock">
      <div class="section-head">
        <div class="section-title">Operator girişi</div>
        <div class="section-meta">Lokal və şəbəkə üçün</div>
      </div>
      <div class="content-pad">
        <div class="operator-headline">
          <strong>Ayrı operator panelini açın</strong>
          <span class="subtle">Bu panel lokal şəbəkədə paylaşılan operator məlumatını yeniləyir. Digər cihazlardakı ictimai səhifə də bu dəyişiklikləri görə bilər.</span>
        </div>
        <div class="field">
          <label>PIN</label>
          <input id="pin-input" type="password" inputmode="numeric" placeholder="PIN daxil edin" />
        </div>
        <div class="button-row">
          <button id="pin-submit" class="button button-primary" type="button">Aç</button>
        </div>
      </div>
    </section>
  `;

  document.querySelector("#pin-submit")?.addEventListener("click", () => {
    const value = document.querySelector("#pin-input").value.trim();
    if (value === OPERATOR_PIN) {
      sessionStorage.setItem(SESSION_KEY, "ok");
      render();
      return;
    }
    alert("PIN yanlışdır");
  });
}

function ensureOverride(match) {
  const store = readStore();
  if (!store.matches[match.id]) {
    store.matches[match.id] = {
      status: match.status,
      match_minute: match.match_minute,
      added_time: match.added_time,
      home_score: match.home_score,
      away_score: match.away_score,
      events: clone(match.events || []),
      lineups: clone(match.lineups || { home: { starter: [], bench: [] }, away: { starter: [], bench: [] } }),
    };
    operatorStore = clone(store);
    writeLocalStore(store);
  }
  return store;
}

async function updateOverride(match, updater) {
  const store = ensureOverride(match);
  const override = store.matches[match.id];
  updater(override);
  await persistStore(store);
  render();
}

async function addEvent(match, payload) {
  await updateOverride(match, (override) => {
    override.events.push(payload);
    override.events.sort((a, b) => (a.minute || 0) - (b.minute || 0));
    if (payload.event_type === "goal") {
      if (payload.team_side === "home") override.home_score += 1;
      if (payload.team_side === "away") override.away_score += 1;
    }
  });
}

async function removeEvent(match, index) {
  await updateOverride(match, (override) => {
    const [event] = override.events.splice(index, 1);
    if (event?.event_type === "goal") {
      if (event.team_side === "home") override.home_score = Math.max(0, override.home_score - 1);
      if (event.team_side === "away") override.away_score = Math.max(0, override.away_score - 1);
    }
  });
}

async function addLineupPlayer(match, payload) {
  await updateOverride(match, (override) => {
    override.lineups[payload.team_side][payload.unit].push({
      player_name: payload.player_name,
      shirt_number: payload.shirt_number,
      position_label: payload.position_label,
    });
  });
}

async function clearOverride(match) {
  const store = readStore();
  delete store.matches[match.id];
  await persistStore(store);
  render();
}

function renderOperator() {
  const params = new URLSearchParams(window.location.search);
  const selectedCompetition = params.get("competition") || "all";
  const allMatches = getMatches();
  const filteredMatches = allMatches.filter((match) => selectedCompetition === "all" || match.competition_code === selectedCompetition);
  if (!selectedMatchId || !filteredMatches.find((match) => match.id === selectedMatchId)) {
    selectedMatchId = filteredMatches[0]?.id || allMatches[0]?.id || null;
  }
  const match = getSelectedMatch();

  if (!match) {
    app.innerHTML = '<div class="empty-state">Mövcud oyun yoxdur.</div>';
    return;
  }

  const override = readStore().matches[match.id];
  const fixtureBulletin = findFixtureBulletin(match);
  const suspensions = getMatchSuspensions(match);

  app.innerHTML = `
    <section class="service-bar">
      <div class="service-bar__title">
        <strong>Operator paneli</strong>
        <span>${Object.keys(readStore().matches).length} oyunda operator düzəlişi var</span>
      </div>
      <div class="service-bar__meta">AFFA Canlı nəticələr üçün paylaşılan operator qatı${(manualDataset.supplements || []).length ? ` · ${(manualDataset.supplements || []).length} rəsmi bülleten əlavə olunub` : ""}</div>
      <div class="button-row">
        <button id="logout-button" class="button button-secondary" type="button">Bağla</button>
        <button id="clear-button" class="button button-danger" type="button">Cari düzəlişi sil</button>
      </div>
    </section>
    <section class="panel toolbar-panel operator-toolbar">
      <div class="toolbar-strip">
        <div class="toolbar-cell toolbar-cell--grow">
          <div class="toolbar-label">Yarış</div>
          <select id="competition-filter">
            <option value="all">Bütün yarışlar</option>
            ${dataset.competitions
              .map((competition) => `<option value="${competition.code}" ${competition.code === selectedCompetition ? "selected" : ""}>${competition.name}</option>`)
              .join("")}
          </select>
        </div>
        <div class="toolbar-cell toolbar-cell--grow">
          <div class="toolbar-label">Oyun</div>
          <select id="match-filter">
            ${filteredMatches
              .map(
                (item) =>
                  `<option value="${item.id}" ${item.id === match.id ? "selected" : ""}>${formatDate(item.match_date)} · ${item.home_team} - ${item.away_team}${item.kickoff_label ? ` · ${item.kickoff_label}` : ""}</option>`
              )
              .join("")}
          </select>
        </div>
      </div>
      <div class="operator-toolbar__status">${override ? "Bu oyun üçün operator düzəlişi aktivdir." : "Hələ düzəliş yoxdur. İlk yadda saxla və ya hadisə əlavə et əməliyyatı yeni qeyd yaradacaq."}</div>
    </section>
    <section class="operator-grid">
      <div class="operator-stack">
        <article class="detail-panel">
          <div class="section-head">
            <div class="section-title">${match.home_team} - ${match.away_team}</div>
            <div class="section-meta">${formatDate(match.match_date)} · ${match.round_label || "Tur"}</div>
          </div>
          <div class="content-pad">
            <div class="operator-matchbar">
              <div class="operator-matchbar__status">
                <span class="status-pill ${badgeClass(match.status)}">${operatorStatusLabel(match.status)}</span>
                <span>${statusLabel(match)}</span>
              </div>
              <div class="operator-matchbar__teams">
                <strong>${match.home_team} ${match.home_score} - ${match.away_score} ${match.away_team}</strong>
                <div class="operator-matchbar__meta">${match.round_label || "Tur"}${match.phase_label ? ` · ${match.phase_label}` : ""}${match.group_name ? ` · ${match.group_name}` : ""}</div>
              </div>
              <div class="operator-matchbar__side">
                <div class="operator-inline-note">${match.venue || "Stadion gözlənilir"}</div>
                <div class="operator-inline-note">${override ? "Düzəliş saxlanılıb" : fixtureBulletin ? "Rəsmi bülletendən əlavə edilib" : "AFFA əsas məlumatı"}</div>
              </div>
            </div>
            <div class="button-row">
              <button data-status="scheduled" class="button button-secondary ${statusButtonClass(match.status, "scheduled")}" type="button">Planlandı</button>
              <button data-status="live" class="button button-secondary ${statusButtonClass(match.status, "live")}" type="button">Canlı</button>
              <button data-status="halftime" class="button button-secondary ${statusButtonClass(match.status, "halftime")}" type="button">Fasilə</button>
              <button data-status="finished" class="button button-secondary ${statusButtonClass(match.status, "finished")}" type="button">Bitdi</button>
            </div>
            <div class="score-inputs" style="margin-top:12px;">
              <div class="field"><label>Ev hesabı</label><input id="home-score" type="number" min="0" value="${match.home_score}" /></div>
              <div class="field"><label>Səfər hesabı</label><input id="away-score" type="number" min="0" value="${match.away_score}" /></div>
              <div class="field"><label>Dəqiqə</label><input id="match-minute" type="number" min="0" value="${match.match_minute || ""}" /></div>
              <div class="field"><label>Əlavə vaxt</label><input id="added-time" type="number" min="0" value="${match.added_time || ""}" /></div>
            </div>
            <div class="button-row" style="margin-top:12px;">
              <button id="save-score" class="button button-primary" type="button">Hesabı yadda saxla</button>
            </div>
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
                  <div class="operator-status">Bu oyun AFFA bülletenindən əlavə olunub və indi operator panelində redaktə edilə bilər.</div>
                  <div class="event-log" style="margin-top:10px;">
                    <div class="event-log__item">
                      <div>
                        <div class="operator-mini-title">${fixtureBulletin.title}</div>
                        <div class="section-meta">${formatDate(fixtureBulletin.published_date)} · ${fixtureBulletin.phase_label || "-"} · ${fixtureBulletin.round_label || "-"}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            `
            : ""
        }
        <article class="detail-panel">
          <div class="section-head">
            <div class="section-title">Hadisə əlavə et</div>
            <div class="section-meta">Qol, vərəqə, əvəzetmə, qeyd</div>
          </div>
          <div class="content-pad">
            <div class="operator-inline-note" style="margin-bottom:10px;">İctimai timeline ilə eyni ritmdə hadisə daxil edin. Qol əlavə ediləndə hesab avtomatik yenilənir.</div>
            <div class="subgrid">
              <div class="field">
                <label>Növ</label>
                <select id="event-type">
                  <option value="goal">Qol</option>
                  <option value="yellow-card">Sarı vərəqə</option>
                  <option value="red-card">Qırmızı vərəqə</option>
                  <option value="substitution">Əvəzetmə</option>
                  <option value="note">Qeyd</option>
                </select>
              </div>
              <div class="field">
                <label>Tərəf</label>
                <select id="event-side">
                  <option value="home">Ev</option>
                  <option value="away">Səfər</option>
                </select>
              </div>
              <div class="field">
                <label>Dəqiqə</label>
                <input id="event-minute" type="number" min="0" value="${match.match_minute || ""}" />
              </div>
              <div class="field">
                <label>Oyunçu</label>
                <input id="event-player" type="text" placeholder="Oyunçu adı" />
              </div>
            </div>
            <div class="field" style="margin-top:10px;">
              <label>Qeyd</label>
              <input id="event-note" type="text" placeholder="İstəyə bağlı qeyd" />
            </div>
            <div class="button-row" style="margin-top:12px;">
              <button id="add-event" class="button button-primary" type="button">Hadisə əlavə et</button>
            </div>
          </div>
        </article>
        <article class="detail-panel">
          <div class="section-head">
            <div class="section-title">Heyətə oyunçu əlavə et</div>
            <div class="section-meta">Start heyəti və ya ehtiyat</div>
          </div>
          <div class="content-pad">
            <div class="operator-inline-note" style="margin-bottom:10px;">Burada daxil edilən heyətlər ictimai oyun səhifəsində birbaşa görünəcək.</div>
            <div class="subgrid">
              <div class="field">
                <label>Tərəf</label>
                <select id="lineup-side">
                  <option value="home">Ev</option>
                  <option value="away">Səfər</option>
                </select>
              </div>
              <div class="field">
                <label>Bölmə</label>
                <select id="lineup-unit">
                  <option value="starter">Start heyəti</option>
                  <option value="bench">Ehtiyat heyət</option>
                </select>
              </div>
              <div class="field">
                <label>Oyunçu</label>
                <input id="lineup-player" type="text" placeholder="Oyunçu adı" />
              </div>
              <div class="field">
                <label>Forma nömrəsi</label>
                <input id="lineup-number" type="text" placeholder="İstəyə bağlı" />
              </div>
            </div>
            <div class="field" style="margin-top:10px;">
              <label>Mövqe</label>
              <input id="lineup-position" type="text" placeholder="İstəyə bağlı" />
            </div>
            <div class="button-row" style="margin-top:12px;">
              <button id="add-lineup-player" class="button button-primary" type="button">Oyunçu əlavə et</button>
            </div>
          </div>
        </article>
      </div>
      <div class="operator-stack">
        <article class="detail-panel">
          <div class="section-head">
            <div class="section-title">Hadisələr jurnalı</div>
            <div class="section-meta">${match.events.length} qeyd</div>
          </div>
          <div class="content-pad">
            ${
              match.events.length
                ? `<div class="event-log">${match.events
                    .map(
                      (event, index) => `
                        <div class="event-log__item">
                          <div>
                            <div class="operator-mini-title">${event.minute || ""}' ${event.player_name || event.note || eventTypeLabel(event.event_type)}</div>
                            <div class="section-meta">${teamSideLabel(event.team_side)} · ${eventTypeLabel(event.event_type)} ${event.note ? `· ${event.note}` : ""}</div>
                          </div>
                          <button class="button button-danger" data-remove-event="${index}" type="button">Sil</button>
                        </div>
                      `
                    )
                    .join("")}</div>`
                : '<div class="empty-state">Hadisə daxil edilməyib.</div>'
            }
          </div>
        </article>
        <article class="detail-panel">
          <div class="section-head">
            <div class="section-title">Heyətlər</div>
            <div class="section-meta">Cari operator məlumatı</div>
          </div>
          <div class="content-pad">
            <div class="operator-mini-title">${match.home_team}</div>
            <div class="subtle">Start heyəti: ${match.lineups.home.starter.map((player) => player.player_name).join(", ") || "yoxdur"}</div>
            <div class="subtle" style="margin-top:4px;">Ehtiyat heyət: ${match.lineups.home.bench.map((player) => player.player_name).join(", ") || "yoxdur"}</div>
            <div class="operator-mini-title" style="margin-top:14px;">${match.away_team}</div>
            <div class="subtle">Start heyəti: ${match.lineups.away.starter.map((player) => player.player_name).join(", ") || "yoxdur"}</div>
            <div class="subtle" style="margin-top:4px;">Ehtiyat heyət: ${match.lineups.away.bench.map((player) => player.player_name).join(", ") || "yoxdur"}</div>
          </div>
        </article>
        ${
          suspensions.length
            ? `
              <article class="detail-panel">
                <div class="section-head">
                  <div class="section-title">Bu turu buraxmalı olanlar</div>
                  <div class="section-meta">Rəsmi bülleten siyahısı</div>
                </div>
                <div class="content-pad">
                  <div class="event-log">
                    ${suspensions
                      .map(
                        (entry) => `
                          <div class="event-log__item">
                            <div>
                              <div class="operator-mini-title">${entry.person_name}</div>
                              <div class="section-meta">${entry.team_name}</div>
                            </div>
                            <div class="section-meta operator-suspension-reason">${entry.reason}</div>
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
      </div>
    </section>
  `;

  document.querySelector("#competition-filter")?.addEventListener("change", (event) => {
    const next = new URL(window.location.href);
    next.searchParams.set("competition", event.target.value);
    window.location.href = next.toString();
  });

  document.querySelector("#match-filter")?.addEventListener("change", (event) => {
    selectedMatchId = event.target.value;
    render();
  });

  document.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", () => {
      updateOverride(match, (current) => {
        current.status = button.getAttribute("data-status");
      }).catch((error) => alert(error.message));
    });
  });

  document.querySelector("#save-score")?.addEventListener("click", () => {
    updateOverride(match, (current) => {
      current.home_score = Number(document.querySelector("#home-score").value || 0);
      current.away_score = Number(document.querySelector("#away-score").value || 0);
      current.match_minute = document.querySelector("#match-minute").value ? Number(document.querySelector("#match-minute").value) : null;
      current.added_time = document.querySelector("#added-time").value ? Number(document.querySelector("#added-time").value) : null;
    }).catch((error) => alert(error.message));
  });

  document.querySelector("#add-event")?.addEventListener("click", () => {
    const eventType = document.querySelector("#event-type").value;
    const teamSide = document.querySelector("#event-side").value;
    const minute = Number(document.querySelector("#event-minute").value || 0);
    const playerName = document.querySelector("#event-player").value.trim();
    const note = document.querySelector("#event-note").value.trim();
    addEvent(match, {
      event_type: eventType,
      team_side: teamSide,
      minute,
      player_name: playerName,
      note,
    }).catch((error) => alert(error.message));
  });

  document.querySelector("#add-lineup-player")?.addEventListener("click", () => {
    const playerName = document.querySelector("#lineup-player").value.trim();
    if (!playerName) {
      alert("Oyunçu adı vacibdir");
      return;
    }
    addLineupPlayer(match, {
      team_side: document.querySelector("#lineup-side").value,
      unit: document.querySelector("#lineup-unit").value,
      player_name: playerName,
      shirt_number: document.querySelector("#lineup-number").value.trim(),
      position_label: document.querySelector("#lineup-position").value.trim(),
    }).catch((error) => alert(error.message));
  });

  document.querySelectorAll("[data-remove-event]").forEach((button) => {
    button.addEventListener("click", () => {
      removeEvent(match, Number(button.getAttribute("data-remove-event"))).catch((error) => alert(error.message));
    });
  });

  document.querySelector("#clear-button")?.addEventListener("click", () => {
    clearOverride(match).catch((error) => alert(error.message));
  });

  document.querySelector("#logout-button")?.addEventListener("click", () => {
    sessionStorage.removeItem(SESSION_KEY);
    render();
  });
}

function render() {
  if (!dataset) {
    app.innerHTML = '<div class="loading-state">Operator paneli yüklənir…</div>';
    return;
  }
  if (sessionStorage.getItem(SESSION_KEY) !== "ok") {
    renderLock();
    return;
  }
  renderOperator();
}

async function load() {
  const [response, bulletinResponse] = await Promise.all([
    fetch("./data/affa.json", { cache: "no-store" }),
    fetch("./data/manual_bulletins.json", { cache: "no-store" }).catch(() => null),
  ]);
  if (!response.ok) {
    throw new Error(`Məlumat yüklənmədi: ${response.status}`);
  }
  dataset = await response.json();
  manualDataset = bulletinResponse && bulletinResponse.ok ? await bulletinResponse.json() : { supplements: [] };
  operatorStore = await fetchStore();
  dataset.matches = [...dataset.matches, ...buildSupplementalMatches(dataset.matches)];
  render();
}

load().catch((error) => {
  app.innerHTML = `<div class="empty-state">${error.message}</div>`;
});

window.setInterval(() => {
  if (!dataset || sessionStorage.getItem(SESSION_KEY) !== "ok") return;
  fetchStore()
    .then((nextStore) => {
      if (JSON.stringify(nextStore) !== JSON.stringify(operatorStore)) {
        operatorStore = nextStore;
        render();
      }
    })
    .catch(() => {});
}, 4000);
