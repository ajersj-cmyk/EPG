# Stage 2 bank expansion: real sourced multiple choice (OpenTDB CC BY-SA, The Trivia API, Wikipedia paraphrase).
import json,re,glob,hashlib,random,html,collections
norm=lambda t:re.sub(r"[^a-z0-9]","",t.lower())
existing=set()
for f in glob.glob('/workspace/EPG-ghp/data/questions-*.json'):
    if f.endswith('questions-real2.json'): continue
    for q in json.load(open(f)): existing.add(norm(q.get("question","") or q.get("text","")))
BAD=re.compile(r"\b(sex|sexy|kill|killed|murder|drug|cocaine|beer|alcohol|vodka|whisk|nazi|hitler|porn|nude|naked|suicide|gun|rape|blood|bitch|damn|hell|devil|satan|war\b|bomb|terror|prison|weed|marijuana|wine|strip|playboy|slave|death|dead|die\b|died|cancer)",re.I)
META=re.compile(r"(which of (the|these)|following|not\b|NOT\b|true or false|all of|none of|\bexcept\b)",re.I)
ANIME=re.compile(r"(anime|manga|JoJo|Naruto|Gundam|Evangelion|One Piece|Dragon Ball|Sailor|Bleach|Hunter x|Touhou|Kancolle|Persona|Fate/|Danganronpa|Yu-Gi)",re.I)
VIBE=[("mario",r"\bMario\b|Luigi|Bowser|Princess Peach|Yoshi|Donkey Kong|Koopa|Toad\b|Wario"),
("pixar",r"Pixar|Toy Story|Buzz Lightyear|Woody|Finding (Nemo|Dory)|Monsters, Inc|Incredibles|Ratatouille|WALL-E|\bUp\b|Inside Out|Cars\b|Lightning McQueen|Coco\b|Brave\b|Luca\b"),
("parks",r"Disneyland|Walt Disney World|Magic Kingdom|EPCOT|Epcot|Animal Kingdom|Hollywood Studios|theme park|Space Mountain|Haunted Mansion|Splash Mountain"),
("disney",r"Disney|Mickey|Minnie|Goofy|Donald Duck|Lion King|Aladdin|Little Mermaid|Frozen|Moana|Cinderella|Snow White|Beauty and the Beast|Mulan|Pocahontas|Hercules|Tangled|Encanto|Zootopia|Bambi|Dumbo|Pinocchio|Peter Pan|Jungle Book|Stitch"),
("pokemon",r"Pok[eé]mon|Pikachu|Charizard|Ash Ketchum"),
("marvel",r"Marvel|Avengers|Spider-Man|Iron Man|Thor\b|Hulk|Captain America|X-Men|Wolverine|Black Panther"),
("kidsmovies",r"Shrek|Harry Potter|Hogwarts|Star Wars|Jedi|Darth|Jurassic|Willy Wonka|Wizard of Oz|E\.T\.|Home Alone|Ghostbusters|Back to the Future|Despicable|Minion|Kung Fu Panda|Madagascar|Ice Age|How to Train Your Dragon|Paddington|Lego Movie"),
("toons",r"Simpsons|SpongeBob|Scooby|Looney|Bugs Bunny|Tom and Jerry|Flintstones|Jetsons|Rugrats|Hey Arnold|Powerpuff|Dexter|Futurama|Family Guy|Teenage Mutant|Ninja Turtles|Garfield|Peanuts|Snoopy|Nickelodeon|Cartoon Network|Animaniacs|Pinky|Doug\b|Arthur\b"),
("toys",r"LEGO|Lego|Barbie|Hot Wheels|Nerf|Tamagotchi|Furby|Rubik|Monopoly|Scrabble|Hasbro|Mattel|Transformers|G\.I\. Joe|Beanie|Play-Doh|Etch|Slinky|Yo-yo|Tickle Me|Cabbage Patch|Operation\b|Clue\b|Candy Land|Twister|Uno\b")]
def route(text,base):
    for c,rx in VIBE:
        if re.search(rx,text): return c
    return base
OT_BASE={11:"movies",12:"music",14:"tv",15:"games",32:"toons",21:"sports",16:"toys",10:"mixed"}
TA_BASE={"film_and_tv":"movies","music":"music","sport_and_leisure":"sports","arts_and_literature":"mixed","general_knowledge":"mixed"}
def mk(src,cat,diff,q,a,w):
    q=q.strip(); q=q if q[-1] in "?." else q+"?"
    h=hashlib.md5((src+q).encode()).hexdigest()[:8]
    opts=[a]+list(w); r=random.Random(h); r.shuffle(opts)
    return {"id":f"{cat}-x-{h}","category":cat,"difficulty":diff,"question":q,"options":opts,"answer":opts.index(a),"kid_safe":True,"source":src,"answerType":"choice"}
def good(q,a,w):
    allt=" ".join([q,a]+w)
    if BAD.search(allt) or META.search(q) or ANIME.search(allt): return False
    if len(q)>130 or len(q)<18 or any(len(x)>34 for x in [a]+w): return False
    if len(set(norm(x) for x in [a]+w))<4: return False
    return True
cands=[]
for x in json.load(open('raw/opentdb.json')):
    if x["difficulty"]=="hard": continue
    q=html.unescape(x["question"]);a=html.unescape(x["correct_answer"]);w=[html.unescape(i) for i in x["incorrect_answers"]]
    if not good(q,a,w): continue
    cat=route(q+" "+a,OT_BASE[x["_cat"]])
    cands.append(mk("opentdb.com (CC BY-SA 4.0)",cat,x["difficulty"],q,a,w))
for x in json.load(open('raw/triviaapi.json')):
    if x.get("difficulty")=="hard" or x.get("isNiche"): continue
    q=x["question"]["text"];a=x["correctAnswer"];w=x["incorrectAnswers"]
    if not good(q,a,w): continue
    cat=route(q+" "+a,TA_BASE[x["_cat"]])
    if cat in ("mixed",) : continue  # general knowledge filler stays out unless it routes to a vibe category
    cands.append(mk("the-trivia-api.com",cat,x.get("difficulty","medium"),q,a,w))
exec(open('wiki2.py').read())  # WIKI: hand-written, paraphrased from Wikipedia
for cat,diff,q,a,w,art,fmt in WIKI:
    o=mk("Paraphrased from Wikipedia: "+art,cat,diff,q,a,w)
    if fmt: o["format"]=fmt
    cands.append(o)
exec(open('curate2.py').read())
def _keep(o):
    return (not any(d in o["question"] for d in DROP)) and any(a in o["question"] for a in ALLOW)
cands=[o for o in cands if o["source"].startswith("Paraphrased") or _keep(o)]
for o in cands:
    for k,c in RECAT.items():
        if k in o["question"]: o["category"]=c; o["id"]=c+"-x-"+o["id"].split("-x-")[1]
out=[];seen=set();dup=0
for o in cands:
    n=norm(o["question"])
    if n in existing or n in seen: dup+=1; continue
    seen.add(n); out.append(o)
# balance: cap each generic category so the vibe ones lead
CAP={"movies":24,"music":22,"tv":20,"sports":20,"games":22,"toons":24,"toys":16,"kidsmovies":30,"mixed":0}
cnt=collections.Counter();final=[]
r=random.Random(7); r.shuffle(out)
for o in sorted(out,key=lambda o:0 if o["source"].startswith("Paraphrased") else 1):
    c=o["category"]
    if c in CAP and cnt[c]>=CAP[c]: continue
    cnt[c]+=1; final.append(o)
for o in final:
    assert len(o["options"])==4 and 0<=o["answer"]<4 and len(set(o["options"]))==4
json.dump(final,open('/workspace/EPG-ghp/data/questions-real2.json','w'),ensure_ascii=False,indent=0)
print(len(final),"dupes",dup); print(collections.Counter(o["category"] for o in final))
print(collections.Counter(o["source"].split(":")[0] for o in final))
