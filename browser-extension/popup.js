import {isChat} from "./policy.js";
const status=document.getElementById("status"),select=document.getElementById("tab");
const {activeSite}=await chrome.storage.session.get("activeSite");
status.textContent=activeSite?"Grace chat: "+activeSite.title:"Open Grace Planner and click Connect ChatGPT first.";
const tabs=await chrome.tabs.query({url:"https://chatgpt.com/*"});
for(const tab of tabs.filter(t=>isChat(t.url))){const option=document.createElement("option");option.value=tab.id;option.textContent=tab.title||"ChatGPT";select.append(option);}
document.getElementById("pair").onclick=async()=>{
  if(!activeSite||!select.value||!document.getElementById("instant").checked){status.textContent="Choose a signed-in ChatGPT tab and confirm Instant.";return;}
  const probe=await chrome.tabs.sendMessage(Number(select.value),{channel:"GRACE_TARGET_V1",action:"PROBE"}).catch(()=>({error:"Refresh ChatGPT after installing the extension."}));
  if(probe?.error){status.textContent=probe.error;return;}
  const {pairs={}}=await chrome.storage.session.get("pairs");
  if(Object.entries(pairs).some(([id,pair])=>id!==activeSite.chatId&&pair.tabId===Number(select.value))){status.textContent="This tab is paired to another Grace chat. Use a different ChatGPT conversation.";return;}
  pairs[activeSite.chatId]={tabId:Number(select.value),instantConfirmed:true};await chrome.storage.session.set({pairs});status.textContent="Paired. Return to Grace Planner.";
};
document.getElementById("disconnect").onclick=async()=>{if(!activeSite)return;const {pairs={}}=await chrome.storage.session.get("pairs");delete pairs[activeSite.chatId];await chrome.storage.session.set({pairs});status.textContent="Disconnected. The ChatGPT conversation is retained.";};
