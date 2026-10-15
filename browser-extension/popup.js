import {conversationUrl} from "./policy.js";
const status=document.getElementById("status"),select=document.getElementById("tab");
const {activeSite}=await chrome.storage.session.get("activeSite");
status.textContent=activeSite?"Grace chat: "+activeSite.title:"Open Grace Planner and click Connect ChatGPT first.";
const tabs=await chrome.tabs.query({url:"https://chatgpt.com/*"});
for(const tab of tabs.filter(t=>conversationUrl(t.url))){const option=document.createElement("option");option.value=tab.id;option.textContent=tab.title||"ChatGPT";select.append(option);}
document.getElementById("pair").onclick=async()=>{
  if(!activeSite||!select.value||!document.getElementById("instant").checked){status.textContent="Choose a signed-in ChatGPT tab and confirm Instant.";return;}
  const result=await chrome.runtime.sendMessage({channel:"GRACE_POPUP_V1",action:"PAIR",chatId:activeSite.chatId,tabId:Number(select.value),instantConfirmed:true}).catch(()=>({error:"Refresh ChatGPT after installing the extension."}));
  status.textContent=result?.paired?"Pairing saved. Return to Grace Planner.":result?.error||"Pairing could not be verified.";
};
document.getElementById("disconnect").onclick=async()=>{if(!activeSite)return;const result=await chrome.runtime.sendMessage({channel:"GRACE_POPUP_V1",action:"DISCONNECT",chatId:activeSite.chatId});status.textContent=result?.disconnected?"Disconnected. The ChatGPT conversation is retained.":result?.error||"Disconnect could not be verified.";};
