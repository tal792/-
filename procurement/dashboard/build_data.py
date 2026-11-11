"""Builds procurement/dashboard/data.json AND per-supplier dossiers (procurement/suppliers/<ID>/dossier.md)
from the repo files. Run after every update, then republish the artifact (same URL)."""
import csv, json, re, datetime, collections, os
B='procurement/'
def rows(p):
    return list(csv.DictReader(open(B+p,encoding='utf-8-sig'))) if os.path.exists(B+p) else []
sup=rows('data/suppliers.csv'); log=rows('outbox/sent-log.csv'); files=rows('data/drive-files.csv')
folders={r['supplier_id']:r['folder_id'] for r in rows('data/drive-folders.csv')}
notes=json.load(open(B+'data/notes.json',encoding='utf-8'))
ROOT='https://drive.google.com/drive/folders/'+folders.get('ROOT','')
PRICE_FILES={'T01':'analysis/okeypets-prices.csv','B01':'analysis/bestjoy-prices.csv','B02':'analysis/ivy-catalog.csv'}
for f in os.listdir(B+'analysis'):
    m=re.match(r'prices-([A-Z]\d+)\.csv$',f)
    if m: PRICE_FILES[m.group(1)]='analysis/'+f
HE={'S001':'Petstar','S002':'PamiPet','S003':'Ronipet','T01':'OKEYPETS','B01':'Bestjoy','B02':'Ivy Textile','B04':'Hengshang','B05':'JCZCARE','F01':'Myjian','F03':'Yantai Yummy','F04':'Rongchong','P03':'Petmex'}
today=datetime.date.today()
def bdays(a,b):
    d=0;x=a
    while x<b:
        x+=datetime.timedelta(days=1)
        if x.weekday()<5: d+=1   # Mon-Fri (Chinese/Polish workweek)
    return d
def state(s):
    s=s.lower()
    if any(k in s for k in ('replied','follow-up','quote request','holding')): return 'replied'
    if 'sent' in s or 'request' in s: return 'waiting'
    return 'lead'
# ---------- products
CATS={'harness':'רתמות','collar':'קולרים','leash':'רצועות','bed':'מיטות','bowl':'קערות','toy':'צעצועים','pad':'פדים','other':'אחר'}
def cat_of(t):
    t=t.lower()
    for k,v in [('harness','harness'),('collar','collar'),('leash','leash'),('bed','bed'),('bowl','bowl'),('feeder','bowl'),('toy','toy'),('snuffle','toy'),('pad','pad'),('mat','pad')]:
        if k in t: return v
    return 'other'
HEB=[('snuffle mat','משטח הרחה'),('snuffle','צעצוע הרחה'),('anti-pull','רתמה נגד משיכה'),('t-strap','רתמת T'),('mesh','רתמת רשת'),('oxford','רתמת אוקספורד'),('tactical','רתמה טקטית'),('pvc','רתמת PVC מודפסת'),('with bag','רתמה עם תיק'),('pouch','רתמה עם כיס'),('harness+leash','סט רתמה + רצועה'),('harness and leash','סט רתמה + רצועה'),('harness','רתמה'),('pu collar','קולר PU'),('cat c','קולר לחתול'),('recovery','קונוס לאחר ניתוח'),('elizabeth','קונוס לאחר ניתוח'),('collar','קולר'),('leash','רצועה'),('slow feeder','קערת האכלה איטית'),('bowl','קערה'),('pee pad','פד רחיץ'),('pad','פד'),('bed','מיטה'),('bow tie','פפיון'),('bandana','בנדנה'),('poop bag','מחזיק שקיות'),('safety belt','חגורת בטיחות לרכב'),('toy','צעצוע')]
def heb(n):
    l=n.lower()
    for k,v in HEB:
        if k in l: return v
    return n
def nums(s): return [float(x) for x in re.findall(r'\d+\.?\d*',s or '')]
all_products=collections.defaultdict(list)   # sid -> all priced rows (dossier)
display=[]
for sid,path in PRICE_FILES.items():
    name=HE.get(sid,sid)
    groups=collections.OrderedDict()
    for r in rows(path):
        p=nums(r.get('unit_price_usd'))
        if not p or max(p)>30: continue
        key=r.get('item_code') if r.get('item_code') not in (None,'','not stated') else r.get('description')
        groups.setdefault((key,r.get('description')),[]).append((r,p))
    for (key,desc),rs in groups.items():
        allp=[x for _,ps in rs for x in ps]; r0=rs[0][0]
        moqs=sorted(set(re.sub(r'\s*\(.*','',r.get('moq','')).replace('pcs','').strip() for r,_ in rs if r.get('moq') and r['moq']!='not stated'))
        clean=re.sub(r'\s*\[.*?\]','',desc or '').strip()
        item=dict(sup=name,sid=sid,cat=cat_of((r0.get('category') or '')+' '+clean),name=clean,he=heb(clean),
          code=r0.get('item_code','') if r0.get('item_code') not in (None,'not stated') else '',
          sizes=len(rs) if len(rs)>1 else (r0.get('size') or ''),pmin=min(allp),pmax=max(allp),
          moq=' / '.join(moqs[:2]),term=r0.get('price_term',''),img=r0.get('img',''))
        all_products[sid].append(item)
MOQFIX={'Slow feeder bowl':'10','Dog bed':'50','Pets Elizabeth Circle':'—'}
for sid,items in all_products.items():
    for it in items:
        for k,v in MOQFIX.items():
            if it['name'].startswith(k): it['moq']=v
    by=collections.defaultdict(list)
    for it in items:
        if it['cat']!='other' or sid=='T01': by[it['cat']].append(it)
    for c,its in by.items():
        its=sorted(its,key=lambda x:x['pmin'])
        display+= its if len(its)<=12 else its[:6]+its[6::max(1,len(its)//6)][:6]
# ---------- suppliers + dossiers
suppliers=[]; todo=[]; approvals=[]
for r in sup:
    sid=r['id']; contacted=[l for l in log if l['supplier_id']==sid]
    st=state(r['status']) if contacted else 'lead'
    if not contacted and int(r['fit_score_1_5'] or 0)<3: continue
    name=HE.get(sid) or (r['brand'] if r['brand'] not in ('-','') else r['legal_name'])
    fl=[f for f in files if f['supplier_id']==sid]
    inbox=''
    for f in os.listdir(B+'inbox'):
        if f.startswith(sid+'-') or f.startswith(sid+'.'): inbox=open(B+'inbox/'+f,encoding='utf-8').read()
    wait=notes['waiting_for'].get(sid,[])
    # stuck / missing detection
    issues=[]
    for l in contacted:
        if state(l['status'])=='waiting':
            d=bdays(datetime.date.fromisoformat(l['sent_date']),today)
            if d>=5: issues.append(f'לא ענה {d} ימי עבודה – להכין תזכורת')
    prom=notes['promised'].get(sid)
    if prom and datetime.date.fromisoformat(prom)<today and st!='replied': issues.append(f'הבטיח תשובה עד {prom} ולא ענה')
    if st=='replied' and wait: issues.append('מחכים ל: '+', '.join(wait))
    unparsed=[f for f in fl if not f['processed']]
    if unparsed: issues.append(f'{len(unparsed)} קבצים חדשים שעוד לא נותחו')
    for i in issues: todo.append(f'{name}: {i}')
    drive=('https://drive.google.com/drive/folders/'+folders[sid]) if sid in folders else ''
    dossier=dict(
      emails=[dict(date=l['sent_date'],subject=l['subject'],status=l['status']) for l in contacted],
      files=[dict(name=f['name'],kind=f['result'],url='https://drive.google.com/file/d/'+f['file_id']+'/view') for f in fl],
      products=len(all_products.get(sid,[])),
      items=[{k:v for k,v in it.items() if k not in ('sup','sid')} for it in all_products.get(sid,[])],
      waiting_for=wait, issues=issues,
      notes=inbox[:4000])
    suppliers.append(dict(id=sid,name=name,legal=r['legal_name'],city=r['city_province'],email=r['email'],phone=r['phone_whatsapp'],web=r['website'],
      kind='חטיפים' if sid[0] in 'FP' else 'אקססוריז',score=r['fit_score_1_5'],state=st,status=r['status'],
      summary=notes['summary'].get(sid,''),drive=drive,dossier=dossier))
    # markdown dossier
    os.makedirs(B+f'suppliers/{sid}',exist_ok=True)
    md=[f'# תיק רכש – {name} ({sid})',f'עודכן: {today}','',f'**חברה:** {r["legal_name"]}  ',f'**עיר:** {r["city_province"]}  ',f'**מייל:** {r["email"]}  ',f'**טלפון:** {r["phone_whatsapp"]}  ',f'**אתר:** {r["website"]}  ',f'**סטטוס:** {r["status"]}  ',f'**תיקיית Drive:** {drive}','',
        '## תקציר',notes['summary'].get(sid,'—'),'','## מחכים ל',*(['- '+w for w in wait] or ['—']),'','## בעיות פתוחות',*(['- '+i for i in issues] or ['—']),'',
        f'## מוצרים עם מחיר ({len(all_products.get(sid,[]))})','| מוצר | קוד | מחיר $ | MOQ |','|---|---|---|---|',
        *[f'| {p["he"]} – {p["name"][:40]} | {p["code"]} | {p["pmin"]:.2f}–{p["pmax"]:.2f} | {p["moq"]} |' for p in all_products.get(sid,[])[:200]],'',
        '## קבצים',*(['- ['+f['name']+'](https://drive.google.com/file/d/'+f['file_id']+'/view) – '+f['result'] for f in fl] or ['—']),'',
        '## התכתבות',*(['- '+l['sent_date']+' · '+l['subject']+' · '+l['status'] for l in contacted] or ['—']),'','## סיכומי תשובות',inbox or '—']
    open(B+f'suppliers/{sid}/dossier.md','w',encoding='utf-8').write('\n'.join(md))
todo+=notes.get('manual_todo',[])
apq=json.load(open(B+'data/approvals.json',encoding='utf-8')) if os.path.exists(B+'data/approvals.json') else []
TEAM=json.load(open(B+'data/team.json',encoding='utf-8')) if os.path.exists(B+'data/team.json') else []
data=dict(updated=datetime.datetime.now().strftime('%d.%m.%Y %H:%M'),drive_root=ROOT,cats=CATS,suppliers=suppliers,products=display,
  todo=todo or ['אין משימות תקועות כרגע'],
  files=[dict(name='השוואת מחירים',url='https://docs.google.com/document/d/1lkvh9VCgCaOcCDJBCu6UfVVJxql2PbQoJPppU3Ix6SQ/edit')],
  history=[dict(date=l['sent_date'],sup=l['supplier'],subject=l['subject'],status=l['status']) for l in log],
  approvals=[a for a in apq if a.get('state','pending')=='pending'],team=TEAM)
json.dump(data,open(B+'dashboard/data.json','w',encoding='utf-8'),ensure_ascii=False,indent=1)
print(len(suppliers),'suppliers',len(display),'products shown',sum(len(v) for v in all_products.values()),'priced total; todo',len(todo))
