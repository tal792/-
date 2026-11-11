"""Builds procurement/dashboard/data.json from the repo files. Run after every update, then republish the artifact."""
import csv, json, re, datetime, collections
B='procurement/'
sup=list(csv.DictReader(open(B+'data/suppliers.csv',encoding='utf-8')))
log=list(csv.DictReader(open(B+'outbox/sent-log.csv',encoding='utf-8')))
DRIVE={'T01':'https://drive.google.com/drive/folders/11MdlVxgBEAHiHQAt-sVXoK2sYDS1z4aO',
       'B01':'https://drive.google.com/drive/folders/1HMEpcWUSH9qgwZvHz6VSDcOOUT83c5xz',
       'B02':'https://drive.google.com/drive/folders/1YZS2nDqJQdBTnT6YMCA6aJUVwgoTzDVx'}
ROOT='https://drive.google.com/drive/folders/11s8eOTg0uXjmOX9Zt9EXrU7jVfrMkae7'
HE={'S001':'Petstar','S002':'PamiPet','S003':'Ronipet','T01':'OKEYPETS','B01':'Bestjoy','B02':'Ivy Textile','B04':'Hengshang','B05':'JCZCARE','F01':'Myjian','F03':'Yantai Yummy','F04':'Rongchong','P03':'Petmex'}
SUMMARY={
 'T01':'מפעל לרתמות, קולרים ורצועות. MOQ נמוך מאוד (20–50). שלח מחירונים. ביקשנו FOB ודוגמאות.',
 'B01':'מבחר ענק, 14 קטלוגים. MOQ 300 לדגם. ביקשנו FOB, מחירי מיטות וקערות, MOQ 100–150.',
 'B02':'מיטות ופדים רחיצים. ביקשנו הצעה ל-10 מיטות + פד 50×50, ושאלנו על אריזה לכל הליינים.',
 'S003':'ענו שהצוות בתערוכה בגואנגג׳ואו. תשובה מלאה הובטחה ל-12.11.',
}
def state(s):
    s=s.lower()
    if 'replied' in s or 'follow-up' in s or 'quote request' in s: return 'replied'
    if 'holding' in s: return 'replied'
    if 'sent' in s or 'request' in s: return 'waiting'
    return 'lead'
suppliers=[]
for r in sup:
    st=state(r['status'])
    contacted = any(l['supplier_id']==r['id'] for l in log)
    if not contacted and st=='lead' and r['fit_score_1_5'] and int(r['fit_score_1_5'] or 0)<3: continue
    suppliers.append(dict(id=r['id'],name=HE.get(r['id']) or (r['brand'] if r['brand'] not in ('-','') else r['legal_name']),
      legal=r['legal_name'],city=r['city_province'],email=r['email'],phone=r['phone_whatsapp'],web=r['website'],
      kind='חטיפים' if r['id'][0] in 'FP' else 'אקססוריז',score=r['fit_score_1_5'],
      state=st if contacted else 'lead',status=r['status'],summary=SUMMARY.get(r['id'],''),drive=DRIVE.get(r['id'],'')))
# products
CATS={'harness':'רתמות','collar':'קולרים','leash':'רצועות','bed':'מיטות','bowl':'קערות','toy':'צעצועים','pad':'פדים','other':'אחר'}
def cat_of(t):
    t=t.lower()
    for k,v in [('harness','harness'),('collar','collar'),('leash','leash'),('bed','bed'),('bowl','bowl'),('feeder','bowl'),('toy','toy'),('snuffle','toy'),('pad','pad'),('mat','pad')]:
        if k in t: return v
    return 'other'
products=[]
ok=list(csv.DictReader(open(B+'analysis/okeypets-prices.csv',encoding='utf-8-sig')))
groups=collections.OrderedDict()
for r in ok:
    key=(r['description'],r['source_file'])
    groups.setdefault(key,[]).append(r)
for (desc,src),rs in groups.items():
    prices=[float(x) for r in rs for x in re.findall(r'\d+\.?\d*',r['unit_price_usd'] or '')]
    if not prices: continue
    moqs=sorted(set(r['moq'] for r in rs if r['moq'] and r['moq']!='not stated'))
    products.append(dict(sup='OKEYPETS',sid='T01',cat=cat_of(r['category']+' '+desc),name=desc,code=rs[0]['item_code'] if rs[0]['item_code']!='not stated' else '',
      sizes=len(rs),pmin=min(prices),pmax=max(prices),moq=' / '.join(moqs[:2]),term=rs[0]['price_term'],img=''))
bj=list(csv.DictReader(open(B+'analysis/bestjoy-prices.csv',encoding='utf-8-sig')))
pick=collections.defaultdict(list)
for r in bj:
    c=cat_of(r['category']+' '+r['description'])
    if c=='other': continue
    prices=[float(x) for x in re.findall(r'\d+\.?\d*',r['unit_price_usd'] or '')]
    if not prices or max(prices)>30: continue
    name=re.sub(r'\s*\[.*?\]','',r['description']).strip()
    pick[c].append(dict(sup='Bestjoy',sid='B01',cat=c,name=name,code=r['item_code'],sizes=r['size'],pmin=min(prices),pmax=max(prices),
      moq=re.sub(r'\s*\(.*','',r['moq']),term=r['price_term'],img=''))
for c,items in pick.items():
    seen=set();out=[]
    for it in sorted(items,key=lambda x:x['pmin']):
        k=it['code'] or it['name']
        if k in seen: continue
        seen.add(k); out.append(it)
    # spread: cheapest 6 + 6 across the range
    sel=out[:6]+out[6::max(1,len(out)//6)][:6]
    products+=sel
HEB=[('snuffle mat','משטח הרחה'),('snuffle','צעצוע הרחה'),('anti-pull','רתמה נגד משיכה'),('t-strap','רתמת T'),('mesh','רתמת רשת'),('oxford','רתמת אוקספורד'),('tactical','רתמה טקטית'),('pvc','רתמת PVC מודפסת'),('with bag','רתמה עם תיק'),('pouch','רתמה עם כיס'),('harness+leash','סט רתמה + רצועה'),('harness and leash','סט רתמה + רצועה'),('harness','רתמה'),('pu collar','קולר PU'),('cat c','קולר לחתול'),('recovery','קונוס לאחר ניתוח'),('collar','קולר'),('leash','רצועה'),('slow feeder','קערת האכלה איטית'),('bowl','קערה'),('bed','מיטת כלב'),('bow tie','פפיון'),('bandana','בנדנה'),('poop bag','מחזיק שקיות'),('safety belt','חגורת בטיחות לרכב'),('toy','צעצוע')]
def heb(n):
    l=n.lower()
    for k,v in HEB:
        if k in l: return v
    return n
MOQFIX={'Slow feeder bowl':'10','Dog bed':'50','Pets Elizabeth Circle':'—'}
for p in products:
    p['he']=heb(p['name'])
    for k,v in MOQFIX.items():
        if p['name'].startswith(k): p['moq']=v
    if p['he']=='קונוס לאחר ניתוח': p['cat']='other'
    p['moq']=p['moq'].replace('pcs','')
waiting=[]
for s in suppliers:
    if s['state']=='replied' and s['id'] in ('T01','B01','B02'): pass
data=dict(updated=datetime.datetime.now().strftime('%d.%m.%Y %H:%M'),drive_root=ROOT,cats=CATS,suppliers=suppliers,products=products,
  todo=[
   'לחכות למחירי FOB ונתוני קרטון מ-OKEYPETS ו-Bestjoy (נשלח 11.11)',
   'לחכות להצעת Ivy ל-10 מיטות ופדים 50×50 (נשלח 11.11)',
   'Ronipet – תשובה מלאה צפויה 12.11',
   '17.11 – תזכורות לספקים שלא ענו (אאשר איתך לפני שליחה)',
  ],
  files=[dict(name='תיק ספקים',url=''),dict(name='השוואת מחירים',url='https://docs.google.com/document/d/1lkvh9VCgCaOcCDJBCu6UfVVJxql2PbQoJPppU3Ix6SQ/edit'),dict(name='מדריך עבודה',url='')],
  history=[dict(date=l['sent_date'],sup=l['supplier'],subject=l['subject'],status=l['status']) for l in log])
json.dump(data,open(B+'dashboard/data.json','w',encoding='utf-8'),ensure_ascii=False,indent=1)
print(len(suppliers),'suppliers',len(products),'products', collections.Counter(p['cat'] for p in products))
