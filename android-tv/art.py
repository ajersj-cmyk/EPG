from PIL import Image, ImageDraw, ImageFont, ImageFilter
import glob
F="/usr/share/fonts/truetype/sand-box/google/Bricolage Grotesque/BricolageGrotesque-VariableFont_opsz,wdth,wght.ttf"
def font(sz):
    f=ImageFont.truetype(F,sz)
    try: f.set_variation_by_name("ExtraBold")
    except Exception: pass
    return f
def render(path, bg=True, lines=("CAVE","TRIVIA"), pad=0.12):
    im0=Image.open(path); w,h=im0.size
    base=Image.new("RGBA",(w,h),(5,8,20,255) if bg else (0,0,0,0))
    if bg:
        d=ImageDraw.Draw(base)
        for y in range(h): d.line([(0,y),(w,y)],fill=(5,int(10+25*y/h),int(30+30*y/h),255))
    text="\n".join(lines)
    sz=10
    while True:
        f=font(sz+2); b=ImageDraw.Draw(base).multiline_textbbox((0,0),text,font=f,align="center",spacing=sz//8)
        if b[2]-b[0]>w*(1-2*pad) or b[3]-b[1]>h*(1-2*pad): break
        sz+=2
    f=font(sz); d=ImageDraw.Draw(base); b=d.multiline_textbbox((0,0),text,font=f,align="center",spacing=sz//8)
    xy=((w-(b[2]-b[0]))/2-b[0],(h-(b[3]-b[1]))/2-b[1])
    glow=Image.new("RGBA",(w,h),(0,0,0,0)); ImageDraw.Draw(glow).multiline_text(xy,text,font=f,fill=(0,229,255,255),align="center",spacing=sz//8,stroke_width=max(2,sz//10),stroke_fill=(0,229,255,255))
    glow=glow.filter(ImageFilter.GaussianBlur(max(2,sz//8)))
    base=Image.alpha_composite(base,glow)
    ImageDraw.Draw(base).multiline_text(xy,text,font=f,fill=(235,255,255,255),align="center",spacing=sz//8,stroke_width=max(1,sz//20),stroke_fill=(0,229,255,255))
    fmt="WEBP" if path.endswith(".webp") else "PNG"
    (base if bg or fmt=="PNG" else base).save(path,fmt)
    print(path,w,h)
render("drawable-xhdpi/tv_banner.png",lines=("CAVE TRIVIA",),pad=0.08)
render("drawable-xhdpi/logo_wordmark.webp",bg=False,lines=("CAVE TRIVIA",),pad=0.05)
for p in glob.glob("mipmap-*/ic_launcher.png"): render(p,pad=0.14)
render("mipmap-xxxhdpi/ic_launcher_foreground.png",bg=False,pad=0.28)
im=Image.open("mipmap-xxxhdpi/ic_launcher_background.webp"); Image.new("RGB",im.size,(5,20,45)).save("mipmap-xxxhdpi/ic_launcher_background.webp","WEBP")
