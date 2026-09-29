"""新港（Nyhavn）平面資料擷取：Overture Maps（OSM 建物、門牌、marina 水域）→ src/scene/nyhavn-data.ts

用法（需 pyarrow、shapely）：
  python3 scripts/nyhavn/extract.py fetch      # 從 Overture S3 下載 bbox 內的 parquet 到目前目錄
  python3 scripts/nyhavn/extract.py            # 由 parquet 產生 src/scene/nyhavn-data.ts
需要代理時設定 HTTPS_PROXY；自訂 CA 用 SSL_CERT_FILE。
"""
import os, sys, json, math
import pyarrow.parquet as pq
OUT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','src','scene','nyhavn-data.ts')
RELEASE='2026-09-23.1'

def fetch():
    import pyarrow.fs as pfs, pyarrow.dataset as ds, pyarrow.compute as pc
    kw={}
    if os.environ.get('HTTPS_PROXY'): kw['proxy_options']=os.environ['HTTPS_PROXY']
    if os.environ.get('SSL_CERT_FILE'): kw['tls_ca_file_path']=os.environ['SSL_CERT_FILE']
    fs=pfs.S3FileSystem(anonymous=True, region='us-west-2', **kw)
    W,S,E,N=12.583,55.6780,12.5960,55.6815
    f=(pc.field('bbox','xmin')<E)&(pc.field('bbox','xmax')>W)&(pc.field('bbox','ymin')<N)&(pc.field('bbox','ymax')>S)
    for theme,typ in [('base','land_use'),('buildings','building'),('addresses','address')]:
        t=ds.dataset(f'overturemaps-us-west-2/release/{RELEASE}/theme={theme}/type={typ}/',filesystem=fs,format='parquet').to_table(filter=f)
        print(theme,typ,t.num_rows)
        pq.write_table(t,f'{theme}_{typ}.parquet')

if len(sys.argv)>1 and sys.argv[1]=='fetch':
    fetch(); sys.exit()

# ---- (a, c) 座標系 ----
# 與 src/geo.ts 的 offsetLatLon 相同的橢球切平面換算
LAT0,LON0=55.6798,12.5903
BEAR=115.0
A=6378137.0; E2=0.00669437999014
_s=math.sin(math.radians(LAT0)); _w=1-E2*_s*_s
M_LAT=A*(1-E2)/_w**1.5*math.pi/180
M_LON=A/math.sqrt(_w)*math.cos(math.radians(LAT0))*math.pi/180
def en(lon,lat):
    return (lon-LON0)*M_LON,(lat-LAT0)*M_LAT
def ac(lon,lat):
    e,n=en(lon,lat); b=math.radians(BEAR); bc=math.radians(BEAR-90)
    return e*math.sin(b)+n*math.cos(b), e*math.sin(bc)+n*math.cos(bc)

# ---- 運河、涵蓋範圍、建物 ----
import shapely.wkb as W, json, math
from shapely.geometry import Polygon, box
from shapely.ops import transform, unary_union
T=lambda g: transform(lambda x,y,z=None: ac(x,y), g)
lu=[r for r in pq.read_table('base_land_use.parquet').to_pylist() if r['class']=='marina'][0]
canal=T(W.loads(lu['geometry']))
quay=unary_union([box(-192,15,-182,38.5), box(-182,-17.3,-99.5,38.5), box(-99.5,-19.8,246,38.5)])
addrs=[(T(W.loads(r['geometry'])), r['street'], r['number']) for r in pq.read_table('addresses_address.parquet').to_pylist()]
blds=[]
for r in pq.read_table('buildings_building.parquet').to_pylist():
    nm=r['names'] and r['names']['primary']
    if nm=='Charlottenborg Slot': continue
    G=T(W.loads(r['geometry']))
    if [x['dataset'] for x in r['sources']]==['Microsoft ML Buildings']: continue
    for g in getattr(G,'geoms',[G]):
        if g.area<30: continue
        inwater = g.intersection(canal).area > 0.5*g.area
        if inwater: continue
        if g.intersection(quay.buffer(0.3)).area<=0.5: continue
        if g.distance(canal)>25: continue
        ad=sorted(set(f"{n}" for p,s,n in addrs if s=='Nyhavn' and g.buffer(0.5).contains(p)))
        other=sorted(set(f"{s} {n}" for p,s,n in addrs if s!='Nyhavn' and g.buffer(0.5).contains(p)))
        g=g.simplify(0.15)
        blds.append(dict(g=g,addr=ad,other=other))
# drop quay kiosks (tiny objects) kept if area>30 only
union=unary_union([quay]+[b['g'] for b in blds])
print(union.geom_type, union.area)
if union.geom_type!='Polygon':
    for p in union.geoms: print('  part',[round(v,1) for v in p.bounds], p.area)
    union=max(union.geoms,key=lambda p:p.area)
ring=list(union.exterior.coords) if union.geom_type=='Polygon' else None
clipbox=box(-300,-200,236,200)
maskp=Polygon(ring).simplify(0.3).intersection(clipbox)
canal=canal.intersection(clipbox)
print('interiors',len(union.interiors))
ring=maskp.exterior.coords
ground=maskp.difference(canal)
print('ground',ground.geom_type,len(ground.interiors) if ground.geom_type=='Polygon' else '')
print(len(ring))
out=dict(
  canal=[[round(x,2),round(y,2)] for x,y in canal.simplify(0.1).exterior.coords][:-1],
  mask=[[round(x,2),round(y,2)] for x,y in ring][:-1],
  ground=[[round(x,2),round(y,2)] for x,y in ground.exterior.coords][:-1],
  buildings=[]
)
blds.sort(key=lambda b:(b['g'].centroid.y<8, b['g'].bounds[0]))
for b in blds:
    g=b['g']; cs=list(g.exterior.coords)[:-1]
    if Polygon(cs).exterior.is_ccw is False: pass
    out['buildings'].append(dict(addr=b['addr'],other=b['other'],side='N' if g.centroid.y>8 else 'S',poly=[[round(x,2),round(y,2)] for x,y in cs]))
    print(out['buildings'][-1]['side'], b['addr'], b['other'][:2], [round(v,1) for v in g.bounds], len(cs))
# anchor lat lon for a=0,c=0
print('anchor', LAT0, LON0)

# ---- 寫出 TypeScript ----
d=out
fix=[(92.1,'N',['53']),(130.1,'N',['63']),(-180.3,'N',['']),(-180.2,'S',[''])]
L=[]
L.append("// 新港（Nyhavn）的平面資料：OpenStreetMap 貢獻者（ODbL），經 Overture Maps 2026-09-23.1 發布版取得。")
L.append("// 座標為 (a, c) 公尺：a 沿運河指向港口（方位 115°），c 垂直運河指向北岸（方位 25°）；原點＝北緯 55.6798、東經 12.5903。")
L.append("// 由 scripts/nyhavn/extract.py 產生，請勿手動修改；建物輪廓已簡化到 0.15 m。")
L.append("")
L.append("export type P2 = [number, number];")
L.append("")
def arr(pts): return '[' + ', '.join(f'[{x:g}, {y:g}]' for x,y in pts) + ']'
L.append("/** 運河水面（西端有下到水面的階梯缺口） */")
L.append(f"export const CANAL: P2[] = {arr(d['canal'])};")
L.append("")
L.append("/** 自建模型涵蓋範圍（兩岸碼頭＋臨運河的整排建物）：Google 模型在此挖空 */")
L.append(f"export const MASK: P2[] = {arr(d['mask'])};")
L.append("")
L.append("/** 碼頭地面＝涵蓋範圍扣掉運河（建物之間的中庭也鋪上） */")
L.append(f"export const GROUND: P2[] = {arr(d['ground'])};")
L.append("")
L.append("export interface Footprint {")
L.append("  /** Nyhavn 門牌（空字串＝碼頭上的公廁入口亭） */")
L.append("  no: string;")
L.append("  side: 'N' | 'S';")
L.append("  poly: P2[];")
L.append("}")
L.append("")
L.append("export const FOOTPRINTS: Footprint[] = [")
for b in d['buildings']:
    xs=[p[0] for p in b['poly']]
    no=b['addr']
    for fa,fs,fv in fix:
        if fs==b['side'] and abs(min(xs)-fa)<1.5: no=fv
    main=sorted(no,key=lambda s:(not s.isdigit(), len(s), s))[0] if no else ''
    L.append(f"  {{ no: '{main}', side: '{b['side']}', poly: {arr(b['poly'])} }},")
L.append("];")
open(OUT,'w').write('\n'.join(L)+'\n')
print('wrote',OUT)
