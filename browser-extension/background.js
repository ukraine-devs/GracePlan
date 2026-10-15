import {isSite,isChat,validId,validateRequest} from "./policy.js";
const read=async(key)=>(await chrome.storage.session.get(key))[key];
const write=async(key,value)=>chrome.storage.session.set({[key]:value});
const safeUrl=(url)=>{const u=new URL(url);return u.origin+u.pathname;};
let queue=Promise.resolve();
const serialWork=(task)=>{const work=queue.then(task,task);queue=work.catch(()=>{});return work;};
const respond=(task,send)=>{task.then(send).catch(error=>send({error:error.message}));return true;};
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message?.channel==="GRACE_SITE_V1"){
    if(!isSite(sender.url)||sender.frameId!==0||!sender.tab?.id)return;
    return respond(serialWork(async()=>{
      if(!validId(message.chatId))throw new Error("Invalid chat id.");
      if(message.action==="STATUS"){
        await write("activeSite",{chatId:message.chatId,tabId:sender.tab.id,title:String(message.title||"Grace chat").slice(0,80)});
        const pair=(await read("pairs")||{})[message.chatId];
        if(!pair)return {installed:true,paired:false};
        let tab;try{tab=await chrome.tabs.get(pair.tabId);}catch{return {installed:true,paired:false};}
        return {installed:true,paired:isChat(tab.url),chatUrl:safeUrl(tab.url)};
      }
      const pairs=await read("pairs")||{},pair=pairs[message.chatId];
      if(!pair?.instantConfirmed)throw new Error("Pair this chat in the Grace Bridge extension first.");
      const target=await chrome.tabs.get(pair.tabId);
      if(!isChat(target.url))throw new Error("The paired tab is no longer a ChatGPT conversation.");
      const jobs=await read("jobs")||{};
      if(message.action==="BEGIN"){
        validateRequest(message);
        if(Object.values(jobs).some(job=>job.tabId===pair.tabId))throw new Error("This ChatGPT tab already has a request. Check it before retrying.");
        jobs[message.id]={tabId:pair.tabId,siteTabId:sender.tab.id,chatId:message.chatId,expected:message.files,received:0};await write("jobs",jobs);
        try{const ready=await chrome.tabs.sendMessage(pair.tabId,{channel:"GRACE_TARGET_V1",action:"BEGIN",id:message.id,text:message.text,files:message.files});if(ready?.error)throw new Error(ready.error);return{accepted:true,chatUrl:safeUrl(target.url)};}
        catch(error){delete jobs[message.id];await write("jobs",jobs);throw error;}
      }
      const job=jobs[message.id];
      if(!job||job.siteTabId!==sender.tab.id||job.chatId!==message.chatId)throw new Error("Request binding expired. Check ChatGPT before retrying.");
      if(message.action==="ABORT"){
        if(job.committed)throw new Error("The request may already be sent. Check ChatGPT before retrying.");
        await chrome.tabs.sendMessage(pair.tabId,{channel:"GRACE_TARGET_V1",action:"ABORT",id:message.id}).catch(()=>{});delete jobs[message.id];await write("jobs",jobs);return{aborted:true};
      }
      if(message.action==="FILE"){
        const expected=job.expected[job.received],file=message.file;
        if(!expected||file?.name!==expected.name||file?.type!==expected.type||file?.size!==expected.size||typeof file.data!=="string"||file.data.length>Math.ceil(expected.size/3)*4+4||!/^[A-Za-z0-9+/=]*$/.test(file.data))throw new Error("Attachment does not match this request.");
        const result=await chrome.tabs.sendMessage(pair.tabId,{channel:"GRACE_TARGET_V1",action:"FILE",id:message.id,file});
        if(result?.error)throw new Error(result.error);job.received++;await write("jobs",jobs);return {accepted:true};
      }
      if(message.action==="COMMIT"){
        if(job.received!==job.expected.length)throw new Error("Attachment transfer is incomplete.");
        job.committed=true;await write("jobs",jobs);
        const result=await chrome.tabs.sendMessage(pair.tabId,{channel:"GRACE_TARGET_V1",action:"COMMIT",id:message.id});
        if(result?.error)throw new Error(result.error);return {accepted:true};
      }
      throw new Error("Unknown bridge command.");
    }),sendResponse);
  }
  if(message?.channel==="GRACE_TARGET_EVENT_V1"&&isChat(sender.url)&&sender.frameId===0){
    return respond(serialWork(async()=>{
      const jobs=await read("jobs")||{},job=jobs[message.id];
      if(!job||job.tabId!==sender.tab?.id)return {ignored:true};
      await chrome.tabs.sendMessage(job.siteTabId,{...message,channel:"GRACE_EVENT_V1",chatUrl:safeUrl(sender.url)}).catch(()=>{});
      if(["done","error"].includes(message.kind)){delete jobs[message.id];await write("jobs",jobs);}
      return {received:true};
    }),sendResponse);
  }
});
