"""
SBS Biz YouTube 채널 추천 종목 자동 수집
- 채널 RSS로 최근 영상 목록
- 자막 우선, 없으면 제목/설명에서 종목명 매칭
- site/sbsbiz.json에 video_id 기반 누적 저장
"""

import os
import re
import json
import time
import requests
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

KST = timezone(timedelta(hours=9))
def now_kst():
    return datetime.now(KST)

CHANNEL_HANDLE_URL = "https://www.youtube.com/@SBSBizStock"
RSS_URL_TEMPLATE = "https://www.youtube.com/feeds/videos.xml?channel_id={}"
SHORTS_RSS_URL_TEMPLATE = "https://www.youtube.com/feeds/videos.xml?playlist_id={}"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
}

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_DIR = os.path.join(BASE_DIR, "public")
JSON_PATH = os.path.join(SITE_DIR, "sbsbiz.json")

# 포맷 변경 시 증가시켜 기존 데이터를 폐기하고 재수집
FORMAT_VERSION = 8  # v8: 자막 매칭 임계값 2 → 1 (영상에서 종목명 2회 언급 잘 안 되는 패턴 반영)

# 종목 매칭 시 제외할 흔한 단어 (실제 종목명이지만 본문에 자주 등장해 오탐 유발)
NAME_BLACKLIST = {
    "한국", "현대", "대한", "코리아", "삼성", "엘지", "신한", "포스코",
    "DB", "SK", "GS", "KT", "S&T", "한국전력",
    # SBS Biz 채널 자기 언급 차단
    "SBS",
    "SBS콘텐츠허브",
    "SBS미디어홀딩스",
}


# ============================================================
# 채널 ID 추출
# ============================================================
def resolve_channel_id(cached_id=None):
    """캐시된 ID가 있으면 사용, 없으면 채널 HTML에서 추출"""
    if cached_id and re.fullmatch(r"UC[\w-]{22}", cached_id):
        return cached_id
    try:
        resp = requests.get(CHANNEL_HANDLE_URL, headers=HEADERS, timeout=10)
        m = re.search(r'"channelId":"(UC[\w-]{22})"', resp.text)
        if m:
            return m.group(1)
        m = re.search(r'/channel/(UC[\w-]{22})', resp.text)
        if m:
            return m.group(1)
    except Exception as e:
        print(f"   [SBS Biz] 채널 ID 추출 실패: {e}")
    return None


# ============================================================
# RSS 영상 목록
# ============================================================
def _parse_rss(url, is_short=False):
    """단일 RSS feed를 파싱해 영상 리스트 반환"""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        resp.raise_for_status()
    except Exception as e:
        print(f"   [SBS Biz] RSS 조회 실패 ({'쇼츠' if is_short else '일반'}): {e}")
        return []

    ns = {
        "atom": "http://www.w3.org/2005/Atom",
        "yt": "http://www.youtube.com/xml/schemas/2015",
        "media": "http://search.yahoo.com/mf/rss/",
    }
    try:
        root = ET.fromstring(resp.text)
    except ET.ParseError as e:
        print(f"   [SBS Biz] RSS 파싱 실패: {e}")
        return []

    out = []
    for entry in root.findall("atom:entry", ns):
        video_id_el = entry.find("yt:videoId", ns)
        title_el = entry.find("atom:title", ns)
        link_el = entry.find("atom:link", ns)
        published_el = entry.find("atom:published", ns)
        media_group = entry.find("media:group", ns)
        description = ""
        thumbnail = ""
        if media_group is not None:
            desc_el = media_group.find("media:description", ns)
            if desc_el is not None and desc_el.text:
                description = desc_el.text
            thumb_el = media_group.find("media:thumbnail", ns)
            if thumb_el is not None:
                thumbnail = thumb_el.attrib.get("url", "")

        if video_id_el is None or title_el is None:
            continue

        vid = video_id_el.text
        url_link = link_el.attrib.get("href") if link_el is not None else f"https://youtu.be/{vid}"
        out.append({
            "video_id": vid,
            "title": title_el.text or "",
            "description": description,
            "url": url_link,
            "published": published_el.text if published_el is not None else "",
            "thumbnail": thumbnail or f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
            "is_short": is_short,
        })
    return out


def fetch_recent_videos(channel_id):
    """일반 영상 + 쇼츠를 모두 수집해 합치고 video_id로 dedup"""
    # 일반 영상
    normal = _parse_rss(RSS_URL_TEMPLATE.format(channel_id), is_short=False)
    # 쇼츠 (채널 ID UC... → playlist UUSH... 변환)
    shorts = []
    if channel_id.startswith("UC"):
        shorts_playlist_id = "UUSH" + channel_id[2:]
        shorts = _parse_rss(SHORTS_RSS_URL_TEMPLATE.format(shorts_playlist_id), is_short=True)
    print(f"   영상 일반 {len(normal)}개 / 쇼츠 {len(shorts)}개")

    # 합치고 dedup (일반이 쇼츠와 겹치면 일반 우선이라 쇼츠 정보 덮어쓰기 방지)
    seen = set()
    merged = []
    for v in normal + shorts:
        if v["video_id"] in seen:
            continue
        seen.add(v["video_id"])
        merged.append(v)
    return merged


# ============================================================
# 자막 추출
# ============================================================
def _fetch_transcript_via_ytdlp(video_id):
    """yt-dlp 로 한국어 자막 URL → json3 다운로드 → 텍스트 합치기. 실패 시 None.
    youtube-transcript-api 가 GitHub Actions 등 데이터센터 IP에서 차단되는 문제 회피용."""
    try:
        import yt_dlp
    except ImportError:
        return None
    url = f"https://www.youtube.com/watch?v={video_id}"
    ydl_opts = {
        "skip_download": True,
        "writeautomaticsub": True,
        "writesubtitles": True,
        "subtitleslangs": ["ko", "ko-KR", "a.ko"],
        "subtitlesformat": "json3",
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        print(f"   [SBS Biz] yt-dlp info 추출 실패 {video_id}: {type(e).__name__}: {str(e)[:120]}")
        return None

    # 수동 자막 우선, 없으면 자동 자막
    for src in (info.get("subtitles") or {}, info.get("automatic_captions") or {}):
        for lang_key in ("ko", "ko-KR", "ko_KR"):
            entries = src.get(lang_key)
            if not entries:
                continue
            # json3 우선
            ent = next((e for e in entries if e.get("ext") == "json3"), None) or entries[0]
            sub_url = ent.get("url")
            ext = ent.get("ext")
            if not sub_url:
                continue
            try:
                import urllib.request
                req = urllib.request.Request(sub_url, headers={"User-Agent": HEADERS["User-Agent"]})
                with urllib.request.urlopen(req, timeout=15) as r:
                    raw = r.read().decode("utf-8", errors="ignore")
            except Exception as e:
                print(f"   [SBS Biz] 자막 fetch 실패 {video_id}: {type(e).__name__}")
                continue
            text = _parse_subtitle_text(raw, ext)
            if text:
                return text
    return None


def _parse_subtitle_text(raw, ext):
    """yt-dlp 가 받아온 자막 데이터에서 본문 텍스트만 추출."""
    try:
        if ext == "json3":
            data = json.loads(raw)
            events = data.get("events") or []
            text = " ".join(
                seg.get("utf8", "")
                for ev in events
                for seg in (ev.get("segs") or [])
            )
        elif ext in ("vtt", "srt"):
            # 타임스탬프 라인·번호 제거
            lines = []
            for line in raw.splitlines():
                line = line.strip()
                if not line or "-->" in line or line.isdigit() or line.startswith("WEBVTT"):
                    continue
                lines.append(line)
            text = " ".join(lines)
        else:
            # srv1, srv2, srv3, ttml 등 XML 계열은 태그 제거 후 텍스트만
            text = re.sub(r"<[^>]+>", " ", raw)
        text = re.sub(r"\s+", " ", text).strip()
        return text or None
    except Exception:
        return None


def get_transcript_text(video_id):
    """한국어 자막 텍스트 (yt-dlp 우선, 실패 시 youtube-transcript-api 폴백). 모두 실패 시 None."""
    text = _fetch_transcript_via_ytdlp(video_id)
    if text:
        return text
    # 폴백: youtube-transcript-api (개인 IP에서는 더 빠를 수 있음)
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        return None
    try:
        api = YouTubeTranscriptApi()
        transcript = api.fetch(video_id, languages=["ko", "ko-KR"])
        snippets = transcript.snippets if hasattr(transcript, "snippets") else transcript
        return " ".join(s.text for s in snippets if getattr(s, "text", None))
    except Exception:
        try:
            from youtube_transcript_api import YouTubeTranscriptApi as _YTA
            data = _YTA.get_transcript(video_id, languages=["ko", "ko-KR"])
            return " ".join(item.get("text", "") for item in data)
        except Exception:
            return None


# ============================================================
# 종목 매칭
# ============================================================
def _extract_snippet(text, name, name_lower, text_lower, window=50):
    """name 첫 등장 위치 주변 텍스트를 한 줄로 잘라 반환"""
    idx = text_lower.find(name_lower)
    if idx < 0:
        return ""
    start = max(0, idx - window)
    end = min(len(text), idx + len(name) + window)
    snippet = text[start:end]
    # 공백/줄바꿈 정리
    snippet = re.sub(r"\s+", " ", snippet).strip()
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet


def extract_stocks_from_text(text, stocks_master, min_mentions=1):
    """텍스트에서 종목명 검색하여 (code, name, mentions, snippet) 목록 반환"""
    if not text:
        return []
    text_lower = text.lower()
    results = []

    for s in stocks_master:
        name = s.get("name", "")
        code = s.get("code", "")
        if not name or not code or name in NAME_BLACKLIST:
            continue
        name_lower = name.lower()

        # 영문/숫자/기호로만 구성된 종목명(SBS, NEW, KT, LG 등)은 양쪽 단어 경계 적용 -
        # "News"의 NEW, "Newage"의 NEW 같은 영문 단어 부분 매칭 오탐 방지.
        is_alpha = bool(re.fullmatch(r'[A-Za-z0-9&\-\. ]+', name))
        if is_alpha or len(name) <= 2:
            pattern = r'(?<![가-힣A-Za-z0-9])' + re.escape(name_lower) + r'(?![가-힣A-Za-z0-9])'
            matches = re.findall(pattern, text_lower)
        else:
            # 한글 3자 이상: 시작 단어 경계만 (뒤에 조사 허용, 앞에 한글 붙으면 안 됨 - "SK하이닉스"의 "이닉스" 오탐 방지)
            pattern = r'(?<![가-힣A-Za-z0-9])' + re.escape(name_lower)
            matches = re.findall(pattern, text_lower)

        n = len(matches)
        if n >= min_mentions:
            snippet = _extract_snippet(text, name, name_lower, text_lower)
            results.append({
                "code": code,
                "name": name,
                "mentions": n,
                "snippet": snippet,
            })

    return sorted(results, key=lambda x: x["mentions"], reverse=True)


# ============================================================
# 메인 갱신 로직
# ============================================================
def _load_existing():
    if os.path.exists(JSON_PATH):
        try:
            with open(JSON_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("format_version") == FORMAT_VERSION:
                return data
            # 포맷/채널 변경 — 영상과 채널 ID 모두 초기화
            print(f"   [INFO] sbsbiz.json 포맷 변경 감지 (기존 v{data.get('format_version', 1)} → v{FORMAT_VERSION}) — 재수집")
            return {
                "format_version": FORMAT_VERSION,
                "channel": "SBS Biz 증권",
                "channel_id": None,
                "updated_at": "",
                "videos": [],
            }
        except Exception:
            pass
    return {
        "format_version": FORMAT_VERSION,
        "channel": "SBS Biz 증권",
        "channel_id": None,
        "updated_at": "",
        "videos": [],
    }


def _save(data):
    os.makedirs(SITE_DIR, exist_ok=True)
    with open(JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def update(stocks_master):
    """전체 갱신 엔트리포인트"""
    print("=" * 60)
    print(f"📺 SBS Biz YouTube 추천 종목 수집 - {now_kst().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 60)

    data = _load_existing()
    channel_id = resolve_channel_id(data.get("channel_id"))
    if not channel_id:
        print("   [WARN] 채널 ID를 확보하지 못해 종료")
        return data
    data["channel_id"] = channel_id

    videos = fetch_recent_videos(channel_id)
    if not videos:
        print("   [WARN] RSS에서 영상을 받지 못함")
        return data
    print(f"   RSS 영상 {len(videos)}개")

    existing_ids = {v["video_id"] for v in data["videos"]}
    new_videos = [v for v in videos if v["video_id"] not in existing_ids]
    print(f"   신규 영상 {len(new_videos)}개")

    for v in new_videos:
        transcript = get_transcript_text(v["video_id"])
        if transcript:
            stocks = extract_stocks_from_text(transcript, stocks_master, min_mentions=1)
            source = "transcript"
            log_extra = f"자막 {len(transcript)}자"
        else:
            text = f"{v['title']}\n{v['description']}"
            stocks = extract_stocks_from_text(text, stocks_master, min_mentions=1)
            source = "title"
            log_extra = "제목/설명"

        entry = {
            "video_id": v["video_id"],
            "title": v["title"],
            "url": v["url"],
            "published": v["published"],
            "thumbnail": v["thumbnail"],
            "is_short": v.get("is_short", False),
            "source": source,
            "stocks": stocks[:20],  # 상위 20개로 제한
        }
        data["videos"].insert(0, entry)
        print(f"   [+] {v['title'][:50]}  ({log_extra}, 종목 {len(stocks)}개)")
        time.sleep(0.5)  # 자막 API 부하 줄이기

    # 최신순 정렬 (published 기준 내림차순) + 상한
    data["videos"].sort(key=lambda x: x.get("published", ""), reverse=True)
    data["videos"] = data["videos"][:200]  # 최대 200개 누적

    data["updated_at"] = now_kst().strftime("%Y-%m-%d %H:%M:%S")
    _save(data)
    print(f"   ✅ 저장: {JSON_PATH} (총 {len(data['videos'])}개 영상)")
    return data


# ============================================================
# 단독 실행 (테스트)
# ============================================================
if __name__ == "__main__":
    stocks_path = os.path.join(SITE_DIR, "stocks.json")
    if not os.path.exists(stocks_path):
        print(f"[ERROR] {stocks_path} 가 없습니다. 먼저 fetch_data.py 를 실행해 종목 마스터를 생성해주세요.")
    else:
        with open(stocks_path, "r", encoding="utf-8") as f:
            master = json.load(f)
        update(master)
