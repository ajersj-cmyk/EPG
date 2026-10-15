#!/usr/bin/env python3
"""
Bulk import TriviaQA into Cave Trivia format.
Runs on GitHub Actions.

Output: web/data/tqa-*.json chunks (200 Qs each), categorized, NSFW-filtered.

Memory-safe design: processes ONE shard at a time, writes chunks incrementally,
and frees each shard's table before loading the next. A single bad shard is
logged and skipped instead of killing the whole import.
"""
import json, os, re, random, sys, hashlib, glob, gc
from collections import Counter

# ---- Config ----
CHUNK_SIZE = 200
OUT_DIR = "web/data"
SEED = 123

# NSFW filter (expanded from engine.js FAMILY_BLOCK)
NSFW = re.compile(
    r"\b(damn|bitch|bastard|shit|fuck|porn|nude|naked|cocaine|marijuana|"
    r"whore|slut|penis|vagina|sex|erotic|orgasm|masturbat|prostitut|"
    r"stripper|playboy|hentai|xxx)\b", re.I)

# Category keywords for classification
CAT_KEYWORDS = {
    "movies": ["film", "movie", "actor", "actress", "director", "oscar", "hollywood"],
    "music": ["song", "band", "singer", "album", "music", "guitar", "piano", "rapper"],
    "tv": ["television", "tv show", "sitcom", "episode", "series", "netflix"],
    "sports": ["football", "basketball", "baseball", "soccer", "olympics", "athlete",
               "championship", "quarterback", "home run", "touchdown"],
    "history": ["war", "century", "president", "king", "queen", "empire", "revolution",
                "ancient", "medieval", "civil war", "independence"],
    "science": ["scientist", "chemistry", "physics", "biology", "element", "atom",
                "dna", "evolution", "planet", "galaxy", "quantum"],
    "geography": ["country", "capital", "city", "river", "mountain", "ocean", "continent",
                  "border", "island", "desert"],
    "literature": ["novel", "author", "poet", "book", "shakespeare", "poem", "writer",
                   "literature", "playwright"],
    "art": ["painting", "artist", "sculpture", "museum", "picasso", "vangogh", "renaissance"],
    "food": ["food", "cuisine", "recipe", "dish", "restaurant", "chef", "wine", "beer",
             "coffee", "chocolate"],
    "nature": ["animal", "bird", "fish", "tree", "flower", "insect", "mammal", "reptile",
               "ocean", "forest"],
    "tech": ["computer", "internet", "software", "apple", "google", "microsoft", "iphone",
             "ai", "robot", "code"],
    "politics": ["election", "senator", "congress", "parliament", "democrat", "republican",
                 "prime minister", "government"],
    "mythology": ["zeus", "myth", "greek god", "odin", "thor", "hercules", "olympus"],
    "games": ["video game", "nintendo", "playstation", "xbox", "mario", "zelda", "pokemon"],
    "disney": ["disney", "mickey", "pixar"],
}

def classify(question, source=""):
    """Assign a category based on keywords. Falls back to 'mixed'."""
    text = (question + " " + source).lower()
    scores = Counter()
    for cat, keywords in CAT_KEYWORDS.items():
        for kw in keywords:
            if kw in text:
                scores[cat] += 1
    if scores:
        return scores.most_common(1)[0][0]
    return "mixed"

def is_clean(question, answer):
    """NSFW filter."""
    text = f"{question} {answer}"
    return not NSFW.search(text)

def extract_answer(ans):
    """Pull the correct answer string out of TriviaQA's answer dict."""
    if isinstance(ans, dict):
        v = ans.get("normalized_value") or ans.get("value") or ""
    else:
        v = str(ans)
    return v.strip()

def process_shard(parquet_path):
    """Process one parquet shard into question dicts.

    Reads only the columns we need, converts to plain dicts immediately,
    and returns them. Caller is responsible for freeing memory.
    """
    import pyarrow.parquet as pq
    table = pq.read_table(parquet_path, columns=["question", "answer", "question_source"])
    questions = []
    try:
        for row in table.to_pylist():
            q_text = (row.get("question") or "").strip()
            correct = extract_answer(row.get("answer"))
            source = row.get("question_source") or ""

            # Filters
            if len(q_text) < 10 or len(q_text) > 300:
                continue
            if len(correct) < 1 or len(correct) > 80:
                continue
            if not is_clean(q_text, correct):
                continue

            cat = classify(q_text, source)

            questions.append({
                "id": f"tqa-{hashlib.md5(q_text.encode('utf-8')).hexdigest()[:10]}",
                "category": cat,
                "difficulty": random.choice(["easy", "medium", "hard"]),
                "question": q_text,
                "answerType": "text",
                "answerText": correct,
                "options": [],
                "answer": 0,
                "source": "triviaqa",
            })
    finally:
        # Free the arrow table before returning; the caller holds only dicts.
        del table
    return questions


class ChunkWriter:
    """Writes tqa-N.json chunks incrementally as questions arrive."""

    def __init__(self, out_dir, chunk_size=CHUNK_SIZE):
        self.out_dir = out_dir
        self.chunk_size = chunk_size
        self.buf = []
        self.chunk_n = 0
        self.total = 0
        os.makedirs(out_dir, exist_ok=True)

    def add(self, q):
        self.buf.append(q)
        self.total += 1
        if len(self.buf) >= self.chunk_size:
            self.flush()

    def flush(self):
        if not self.buf:
            return
        self.chunk_n += 1
        fp = os.path.join(self.out_dir, f"tqa-{self.chunk_n}.json")
        with open(fp, "w", encoding="utf-8") as f:
            json.dump(self.buf, f, separators=(",", ":"))
        print(f"  wrote {fp} ({len(self.buf)} Qs)", flush=True)
        self.buf = []


def main():
    random.seed(SEED)

    shards = sorted(glob.glob("tqa-*.parquet"))
    if not shards:
        print("FATAL: no parquet shards found in cwd!", flush=True)
        sys.exit(1)
    print(f"Found {len(shards)} shards", flush=True)

    writer = ChunkWriter(OUT_DIR)
    seen = set()          # dedup keys (question text hashes) — small vs full dicts
    cats = Counter()
    failed_shards = []

    for i, sp in enumerate(shards, 1):
        try:
            qs = process_shard(sp)
        except Exception as e:
            print(f"[{i}/{len(shards)}] {sp}: FAILED ({type(e).__name__}: {e}) — skipping shard",
                  flush=True)
            failed_shards.append(sp)
            gc.collect()
            continue

        kept = 0
        for q in qs:
            # Dedup on md5 id (derived from question text) — cheaper than full text
            if q["id"] in seen:
                continue
            seen.add(q["id"])
            writer.add(q)
            cats[q["category"]] += 1
            kept += 1

        # Free shard dicts now; only `seen` ids and written chunks persist
        del qs
        gc.collect()
        print(f"[{i}/{len(shards)}] {sp}: {kept} kept, {writer.total} total so far",
              flush=True)

    writer.flush()

    print(f"\nDone: {writer.total} questions in {writer.chunk_n} chunks", flush=True)
    print("Categories:", dict(cats.most_common()), flush=True)
    if failed_shards:
        print(f"WARNING: {len(failed_shards)} shard(s) failed and were skipped:",
              flush=True)
        for sp in failed_shards:
            print(f"  - {sp}", flush=True)
    if writer.total == 0:
        print("FATAL: no questions written!", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
