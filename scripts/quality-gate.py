#!/usr/bin/env python3
"""
Quality gate for Cave Trivia question banks.
Validates, filters, and scores questions. Run before any bulk import.

Usage: python3 quality-gate.py <input.json> [--fix] [--report]
  --fix: write cleaned output to <input>.clean.json
  --report: print detailed quality report

Checks:
1. Schema: has id, question, answer (or answerText), category
2. Question length: 10-300 chars (not too short, not a paragraph)
3. Answer validity: non-empty, < 80 chars
4. No duplicates (by normalized question text)
5. No garbage patterns (placeholder text, "Option 1", etc.)
6. Category is in known list
7. For choice questions: 4 unique options, valid answer index
8. For text questions: answerText present and clean
"""
import json, re, sys
from collections import Counter

KNOWN_CATS = {
    'movies', 'music', 'tv', 'sports', 'games', 'toys', 'pokemon',
    'disney', 'pixar', 'parks', 'toons', 'jeopardy', 'mixed', 'marvel',
    'history', 'science', 'geography', 'literature', 'art', 'food',
    'nature', 'tech', 'politics', 'mythology',
}

GARBAGE_PATTERNS = [
    r'^option \d+$',           # "Option 1", "Option 2" placeholders
    r'^test',                  # test data
    r'lorem ipsum',
    r'^\?+$',                  # just question marks
    r'(.)\1{5,}',              # repeated chars "aaaaaa"
]

NSFW = re.compile(
    r"\b(damn|bitch|bastard|shit|fuck|porn|nude|naked|cocaine|marijuana|"
    r"whore|slut|penis|vagina|erotic|orgasm|masturbat|prostitut|"
    r"stripper|playboy|hentai)\b", re.I)

def quality_score(q):
    """Return (score 0-100, issues list). Higher is better."""
    issues = []
    score = 100
    
    # Schema
    if not q.get('id'):
        issues.append('missing id'); score -= 20
    if not q.get('question') or len(q['question'].strip()) < 10:
        issues.append('question too short'); score -= 30
    if len(q.get('question', '')) > 300:
        issues.append('question too long'); score -= 10
    
    # Category
    if q.get('category') not in KNOWN_CATS:
        issues.append(f"unknown category: {q.get('category')}"); score -= 15
    
    # Answer checks
    is_text = q.get('answerType') == 'text' or q.get('category') == 'jeopardy'
    if is_text:
        at = q.get('answerText', '')
        if not at or len(at.strip()) < 1:
            # fallback to options[answer]
            opts = q.get('options', [])
            ai = q.get('answer', -1)
            if not opts or ai < 0 or ai >= len(opts):
                issues.append('text Q missing answerText'); score -= 40
        if len(at) > 80:
            issues.append('answer too long'); score -= 10
    else:
        opts = q.get('options', [])
        if len(opts) != 4:
            issues.append(f'expected 4 options, got {len(opts)}'); score -= 25
        if len(set(o.lower().strip() for o in opts)) != len(opts):
            issues.append('duplicate options'); score -= 20
        ai = q.get('answer', -1)
        if not (0 <= ai < len(opts)):
            issues.append('invalid answer index'); score -= 40
        # Check for garbage options
        for o in opts:
            for pat in GARBAGE_PATTERNS:
                if re.search(pat, o, re.I):
                    issues.append(f'garbage option: {o[:30]}'); score -= 25
                    break
    
    # NSFW
    text = q.get('question', '') + ' ' + str(q.get('answerText', '')) + ' ' + ' '.join(q.get('options', []))
    if NSFW.search(text):
        issues.append('NSFW content'); score -= 100
    
    # Garbage question patterns
    for pat in GARBAGE_PATTERNS:
        if re.search(pat, q.get('question', ''), re.I):
            issues.append('garbage question text'); score -= 30
            break
    
    return max(0, score), issues

def run_gate(input_path, fix=False, report=False):
    with open(input_path) as f:
        data = json.load(f)
    
    seen = set()
    passed = []
    rejected = []
    scores = []
    
    for q in data:
        # Dedupe
        key = re.sub(r'[^a-z0-9]', '', q.get('question', '').lower())
        if key in seen:
            rejected.append((q, ['duplicate']))
            continue
        seen.add(key)
        
        score, issues = quality_score(q)
        scores.append(score)
        if score >= 70:
            passed.append(q)
        else:
            rejected.append((q, issues))
    
    if report or not fix:
        print(f"\n=== Quality Gate: {input_path} ===")
        print(f"Total: {len(data)}")
        print(f"Passed (≥70): {len(passed)}")
        print(f"Rejected: {len(rejected)}")
        if scores:
            print(f"Avg score: {sum(scores)/len(scores):.1f}")
        # Top rejection reasons
        reasons = Counter()
        for _, issues in rejected:
            for i in issues:
                reasons[i.split(':')[0]] += 1
        if reasons:
            print("\nTop rejection reasons:")
            for r, c in reasons.most_common(10):
                print(f"  {c}x: {r}")
    
    if fix:
        out = input_path.replace('.json', '.clean.json')
        with open(out, 'w') as f:
            json.dump(passed, f, separators=(',', ':'))
        print(f"\nCleaned: {out} ({len(passed)} questions)")
    
    return passed, rejected

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 quality-gate.py <input.json> [--fix] [--report]")
        sys.exit(1)
    run_gate(sys.argv[1], '--fix' in sys.argv, '--report' in sys.argv)
