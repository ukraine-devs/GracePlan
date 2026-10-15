import {conversationUrl} from "./policy.js";

// Tab ids can be reused after restarting Chrome. The conversation URL is the
// identity; an old tab id alone must never authorize sending into another chat.
export async function resolvePairedTab(pair,tabs) {
  const url=conversationUrl(pair?.chatUrl);
  if(!url)throw new Error("Open an existing ChatGPT conversation and pair it again.");
  if(pair.tabId){
    const tab=await tabs.get(pair.tabId).catch(()=>null);
    if(tab&&conversationUrl(tab.url)===url)return tab;
  }
  const matches=(await tabs.query({url:"https://chatgpt.com/*"})).filter(tab=>conversationUrl(tab.url)===url);
  if(matches.length===1)return matches[0];
  if(matches.length>1)throw new Error("This conversation is open in multiple tabs. Pair the intended tab again.");
  throw new Error("Open your saved ChatGPT conversation, then check the connection. The bridge will not choose another chat.");
}

export async function savedPairs() {
  const {gracePairsV2}=await chrome.storage.local.get("gracePairsV2");
  if(gracePairsV2)return gracePairsV2;
  // Preserve consent from the original session-scoped prototype when possible.
  const {pairs={}}=await chrome.storage.session.get("pairs"),migrated={};
  for(const [id,pair] of Object.entries(pairs)){
    const tab=await chrome.tabs.get(pair.tabId).catch(()=>null),chatUrl=conversationUrl(tab?.url);
    if(chatUrl&&pair.instantConfirmed)migrated[id]={tabId:pair.tabId,chatUrl,instantConfirmed:true};
  }
  await savePairs(migrated);
  return migrated;
}

export function savePairs(pairs){return chrome.storage.local.set({gracePairsV2:pairs});}
