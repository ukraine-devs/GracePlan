import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { GRACE_REFERENCE_PROFILE as REF } from "../lib/referenceProfile.js";

const INK=rgb(.09,.14,.16), MUTED=rgb(.39,.45,.47), PINK=rgb(.79,.47,.58), LINE=rgb(.86,.89,.89), PALE=rgb(.965,.975,.972), WHITE=rgb(1,1,1), BLUE=rgb(.16,.48,.58);
const list=(value)=>Array.isArray(value)?value:[];
const string=(value)=>typeof value==="string"?value:value==null?"Не підтверджено":JSON.stringify(value);

async function image(pdf,data) {
  if(data?.startsWith("data:image/webp;base64,")) {
    const bitmap=await createImageBitmap(await(await fetch(data)).blob());
    try {const canvas=document.createElement("canvas");canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext("2d").drawImage(bitmap,0,0);data=canvas.toDataURL("image/png");}finally{bitmap.close();}
  }
  const match=/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i.exec(data||"");
  if(!match)throw new Error("A valid source image is required for the proposal.");
  return match[1].toLowerCase()==="png"?pdf.embedPng(match[2]):pdf.embedJpg(match[2]);
}
function fit(page,img,{x,y,w,h}) {const scale=Math.min(w/img.width,h/img.height),width=img.width*scale,height=img.height*scale;page.drawImage(img,{x:x+(w-width)/2,y:y+(h-height)/2,width,height});}

export async function createConceptReviewPdf({renderData,planData,photoCount=0,contactSheets=[],renderQa,project={},observations=[],photos=[],sourceChecks=[],fontBytes,boldFontBytes,onProgress=()=>{}}) {
  if(!renderData||!planData)throw new Error("A completed render and source plan are required. Intermediate data is not a final proposal.");
  if(!photos.length&&!contactSheets.length)throw new Error("Photo evidence is required for the final proposal.");
  const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit);
  const load=async(name)=>{const r=await fetch("/fonts/"+name);if(!r.ok)throw new Error("PDF font unavailable");return new Uint8Array(await r.arrayBuffer());};
  onProgress("Loading measured reference layout");
  // The font assets are already subsetted with fonttools. A second fontkit
  // subset can corrupt small Cyrillic glyphs in some PDF viewers.
  const [regular,bold,plan,render]=await Promise.all([pdf.embedFont(fontBytes||await load("GraceSans.ttf"),{subset:false}),pdf.embedFont(boldFontBytes||await load("GraceSans-Bold.ttf"),{subset:false}),image(pdf,planData),image(pdf,renderData)]);
  const chars=new Set(regular.getCharacterSet()),clean=(value)=>Array.from(string(value)).filter((c)=>c==="\n"||chars.has(c.codePointAt(0))).join("");
  const index=[],sections=new Set(),date=new Date().toLocaleDateString("uk-UA");
  function text(page,value,x,y,size=11,strong=false,color=INK){page.drawText(clean(value),{x,y,size,font:strong?bold:regular,color});}
  function wrap(value,width,size=11,strong=false){
    const font=strong?bold:regular,result=[];
    for(const part of clean(value).split("\n")){let line="";for(const word of part.split(/\s+/)){const candidate=line?line+" "+word:word;if(font.widthOfTextAtSize(candidate,size)>width&&line){result.push(line);line=word;}else line=candidate;while(font.widthOfTextAtSize(line,size)>width){let end=line.length-1;while(end>1&&font.widthOfTextAtSize(line.slice(0,end),size)>width)end--;result.push(line.slice(0,end));line=line.slice(end);}}result.push(line);}return result;
  }
  function para(page,value,x,y,width,size=11){for(const line of wrap(value,width,size)){text(page,line,x,y,size);y-=size*1.45;}return y;}
  function page(code,title,subtitle,format="A3",section){
    const[w,h]=REF.formats[format],p=pdf.addPage([w,h]);if(section)sections.add(section);index.push({code,title,page:pdf.getPageCount(),format});
    p.drawRectangle({x:30,y:h-43,width:31,height:4,color:PINK});text(p,code,73,h-42,11,true,MUTED);text(p,title,30,h-83,format==="A4"?19:24,true);para(p,subtitle,30,h-105,w-60,10);
    p.drawLine({start:{x:30,y:31},end:{x:w-30,y:31},thickness:.7,color:LINE});text(p,"ПРОЄКТНА ПРОПОЗИЦІЯ · "+date+" · КОНЦЕПЦІЯ GRACE",30,17,7.5,false,MUTED);text(p,String(pdf.getPageCount()).padStart(2,"0"),w-52,17,8,false,MUTED);return p;
  }
  function table(p,head,rows,widths,section="checks",title="Продовження"){
    let y=p.getHeight()-150,width=p.getWidth()-60;
    function row(values,heading=false){const cells=values.map((v,i)=>wrap(v,width*widths[i]-18,11,heading)),height=Math.max(35,...cells.map((c)=>c.length*16+16));if(y-height<65){p=page("CONT",title,"Продовження таблиці","A3",section);y=p.getHeight()-150;row(head,true);}p.drawRectangle({x:30,y:y-height,width,height,color:heading?rgb(.91,.94,.94):PALE});let x=30;cells.forEach((cell,i)=>{cell.forEach((line,j)=>text(p,line,x+9,y-18-j*16,11,heading));x+=width*widths[i];});y-=height+2;}
    row(head,true);for(const values of rows)row(values);return{page:p,y};
  }
  function diagram(p,nodes){
    const x=50,y=950,w=1020,h=760,count=Math.max(1,nodes.length),step=Math.min(90,(h-100)/count),rootY=y-h/2;
    p.drawRectangle({x,y:y-h,width:w,height:h,color:PALE});text(p,"Логічна схема / пропозиція",x+24,y-35,18,true);p.drawRectangle({x:x+30,y:rootY-32,width:230,height:64,color:INK});text(p,"Firewall / LAN / NVR",x+45,rootY-6,14,true,WHITE);
    for(let i=0;i<count;i++){const n=nodes[i]||{id:"INPUT",type:"Потрібні підтверджені вузли"},ny=y-95-i*step;p.drawLine({start:{x:x+260,y:rootY},end:{x:x+430,y:ny-15},thickness:1.3,color:BLUE});p.drawRectangle({x:x+430,y:ny-37,width:w-470,height:43,color:WHITE,borderColor:LINE,borderWidth:1});para(p,n.id+" · "+n.type,x+442,ny-12,w-500,11);}
  }
  const rooms=list(project.rooms),devices=list(project.devices),routes=list(project.routes),cameraCount=devices.filter((d)=>/camera|cctv|камера|^c$/i.test(d.type)).length;
  onProgress("Composing six main A2 sheets");
  let p=page("A2-01","Поверх / простір за наданим 2D-планом","Безпека даних та конфіденційність доступу","A2","floor");
  const box=([x0,y0,x1,y1])=>({x:x0,y:p.getHeight()-y1,w:x1-x0,h:y1-y0});
  fit(p,render,box(REF.floorLayout.hero));text(p,"01  ПЛАН ПОВЕРХУ",1200,1045,13,true);fit(p,plan,box(REF.floorLayout.sourcePlan));text(p,"02  МЕРЕЖІ ТА ІНЖЕНЕРНІ ТОЧКИ",1200,591,12,true);fit(p,plan,box(REF.floorLayout.engineering));
  text(p,"Точки та траси потребують прив'язки й обміру",1200,91,9,false,MUTED);text(p,"C — камера · AP — Wi-Fi · D — RJ45 · FD — шафа",1200,73,9,false,MUTED);text(p,photoCount+" фото-джерел · оригінальний план збережено · чорний зріз стін",30,62,10,false,MUTED);text(p,"Концептуальний рендер, не BIM. Інженерні координати не підтверджені.",30,45,9,false,MUTED);
  p=page("A2-02","Відеоспостереження / концепція","Розміщення та реальне поле зору перевіряються окремо.","A2","floor");fit(p,plan,{x:45,y:140,w:1000,h:865});para(p,"Камери: "+cameraCount+" запропонованих вузлів.\n\nМісця: входи, проходи, загальні зони. Приватні приміщення виключаються. Кут огляду, висота й перешкоди потребують перевірки.\n\nСектори не намальовано довільно. Лінії та символи оригінального плану збережені.",1120,950,500,16);
  p=page("A2-03","Мережі / логічна топологія","Схематичні зв'язки не є монтажними кабельними маршрутами.","A2","floor");diagram(p,devices.slice(0,8));para(p,"VLAN 10 — керування\nVLAN 20 — співробітники\nVLAN 30 — камери\nVLAN 40 — гості\n\nГості не мають доступу до NAS, камер і керування. Віддалений офіс — через VPN.\n\nПорти й PoE-бюджет уточнюються за вибраними моделями.",1120,950,500,16);
  p=page("A2-04","Живлення / розрахункова схема","Потужності не приймаються з еталонного об'єкта.","A2","floor");diagram(p,[{id:"230V",type:"Ввід → захист → UPS"},{id:"PoE",type:"UPS → комутатор → камери/AP"},{id:"NAS",type:"UPS → NAS/NVR → коректна зупинка"}]);para(p,"PoE: сума паспортних потужностей + резерв.\n\nUPS: E ≥ P × t / (η × доступна ємність).\n\nНевідомі потужності не прийнято за виміряний результат. Перед вибором UPS потрібні навантаження й час автономності.",1120,950,500,16);
  p=page("A2-05","Серверний вузол / сервісна ніша","Обладнання має бути доступним і вентильованим.","A2","floor");p.drawRectangle({x:210,y:160,width:650,height:840,borderWidth:3,borderColor:INK,color:PALE});["Patch panel / маркування","Firewall / комутатор","NVR / сервер","NAS / резервні копії","UPS / живлення"].forEach((name,i)=>{p.drawRectangle({x:240,y:870-i*145,width:590,height:105,color:INK});text(p,name,263,915-i*145,18,true,WHITE);});para(p,"LAN і 230 V — окремо.\nПриплив унизу, вихід угорі.\nВільна зона обслуговування.\nКонтроль доступу.\n\nСхема не є обмірною моделлю. Остаточне місце погоджується за планом і оглядом.",1120,950,500,16);
  p=page("A2-06","Якість / зіставлення вихідних даних","Геометрія й прив'язка фото потребують підтвердження.","A2","floor");fit(p,render,{x:30,y:130,w:1060,h:900});fit(p,plan,{x:1150,y:470,w:480,h:530});para(p,"Перевірка рендера: "+(renderQa?.status||"manual_review_required")+".\n\nОригінал і формат листа перевіряються програмно. Точність реконструкції та візуальне зближення на 80% не сертифіковані.",1150,410,480,13);
  onProgress("Composing reference workflow supplements");
  p=page("D1-MAT","Матеріали / фото-зв'язки","Непідтверджені кімнати не оголошено встановленими.","A3","materials");
  const materialRows=list(observations).filter((o)=>!/plan|план/i.test(o.observations?.kind||"")).map((o,i)=>[String(i+1),o.name,string(o.observations?.surfaces),string(o.observations?.uncertainty||"Прив'язка не підтверджена")]);
  table(p,["Фото","Джерело","Матеріали","Обмеження"],materialRows.length?materialRows:[["—","Фото: "+photoCount,"Див. фотоатлас","Прив'язка не підтверджена"]],[.06,.22,.42,.30],"materials","Матеріали / продовження");
  for(const[code,title,body]of[["V-A","Варіант A / проводова PoE-система","Дані й живлення камер — PoE. Стабільність і адміністрування критичних зон. Потрібні підтверджені маршрути та PoE-бюджет."],["V-B","Варіант B / Wi-Fi + живлення","Wi-Fi передає дані, але не живлення. Потрібні адаптери, розетки й UPS. AP та магістралі залишаються провідними. Необхідне радіообстеження."],["V-C","Варіант C / гібрид","Критичні зони — PoE, інші камери — Wi-Fi після радіообстеження. Альтернативи A/B/C не сумуються в кошторисі."]]){p=page(code,title,"Варіанти для поточних вихідних даних.","A3","variants");para(p,body,30,680,750,17);para(p,"Моделі й ціни не перенесено з еталонного будинку. Потрібні підтверджені потужності та специфікація.",820,680,330,12);}
  p=page("E-01","Кабельні траси / журнал ліній","Невідомий метраж не замінено вигаданими числами.","A3","cabling");table(p,["ID","Від","До","Довжина, м","Резерв"],routes.length?routes.map((r)=>[r.id,r.from,r.to,Number.isFinite(r.measured_m)?String(r.measured_m):"Потрібен обмір",(r.reserve_percent??10)+"%"]):[["—","—","—","Потрібен масштаб","10% після обміру"]],[.15,.23,.23,.24,.15],"cabling","Журнал ліній / продовження");
  for(const[code,title,body,section]of[["SRV-1","Серверна / компактний варіант","Firewall, керований комутатор, NVR, окремий NAS і UPS. Доступне обслуговування, маркування, розділення LAN та 230 V.","server"],["SRV-2","Серверна / резервований варіант","Резервний канал, контроль UPS, копії конфігурацій і тест відновлення. Два кабелі в одному стояку не захищають від його пошкодження.","server"],["NAS-1","Зберігання / локальний NAS + NVR","NVR — відео, NAS — документи. RAID не замінює резервну копію. Ємність залежить від потоків, RAID, RPO/RTO та строку архіву.","storage"],["NAS-2","Зберігання / прихована сервісна ніша","Доступна вентильована ніша, UPS, резервний канал. Антена — поза металевою шафою. Тест відновлення обов'язковий.","storage"]]){p=page(code,title,"Габарити й паспортні моделі потребують підтвердження.","A3",section);para(p,body,30,680,1060,17);}
  p=page("ACCESS","Доступ / гості / співробітники","Мінімально необхідні права; керування відокремлено.","A3","access");table(p,["Роль","Інтернет","NAS","Камери","Керування"],[["Гість","Так","Ні","Ні","Ні"],["Співробітник","Так","За роллю","За дозволом","Ні"],["Адміністратор","Так","За роллю","За роллю","VPN / MFA"]],[.2,.16,.22,.2,.22]);
  p=page("COST","Кошторис / склад варіантів","Неперевірені суми не підставляються з еталона.","A3","budget");table(p,["Підсистема","Склад","Кількість / бюджет","Статус"],[["Відео A/B/C","Одна альтернатива",cameraCount+" запропонованих камер","Потрібна специфікація"],["Серверна 1/2","Один варіант","За портами й навантаженням","Моделі не підтверджені"],["NAS 1/2","Один варіант","За обсягом даних","Потрібна ємність"],["Монтаж","Кабелі, UPS, роботи","Після обміру","Ціни не перевірені"]],[.19,.28,.28,.25]);
  onProgress("Embedding all photo evidence");
  if(photos.length){for(let start=0;start<photos.length;start+=6){p=page("PHOTO-"+String(start/6+1).padStart(2,"0"),"Фотоатлас / "+(start+1)+"–"+Math.min(start+6,photos.length),"Кожен наданий ракурс включено.","A3","photos");for(let offset=0;offset<Math.min(6,photos.length-start);offset++){const photo=photos[start+offset],img=await image(pdf,photo.data),x=30+(offset%3)*380,y=90+(1-Math.floor(offset/3))*280;fit(p,img,{x,y:y+30,w:365,h:235});text(p,String(start+offset+1)+" · "+clean(photo.name).slice(0,48),x,y+10,9);}}}else{for(const[i,data]of contactSheets.entries()){p=page("PHOTO-"+(i+1),"Фотоатлас / контактний лист "+(i+1),"Усі ракурси враховано.","A3","photos");fit(p,await image(pdf,data),{x:30,y:65,w:1130,h:660});}}
  p=page("SOURCE","Джерела / точність / статус","Еталон визначає композицію; факти беруться з поточних джерел.","A3","sources");para(p,"Профіль: "+REF.id+". Еталон — 48 сторінок: 6 A2, 41 A3, 1 A4. Цей пакет адаптовано до одного наданого поверху, без вигаданих відсутніх поверхів.\n\nПлан використано без генеративного перемальовування. AI-рендер не є доказом точних стін і розмірів.\n\n"+list(project.unresolved).map(string).join("\n"),30,680,1100,12);
  p=page("CHECK-01","Порти / живлення / архів","Перевірки за фактичними параметрами.","A3","checks");table(p,["Перевірка","Метод","Статус"],[["Порти","Пристрої + uplink + резерв",devices.length+" запропонованих вузлів"],["PoE","Сума паспортних P + резерв","Потрібні паспортні значення"],["Відеоархів","Камери × бітрейт × час / 8","Потрібні бітрейти й строк"],["UPS","E ≥ P × t / (η × ємність)","Потрібні навантаження й час"],["Геометрія","Джерело + обмір","Оригінал збережено; CAD не підтверджено"],["Рендер","Зіставлення з джерелом",renderQa?.status||"Потрібен огляд"]],[.2,.45,.35]);
  p=page("CHECK-02","Комплектність / приймання","Контроль до монтажу й введення в експлуатацію.","A3","checks");para(p,"1. Перевірити кімнати, двері, вікна, сходи й неоднозначні символи.\n2. Підтвердити фото-зв'язки та матеріали.\n3. Перевірити кадри камер і приватні зони.\n4. Виміряти трасування, порти, PoE та автономність UPS.\n5. Перевірити ізоляцію гостей і віддалений VPN.\n6. Відновити документ, відеофрагмент і конфігурацію з копії.\n7. Передати специфікацію та журнал змін.",30,680,1080,15);
  p=page("SUMMARY","Проєктна пропозиція","Безпека даних та конфіденційність доступу","A4","summary");para(p,"Пакет сформовано за композицією й розділами еталона Grace.\n\nОдин 2D-план, "+photoCount+" фото, концептуальний 3D-рендер; шість A2, додатки A3 та цей загальний A4.\n\nВаріанти: PoE / Wi-Fi / гібрид, дві серверні й два способи зберігання.\n\nМаршрути, габарити, кошторис і BIM/IFC потребують підтверджених вимірів.\n\nФорматна перевірка не є гарантією геометричного або візуального збігу.\n\nДрук: папір за розміром сторінки, масштаб 100%.",30,680,535,12);
  onProgress("Validating the final proposal");
  const structureScore=REF.requiredSections.filter((key)=>sections.has(key)).length/REF.requiredSections.length;
  if(structureScore<REF.structureThreshold)throw new Error("Reference section completeness check failed.");
  if(pdf.getPages().slice(0,6).some((s)=>Math.abs(s.getWidth()-REF.formats.A2[0])>1||Math.abs(s.getHeight()-REF.formats.A2[1])>1))throw new Error("A2 dimensions check failed.");
  const report={template:REF.id,originals:REF.originals,index,structureScore,structureScoreMeaning:REF.structureScoreMeaning,renderQa,sourceChecks,exactGeometryVerified:false,visualSimilarityPercent:null};
  await pdf.attach(new TextEncoder().encode(JSON.stringify(report,null,2)),"GracePlan_validation.json",{mimeType:"application/json",description:"Reference provenance and validation embedded in the final proposal"});
  pdf.setTitle("Проєктна пропозиція від Grace");pdf.setAuthor("Grace AI Planner");pdf.setSubject("A2 + A3 + A4 / reference structure / concept proposal");
  const bytes=await pdf.save({useObjectStreams:true});if(bytes.length<10000)throw new Error("PDF export is unexpectedly small.");
  const chunks=[];for(let start=0;start<bytes.length;start+=0x8000)chunks.push(String.fromCharCode(...bytes.subarray(start,start+0x8000)));return"data:application/pdf;base64,"+btoa(chunks.join(""));
}
