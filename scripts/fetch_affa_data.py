from __future__ import annotations

import json
import hashlib
import re
import unicodedata
from collections import defaultdict
from datetime import date, datetime
from html import unescape
from pathlib import Path
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup


BASE_URL = "https://www.affa.az"
DISCOVERY_URL = f"{BASE_URL}/index.php/yarlar/affa-region-liqas/sasnam/60932"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    )
}

MONTHS = {
    "yanvar": 1,
    "fevral": 2,
    "mart": 3,
    "aprel": 4,
    "may": 5,
    "iyun": 6,
    "iyul": 7,
    "avqust": 8,
    "sentyabr": 9,
    "oktyabr": 10,
    "noyabr": 11,
    "dekabr": 12,
}

FETCH_CACHE: dict[tuple[str, tuple[tuple[str, str], ...]], str] = {}


def fetch_html(url: str, data: dict[str, str] | None = None) -> str:
    cache_key = (url, tuple(sorted((data or {}).items())))
    if cache_key in FETCH_CACHE:
        return FETCH_CACHE[cache_key]
    payload = urlencode(data).encode("utf-8") if data else None
    request = Request(url, data=payload, headers=HEADERS)
    with urlopen(request, timeout=30) as response:
        html = response.read().decode("utf-8", "ignore")
    FETCH_CACHE[cache_key] = html
    return html


def clean_text(value: str) -> str:
    text = unescape(value or "")
    text = text.replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def resolve_url(href: str) -> str:
    return urljoin(BASE_URL, href.strip())


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", clean_text(value))
    ascii_value = normalized.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", ascii_value.lower()).strip("-")


def competition_category(name: str) -> str:
    if "qız" in name.lower():
        return "Girls"
    if "futzal" in name.lower():
        return "Futsal"
    if "u-" in name.lower() or "gənclər" in name.lower():
        return "Youth"
    return "Senior"


def competition_region(name: str) -> str:
    return "Azerbaijan" if "region" in name.lower() else "National"


def parse_int(value: str) -> int | None:
    match = re.search(r"-?\d+", value or "")
    return int(match.group()) if match else None


def parse_date(value: str) -> date | None:
    value = clean_text(value).lower()
    match = re.search(r"(\d{2})[.\s](\d{2})[.\s](\d{4})", value)
    if match:
        return datetime.strptime(".".join(match.groups()), "%d.%m.%Y").date()
    parts = value.split()
    if len(parts) >= 2 and parts[0].isdigit() and parts[1] in MONTHS:
        day = int(parts[0])
        month = MONTHS[parts[1]]
        year = 2025 if month >= 7 else 2026
        return date(year, month, day)
    return None


def split_teams(value: str) -> tuple[str, str] | None:
    value = clean_text(value)
    if "-" not in value:
        return None
    left, right = value.rsplit("-", 1)
    return left.strip(), right.strip()


def rows_from_table(table) -> list[list[str]]:
    rows = []
    for tr in table.select("tr"):
        cells = [clean_text(cell.get_text("\n", strip=True)) for cell in tr.select("td, th")]
        if cells:
            rows.append(cells)
    return rows


def extract_items(soup: BeautifulSoup) -> list[dict]:
    items = []
    for item in soup.select("div.item"):
        title_tag = item.select_one("div.title")
        title = clean_text(title_tag.get_text(" ", strip=True)) if title_tag else ""
        tables = []
        for table in item.select("div.items table"):
            rows = rows_from_table(table)
            if rows:
                tables.append(rows)
        if title or tables:
            items.append({"title": title, "tables": tables})
    return items


def parse_region_config(page_html: str) -> tuple[int, dict[str, str], dict[str, list[dict[str, str]]]]:
    soup = BeautifulSoup(page_html, "html.parser")
    select = soup.select_one("#filter_region")
    region_names = {}
    for option in select.select("option"):
        value = option.get("value", "0")
        label = clean_text(option.get_text())
        if value != "0" and label:
            region_names[value] = label
    item_match = re.search(r"curr_item_id\s*=\s*(\d+)", page_html)
    cities_match = re.search(r"var cities = (\{.*?\});", page_html, re.S)
    cities_blob = re.sub(r"([,{])\s*(\d+)\s*:", r'\1"\2":', cities_match.group(1))
    return int(item_match.group(1)), region_names, json.loads(cities_blob)


def match_status(match_date: date, has_result: bool) -> str:
    today = date.today()
    if has_result or match_date < today:
        return "finished"
    if match_date == today:
        return "live"
    return "scheduled"


def stable_match_id(match: dict) -> str:
    raw = "|".join(
        [
            clean_text(match.get("competition_code", "")).lower(),
            clean_text(match.get("match_date", "")),
            clean_text(match.get("round_label", "")).lower(),
            clean_text(match.get("phase_label", "")).lower(),
            clean_text(match.get("home_team", "")).lower(),
            clean_text(match.get("away_team", "")).lower(),
        ]
    )
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]
    slug = re.sub(r"[^a-z0-9]+", "-", raw).strip("-")
    return f"{slug[:72]}-{digest}"


def is_region_page(url: str | None) -> bool:
    if not url:
        return False
    html = fetch_html(url)
    return "#filter_region" in html and "act=js/regions" in html


def discover_phase_schedule_urls(initial_url: str) -> list[str]:
    urls = []
    seen = set()
    queue = [initial_url]
    while queue:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        urls.append(url)
        soup = BeautifulSoup(fetch_html(url), "html.parser")
        for link in soup.select("div.button_tabs a.link[href]"):
            href = resolve_url(link.get("href", ""))
            if "/tqvim" in href and href not in seen:
                queue.append(href)
    return urls


def discover_competitions() -> list[dict]:
    soup = BeautifulSoup(fetch_html(DISCOVERY_URL), "html.parser")
    entries = []
    seen_root_urls = set()
    pattern = re.compile(rf"^{re.escape(BASE_URL)}/index\.php/yarlar/([^/]+)/(\d+)$")
    for anchor in soup.select("a[href]"):
        name = clean_text(anchor.get_text(" ", strip=True)).strip("/ ")
        href = resolve_url(anchor.get("href", ""))
        if not name:
            continue
        if not pattern.match(href):
            continue
        if href in seen_root_urls:
            continue
        seen_root_urls.add(href)
        page = BeautifulSoup(fetch_html(href), "html.parser")
        schedule_candidates = []
        standings_url = None
        scorers_url = None
        for link in page.select("a[href]"):
            link_href = resolve_url(link.get("href", ""))
            if not link_href.startswith(BASE_URL):
                continue
            if "/tqvim" in link_href and link_href not in schedule_candidates:
                schedule_candidates.append(link_href)
            if "/cdvl" in link_href and not standings_url:
                standings_url = link_href
            if "/bombardirl" in link_href and not scorers_url:
                scorers_url = link_href
        schedule_urls = []
        for candidate in schedule_candidates:
            for phase_url in discover_phase_schedule_urls(candidate):
                if phase_url not in schedule_urls:
                    schedule_urls.append(phase_url)
        if not schedule_urls and not standings_url and not scorers_url:
            continue
        mode = "region" if is_region_page(standings_url or (schedule_urls[0] if schedule_urls else None)) else "direct"
        entries.append(
            {
                "code": slugify(name),
                "name": name,
                "category": competition_category(name),
                "region": competition_region(name),
                "mode": mode,
                "source_url": href,
                "schedule_urls": schedule_urls,
                "standings_url": standings_url,
                "scorers_url": scorers_url,
            }
        )
    return entries


def parse_standings_rows(rows: list[list[str]], competition_code: str, region_name: str, group_name: str) -> list[dict]:
    if len(rows) < 2:
        return []
    header = " ".join(rows[0]).lower()
    if "komanda" not in header and "klublar" not in header:
        return []
    parsed = []
    for row in rows[1:]:
        if len(row) < 10:
            continue
        parsed.append(
            {
                "competition_code": competition_code,
                "region_name": region_name,
                "group_name": group_name,
                "rank": parse_int(row[0]) or 0,
                "team_name": row[1],
                "played": parse_int(row[2]) or 0,
                "won": parse_int(row[3]) or 0,
                "drawn": parse_int(row[4]) or 0,
                "lost": parse_int(row[5]) or 0,
                "goals_for": parse_int(row[6]) or 0,
                "goals_against": parse_int(row[7]) or 0,
                "goal_diff": parse_int(row[8]) or 0,
                "points": parse_int(row[9]) or 0,
            }
        )
    return parsed


def parse_direct_standings(config: dict) -> list[dict]:
    if not config.get("standings_url"):
        return []
    html = fetch_html(config["standings_url"])
    soup = BeautifulSoup(html, "html.parser")
    standings = []
    for item in extract_items(soup):
        for table in item["tables"]:
            standings.extend(
                parse_standings_rows(
                    table,
                    config["code"],
                    config["region"],
                    item["title"] or config["name"],
                )
            )
    if standings:
        return standings
    tables = soup.select("div.bgc table.rte_table_style, div.shedule table.rte_table_style")
    for table in tables:
        standings.extend(parse_standings_rows(rows_from_table(table), config["code"], config["region"], config["name"]))
    return standings


def parse_direct_schedule(config: dict) -> list[dict]:
    matches = []
    for url in config["schedule_urls"]:
        html = fetch_html(url)
        soup = BeautifulSoup(html, "html.parser")
        phase_tabs = [clean_text(link.get_text(" ", strip=True)) for link in soup.select("div.button_tabs a.link")]
        phase_label = phase_tabs[0] if phase_tabs else config["name"]

        for item in extract_items(soup):
            label = item["title"] or phase_label
            for table in item["tables"]:
                if len(table) < 3:
                    continue
                if "Oyun" not in " ".join(table[1]) or "Tarix" not in " ".join(table[1]):
                    continue
                round_label = table[0][0]
                for row in table[2:]:
                    if len(row) < 5:
                        continue
                    teams = split_teams(row[0])
                    match_date = parse_date(row[1])
                    if not teams or not match_date:
                        continue
                    home_score = parse_int(row[3])
                    away_score = parse_int(row[4])
                    matches.append(
                        {
                            "id": stable_match_id(
                                {
                                    "competition_code": config["code"],
                                    "match_date": match_date.isoformat(),
                                    "round_label": round_label,
                                    "phase_label": label,
                                    "home_team": teams[0],
                                    "away_team": teams[1],
                                }
                            ),
                            "competition_code": config["code"],
                            "match_date": match_date.isoformat(),
                            "kickoff_label": "TBC",
                            "round_label": round_label,
                            "venue": row[2] or "",
                            "home_team": teams[0],
                            "away_team": teams[1],
                            "home_score": home_score or 0,
                            "away_score": away_score or 0,
                            "status": match_status(match_date, home_score is not None and away_score is not None),
                            "match_minute": 90 if home_score is not None and away_score is not None else None,
                            "added_time": None,
                            "phase_label": label,
                            "events": [],
                            "lineups": {"home": {"starter": [], "bench": []}, "away": {"starter": [], "bench": []}},
                        }
                    )

        for table in soup.select("div.shedule table.rte_table_style"):
            header_row = table.select_one("tr")
            data_rows = table.select("tr")[1:]
            if not header_row or not data_rows:
                continue
            round_titles = [clean_text(cell.get_text(" ", strip=True)) for cell in header_row.select("td, th")]
            if not any("tur" in cell.lower() for cell in round_titles):
                continue
            for row in data_rows:
                cells = row.select("td")
                for idx, cell in enumerate(cells):
                    chunks = [clean_text(div.get_text(" ", strip=True)) for div in cell.find_all("div", recursive=False)]
                    current_date = None
                    for chunk in chunks:
                        chunk_date = parse_date(chunk)
                        if chunk_date:
                            current_date = chunk_date
                            continue
                        if not current_date:
                            continue
                        score_match = re.search(r"(\d+)\s*:\s*(\d+)", chunk)
                        teams_part = chunk[:score_match.start()].strip() if score_match else chunk
                        teams = split_teams(teams_part)
                        if not teams:
                            continue
                        home_score = int(score_match.group(1)) if score_match else None
                        away_score = int(score_match.group(2)) if score_match else None
                        matches.append(
                            {
                                "id": stable_match_id(
                                    {
                                        "competition_code": config["code"],
                                        "match_date": current_date.isoformat(),
                                        "round_label": round_titles[idx] if idx < len(round_titles) else phase_label,
                                        "phase_label": phase_label,
                                        "home_team": teams[0],
                                        "away_team": teams[1],
                                    }
                                ),
                                "competition_code": config["code"],
                                "match_date": current_date.isoformat(),
                                "kickoff_label": "TBC",
                                "round_label": round_titles[idx] if idx < len(round_titles) else phase_label,
                                "venue": "",
                                "home_team": teams[0],
                                "away_team": teams[1],
                                "home_score": home_score or 0,
                                "away_score": away_score or 0,
                                "status": match_status(current_date, home_score is not None and away_score is not None),
                                "match_minute": 90 if home_score is not None and away_score is not None else None,
                                "added_time": None,
                                "phase_label": phase_label,
                                "events": [],
                                "lineups": {"home": {"starter": [], "bench": []}, "away": {"starter": [], "bench": []}},
                            }
                        )
    deduped = {}
    for match in matches:
        deduped[match["id"]] = match
    return list(deduped.values())


def parse_region_payload(config: dict) -> tuple[list[dict], list[dict], list[dict]]:
    if not config.get("standings_url") or not config.get("schedule_urls"):
        return [], [], []
    standings_page = fetch_html(config["standings_url"])
    standings_item_id, standings_regions, standings_cities = parse_region_config(standings_page)
    standings = []
    teams_by_group = defaultdict(set)
    for region_id, cities in standings_cities.items():
        region_name = standings_regions.get(region_id, region_id)
        for city in cities:
            fragment = fetch_html(f"{BASE_URL}/?act=js/regions", {"city_id": city["id"], "item_id": str(standings_item_id)})
            soup = BeautifulSoup(fragment, "html.parser")
            for item in extract_items(soup):
                if not item["tables"]:
                    continue
                group_name = clean_text(item["title"])
                for row in item["tables"][0][1:]:
                    if len(row) < 10:
                        continue
                    standings.append(
                        {
                            "competition_code": config["code"],
                            "region_name": region_name,
                            "group_name": group_name,
                            "rank": parse_int(row[0]) or 0,
                            "team_name": row[1],
                            "played": parse_int(row[2]) or 0,
                            "won": parse_int(row[3]) or 0,
                            "drawn": parse_int(row[4]) or 0,
                            "lost": parse_int(row[5]) or 0,
                            "goals_for": parse_int(row[6]) or 0,
                            "goals_against": parse_int(row[7]) or 0,
                            "goal_diff": parse_int(row[8]) or 0,
                            "points": parse_int(row[9]) or 0,
                        }
                    )
                    teams_by_group[(region_name, group_name)].add(row[1])

    schedule_page = fetch_html(config["schedule_urls"][0])
    schedule_item_id, schedule_regions, schedule_cities = parse_region_config(schedule_page)
    matches = []
    for region_id, cities in schedule_cities.items():
        region_name = schedule_regions.get(region_id, region_id)
        for city in cities:
            fragment = fetch_html(f"{BASE_URL}/?act=js/regions", {"city_id": city["id"], "item_id": str(schedule_item_id)})
            soup = BeautifulSoup(fragment, "html.parser")
            for item in extract_items(soup):
                group_name = clean_text(item["title"].split(".")[0])
                full_group = clean_text(item["title"])
                group_teams = teams_by_group.get((region_name, group_name), set())
                for table in item["tables"]:
                    if len(table) < 3:
                        continue
                    round_label = table[0][0]
                    for row in table[2:]:
                        if len(row) < 5:
                            continue
                        teams = None
                        for team in sorted(group_teams, key=len, reverse=True):
                            if row[0].startswith(f"{team}-"):
                                other = row[0][len(team) + 1 :].strip()
                                if other in group_teams:
                                    teams = (team, other)
                                    break
                        if not teams:
                            teams = split_teams(row[0])
                        match_date = parse_date(row[1])
                        if not teams or not match_date:
                            continue
                        home_score = parse_int(row[3])
                        away_score = parse_int(row[4])
                        matches.append(
                            {
                                "id": stable_match_id(
                                    {
                                        "competition_code": config["code"],
                                        "match_date": match_date.isoformat(),
                                        "round_label": round_label,
                                        "phase_label": full_group,
                                        "home_team": teams[0],
                                        "away_team": teams[1],
                                    }
                                ),
                                "competition_code": config["code"],
                                "match_date": match_date.isoformat(),
                                "kickoff_label": "TBC",
                                "round_label": round_label,
                                "venue": row[2] or "",
                                "home_team": teams[0],
                                "away_team": teams[1],
                                "home_score": home_score or 0,
                                "away_score": away_score or 0,
                                "status": match_status(match_date, home_score is not None and away_score is not None),
                                "match_minute": 90 if home_score is not None and away_score is not None else None,
                                "added_time": None,
                                "phase_label": full_group,
                                "events": [],
                                "lineups": {"home": {"starter": [], "bench": []}, "away": {"starter": [], "bench": []}},
                            }
                        )

    players = []
    if config.get("scorers_url"):
        scorers_html = fetch_html(config["scorers_url"])
        soup = BeautifulSoup(scorers_html, "html.parser")
        table = soup.select_one("div.shedule table")
        if table:
            rows = rows_from_table(table)
            for row in rows[1:]:
                if len(row) >= 4:
                    players.append(
                        {
                            "competition_code": config["code"],
                            "rank": parse_int(row[0]) or 0,
                            "player_name": row[1],
                            "team_name": row[2],
                            "goals": parse_int(row[3]) or 0,
                        }
                    )
    return standings, matches, players


def build_dataset() -> dict:
    discovered_competitions = discover_competitions()
    competitions = []
    standings = []
    matches = []
    players = []
    imported_rows = []
    for config in discovered_competitions:
        competitions.append(
            {
                "code": config["code"],
                "name": config["name"],
                "category": config["category"],
                "region": config["region"],
            }
        )
        try:
            if config["mode"] == "region":
                comp_standings, comp_matches, comp_players = parse_region_payload(config)
            else:
                comp_standings = parse_direct_standings(config)
                comp_matches = parse_direct_schedule(config) if config.get("schedule_urls") else []
                comp_players = []
        except Exception as error:
            print(f"Skipped {config['name']}: {error}")
            comp_standings, comp_matches, comp_players = [], [], []
        standings.extend(comp_standings)
        matches.extend(comp_matches)
        players.extend(comp_players)
        imported_rows.append((config["name"], len(comp_matches), len(comp_standings), len(comp_players)))

    deduped_matches = {}
    for match in matches:
        deduped_matches[match["id"]] = match
    matches = list(deduped_matches.values())

    teams_by_competition = defaultdict(set)
    for standing in standings:
        teams_by_competition[standing["competition_code"]].add(standing["team_name"])

    clubs = []
    for competition in competitions:
        code = competition["code"]
        for team_name in sorted(teams_by_competition[code]):
            club_matches = [m for m in matches if m["competition_code"] == code and (m["home_team"] == team_name or m["away_team"] == team_name)]
            standing_rows = [s for s in standings if s["competition_code"] == code and s["team_name"] == team_name]
            scorers = [p for p in players if p["competition_code"] == code and p["team_name"] == team_name]
            clubs.append(
                {
                    "competition_code": code,
                    "team_name": team_name,
                    "standing": standing_rows[0] if standing_rows else None,
                    "recent_matches": sorted(club_matches, key=lambda m: m["match_date"], reverse=True)[:5],
                    "scorers": scorers,
                }
            )

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "competitions": competitions,
        "matches": matches,
        "standings": standings,
        "players": players,
        "clubs": clubs,
        "import_summary": [
            {
                "competition_name": name,
                "matches": match_count,
                "standings": standing_count,
                "players": player_count,
            }
            for name, match_count, standing_count, player_count in imported_rows
        ],
    }


def main() -> None:
    target = Path(__file__).resolve().parents[1] / "site" / "data"
    target.mkdir(parents=True, exist_ok=True)
    dataset = build_dataset()
    output_path = target / "affa.json"
    output_path.write_text(json.dumps(dataset, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {output_path}")
    print(
        f"Competitions: {len(dataset['competitions'])}, "
        f"matches: {len(dataset['matches'])}, "
        f"standings: {len(dataset['standings'])}, "
        f"players: {len(dataset['players'])}"
    )


if __name__ == "__main__":
    main()
