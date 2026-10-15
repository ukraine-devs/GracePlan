import {assertReady,isGenerating,assistantNodes,pdfLinks,allowedFileUrl,toMarkdown,fillEditor,sendButton} from "./dom-adapter.js";
let pending=null;
const pause=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const emit=(id,kind,payload={})=>chrome.runtime.sendMessage({channel:"GRACE_TARGET_EVENT_V1",id,kind,...payload}).catch(()=>{});
async function waitFor(check,timeout=60000){const until=Date.now()+timeout;while(Date.now()<until){const value=check();if(value)return value;await pause(500);}throw new Error("ChatGPT did not become ready. Check its tab before retrying; the bridge never resends automatically.");}
async function collectPdf(link){
  if(!allowedFileUrl(link.url))return null;
  const response=await fetch(link.url,{credentials:"include",redirect:"error",signal:AbortSignal.timeout(30000)});
  if(!response.ok)return null;
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length>25*1024*1024||String.fromCharCode(...bytes.slice(0,5))!=="%PDF-")return null;
  const parts=[];for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
  return {type:"pdf",name:link.name.replace(/[\\/\u0000-\u001f]/g,"_").slice(0,180),data:"data:application/pdf;base64,"+btoa(parts.join(""))};
}
async function run(job){
  let sent=false;
  try{
    const editor=assertReady();const before=assistantNodes().length;
    if(job.files.length){
      await emit(job.id,"stage",{stage:"upload",label:"Uploading files to your ChatGPT conversation"});
      const fileInput=[...document.querySelectorAll('input[type="file"]')].find(input=>input.id.includes("files"))||document.querySelector('input[type="file"]');
      if(!fileInput)throw new Error("ChatGPT file input is unavailable. No message was sent.");
      const transfer=new DataTransfer();for(const file of job.files){const raw=atob(file.data),bytes=Uint8Array.from(raw,char=>char.charCodeAt(0));if(bytes.length!==file.size)throw new Error("Attachment bytes were incomplete.");transfer.items.add(new File([bytes],file.name,{type:file.type}));}
      fileInput.files=transfer.files;fileInput.dispatchEvent(new Event("change",{bubbles:true}));job.files=[];
      // The send control only becomes usable after normal ChatGPT upload processing.
      await pause(1000);
    }
    fillEditor(editor,job.text);
    const button=await waitFor(()=>{const b=sendButton();return b&&!b.disabled?b:null;},120000);
    const uploadFailed=[...document.querySelectorAll('[role="alert"]')].map(n=>n.textContent).find(t=>/upload|file|файл|ліміт|limit|помил|error/i.test(t||""));
    if(uploadFailed)throw new Error(uploadFailed);
    await emit(job.id,"stage",{stage:"send",label:"Sending once through the visible ChatGPT composer"});
    sent=true;button.click();
    let lastText="",stableAt=Date.now(),started=false,lastHeartbeat=0;
    const deadline=Date.now()+30*60*1000;
    while(Date.now()<deadline){
      const nodes=assistantNodes(),last=nodes.length>before?nodes[nodes.length-1]:null;
      const text=last?toMarkdown(last).replace(/\n{3,}/g,"\n\n").trim():"";
      const generating=isGenerating();if(generating||last)started=true;
      if(text!==lastText){lastText=text;stableAt=Date.now();await emit(job.id,"text",{text});}
      if(Date.now()-lastHeartbeat>15000){lastHeartbeat=Date.now();await emit(job.id,"stage",{stage:"response",label:generating?"ChatGPT is responding":"Waiting for the ChatGPT response"});}
      if(started&&last&&!generating&&text&&Date.now()-stableAt>5000){
        const links=pdfLinks(last),artifacts=[];for(const link of links){try{const pdf=await collectPdf(link);if(pdf)artifacts.push(pdf);}catch{/* The original PDF remains accessible in ChatGPT. */}}
        await emit(job.id,"done",{text,artifacts,pdfAvailableInChatGPT:links.length>artifacts.length});return;
      }
      await pause(1000);
    }
    throw new Error("ChatGPT completion could not be verified. The request may still be running; open the paired tab. It was not resent.");
  }catch(error){await emit(job.id,"error",{error:error.message,sent});}
  finally{if(pending?.id===job.id)pending=null;}
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.channel!=="GRACE_TARGET_V1")return;
  try{
    if(message.action==="PROBE"){assertReady();sendResponse({ready:true});return;}
    if(message.action==="BEGIN"){if(pending)throw new Error("A Grace request is already active in this tab.");assertReady();pending={id:message.id,text:message.text,files:[],expected:message.files.length};sendResponse({ready:true});return;}
    if(!pending||pending.id!==message.id)throw new Error("ChatGPT bridge request expired. Check the tab before retrying.");
    if(message.action==="ABORT"){if(!pending.committed)pending=null;sendResponse({aborted:true});return;}
    if(message.action==="FILE"){pending.files.push(message.file);sendResponse({received:true});return;}
    if(message.action==="COMMIT"){if(pending.files.length!==pending.expected)throw new Error("Attachment transfer is incomplete.");pending.committed=true;const job=pending;sendResponse({accepted:true});void run(job);return;}
  }catch(error){sendResponse({error:error.message});}
});
