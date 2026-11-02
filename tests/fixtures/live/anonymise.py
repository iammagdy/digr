#!/usr/bin/env python3
"""Anonymise Diger raw pages (raw/*.json, rows/*.json).

Rule: whitelist. A string is KEPT only if its key is structural (ids, cursors,
paging tokens, dates, types, statuses, languages, country codes, counters,
Diger's own request params). EVERY other string (names, handles, texts,
captions, titles, avatars, places, free text) is replaced by a stable
placeholder: same input -> same placeholder, so joins still work.
URLs keep scheme + host; path segments without a digit are hashed; the query
string is dropped except id-like params. Provider session tokens and cookies
are redacted. Numbers, booleans, nulls and JSON structure are untouched.

Usage: python3 anonymise.py <in_dir> <out_dir> <salt>
The salt is never written to the output.
"""
import hashlib, hmac, json, os, re, sys
from urllib.parse import urlsplit, parse_qsl, urlencode

ARABIC = re.compile(r"[\u0600-\u06FF]")
ID_KEY = re.compile(r"(^|_)(id|ids|pk|uid|cid|mid|fbid)$|Id$|^id_str$|_id_str$|^sec_uid$|^aweme_id$|^feedback_id$|^comments_id$|^shares_id$|^rest_id$|^fbid_v2$")
PERSONAL_OVERRIDE = {"unique_id", "username", "handle", "screen_name", "owner_handle",
                     "authorUsername", "nickname", "nick_name", "owner_nickname", "ins_id", "topic_id",
                     "keyword", "query", "search_query"}
REDACT = {"token", "cookie", "tt_chain_token"}
KEEP = {
    # paging
    "cursor", "nextCursor", "next_cursor", "prev_cursor", "next_max_id", "continuation_token",
    "continuationToken", "expansion_token", "offset", "hasNextPage", "has_next_page",
    # dates and times
    "created_at", "date", "startDate", "endDate", "posted_at", "published", "publishedTime",
    "publishedTimeText", "published_time", "taken_at", "time", "recordTime", "timestamp",
    "createdUtc", "_approx_dates",
    # types, statuses, codes
    "type", "kind", "__typename", "media_type", "content_type", "status", "status_msg", "code",
    "success", "provider", "error", "reason", "unavailable_reason", "verified", "is_reply",
    "link_type", "token_type", "sort_type", "sort_order", "sort_label", "version", "sub_version",
    "engine", "step", "message_zh", "feedback_type", "artworkKey", "resultId", "requestId",
    "request_id", "logid", "impr_id", "_rid", "search_request_id", "found", "replayed",
    # languages and regions
    "lang", "language", "language_code", "comment_language", "desc_language", "text_language",
    "title_language", "words_lang", "text_sticker_major_lang", "region", "region_code", "country",
    "city_code", "time_zone", "timezone",
    # counters written as text
    "viewCountText", "subscriberCountText", "subscriber_count_text", "lengthText", "count",
    "likes", "views", "shares", "followers", "saves", "retweets", "plays", "length", "video_length",
    "replies_count", "reactions_count", "comments_count",
    # Diger flags in delivered rows
    "liked_by_creator", "reply_video_flag", "reply_with_video", "reply_with_video_flag", "video_reply",
}
PERSONAL_FIELDS = {"name", "authorname", "username", "handle", "uniqueid", "nickname", "text", "message",
                   "caption", "title", "description", "bio", "biography", "place", "address", "fullname",
                   "screenname", "channelname", "content", "desc"}


def norm(k):
    return re.sub(r"[_-]", "", k or "").lower()
REQ_KEEP = {"keyword", "query", "search_query", "startDate", "endDate", "cursor"}
PLATFORM_HOSTS = ("facebook.com", "fbcdn.net", "fb.watch", "instagram.com", "cdninstagram.com",
                  "tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com", "byteoversea.com",
                  "ibyteimg.com", "muscdn.com", "youtube.com", "youtu.be", "ytimg.com", "ggpht.com",
                  "googleusercontent.com", "x.com", "twitter.com", "twimg.com", "t.co")
ID_AFTER = {"posts", "videos", "video", "watch", "reel", "reels", "p", "status", "comment",
            "shorts", "channel", "photo", "photos", "permalink.php", "story.php"}


def tag(salt, s, n=8):
    return hmac.new(salt, s.encode("utf-8"), hashlib.sha256).hexdigest()[:n]


class Anon:
    def __init__(self, salt):
        self.salt = salt.encode()
        self.replaced = set()

    def text(self, s):
        if s == "":
            return s
        self.replaced.add(s)
        h = tag(self.salt, s)
        return f"نص_{h}" if ARABIC.search(s) else f"txt_{h}"

    def url(self, s):
        try:
            u = urlsplit(s)
        except ValueError:
            return self.text(s)
        if not u.scheme or not u.netloc:
            return self.text(s)
        segs = []
        prev = ""
        for seg in u.path.split("/"):
            keep = (seg == "" or seg.isdigit() or seg.startswith("pfbid")
                    or seg in ID_AFTER or prev in ID_AFTER)
            if keep:
                segs.append(seg)
            else:
                self.replaced.add(seg)
                segs.append("seg_" + tag(self.salt, seg, 6))
            prev = seg
        q = [(k, v) for k, v in parse_qsl(u.query) if k in {"v", "id", "fbid", "story_fbid", "comment_id"}]
        host = u.netloc.lower().split(":")[0]
        if not any(host == h or host.endswith("." + h) for h in PLATFORM_HOSTS):
            self.replaced.add(host)
            host = "host-" + tag(self.salt, host, 6) + ".invalid"
        out = f"{u.scheme}://{host}{'/'.join(segs)}"
        return out + ("?" + urlencode(q) if q else "")

    def value(self, key, v, in_req=False):
        if isinstance(v, dict):
            return {k: self.value(k, x, in_req or k == "requestParams") for k, x in v.items()}
        if isinstance(v, list):
            return [self.value(key, x, in_req) for x in v]
        if not isinstance(v, str):
            return v
        if in_req and key in REQ_KEEP:
            return v
        if key in REDACT:
            return "redacted"
        if key in PERSONAL_OVERRIDE or norm(key) in PERSONAL_FIELDS:
            return self.text(v)
        if key in KEEP or (key and ID_KEY.search(key)):
            return v
        if re.match(r"^https?://", v):
            return self.url(v)
        if key and key.lower().endswith("cookie"):
            return "redacted"
        return self.text(v)


def main(src, dst, salt):
    a = Anon(salt)
    n = 0
    for root, _, files in os.walk(src):
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, src)
            with open(p, encoding="utf-8") as fh:
                d = json.load(fh)
            out = a.value(None, d)
            q = os.path.join(dst, rel)
            os.makedirs(os.path.dirname(q), exist_ok=True)
            with open(q, "w", encoding="utf-8") as fh:
                json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
            n += 1
    return n, a.replaced


if __name__ == "__main__":
    n, rep = main(sys.argv[1], sys.argv[2], sys.argv[3])
    print(f"files {n}, distinct strings replaced {len(rep)}")
