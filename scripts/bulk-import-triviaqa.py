#!/usr/bin/env python3
"""
Bulk import TriviaQA into Cave Trivia format.
Runs on GitHub Actions (has the bandwidth/RAM for 7GB of parquet).

Output: web/data/tqa-*.json chunks (200 Qs each), categorized, NSFW-filtered.
"""
import json, os, re, random, sys, hashlib
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

def make_distractors(correct_answer, all_answers, n=3):
    """Pick n wrong answers from the pool of all answers."""
    pool = [a for a in all_answers if a.lower() != correct_answer.lower()
            and len(a) < 60 and len(a) > 1]
    random.shuffle(pool)
    picked = []
    seen = {correct_answer.lower()}
    for a in pool:
        if a.lower() not in seen:
            picked.append(a)
            seen.add(a.lower())
        if len(picked) >= n:
            break
    # Pad if needed
    while len(picked) < n:
        picked.append(f"Option {len(picked)+1}")
    return picked[:n]

def process_shard(parquet_path, all_answers_pool):
    """Process one parquet shard into question dicts."""
    import pyarrow.parquet as pq
    table = pq.read_table(parquet_path, columns=["question", "answer", "question_source"])
    questions = []
    for row in table.to_pylist():
        q_text = row["question"].strip()
        ans = row["answer"]
        # answer is a dict with 'value' or normalized aliases
        if isinstance(ans, dict):
            correct = ans.get("normalized_value") or ans.get("value") or ""
        else:
            correct = str(ans)
        correct = correct.strip()
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
    return questions

def main():
    import glob
    random.seed(SEED)
    os.makedirs(OUT_DIR, exist_ok=True)

    shards = sorted(glob.glob("tqa-*.parquet"))
    if not shards:
        print("No parquet shards found!")
        sys.exit(1)
    print(f"Found {len(shards)} shards")

    # First pass: collect all answers for distractor pool (NSFW-filtered)
    print("Building answer pool...")
    import pyarrow.parquet as pq
    all_answers = []
    for sp in shards:
        t = pq.read_table(sp, columns=["answer"])
        for row in t.to_pylist():
            ans = row["answer"]
            if isinstance(ans, dict):
                v = ans.get("normalized_value") or ans.get("value") or ""
            else:
                v = str(ans)
            v = v.strip()
            # NSFW filter applies to distractor pool too — a dirty answer
            # must never appear even as a wrong option
            if 1 < len(v) < 60 and is_clean("", v):
                all_answers.append(v)
    print(f"Answer pool: {len(all_answers)}")

    # Second pass: process questions
    all_qs = []
    seen = set()
    for sp in shards:
        qs = process_shard(sp, all_answers)
        for q in qs:
            key = q["question"].lower().strip()
            if key not in seen:
                seen.add(key)
                all_qs.append(q)
        print(f"  {sp}: {len(qs)} -> total {len(all_qs)}")

    # Write chunks
    n_chunks = (len(all_qs) + CHUNK_SIZE - 1) // CHUNK_SIZE
    for i in range(n_chunks):
        chunk = all_qs[i*CHUNK_SIZE:(i+1)*CHUNK_SIZE]
        fp = os.path.join(OUT_DIR, f"tqa-{i+1}.json")
        with open(fp, "w") as f:
            json.dump(chunk, f, separators=(",", ":"))
    
    # Category stats
    cats = Counter(q["category"] for q in all_qs)
    print(f"\nDone: {len(all_qs)} questions in {n_chunks} chunks")
    print("Categories:", dict(cats.most_common()))

if __name__ == "__main__":
    main()
