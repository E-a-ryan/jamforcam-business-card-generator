import json, base64
from fontTools.ttLib import TTFont
from fontTools import subset

ROOT=__import__("pathlib").Path(__file__).resolve().parent.parent
fonts={"regular":ROOT/"fonts/SpecialGothic-Regular.ttf","medium":ROOT/"fonts/SpecialGothic-Medium.ttf"}
chars=list(range(0x20,0x7F))+list(range(0xA0,0x180))+[0x2013,0x2014,0x2018,0x2019,0x201C,0x201D,0x2022,0x2026,0x00B7,0x2032,0x2033,0x20AC,0x2122,0x2010,0x2011]
out={}
for key,path in fonts.items():
    opts=subset.Options(); opts.layout_features=['kern']; opts.name_IDs=['*']; opts.notdef_outline=True; opts.glyph_names=True
    f=TTFont(path); s=subset.Subsetter(opts); s.populate(unicodes=chars); s.subset(f)
    sp=ROOT/"build"/f"{key}.subset.ttf"; sp.parent.mkdir(exist_ok=True); f.save(sp); f=TTFont(sp)
    order=f.getGlyphOrder(); gid={n:i for i,n in enumerate(order)}
    cmap=f.getBestCmap()
    hmtx=f['hmtx']
    cm={str(u):gid[n] for u,n in cmap.items()}
    adv=[hmtx[n][0] for n in order]
    # kerning
    kern={}
    gpos=f['GPOS'].table
    idx=set()
    for fr in gpos.FeatureList.FeatureRecord:
        if fr.FeatureTag=='kern': idx.update(fr.Feature.LookupListIndex)
    def xa(v): return getattr(v,'XAdvance',0) if v else 0
    for li in sorted(idx):
        lk=gpos.LookupList.Lookup[li]
        subs=lk.SubTable
        for st in subs:
            if lk.LookupType==9: st=st.ExtSubTable
            if getattr(st,'LookupType',2)!=2 and lk.LookupType not in (2,9): continue
            if st.Format==1:
                cov=st.Coverage.glyphs
                for i,g1 in enumerate(cov):
                    for pvr in st.PairSet[i].PairValueRecord:
                        v=xa(pvr.Value1)
                        k=f"{gid[g1]},{gid[pvr.SecondGlyph]}"
                        if v and k not in kern: kern[k]=v
            elif st.Format==2:
                cov=st.Coverage.glyphs
                c1=st.ClassDef1.classDefs; c2=st.ClassDef2.classDefs
                second=[g for g in order]
                for g1 in cov:
                    cl1=c1.get(g1,0)
                    row=st.Class1Record[cl1].Class2Record
                    for g2 in second:
                        cl2=c2.get(g2,0)
                        v=xa(row[cl2].Value1)
                        k=f"{gid[g1]},{gid[g2]}"
                        if v and k not in kern: kern[k]=v
    os2=f['OS/2']; head=f['head']
    out[key]={"name":f['name'].getDebugName(6),"upm":head.unitsPerEm,"cmap":cm,"adv":adv,"kern":kern,
      "ascent":f['hhea'].ascent,"descent":f['hhea'].descent,"capHeight":os2.sCapHeight,
      "bbox":[head.xMin,head.yMin,head.xMax,head.yMax],"b64":base64.b64encode(open(sp,'rb').read()).decode()}
    print(key,out[key]['name'],len(order),'glyphs',len(kern),'kern pairs',len(open(sp,'rb').read()),'bytes')
json.dump(out,open(ROOT/"build/fonts.json","w"))
