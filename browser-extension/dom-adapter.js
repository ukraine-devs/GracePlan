const label=(node)=>[node.getAttribute("aria-label"),node.getAttribute("title"),node.textContent].filter(Boolean).join(" ").trim();
const visible=(node)=>!node.hidden&&node.getAttribute("aria-hidden")!=="true"&&node.getClientRects().length>0;
export function findEditor(doc=document){return [...doc.querySelectorAll('textarea,[contenteditable="true"][role="textbox"],#prompt-textarea')].find(visible);}
export function signedOut(doc=document){return [...doc.querySelectorAll('button,a')].filter(visible).some(node=>/^(log in|sign in|увійти|войти)$/i.test(label(node)));}
export function assertReady(doc=document){
  if(signedOut(doc))throw new Error("Sign in to ChatGPT in the paired tab first.");
  const editor=findEditor(doc);if(!editor)throw new Error("ChatGPT composer is unavailable. Open the paired conversation.");
  if((editor.value||editor.innerText||editor.textContent||"").trim())throw new Error("ChatGPT already has an unsent draft. Clear or send it there first.");
  if(isGenerating(doc))throw new Error("ChatGPT is already responding. Wait for it to finish.");
  if(doc.querySelector('iframe[src*="challenge"],iframe[src*="captcha"]'))throw new Error("ChatGPT requires browser verification. Complete it manually.");
  return editor;
}
export function isGenerating(doc=document){return [...doc.querySelectorAll('button')].filter(visible).some(node=>/stop (generating|response|streaming)|зупинити|остановить/i.test(label(node)));}
export function assistantNodes(doc=document){return [...new Set(doc.querySelectorAll('[data-message-author-role="assistant"],[data-message-role="assistant"],article[data-turn="assistant"],[data-turn-role="assistant"]'))];}
export function pdfLinks(node){return [...node.querySelectorAll('a[href]')].filter(a=>/\.pdf\b/i.test(a.textContent||a.getAttribute('download')||a.href)).map(a=>({name:a.getAttribute('download')||a.textContent?.trim()||'proposal.pdf',url:a.href}));}
export function allowedFileUrl(url){try{const u=new URL(url);return u.protocol==="blob:"&&u.origin==="https://chatgpt.com"||u.protocol==="https:"&&(u.hostname==="chatgpt.com"||u.hostname.endsWith(".oaiusercontent.com"));}catch{return false;}}
export function toMarkdown(node){
  if(node.nodeType===3)return node.textContent;
  if(node.nodeType!==1||node.matches('button,svg,script,style,[aria-hidden="true"],details'))return "";
  const content=[...node.childNodes].map(toMarkdown).join("");
  const tag=node.tagName.toLowerCase();
  if(/^h[1-6]$/.test(tag))return "\n\n"+"#".repeat(Number(tag[1]))+" "+content+"\n\n";
  if(tag==="p"||tag==="div")return content+"\n\n";
  if(tag==="br")return "\n";
  if(tag==="strong"||tag==="b")return "**"+content+"**";
  if(tag==="em"||tag==="i")return "*"+content+"*";
  if(tag==="pre")return "\n\n```\n"+(node.textContent||"")+"\n```\n\n";
  if(tag==="code")return "`"+content+"`";
  if(tag==="li")return "\n- "+content.trim()+"\n";
  if(tag==="a")return "["+content+"]("+node.href+")";
  return content;
}
export function fillEditor(editor,text){
  editor.focus();
  if(editor.tagName==="TEXTAREA"){
    const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;setter.call(editor,text);editor.dispatchEvent(new Event("input",{bubbles:true}));
  }else{
    const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);
    if(!document.execCommand("insertText",false,text))throw new Error("ChatGPT editor did not accept the text. No message was sent.");
  }
}
export function sendButton(doc=document){return [...doc.querySelectorAll('button')].filter(visible).find(node=>/^(send( message| prompt)?|надіслати( повідомлення)?|отправить( сообщение)?)$/i.test(label(node))||node.getAttribute('data-testid')==='send-button');}
