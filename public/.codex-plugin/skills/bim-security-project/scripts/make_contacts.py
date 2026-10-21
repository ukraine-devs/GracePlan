#!/usr/bin/env python3
"""Create visual reference sheets, preserving all input files. Requires Pillow."""
import argparse,json,hashlib
from pathlib import Path
from PIL import Image,ImageDraw,ImageOps
ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('pictures',type=Path);ap.add_argument('output',type=Path);args=ap.parse_args()
if not args.pictures.is_dir():raise SystemExit('Pictures directory not found')
if args.output.resolve()==args.pictures.resolve():raise SystemExit('Use a separate output directory')
args.output.mkdir(parents=True,exist_ok=True);manifest=[]
for group in ['floor1','floor2','floor3','floor4','Outdoor']:
    folder=args.pictures/group
    if not folder.is_dir():raise SystemExit('Missing group: '+group)
    files=sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower()in('.jpg','.jpeg','.png')and not p.name.startswith('._'))
    for start in range(0,len(files),12):
        batch=files[start:start+12];sheet=Image.new('RGB',(1440,((len(batch)+3)//4)*260),'white');draw=ImageDraw.Draw(sheet)
        for j,p in enumerate(batch):
            with Image.open(p) as src:
                im=ImageOps.exif_transpose(src).convert('RGB');original_size=im.size;im.thumbnail((350,226))
            x=j%4*360;y=j//4*260;sheet.paste(im,(x,y));draw.text((x,y+228),f'{start+j+1:02} {p.stem[:40]}',fill='black')
            manifest.append({'id':f'{group}-{start+j+1:02}','source':str(p.relative_to(args.pictures)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'size':original_size,'contact_sheet':f'{group}_{start//12}.jpg'})
        sheet.save(args.output/f'{group}_{start//12}.jpg',quality=93)
(args.output/'contact_manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'photos':len(manifest),'directory':str(args.output)},ensure_ascii=False))
