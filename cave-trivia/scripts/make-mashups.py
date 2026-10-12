#!/usr/bin/env python3
"""
Cave Trivia — celebrity mashup generator (Dozen-style "who is mashed up here?").

Takes two celebrity portraits (Wikidata primary images, openly licensed),
aligns the faces with YuNet eye landmarks, and blends them 50/50 with
plain deterministic image math — no AI generation involved.

Output:
  public/mashups/<pair>.jpg          the blended portraits
  data/questions-mashups.json        the question bank (regenerated each run)

Setup (one time):
  python3 -m venv /tmp/mashup-env
  /tmp/mashup-env/bin/pip install opencv-python-headless pillow numpy
  curl -sL -o /tmp/yunet.onnx \
    https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx

Run:
  /tmp/mashup-env/bin/python scripts/make-mashups.py [--pairs 10]

To add more mashups later, extend PAIRS below and re-run.
Note: /tmp is ephemeral — rebuild the venv + redownload yunet.onnx if the
VM was replaced since you last ran this.
"""

import urllib.request, urllib.parse, json, io, os, sys, time, random
import cv2, numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT_DIR = os.path.join(ROOT, 'public', 'mashups')
BANK_PATH = os.path.join(ROOT, 'data', 'questions-mashups.json')
YUNET = '/tmp/yunet.onnx'
UA = {'User-Agent': 'cave-trivia-mashups/1.0'}

# Manual portrait overrides: verified frontal Commons headshots for celebs
# whose Wikipedia lead is an action/group shot. Full thumb URLs.
MANUAL_PORTRAITS = {
    'Beyonce': ['https://upload.wikimedia.org/wikipedia/commons/1/17/Beyonc%C3%A9_at_The_Lion_King_European_Premiere_2019.png'],
    'Taylor Swift': ['https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2a/Taylor_Swift_2_-_2019_by_Glenn_Francis_%28cropped%29.jpg/960px-Taylor_Swift_2_-_2019_by_Glenn_Francis_%28cropped%29.jpg'],
}


# (name_a, name_b, category) — keep it to faces Wikidata can find portraits for
PAIRS = [
    ('Dwayne Johnson', 'Kevin Hart', 'movies'),
    ('Tom Holland', 'Zendaya', 'movies'),
    ('Ryan Reynolds', 'Hugh Jackman', 'movies'),
    ('Chris Hemsworth', 'Chris Pratt', 'movies'),
    ('Taylor Swift', 'Travis Kelce', 'music'),
    ('LeBron James', 'Stephen Curry', 'sports'),
    ('Beyonce', 'Rihanna', 'music'),
    ('Will Smith', 'Martin Lawrence', 'movies'),
    ('Emma Stone', 'Ryan Gosling', 'movies'),
    ('Tom Hanks', 'Tim Allen', 'movies'),
]

SIZE = 400


# Wikipedia article titles (unambiguous for these public figures).
# 'Beyoncé' needs the accent; 'Beyonce' redirects poorly for pageimages.
WIKI_TITLES = {
    'Dwayne Johnson': 'Dwayne Johnson',
    'Kevin Hart': 'Kevin Hart',
    'Tom Holland': 'Tom Holland',
    'Zendaya': 'Zendaya',
    'Ryan Reynolds': 'Ryan Reynolds',
    'Hugh Jackman': 'Hugh Jackman',
    'Chris Hemsworth': 'Chris Hemsworth',
    'Chris Pratt': 'Chris Pratt',
    'Taylor Swift': 'Taylor Swift',
    'Travis Kelce': 'Travis Kelce',
    'LeBron James': 'LeBron James',
    'Stephen Curry': 'Stephen Curry',
    'Beyonce': 'Beyoncé',
    'Rihanna': 'Rihanna',
    'Will Smith': 'Will Smith',
    'Martin Lawrence': 'Martin Lawrence',
    'Emma Stone': 'Emma Stone',
    'Ryan Gosling': 'Ryan Gosling',
    'Tom Hanks': 'Tom Hanks',
    'Tim Allen': 'Tim Allen',
}


def portrait_url(name):
    """Lead portrait from the subject's Wikipedia article (pageimages)."""
    title = urllib.parse.quote(WIKI_TITLES.get(name, name))
    url = ('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2'
           f'&titles={title}&prop=pageimages&pithumbsize=800')
    d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20))
    pages = d.get('query', {}).get('pages', [])
    if pages:
        thumb = (pages[0].get('thumbnail') or {}).get('source')
        if thumb:
            return thumb
    return None


def wikidata_image(name):
    q = urllib.parse.quote(name)
    url = f'https://www.wikidata.org/w/api.php?action=wbsearchentities&search={q}&language=en&format=json&limit=5'
    d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20))
    for hit in d.get('search', []):
        qid = hit['id']
        url = f'https://www.wikidata.org/w/api.php?action=wbgetclaims&entity={qid}&property=P18&format=json'
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20))
        claims = d.get('claims', {}).get('P18', [])
        if claims:
            fname = claims[0]['mainsnak']['datavalue']['value'].replace(' ', '_')
            return f'https://commons.wikimedia.org/wiki/Special:FilePath/{urllib.parse.quote(fname)}?width=800'
    return None


def portrait_candidates(name):
    """Candidate portraits: Wikipedia lead first (editorially curated = correct person),
    then Wikidata P18. No blind Commons text search — too many mislabeled files."""
    cands = []
    seen = set()

    def add(url, src):
        if url and url not in seen:
            seen.add(url)
            cands.append((url, src))

    try:
        add(portrait_url(name), 'wikipedia')
    except Exception:
        pass
    try:
        add(wikidata_fallback(name), 'wikidata')
    except Exception:
        pass
    # Manual overrides for known-bad leads (verified frontal headshots on Commons)
    for url in MANUAL_PORTRAITS.get(name, []):
        add(url, 'manual')
    return cands


def score_portrait(img_url):
    """Score a portrait for morph suitability. Returns (score, aligned_image) or (0, None).
    Score rewards: large face, frontal pose (eye symmetry around nose), centered face."""
    try:
        req = urllib.request.Request(img_url, headers=UA)
        img = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=25).read())).convert('RGB')
    except Exception:
        return 0, None
    arr = np.array(img)
    h0, w0 = arr.shape[:2]
    det = cv2.FaceDetectorYN_create(YUNET, '', (w0, h0))
    det.setInputSize((w0, h0))
    det.setScoreThreshold(0.5)
    _, faces = det.detect(arr)
    if faces is None or len(faces) == 0:
        return 0, None
    f = max(faces, key=lambda x: float(x[2]) * float(x[3]))
    fw = float(f[2])
    # face must be a real headshot, not a distant figure
    if fw < 0.20 * w0:
        return 0, None
    rex, rey = float(f[4]), float(f[5])
    lex, ley = float(f[6]), float(f[7])
    nx, ny = float(f[8]), float(f[9])
    # frontal check: nose x should sit midway between the eyes
    eye_mid_x = (rex + lex) / 2.0
    eye_dist = max(1.0, np.hypot(lex - rex, ley - rey))
    asym = abs(nx - eye_mid_x) / eye_dist  # 0 = perfectly frontal
    if asym > 0.30:
        return 0, None
    # eyes should be roughly level
    tilt = abs(ley - rey) / eye_dist
    if tilt > 0.30:
        return 0, None
    score = (fw / w0) * 2.0 - asym * 2.0 - tilt
    aligned, ok = align_face_from_array(arr, f)
    return (score if ok else 0), aligned


def align_face_from_array(arr, f):
    """5-point similarity alignment given a YuNet face row. Returns (image, ok)."""
    src = np.array([
        [float(f[4]), float(f[5])],
        [float(f[6]), float(f[7])],
        [float(f[8]), float(f[9])],
        [float(f[10]), float(f[11])],
        [float(f[12]), float(f[13])],
    ], dtype=np.float64)
    dst = np.array([
        [0.35 * SIZE, 0.38 * SIZE],
        [0.65 * SIZE, 0.38 * SIZE],
        [0.50 * SIZE, 0.55 * SIZE],
        [0.38 * SIZE, 0.72 * SIZE],
        [0.62 * SIZE, 0.72 * SIZE],
    ], dtype=np.float64)
    M, _ = cv2.estimateAffinePartial2D(src, dst, method=cv2.LMEDS)
    if M is None:
        return None, False
    aligned = cv2.warpAffine(arr, M, (SIZE, SIZE), flags=cv2.INTER_LANCZOS4,
                             borderMode=cv2.BORDER_REPLICATE)
    return Image.fromarray(aligned), True


def wikidata_fallback(name):
    """Wikidata P18 portrait as a backup source."""
    q = urllib.parse.quote(name)
    url = f'https://www.wikidata.org/w/api.php?action=wbsearchentities&search={q}&language=en&format=json&limit=5'
    d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20))
    for hit in d.get('search', []):
        url = f'https://www.wikidata.org/w/api.php?action=wbgetclaims&entity={hit["id"]}&property=P18&format=json'
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20))
        claims = d.get('claims', {}).get('P18', [])
        if claims:
            fname = claims[0]['mainsnak']['datavalue']['value'].replace(' ', '_')
            return f'https://commons.wikimedia.org/wiki/Special:FilePath/{urllib.parse.quote(fname)}?width=800'
    return None


def get_aligned_face(name):
    """Pick the best-scoring portrait from candidates and return its aligned face."""
    best = (0, None, None)
    for url, src in portrait_candidates(name):
        score, aligned = score_portrait(url)
        if score > best[0]:
            best = (score, aligned, src)
        time.sleep(0.4)
    if best[1] is None:
        print(f'    {name}: no usable portrait found')
        return None, None
    print(f'    {name}: picked {best[2]} portrait (score {best[0]:.2f})')
    return best[1], best[2]


def main():
    if not os.path.exists(YUNET):
        sys.exit('YuNet model missing at /tmp/yunet.onnx — see setup notes at the top of this script.')
    os.makedirs(OUT_DIR, exist_ok=True)
    random.seed(20261012)

    questions = []
    pair_labels = [f'{a} & {b}' for a, b, _ in PAIRS]
    for idx, (a, b, cat) in enumerate(PAIRS):
        try:
            fa, src_a = get_aligned_face(a)
            time.sleep(0.6)
            fb, src_b = get_aligned_face(b)
            if fa is None or fb is None:
                print(f'  SKIP {a} + {b} (no usable portrait)')
                continue
            mash = Image.blend(fa, fb, 0.5)
            slug = f'mashup-{idx:02d}'
            mash.save(os.path.join(OUT_DIR, slug + '.jpg'), quality=88)
            print(f'  mashup {slug}: {a} + {b} (src: {src_a},{src_b})')
        except Exception as e:
            print(f'  MASHUP FAILED {a} + {b}: {e}')
            continue
        correct = f'{a} & {b}'
        decoys = [l for l in pair_labels if l != correct]
        random.shuffle(decoys)
        options = [correct] + decoys[:3]
        random.shuffle(options)
        questions.append({
            'id': f'mashup-q-{idx:02d}',
            'category': 'mashup',
            'difficulty': 'medium',
            'question': 'Which two celebrities are mashed up in this photo?',
            'options': options,
            'answer': options.index(correct),
            'image': f'/mashups/{slug}.jpg',
            'kid_safe': True,
        })
        time.sleep(0.6)

    with open(BANK_PATH, 'w') as f:
        json.dump(questions, f, indent=2)
    print(f'wrote {BANK_PATH} with {len(questions)} questions')


if __name__ == '__main__':
    main()
