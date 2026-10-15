import JSZip from "jszip";
const SITE_CHANNEL="GRACE_SITE_V1",EXT_CHANNEL="GRACE_EXTENSION_V1";
export function bridgeCall(action,payload={},timeout=3000){
  const id=payload.id||crypto.randomUUID();
  const callId=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{window.removeEventListener("message",receive);reject(new Error("Install or pair the Grace ChatGPT Bridge extension, then refresh this page."));},timeout);
    function receive(event){if(event.source!==window||event.origin!==location.origin||event.data?.channel!==EXT_CHANNEL||event.data.callId!==callId||event.data.id!==id||!event.data.reply)return;clearTimeout(timer);window.removeEventListener("message",receive);event.data.error?reject(new Error(event.data.error)):resolve(event.data);}
    window.addEventListener("message",receive);window.postMessage({channel:SITE_CHANNEL,action,...payload,id,callId},location.origin);
  });
}
export function browserBridgeStatus(chatId,title){return bridgeCall("STATUS",{chatId,title},1200).then(status=>status.protocol===2?{...status,chatId}:{installed:true,paired:false,chatId,updateRequired:true,reason:"Update Grace Bridge to version 0.2, then refresh this site and ChatGPT."}).catch(()=>({installed:false,paired:false,chatId}));}
export async function bridgeFiles(files){
  if(files.length<=8)return files;
  const zip=new JSZip();for(const file of files)zip.file(file.relativePath||file.name,await file.arrayBuffer());
  const bytes=await zip.generateAsync({type:"uint8array",compression:"DEFLATE"});
  if(bytes.length>40*1024*1024)throw new Error("The ChatGPT upload archive exceeds 40 MiB. Split it into smaller batches.");
  return [new File([bytes],"GracePlan_inputs.zip",{type:"application/zip"})];
}
export async function sendToBrowserChat({chatId,text,files=[],onEvent=()=>{}}){
  const id=crypto.randomUUID(),prepared=await bridgeFiles(files);
  let done,fail;
  const completion=new Promise((resolve,reject)=>{done=resolve;fail=reject;});
  completion.catch(()=>{});
  const receive=(event)=>{
    const data=event.data;
    if(event.source!==window||event.origin!==location.origin||data?.channel!==EXT_CHANNEL||data.id!==id||data.reply)return;
    onEvent(data);
    if(data.kind==="done")done(data);
    if(data.kind==="error")fail(new Error(data.error||"ChatGPT browser request failed."));
  };
  window.addEventListener("message",receive);
  const timer=setTimeout(()=>fail(new Error("Completion is unverified. Open ChatGPT before retrying; the bridge never resends automatically.")),31*60*1000);
  let begun=false,committed=false;
  try{
    const accepted=await bridgeCall("BEGIN",{id,chatId,text,files:prepared.map(({name,size,type})=>({name,size,type}))});
    begun=true;
    onEvent({kind:"stage",stage:"connection",label:"Connected to your paired ChatGPT conversation",chatUrl:accepted.chatUrl});
    for(const file of prepared)await bridgeCall("FILE",{id,chatId,file},60000);
    committed=true;await bridgeCall("COMMIT",{id,chatId},10000);
    return await completion;
  }catch(error){if(begun&&!committed)await bridgeCall("ABORT",{id,chatId}).catch(()=>{});throw error;}
  finally{clearTimeout(timer);window.removeEventListener("message",receive);}
}
