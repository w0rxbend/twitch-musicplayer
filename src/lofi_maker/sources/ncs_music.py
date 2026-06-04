from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen

NCS_BASE_URL = "https://ncs.io"
NCS_USAGE_POLICY_URL = "https://ncs.io/usage-policy"
NCS_TERMS_URL = "https://ncs.io/usage-policy/terms"
MAX_DOWNLOAD_LIMIT = 200

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) "
        "AppleWebKit/537.36 Chrome/125 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


@dataclass(frozen=True)
class NcsTrack:
    id: str
    title: str
    artist: str
    page_url: str
    download_url: str
    file_name: str
    cover_url: str
    genre: str
    versions: str
    usage_policy_url: str
    terms_url: str


class NcsDownloadError(RuntimeError):
    """Raised when NCS pages or files cannot be read."""


class _NcsSearchParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tracks: list[NcsTrack] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key: value or "" for key, value in attrs}

        if tag == "a" and "player-play" in attr_map.get("class", "").split():
            download_url = attr_map.get("data-url", "")
            track_id = attr_map.get("data-tid", "")
            if not download_url or not track_id:
                return

            self.tracks.append(
                NcsTrack(
                    id=track_id,
                    title=attr_map.get("data-track", "untitled"),
                    artist=attr_map.get("data-artistraw", "unknown"),
                    page_url="",
                    download_url=download_url,
                    file_name=_filename_from_url(download_url) or f"{track_id}.mp3",
                    cover_url=attr_map.get("data-cover", ""),
                    genre=attr_map.get("data-genre", ""),
                    versions=attr_map.get("data-versions", ""),
                    usage_policy_url=NCS_USAGE_POLICY_URL,
                    terms_url=NCS_TERMS_URL,
                )
            )
            return

        if tag == "a" and self.tracks and not self.tracks[-1].page_url:
            href = attr_map.get("href", "")
            if _looks_like_track_path(href):
                track = self.tracks[-1]
                self.tracks[-1] = NcsTrack(
                    **{**asdict(track), "page_url": urljoin(NCS_BASE_URL, href)}
                )


def build_search_url(
    source: str,
    *,
    genre: str = "",
    mood: str = "",
    version: str = "",
    page: int = 1,
) -> str:
    if source.startswith("http://") or source.startswith("https://"):
        parsed = urlparse(source)
        query = parse_qs(parsed.query, keep_blank_values=True)
        query["page"] = [str(page)]
        if page == 1:
            query.pop("page", None)
        return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))

    query: dict[str, list[str]] = {"q": [source], "genre": [genre], "mood": [mood]}
    if version:
        query["version[]"] = [version]
    if page > 1:
        query["page"] = [str(page)]

    return f"{NCS_BASE_URL}/music-search?{urlencode(query, doseq=True)}"


def parse_search_page(html: str) -> list[NcsTrack]:
    parser = _NcsSearchParser()
    parser.feed(html)

    tracks: list[NcsTrack] = []
    seen: set[str] = set()
    for track in parser.tracks:
        if track.id in seen:
            continue
        seen.add(track.id)
        page_url = track.page_url or NCS_BASE_URL
        tracks.append(NcsTrack(**{**asdict(track), "page_url": page_url}))
    return tracks


def fetch_search_results(
    source: str,
    *,
    pages: int,
    delay: float,
    genre: str = "",
    mood: str = "",
    version: str = "",
) -> list[NcsTrack]:
    tracks: list[NcsTrack] = []
    seen: set[str] = set()

    for page in range(1, pages + 1):
        url = build_search_url(source, genre=genre, mood=mood, version=version, page=page)
        page_tracks = parse_search_page(fetch_text(url))
        if not page_tracks:
            break

        for track in page_tracks:
            if track.id in seen:
                continue
            seen.add(track.id)
            tracks.append(track)

        if page < pages:
            time.sleep(delay)

    return tracks


def fetch_text(url: str, timeout: float = 30.0, retries: int = 3) -> str:
    request = Request(url, headers=DEFAULT_HEADERS)
    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            with urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", errors="replace")
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:200].strip()
            last_error = NcsDownloadError(f"NCS returned HTTP {exc.code} for {url}: {detail}")
            if exc.code not in {429, 500, 502, 503, 504} or attempt == retries:
                raise last_error from exc
        except URLError as exc:
            last_error = NcsDownloadError(f"Could not reach NCS URL {url}: {exc}")
            if attempt == retries:
                raise last_error from exc

        time.sleep(1.5 * attempt)

    raise NcsDownloadError(f"Could not read NCS URL {url}: {last_error}")


def download_file(url: str, destination: Path, timeout: float = 120.0) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_path = destination.with_suffix(destination.suffix + ".part")
    request = Request(url, headers={**DEFAULT_HEADERS, "Accept": "audio/*,*/*;q=0.8"})

    try:
        with urlopen(request, timeout=timeout) as response, temp_path.open("wb") as file:
            total = 0
            while True:
                chunk = response.read(1024 * 128)
                if not chunk:
                    break
                file.write(chunk)
                total += len(chunk)
    except (HTTPError, URLError) as exc:
        temp_path.unlink(missing_ok=True)
        raise NcsDownloadError(f"Could not download audio file {url}: {exc}") from exc

    temp_path.replace(destination)
    return total


def read_manifest_ids(manifest_path: Path) -> set[str]:
    if not manifest_path.exists():
        return set()

    ids: set[str] = set()
    with manifest_path.open("r", encoding="utf-8") as file:
        for line in file:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            track_id = value.get("id")
            if track_id:
                ids.add(str(track_id))
    return ids


def append_manifest(manifest_path: Path, track: NcsTrack, file_path: Path) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        **asdict(track),
        "downloaded_file": str(file_path),
        "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with manifest_path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(payload, ensure_ascii=True, sort_keys=True) + "\n")


def safe_output_name(track: NcsTrack) -> str:
    source_name = track.file_name or _filename_from_url(track.download_url) or f"{track.id}.mp3"
    stem = Path(source_name).stem
    suffix = Path(source_name).suffix or ".mp3"
    return f"{track.id[:8]}_{_slugify(stem)}{suffix.lower()}"


def trim_limit(limit: int) -> int:
    if limit < 1:
        raise ValueError("limit must be at least 1")
    if limit > MAX_DOWNLOAD_LIMIT:
        raise ValueError(f"limit must be {MAX_DOWNLOAD_LIMIT} or lower")
    return limit


def _filename_from_url(url: str) -> str:
    return _sanitize_filename(Path(urlparse(url).path).name)


def _looks_like_track_path(href: str) -> bool:
    if not href.startswith("/"):
        return False
    if href.startswith(("/artist/", "/music-search", "/track/", "/usage-policy", "/privacy")):
        return False
    return bool(re.fullmatch(r"/[A-Za-z0-9][A-Za-z0-9_-]*", href))


def _sanitize_filename(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")


def _slugify(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "-", value.lower()).strip("-")
    return slug or "ncs-track"
